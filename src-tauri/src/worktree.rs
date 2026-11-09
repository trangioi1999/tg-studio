use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub run_id: String,
    pub path: PathBuf,
    pub branch: String,
    pub base: String,
}

impl Worktree {
    /// The agent works in the user's own folder: no worktree, no branch. `base` is then a
    /// tree snapshot of the folder taken before the run, and `path` is the repository root.
    pub fn is_direct(&self) -> bool { self.branch.is_empty() }
}

pub fn git(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<String, String> {
    git_env(cwd, args, stdin, None)
}

/// `git` with its own index file, so a direct run never touches the user's index.
pub fn git_index(cwd: &Path, index: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<String, String> {
    git_env(cwd, args, stdin, Some(index))
}

/// Stages the whole folder except the app's own `.tg/` (`flags`: e.g. `-A`, or `-N
/// --ignore-removal`). Not with `:(exclude).tg`: git refuses any pathspec that names an
/// ignored path, and `.tg/` is ignored as soon as a draft exists. Add everything, then drop it.
pub fn add_all_but_tg(run: impl Fn(&[&str]) -> Result<String, String>, flags: &[&str]) -> Result<(), String> {
    let mut add = vec!["add"];
    add.extend_from_slice(flags);
    add.extend_from_slice(&["--", "."]);
    run(&add)?;
    run(&["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".tg"])?;
    Ok(())
}

fn git_env(cwd: &Path, args: &[&str], stdin: Option<&[u8]>, index: Option<&Path>) -> Result<String, String> {
    let output = git_output(cwd, args, stdin, index)?;
    if !output.status.success() {
        return Err(format!("Lệnh Git thất bại: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("Kết quả Git không phải UTF-8: {e}"))
}

/// Runs git and returns its raw output whatever the exit code: for bytes that are not text
/// (a blob) or an exit code that is not an error (`merge-file` counts conflicts).
pub fn git_output(cwd: &Path, args: &[&str], stdin: Option<&[u8]>, index: Option<&Path>) -> Result<std::process::Output, String> {
    let mut command = crate::env::std_command("git");
    if let Some(index) = index { command.env("GIT_INDEX_FILE", index); }
    let mut child = command
        .current_dir(cwd)
        .env("PATH", crate::env::login_path())
        .args(["-c", "core.quotepath=false"])
        .args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Không chạy được Git: {e}"))?;
    // Drain output concurrently with writing large patches, avoiding full-pipe deadlocks.
    std::thread::scope(|scope| {
        let writer = stdin.map(|data| {
            let mut pipe = child.stdin.take().expect("piped stdin");
            scope.spawn(move || pipe.write_all(data))
        });
        let output = child.wait_with_output().map_err(|e| format!("Không đọc được kết quả Git: {e}"))?;
        let written = writer.map(|w| w.join().expect("stdin writer panicked"));
        // A failed command's own message says more than the broken pipe it caused.
        if let (true, Some(Err(e))) = (output.status.success(), written) {
            return Err(format!("Không gửi được dữ liệu cho Git: {e}"));
        }
        Ok(output)
    })
}

pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            if out.len() == 40 { break; }
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') && out.len() < 40 {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() { "task".into() } else { out.into() }
}

fn io_error(e: std::io::Error) -> String { format!("Không truy cập được dữ liệu worktree: {e}") }

fn root(repo: &Path) -> Result<PathBuf, String> {
    let path = git(repo, &["rev-parse", "--show-toplevel"], None)
        .map_err(|e| format!("Thư mục không phải kho Git có working tree. {e}"))?;
    // Not fs::canonicalize: git rejects the \\?\ paths it returns on Windows.
    dunce::canonicalize(path.trim()).map_err(io_error)
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".."
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
pub fn create(repo: &Path, agent: &str, title: &str, run_id: &str) -> Result<Worktree, String> {
    create_at(repo, agent, title, run_id, None)
}

/// Like `create`, from a given commit instead of HEAD (a composite starts from its runs' base).
pub fn create_at(repo: &Path, agent: &str, title: &str, run_id: &str, base: Option<&str>) -> Result<Worktree, String> {
    let repo = root(repo)?;
    let target = format!("{}^{{commit}}", base.unwrap_or("HEAD"));
    let base = git(&repo, &["rev-parse", "--verify", &target], None)
        .map_err(|e| format!("Kho Git chưa có commit hợp lệ. {e}"))?.trim().to_owned();
    if !valid_segment(agent) || !valid_segment(run_id) {
        return Err("Tên agent hoặc mã lượt chạy không hợp lệ.".into());
    }
    let branch = format!("tg/{agent}/{}-{}", slugify(title), run_id.chars().take(8).collect::<String>());
    let path = repo.join(".tg/worktrees").join(run_id);
    // Parallel tasks create worktrees at once; `info/exclude` is read-modify-write.
    static CREATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = CREATE.lock().unwrap_or_else(|e| e.into_inner());
    let common = git(&repo, &["rev-parse", "--git-common-dir"], None)?;
    let exclude = repo.join(common.trim()).join("info/exclude");
    fs::create_dir_all(exclude.parent().unwrap()).map_err(io_error)?;
    let mut text = match fs::read_to_string(&exclude) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(io_error(e)),
    };
    if !text.lines().any(|line| line == ".tg/") {
        if !text.is_empty() && !text.ends_with('\n') { text.push('\n'); }
        text.push_str(".tg/\n");
        fs::write(&exclude, text).map_err(io_error)?;
    }
    let bases = repo.join(".tg/worktree-bases");
    fs::create_dir_all(&bases).map_err(io_error)?;
    git(&repo, &["worktree", "add", "-b", &branch, path.to_str().ok_or("Đường dẫn không phải UTF-8.")?, &base], None)?;
    if let Err(e) = fs::write(bases.join(run_id), &base) {
        let _ = git(&repo, &["worktree", "remove", "--force", path.to_str().unwrap()], None);
        let _ = git(&repo, &["branch", "-D", &branch], None);
        return Err(io_error(e));
    }
    Ok(Worktree { run_id: run_id.into(), path, branch, base })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub name: String,
    /// None on a detached HEAD.
    pub branch: Option<String>,
}

/// Repository root, folder name and current branch, for the title bar.
pub fn info(path: &Path) -> Result<RepoInfo, String> {
    let root = root(path)?;
    let branch = git(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"], None).ok()
        .map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(RepoInfo { root: root.to_string_lossy().into_owned(), name, branch })
}

pub fn list(repo: &Path) -> Result<Vec<Worktree>, String> {
    let repo = root(repo)?;
    let entries = git(&repo, &["worktree", "list", "--porcelain", "-z"], None)?;
    let mut result = Vec::new();
    for entry in entries.split("\0\0") {
        let fields: Vec<_> = entry.split('\0').collect();
        let Some(path) = fields.iter().find_map(|s| s.strip_prefix("worktree ")) else { continue };
        let path = PathBuf::from(path);
        if path.parent() != Some(repo.join(".tg/worktrees").as_path()) { continue; }
        let run_id = path.file_name().and_then(|s| s.to_str()).ok_or("Mã lượt chạy không hợp lệ.")?.to_owned();
        let branch = fields.iter().find_map(|s| s.strip_prefix("branch refs/heads/"))
            .ok_or("Worktree không còn gắn với nhánh.")?.to_string();
        let base = fs::read_to_string(repo.join(".tg/worktree-bases").join(&run_id)).map_err(io_error)?;
        result.push(Worktree { run_id, path, branch, base });
    }
    Ok(result)
}

/// Index and accepted-tree files of a direct run, in the repository's git dir.
pub fn direct_files(wt: &Worktree) -> Result<(PathBuf, PathBuf), String> {
    if !valid_segment(&wt.run_id) { return Err("Mã lượt chạy không hợp lệ.".into()); }
    let dir = git(&wt.path, &["rev-parse", "--git-path", "tg-direct"], None)?;
    let dir = wt.path.join(dir.trim());
    Ok((dir.join(format!("{}.index", wt.run_id)), dir.join(format!("{}.accepted", wt.run_id))))
}

/// A direct run: snapshot the folder as it is now (tracked, staged and untracked files,
/// ignoring what `.gitignore` ignores) so the review shows only what the agent changes.
/// Nothing in the folder or the user's index changes.
pub fn direct(repo: &Path, run_id: &str) -> Result<Worktree, String> {
    let repo = root(repo)?;
    git(&repo, &["rev-parse", "--verify", "HEAD^{commit}"], None).map_err(|e| format!("Kho Git chưa có commit hợp lệ. {e}"))?;
    let wt = Worktree { run_id: run_id.into(), path: repo.clone(), branch: String::new(), base: String::new() };
    let (index, accepted) = direct_files(&wt)?;
    fs::create_dir_all(index.parent().unwrap()).map_err(io_error)?;
    // Start from the user's index so only changed files are hashed again.
    let real = repo.join(git(&repo, &["rev-parse", "--git-path", "index"], None)?.trim());
    if real.exists() { fs::copy(&real, &index).map_err(io_error)?; }
    add_all_but_tg(|args| git_index(&repo, &index, args, None), &["-A"])?;
    let tree = git_index(&repo, &index, &["write-tree"], None)?.trim().to_owned();
    fs::write(&accepted, &tree).map_err(io_error)?;
    Ok(Worktree { base: tree, ..wt })
}

/// Local branches a draft can start from (the app's own `tg/...` branches left out).
pub fn branches(repo: &Path) -> Result<Vec<String>, String> {
    let out = git(repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads"], None)?;
    Ok(out.lines().map(str::trim).filter(|b| !b.is_empty() && !b.starts_with("tg/")).map(str::to_owned).collect())
}

pub fn remove(repo: &Path, wt: &Worktree, delete_branch: bool) -> Result<(), String> {
    if wt.is_direct() {
        // The user's own folder: only the app's bookkeeping files go away, never the folder.
        let (index, accepted) = direct_files(wt)?;
        for file in [index, accepted] {
            if let Err(e) = fs::remove_file(file) { if e.kind() != std::io::ErrorKind::NotFound { return Err(io_error(e)); } }
        }
        return Ok(());
    }
    if !list(repo)?.iter().any(|entry| entry == wt) {
        return Err("Worktree không thuộc kho Git này hoặc thông tin đã thay đổi.".into());
    }
    git(repo, &["worktree", "remove", "--force", wt.path.to_str().ok_or("Đường dẫn không phải UTF-8.")?], None)?;
    if delete_branch { git(repo, &["branch", "-D", &wt.branch], None)?; }
    fs::remove_file(root(repo)?.join(".tg/worktree-bases").join(&wt.run_id)).map_err(io_error)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    pub struct Repo(pub PathBuf);
    impl Repo {
        pub fn new() -> Self {
            let p = std::env::temp_dir().join(format!("tg-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            let r = Self(p);
            git(&r.0, &["init"], None).unwrap();
            git(&r.0, &["config", "user.name", "Test"], None).unwrap();
            git(&r.0, &["config", "user.email", "test@example.invalid"], None).unwrap();
            git(&r.0, &["config", "commit.gpgsign", "false"], None).unwrap();
            // Keep bytes exact whatever the machine's default is; CRLF has its own test in diff.rs.
            git(&r.0, &["config", "core.autocrlf", "false"], None).unwrap();
            fs::create_dir(r.0.join("empty-hooks")).unwrap();
            git(&r.0, &["config", "core.hooksPath", r.0.join("empty-hooks").to_str().unwrap()], None).unwrap();
            r.write("file.txt", &(1..=30).map(|i| format!("line {i}\n")).collect::<String>());
            git(&r.0, &["add", "."], None).unwrap();
            git(&r.0, &["commit", "-m", "base"], None).unwrap();
            r
        }
        pub fn write(&self, path: &str, text: &str) {
            let p = self.0.join(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        pub fn wt(&self) -> Worktree { create(&self.0, "codex", "My task", "12345678-abcd").unwrap() }
    }
    impl Drop for Repo { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test] fn slugify_handles_unicode_and_empty() {
        assert_eq!(slugify("  Hello___WORLD  "), "hello-world");
        assert_eq!(slugify("你好"), "task");
        assert!(slugify(&"a".repeat(80)).len() <= 40);
    }
    #[test] fn create_makes_branch_and_excludes_tg() {
        let r = Repo::new(); let w = r.wt();
        assert_eq!(w.branch, "tg/codex/my-task-12345678");
        assert_eq!(w.base, git(&r.0, &["rev-parse", "HEAD"], None).unwrap().trim());
        assert!(w.path.join("file.txt").exists());
        assert!(git(&r.0, &["status", "--porcelain"], None).unwrap().is_empty());
    }
    #[test] fn info_reports_root_name_and_branch() {
        let r = Repo::new();
        fs::create_dir_all(r.0.join("sub dir")).unwrap();
        let i = info(&r.0.join("sub dir")).unwrap();
        assert_eq!(PathBuf::from(&i.root), dunce::canonicalize(&r.0).unwrap());
        assert!(i.name.starts_with("tg-test-"));
        assert!(i.branch.is_some());
        let head = git(&r.0, &["rev-parse", "HEAD"], None).unwrap();
        git(&r.0, &["checkout", "--detach", head.trim()], None).unwrap();
        assert_eq!(info(&r.0).unwrap().branch, None);
        assert!(info(&std::env::temp_dir().join(format!("none-{}", uuid::Uuid::new_v4()))).is_err());
    }
    #[test] fn parallel_creates_on_one_repo_all_succeed() {
        let r = Repo::new();
        let repo = r.0.clone();
        let handles: Vec<_> = (0..6).map(|i| {
            let repo = repo.clone();
            std::thread::spawn(move || create(&repo, "claude", "Cùng một task", &format!("{i}{i}{i}{i}{i}{i}{i}{i}-run")))
        }).collect();
        let made: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        for w in &made { assert!(w.as_ref().unwrap().path.join("file.txt").exists(), "{w:?}"); }
        assert_eq!(list(&repo).unwrap().len(), 6);
        let exclude = fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| *l == ".tg/").count(), 1);
    }
    #[test] fn create_twice_keeps_one_exclude_line() {
        let r = Repo::new(); r.wt();
        create(&r.0, "codex", "second", "87654321").unwrap();
        assert_eq!(fs::read_to_string(r.0.join(".git/info/exclude")).unwrap().lines().filter(|s| *s == ".tg/").count(), 1);
    }
    #[test] fn create_rejects_non_repo_and_empty_repo() {
        let p = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&p).unwrap();
        assert!(create(&p, "codex", "a", "12345678").is_err());
        git(&p, &["init"], None).unwrap();
        assert!(create(&p, "codex", "a", "12345678").is_err());
        assert!(!p.join(".tg").exists());
        fs::remove_dir_all(p).unwrap();
    }
    #[test] fn list_and_remove_round_trip() {
        let r = Repo::new(); let w = r.wt();
        assert_eq!(list(&r.0).unwrap(), vec![w.clone()]);
        remove(&r.0, &w, true).unwrap();
        assert!(list(&r.0).unwrap().is_empty());
        assert!(git(&r.0, &["rev-parse", "--verify", &w.branch], None).is_err());
    }
    #[test] fn remove_keeps_branch_unless_asked() {
        let r = Repo::new(); let w = r.wt(); remove(&r.0, &w, false).unwrap();
        assert!(git(&r.0, &["rev-parse", "--verify", &w.branch], None).is_ok());
    }
}
