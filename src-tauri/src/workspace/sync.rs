use crate::system::env;
use super::project::OpenedProjects;
use serde::Serialize;
use std::{io::Read, path::Path, process::Stdio, sync::mpsc, time::{Duration, Instant}};
use tauri::State;

const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const GH_REQUIRED: &str = "Cần cài và đăng nhập GitHub CLI (gh) để tạo PR.";
const MANY_REMOTES: &str = "Repo có nhiều remote nhưng không có origin. Hãy đặt upstream cho nhánh trong terminal.";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub remote: Option<String>,
    pub github: bool,
    pub gh: bool,
    pub default_branch: Option<String>,
    pub pr_url: Option<String>,
}

fn command_error(program: &str, stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if ["authentication failed", "could not read username", "permission denied"].iter().any(|s| lower.contains(s)) {
        "Git chưa đăng nhập được remote. Hãy đăng nhập git hoặc gh trong Terminal rồi thử lại.".into()
    } else {
        format!("Lệnh {program} thất bại: {}", stderr.trim())
    }
}

/// Drain both pipes concurrently; waiting for EOF also shares the deadline (a helper
/// may inherit a pipe). Kill the process group on timeout, then reap the direct child.
fn run_command(root: &Path, program: &Path, args: &[&str], timeout: Duration, timeout_error: &str) -> Result<String, String> {
    let mut cmd = env::std_command(program);
    cmd.current_dir(root).args(args).env("PATH", env::login_path())
        .env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "never")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .env("GH_PROMPT_DISABLED", "1").env("LC_ALL", "C")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Không chạy được {}: {e}", program.display()))?;
    let deadline = Instant::now() + timeout;
    let (tx, rx) = mpsc::channel();
    let pipes: Vec<Box<dyn Read + Send>> = vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    for (index, mut pipe) in pipes.into_iter().enumerate() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.read_to_end(&mut bytes).map(|_| bytes);
            let _ = tx.send((index, result));
        });
    }
    drop(tx);
    let result = (|| {
        let mut output = [Vec::new(), Vec::new()];
        for _ in 0..2 {
            let (index, bytes) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| timeout_error.to_string())?;
            output[index] = bytes.map_err(|e| format!("Không đọc được kết quả lệnh: {e}"))?;
        }
        let exit = loop {
            if let Some(exit) = child.try_wait().map_err(|e| format!("Không chờ được lệnh: {e}"))? { break exit; }
            if Instant::now() >= deadline { return Err(timeout_error.to_string()); }
            std::thread::sleep(Duration::from_millis(10));
        };
        if !exit.success() {
            return Err(command_error(&program.to_string_lossy(), &String::from_utf8_lossy(&output[1])));
        }
        String::from_utf8(std::mem::take(&mut output[0])).map_err(|e| format!("Kết quả lệnh không phải UTF-8: {e}"))
    })();
    if result.is_err() {
        #[cfg(unix)]
        let mut kill = {
            let mut c = env::std_command("kill");
            c.args(["-KILL", "--", &format!("-{}", child.id())]); c
        };
        #[cfg(windows)]
        let mut kill = {
            let mut c = env::std_command("taskkill");
            c.args(["/PID", &child.id().to_string(), "/T", "/F"]); c
        };
        #[cfg(any(unix, windows))]
        let _ = kill.env("PATH", env::login_path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        let _ = child.kill();
        let _ = child.wait();
    }
    result.map(|s| s.trim().to_string())
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let program = env::which("git").ok_or("Không tìm thấy Git trên máy.")?;
    run_command(root, &program, args, QUERY_TIMEOUT, "Đọc trạng thái Git quá lâu, đã dừng.")
}

pub fn is_github_url(url: &str) -> bool {
    if let Some(path) = url.strip_prefix("git@github.com:") { return !path.is_empty(); }
    tauri::Url::parse(url).is_ok_and(|u| {
        matches!(u.scheme(), "https" | "http" | "ssh") && u.host_str() == Some("github.com") && u.path() != "/"
    })
}

fn git_status(root: &Path) -> Result<SyncStatus, String> {
    git(root, &["rev-parse", "--git-dir"])?;
    let branch = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
    let upstream = branch.as_ref().and_then(|_| git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok());
    let (ahead, behind) = if upstream.is_some() {
        let counts = git(root, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])?;
        let counts: Vec<u32> = counts.split_whitespace().map(str::parse).collect::<Result<_, _>>()
            .map_err(|_| "Không đọc được số commit lệch với remote.".to_string())?;
        if counts.len() != 2 { return Err("Không đọc được số commit lệch với remote.".into()); }
        (counts[1], counts[0])
    } else { (0, 0) };
    let remotes = git(root, &["remote"])?;
    let names: Vec<&str> = remotes.lines().collect();
    let upstream_remote = if upstream.is_some() {
        branch.as_ref().and_then(|b| git(root, &["config", "--get", &format!("branch.{b}.remote")]).ok())
    } else { None };
    let remote = upstream_remote.or_else(|| {
        if names.contains(&"origin") { Some("origin".into()) }
        else if names.len() == 1 { Some(names[0].into()) } else { None }
    });
    let github = remote.as_ref().and_then(|r| git(root, &["remote", "get-url", "--push", r]).ok()).is_some_and(|u| is_github_url(&u));
    let default_branch = remote.as_ref().and_then(|r| {
        git(root, &["symbolic-ref", "--quiet", &format!("refs/remotes/{r}/HEAD")]).ok()
            .and_then(|v| v.strip_prefix(&format!("refs/remotes/{r}/")).map(str::to_string))
    });
    Ok(SyncStatus { branch, upstream, ahead, behind, remote, github, gh: false, default_branch, pr_url: None })
}

fn status_with_gh(root: &Path, gh: Option<&Path>) -> Result<SyncStatus, String> {
    let mut s = git_status(root)?;
    if let Some(gh) = gh {
        s.gh = run_command(root, gh, &["auth", "status"], QUERY_TIMEOUT, "Kiểm tra đăng nhập GitHub quá lâu.").is_ok();
        if s.gh && s.github {
            if let Some(branch) = &s.branch {
                s.pr_url = run_command(root, gh, &["pr", "view", branch, "--json", "url"], QUERY_TIMEOUT, "Đọc PR quá lâu.").ok()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                    .and_then(|v| v.get("url").and_then(|u| u.as_str()).filter(|u| http_url(u).is_ok()).map(str::to_string));
            }
        }
    }
    Ok(s)
}

pub fn status(root: &Path) -> Result<SyncStatus, String> {
    status_with_gh(root, env::which("gh").as_deref())
}

fn push_git(root: &Path, s: &SyncStatus) -> Result<(), String> {
    let branch = s.branch.as_deref().ok_or("HEAD đang tách rời. Hãy chọn nhánh trong Terminal trước khi push.")?;
    let remote = match s.remote.as_deref() {
        Some(remote) => remote,
        None => return Err(if git(root, &["remote"])?.lines().count() > 1 { MANY_REMOTES } else { "Repo chưa có remote để push." }.into()),
    };
    let program = env::which("git").ok_or("Không tìm thấy Git trên máy.")?;
    let args = if s.upstream.is_some() { vec!["push"] } else { vec!["push", "-u", "--", remote, branch] };
    run_command(root, &program, &args, PUSH_TIMEOUT, "Push quá 2 phút, đã dừng.")?;
    Ok(())
}

pub async fn push(root: &Path) -> Result<SyncStatus, String> {
    let root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        push_git(&root, &git_status(&root)?)?;
        status(&root)
    }).await.map_err(|e| format!("Không thực hiện được push: {e}"))?
}

fn create_pr_with_gh(root: &Path, title: &str, body: &str, gh: Option<&Path>) -> Result<String, String> {
    let gh = gh.ok_or(GH_REQUIRED)?;
    let s = status_with_gh(root, Some(gh))?;
    if !s.gh { return Err(GH_REQUIRED.into()); }
    if !s.github { return Err("Remote của dự án không phải GitHub.".into()); }
    let branch = s.branch.as_deref().ok_or("HEAD đang tách rời. Hãy chọn nhánh trong Terminal trước khi tạo PR.")?;
    if let Some(url) = s.pr_url { return Ok(url); }
    if s.default_branch.as_deref() == Some(branch) { return Err("Hãy tạo PR từ nhánh khác nhánh mặc định.".into()); }
    if title.trim().is_empty() { return Err("Hãy nhập tiêu đề PR.".into()); }
    if s.ahead > 0 || s.upstream.is_none() { push_git(root, &s)?; }
    let out = run_command(root, gh, &["pr", "create", "--title", title, "--body", body, "--head", branch], PUSH_TIMEOUT, "Tạo PR quá 2 phút, đã dừng.")?;
    out.lines().rev().map(str::trim).find(|line| http_url(line).is_ok()).map(str::to_string)
        .ok_or_else(|| "GitHub CLI không trả về đường dẫn PR.".into())
}

pub async fn create_pr(root: &Path, title: &str, body: &str) -> Result<String, String> {
    let (root, title, body) = (root.to_path_buf(), title.to_string(), body.to_string());
    tauri::async_runtime::spawn_blocking(move || create_pr_with_gh(&root, &title, &body, env::which("gh").as_deref()))
        .await.map_err(|e| format!("Không tạo được PR: {e}"))?
}

fn http_url(url: &str) -> Result<tauri::Url, String> {
    let error = "Chỉ mở được đường dẫn HTTP hoặc HTTPS hợp lệ.";
    if url.chars().any(char::is_control) { return Err(error.into()); }
    let parsed = tauri::Url::parse(url).map_err(|_| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() { return Err(error.into()); }
    Ok(parsed)
}

#[tauri::command(async)]
pub fn open_url(url: String) -> Result<(), String> {
    let url = http_url(&url)?;
    #[cfg(target_os = "macos")]
    let mut cmd = { let mut c = env::std_command("open"); c.arg(url.as_str()); c };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = { let mut c = env::std_command("xdg-open"); c.arg(url.as_str()); c };
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = env::std_command("cmd");
        // Expansion through a variable keeps URL metacharacters inside quotes;
        // /V:OFF prevents exclamation marks from triggering delayed expansion.
        c.env("TG_STUDIO_OPEN_URL", url.as_str()).args(["/D", "/V:OFF", "/C"])
            .raw_arg("start \"\" \"%TG_STUDIO_OPEN_URL%\""); c
    };
    let exit = cmd.env("PATH", env::login_path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|e| format!("Không mở được trình duyệt: {e}"))?;
    if exit.success() { Ok(()) } else { Err("Không mở được đường dẫn trong trình duyệt.".into()) }
}

#[tauri::command(async)]
pub fn git_sync_status(projects: State<OpenedProjects>, root: String) -> Result<SyncStatus, String> {
    status(&projects.root(&root)?)
}

#[tauri::command]
pub async fn git_push(projects: State<'_, OpenedProjects>, root: String) -> Result<SyncStatus, String> {
    push(&projects.root(&root)?).await
}

// Rust cannot overload the core function and command wrapper of the same name.
pub mod commands {
    use super::*;
    #[tauri::command]
    pub async fn create_pr(projects: State<'_, OpenedProjects>, root: String, title: String, body: String) -> Result<String, String> {
        super::create_pr(&projects.root(&root)?, &title, &body).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::worktree::{git, tests::Repo};
    use std::{path::Path, time::{Duration, Instant}};

    fn repo() -> Repo {
        let r = Repo::new();
        git(&r.0, &["branch", "-M", "main"], None).unwrap();
        r
    }
    fn remote(r: &Repo, name: &str) -> std::path::PathBuf {
        let bare = r.0.join(format!("{name}.git"));
        git(&r.0, &["init", "--bare", bare.to_str().unwrap()], None).unwrap();
        git(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"], None).unwrap();
        git(&r.0, &["remote", "add", name, bare.to_str().unwrap()], None).unwrap();
        bare
    }
    fn commit(root: &Path) {
        git(root, &["commit", "--allow-empty", "-m", "local"], None).unwrap();
    }
    #[test]
    fn status_without_remote() {
        let r = repo();
        let s = status(&r.0).unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.remote, None);
        assert_eq!(s.upstream, None);
    }
    #[test]
    fn status_counts_ahead_after_local_commit() {
        let r = repo();
        let bare = remote(&r, "origin");
        git(&r.0, &["push", "-u", "origin", "main"], None).unwrap();
        let clone = r.0.join("clone");
        git(&r.0, &["clone", "-b", "main", bare.to_str().unwrap(), clone.to_str().unwrap()], None).unwrap();
        for (key, value) in [("user.name", "Test"), ("user.email", "test@example.invalid"), ("commit.gpgsign", "false")] {
            git(&clone, &["config", key, value], None).unwrap();
        }
        commit(&clone); commit(&clone);
        let s = status(&clone).unwrap();
        assert_eq!((s.ahead, s.behind), (2, 0));
        assert_eq!(s.default_branch.as_deref(), Some("main"));
    }
    #[tokio::test]
    async fn push_sets_upstream_on_first_push() {
        let r = repo();
        let bare = remote(&r, "origin");
        git(&r.0, &["checkout", "-b", "feature/test"], None).unwrap();
        let s = push(&r.0).await.unwrap();
        assert_eq!(s.upstream.as_deref(), Some("origin/feature/test"));
        assert_eq!(s.ahead, 0);
        assert!(git(&bare, &["rev-parse", "--verify", "refs/heads/feature/test"], None).is_ok());
    }
    #[tokio::test]
    async fn push_without_remote_errors() {
        assert!(push(&repo().0).await.unwrap_err().contains("chưa có remote"));
    }
    #[tokio::test]
    async fn push_with_many_remotes_and_no_origin_errors() {
        let r = repo(); remote(&r, "a"); remote(&r, "b");
        assert!(push(&r.0).await.unwrap_err().contains("không có origin"));
    }
    #[tokio::test]
    async fn push_never_waits_for_credentials() {
        let r = repo();
        git(&r.0, &["remote", "add", "origin", "https://127.0.0.1:9/x.git"], None).unwrap();
        let start = Instant::now();
        assert!(push(&r.0).await.is_err());
        assert!(start.elapsed() < Duration::from_secs(30));
    }
    #[test]
    fn github_urls() {
        for url in ["https://github.com/a/b.git", "git@github.com:a/b.git", "ssh://git@github.com/a/b"] {
            assert!(is_github_url(url), "{url}");
        }
        for url in ["https://gitlab.com/a/b.git", "https://github.com.evil/a/b", "https://github.com@evil/a/b", "file:///github.com/a"] {
            assert!(!is_github_url(url), "{url}");
        }
    }
    #[test]
    fn open_url_rejects_non_http() {
        for url in ["file:///etc/passwd", "javascript:alert(1)", "https://", "https://example.com/\n"] {
            assert!(open_url(url.into()).is_err());
        }
    }
    #[tokio::test]
    async fn detached_head_cannot_push() {
        let r = repo(); remote(&r, "origin");
        git(&r.0, &["checkout", "--detach"], None).unwrap();
        assert_eq!(status(&r.0).unwrap().branch, None);
        assert!(push(&r.0).await.unwrap_err().contains("tách rời"));
    }
    #[tokio::test]
    async fn upstream_remote_takes_precedence() {
        let r = repo(); remote(&r, "origin"); remote(&r, "other");
        git(&r.0, &["push", "-u", "other", "main"], None).unwrap();
        commit(&r.0);
        assert_eq!(status(&r.0).unwrap().remote.as_deref(), Some("other"));
        assert_eq!(push(&r.0).await.unwrap().ahead, 0);
    }
    #[test]
    fn authentication_errors_are_actionable() {
        for stderr in ["Authentication failed", "fatal: could not read Username", "Permission denied (publickey)"] {
            assert_eq!(command_error("Git", stderr), "Git chưa đăng nhập được remote. Hãy đăng nhập git hoặc gh trong Terminal rồi thử lại.");
        }
    }
    #[cfg(unix)]
    #[test]
    fn commands_have_no_prompt_and_are_bounded() {
        let root = std::env::temp_dir();
        let out = run_command(&root, Path::new("/bin/sh"), &["-c", "printf '%s/%s' \"$GIT_TERMINAL_PROMPT\" \"$GCM_INTERACTIVE\""], Duration::from_secs(2), "hết giờ").unwrap();
        assert_eq!(out, "0/never");
        let start = Instant::now();
        let error = run_command(&root, Path::new("/bin/sh"), &["-c", "exec sleep 5"], Duration::from_millis(100), "hết giờ").unwrap_err();
        assert_eq!(error, "hết giờ");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn gh_status_and_create_pr_keep_arguments_literal() {
        use std::os::unix::fs::PermissionsExt;
        let r = repo();
        git(&r.0, &["remote", "add", "origin", "git@github.com:owner/repo.git"], None).unwrap();
        git(&r.0, &["update-ref", "refs/remotes/origin/main", "HEAD"], None).unwrap();
        git(&r.0, &["branch", "--set-upstream-to", "origin/main"], None).unwrap();
        let gh = r.0.join("fake-gh");
        std::fs::write(&gh, r#"#!/bin/sh
case "$1 $2" in
  'auth status') exit 0 ;;
  'pr view') printf '%s' '{"url":"https://github.com/owner/repo/pull/1"}' ;;
  'pr create') printf '%s\n' "$@" > args.txt; printf 'Created\nhttps://github.com/owner/repo/pull/2\n' ;;
  *) exit 1 ;;
esac
"#).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
        let s = status_with_gh(&r.0, Some(&gh)).unwrap();
        assert!(s.gh && s.github);
        assert_eq!(s.pr_url.as_deref(), Some("https://github.com/owner/repo/pull/1"));
        // Remove the existing-PR response to exercise creation.
        let script = std::fs::read_to_string(&gh).unwrap().replace("printf '%s' '{\"url\":\"https://github.com/owner/repo/pull/1\"}'", "exit 1");
        std::fs::write(&gh, script).unwrap();
        let url = create_pr_with_gh(&r.0, "title $(literal)", "body\nsecond line", Some(&gh)).unwrap();
        assert_eq!(url, "https://github.com/owner/repo/pull/2");
        assert_eq!(std::fs::read_to_string(r.0.join("args.txt")).unwrap(), "pr\ncreate\n--title\ntitle $(literal)\n--body\nbody\nsecond line\n--head\nmain\n");
        assert!(create_pr_with_gh(&r.0, "t", "b", None).unwrap_err().contains("Cần cài và đăng nhập"));
    }

}
