use serde::Serialize;
use std::{collections::HashSet, fs, io, path::{Path, PathBuf}, sync::Mutex};
use tauri::State;

#[derive(Default)]
pub struct OpenedProjects(Mutex<HashSet<PathBuf>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub root: String,
    pub name: String,
    pub branch: Option<String>,
    pub git: &'static str,
    pub adjusted: Option<&'static str>,
    /// Files a new draft will not see, because it starts from the latest commit.
    pub uncommitted: usize,
    /// Git has a name and email to commit with.
    pub git_user: bool,
}

/// What preparing Git would do, for the user to confirm.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPlan {
    /// Files the first commit would include.
    pub files: usize,
    /// Lines to add to `.gitignore`, so secrets and dependencies stay out of the commit.
    pub ignore: Vec<String>,
}

fn decode_percent(input: &str) -> String {
    let mut decoded = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                decoded.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    // Preserve invalid input instead of silently substituting filename characters.
    String::from_utf8(decoded).unwrap_or_else(|_| input.to_owned())
}

pub fn normalize_path(input: &str, home: Option<&Path>) -> PathBuf {
    let input = input.trim();
    let input = input.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
        .or_else(|| input.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(input);
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut path = match input.strip_prefix("file://") {
        Some(uri) => decode_percent(uri),
        None => input.to_owned(),
    };
    #[cfg(windows)]
    {
        path = path.replace('/', "\\");
        // A local file URI has an extra separator before the drive letter.
        if input.starts_with("file://") && path.starts_with('\\')
            && path.as_bytes().get(2) == Some(&b':') {
            path.remove(0);
        }
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            path = format!(r"\\{unc}");
        } else if let Some(plain) = path.strip_prefix(r"\\?\") {
            path = plain.to_owned();
        }
    }
    let normalized = if let Some(home) = home {
        if path == "~" {
            home.to_path_buf()
        } else if let Some(rest) = path.strip_prefix("~/") {
            home.join(rest)
        } else if cfg!(windows) && path.starts_with("~\\") {
            home.join(&path[2..])
        } else {
            PathBuf::from(&path)
        }
    } else {
        PathBuf::from(&path)
    };
    // Path components remove trailing separators without turning a root into an empty path.
    normalized.components().collect()
}

fn path_error(path: &Path, error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => format!("Đường dẫn không tồn tại: {}", path.display()),
        io::ErrorKind::PermissionDenied => format!("Không có quyền truy cập: {}", path.display()),
        _ => format!("Không truy cập được đường dẫn {}: {error}", path.display()),
    }
}

pub fn open(input: &str) -> Result<Project, String> {
    let home = crate::detect::home_dir();
    let path = normalize_path(input, home.as_deref().map(Path::new));
    let metadata = fs::metadata(&path).map_err(|e| path_error(&path, e))?;
    let is_file = metadata.is_file();
    let path = dunce::canonicalize(&path).map_err(|e| path_error(&path, e))?;
    let folder = if is_file { path.parent().unwrap_or(&path) } else { &path };
    // Check access before probing Git so missing/unreadable folders retain the right error.
    fs::read_dir(folder).map_err(|e| path_error(folder, e))?;

    let mut project = Project {
        root: folder.to_string_lossy().into_owned(),
        name: folder.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        branch: None,
        git: "none",
        adjusted: is_file.then_some("file"),
        uncommitted: 0,
        git_user: false,
    };
    if let Ok(repo) = crate::worktree::info(folder) {
        if !is_file && Path::new(&repo.root) != folder {
            project.adjusted = Some("subfolder");
        }
        project.git = if crate::worktree::git(Path::new(&repo.root), &["rev-parse", "--verify", "HEAD^{commit}"], None).is_ok() {
            "ready"
        } else {
            "no_commits"
        };
        let root = Path::new(&repo.root);
        if project.git == "ready" {
            project.uncommitted = crate::worktree::git(root, &["status", "--porcelain", "-z"], None)
                .map_or(0, |out| out.split('\0').filter(|line| !line.is_empty()).count());
        }
        project.git_user = has_identity(root);
        project.root = repo.root;
        project.name = repo.name;
        project.branch = repo.branch;
    }
    Ok(project)
}

/// Only exact roots returned by a successful open are authorized.
fn check_opened(opened: &HashSet<PathBuf>, root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    if opened.contains(&root) { Ok(root) } else { Err("Dự án này chưa được mở.".into()) }
}

impl OpenedProjects {
    fn root(&self, root: &str) -> Result<PathBuf, String> {
        let opened = self.0.lock().map_err(|_| "Không truy cập được danh sách dự án.".to_string())?;
        check_opened(&opened, root)
    }
}

fn has_identity(root: &Path) -> bool {
    let set = |key: &str| crate::worktree::git(root, &["config", key], None).is_ok_and(|v| !v.trim().is_empty());
    set("user.name") && set("user.email")
}

/// Patterns for what must never reach a first commit by accident, and how to spot it.
fn sensitive_pattern(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let name = *parts.last()?;
    if let Some(i) = parts.iter().position(|p| *p == "node_modules") {
        return Some(format!("{}/", parts[..=i].join("/")));
    }
    let secret = name == ".env" || name.starts_with(".env.") || name.ends_with(".pem") || name.ends_with(".key") || name.starts_with("id_rsa");
    secret.then(|| name.to_string())
}

/// Files Git would add, from a folder that may not be a repository yet.
fn untracked(root: &Path) -> Result<Vec<String>, String> {
    if crate::worktree::git(root, &["rev-parse", "--git-dir"], None).is_ok() {
        let out = crate::worktree::git(root, &["ls-files", "-z", "--others", "--exclude-standard"], None)?;
        return Ok(out.split('\0').filter(|p| !p.is_empty()).map(String::from).collect());
    }
    // Not a repository: `.git` does not exist, and only a real init could read `.gitignore`.
    let probe = std::env::temp_dir().join(format!("tg-git-probe-{}", uuid::Uuid::new_v4()));
    let git_dir = probe.to_string_lossy().into_owned();
    crate::worktree::git(root, &["--git-dir", &git_dir, "init", "-q"], None)?;
    let listed = crate::worktree::git(root, &["--git-dir", &git_dir, "--work-tree", ".", "ls-files", "-z", "--others", "--exclude-standard"], None);
    let _ = fs::remove_dir_all(&probe);
    Ok(listed?.split('\0').filter(|p| !p.is_empty()).map(String::from).collect())
}

pub fn plan_git(root: &Path) -> Result<GitPlan, String> {
    let files = untracked(root)?;
    let mut ignore: Vec<String> = files.iter().filter_map(|f| sensitive_pattern(f)).collect();
    ignore.sort();
    ignore.dedup();
    let kept = files.iter().filter(|f| sensitive_pattern(f).is_none()).count();
    Ok(GitPlan { files: kept, ignore })
}

/// Makes a folder usable for code tasks: a repository with a first commit. Secrets and
/// dependencies found are ignored first, so they cannot end up in the commit.
pub fn prepare_git(root: &Path, name: Option<&str>, email: Option<&str>) -> Result<Project, String> {
    let plan = plan_git(root)?;
    let git = |args: &[&str]| crate::worktree::git(root, args, None);
    if git(&["rev-parse", "--git-dir"]).is_err() { git(&["init"])?; }
    if let (Some(name), Some(email)) = (name.filter(|v| !v.trim().is_empty()), email.filter(|v| !v.trim().is_empty())) {
        git(&["config", "--local", "user.name", name.trim()])?;
        git(&["config", "--local", "user.email", email.trim()])?;
    }
    if !has_identity(root) { return Err("Git chưa có tên và email để commit. Hãy nhập cả hai.".into()); }
    if !plan.ignore.is_empty() {
        let path = root.join(".gitignore");
        let mut text = fs::read_to_string(&path).unwrap_or_default();
        if !text.is_empty() && !text.ends_with('\n') { text.push('\n'); }
        text.push_str(&plan.ignore.join("\n"));
        text.push('\n');
        fs::write(&path, text).map_err(|e| format!("Không ghi được .gitignore: {e}"))?;
    }
    git(&["add", "-A"])?;
    git(&["commit", "--allow-empty", "-m", "Khởi tạo dự án"])?;
    open(&root.to_string_lossy())
}

#[tauri::command]
pub async fn git_plan(opened: State<'_, OpenedProjects>, root: String) -> Result<GitPlan, String> {
    let root = opened.root(&root)?;
    tauri::async_runtime::spawn_blocking(move || plan_git(&root)).await.map_err(|e| format!("Không đọc được thư mục: {e}"))?
}

#[tauri::command]
pub async fn git_prepare(opened: State<'_, OpenedProjects>, root: String, name: Option<String>, email: Option<String>) -> Result<Project, String> {
    let root = opened.root(&root)?;
    let project = tauri::async_runtime::spawn_blocking(move || prepare_git(&root, name.as_deref(), email.as_deref())).await
        .map_err(|e| format!("Không chuẩn bị được Git: {e}"))??;
    opened.0.lock().map_err(|_| "Không truy cập được danh sách dự án.".to_string())?.insert(PathBuf::from(&project.root));
    Ok(project)
}

#[tauri::command]
pub async fn open_project(opened: State<'_, OpenedProjects>, path: String) -> Result<Project, String> {
    let project = tauri::async_runtime::spawn_blocking(move || open(&path)).await
        .map_err(|e| format!("Không mở được dự án: {e}"))??;
    opened.0.lock().map_err(|_| "Không truy cập được danh sách dự án.".to_string())?
        .insert(PathBuf::from(&project.root));
    Ok(project)
}

#[tauri::command]
pub async fn list_project_files(opened: State<'_, OpenedProjects>, root: String) -> Result<Vec<String>, String> {
    let root = opened.root(&root)?;
    tauri::async_runtime::spawn_blocking(move || crate::workspace::list_root(&root)).await
        .map_err(|e| format!("Không liệt kê được tệp dự án: {e}"))?
}

#[tauri::command]
pub async fn read_project_file(opened: State<'_, OpenedProjects>, root: String, path: String) -> Result<String, String> {
    let root = opened.root(&root)?;
    tauri::async_runtime::spawn_blocking(move || crate::workspace::read_root(&root, &path)).await
        .map_err(|e| format!("Không đọc được tệp dự án: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::fs;
    use crate::worktree::{git, tests::Repo};

    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tg-project-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn open_path(path: &Path) -> Project { open(path.to_str().unwrap()).unwrap() }

    fn identity(path: &Path) {
        git(path, &["config", "user.name", "Test"], None).unwrap();
        git(path, &["config", "user.email", "t@example.com"], None).unwrap();
    }

    #[test]
    fn counts_files_a_new_draft_will_not_see() {
        let repo = Repo::new();
        assert_eq!(open_path(&repo.0).uncommitted, 0);
        repo.write("moi.txt", "x");
        repo.write("file.txt", "đã sửa");
        assert_eq!(open_path(&repo.0).uncommitted, 2);
    }

    #[test]
    fn plan_lists_what_would_be_kept_out() {
        let folder = Folder::new();
        for (path, text) in [("a.txt", "x"), (".env", "SECRET"), ("cfg/.env.local", "SECRET"), ("server.pem", "k"), ("node_modules/x/i.js", "x"), ("sub/node_modules/y.js", "x")] {
            let file = folder.0.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, text).unwrap();
        }
        let plan = plan_git(&folder.0).unwrap();
        assert_eq!(plan.files, 1);
        assert_eq!(plan.ignore, vec![".env", ".env.local", "node_modules/", "server.pem", "sub/node_modules/"]);
        assert!(!folder.0.join(".git").exists(), "chỉ xem trước, chưa được khởi tạo gì");
    }

    #[test]
    fn prepare_never_commits_secrets_or_dependencies() {
        let folder = Folder::new();
        fs::write(folder.0.join("a.txt"), "x").unwrap();
        fs::write(folder.0.join(".env"), "SECRET").unwrap();
        fs::create_dir_all(folder.0.join("node_modules/x")).unwrap();
        fs::write(folder.0.join("node_modules/x/i.js"), "x").unwrap();
        let project = prepare_git(&folder.0, Some("Tên"), Some("a@b.c")).unwrap();
        assert_eq!(project.git, "ready");
        let committed = git(&folder.0, &["ls-tree", "-r", "--name-only", "HEAD"], None).unwrap();
        assert_eq!(committed.lines().collect::<Vec<_>>(), vec![".gitignore", "a.txt"]);
        assert_eq!(project.uncommitted, 0);
        assert!(project.git_user);
    }

    #[test]
    fn prepare_keeps_an_existing_gitignore_and_makes_a_first_commit() {
        let folder = Folder::new();
        git(&folder.0, &["init"], None).unwrap();
        identity(&folder.0);
        fs::write(folder.0.join(".gitignore"), "*.log").unwrap();
        fs::write(folder.0.join(".env"), "SECRET").unwrap();
        let project = prepare_git(&folder.0, None, None).unwrap();
        assert_eq!(project.git, "ready");
        assert_eq!(fs::read_to_string(folder.0.join(".gitignore")).unwrap(), "*.log\n.env\n");
    }

    #[test]
    fn prepare_empty_folder_still_gives_a_commit_to_start_from() {
        let folder = Folder::new();
        assert_eq!(prepare_git(&folder.0, Some("Tên"), Some("a@b.c")).unwrap().git, "ready");
    }

    #[test]
    fn project_root_must_have_been_opened() {
        let folder = Folder::new();
        let root = dunce::canonicalize(&folder.0).unwrap();
        let mut opened = std::collections::HashSet::new();
        assert_eq!(check_opened(&opened, root.to_str().unwrap()).unwrap_err(),
            "Dự án này chưa được mở.");
        opened.insert(root.clone());
        assert_eq!(check_opened(&opened, root.to_str().unwrap()).unwrap(), root);
        assert!(check_opened(&opened, root.join("child").to_str().unwrap()).is_err());
        let _ = OpenedProjects::default();
    }

    #[test]
    fn open_reports_each_git_state() {
        let repo = Repo::new();
        let project = open_path(&repo.0);
        assert_eq!(project.git, "ready");
        assert!(project.branch.is_some());
        assert_eq!(project.adjusted, None);
        assert_eq!(PathBuf::from(&project.root), dunce::canonicalize(&repo.0).unwrap());
        assert_eq!(project.name, repo.0.file_name().unwrap().to_str().unwrap());

        let empty_repo = Folder::new();
        git(&empty_repo.0, &["init"], None).unwrap();
        assert_eq!(open_path(&empty_repo.0).git, "no_commits");

        let folder = Folder::new();
        let project = open_path(&folder.0);
        assert_eq!(project.git, "none");
        assert_eq!(project.branch, None);
        assert_eq!(project.adjusted, None);
        assert_eq!(PathBuf::from(project.root), dunce::canonicalize(&folder.0).unwrap());
    }

    #[test]
    fn open_subfolder_uses_repo_root() {
        let repo = Repo::new();
        let subfolder = repo.0.join("subfolder");
        fs::create_dir(&subfolder).unwrap();
        let project = open_path(&subfolder);
        assert_eq!(PathBuf::from(project.root), dunce::canonicalize(&repo.0).unwrap());
        assert_eq!(project.adjusted, Some("subfolder"));
    }

    #[test]
    fn open_file_uses_its_folder() {
        let folder = Folder::new();
        let file = folder.0.join("example.txt");
        fs::write(&file, "hello").unwrap();
        let project = open_path(&file);
        assert_eq!(PathBuf::from(project.root), dunce::canonicalize(&folder.0).unwrap());
        assert_eq!(project.adjusted, Some("file"));

        let repo = Repo::new();
        repo.write("subfolder/example.txt", "hello");
        let project = open_path(&repo.0.join("subfolder/example.txt"));
        assert_eq!(PathBuf::from(project.root), dunce::canonicalize(&repo.0).unwrap());
        assert_eq!(project.adjusted, Some("file"));
    }

    #[test]
    fn open_rejects_missing_with_vietnamese_error() {
        let folder = Folder::new();
        let missing = folder.0.join("missing");
        let error = open(missing.to_str().unwrap()).unwrap_err();
        assert!(error.contains("không tồn tại"), "{error}");
        assert!(error.contains(missing.to_str().unwrap()), "{error}");
        assert!(!error.contains("Git"), "{error}");
    }

    #[test]
    fn open_handles_spaces_and_vietnamese() {
        let folder = Folder::new();
        let repo = Repo::new();
        let path = folder.0.join("thư mục có dấu cách");
        fs::rename(&repo.0, &path).unwrap();
        let project = open_path(&path);
        assert_eq!(project.git, "ready");
        assert_eq!(project.name, "thư mục có dấu cách");
        assert_eq!(PathBuf::from(project.root), dunce::canonicalize(path).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn open_rejects_unreadable_folder() {
        use std::os::unix::fs::PermissionsExt;
        let uid = crate::env::std_command("id").arg("-u").output().unwrap();
        assert!(uid.status.success());
        if String::from_utf8(uid.stdout).unwrap().trim() == "0" { return; }
        let folder = Folder::new();
        let permissions = fs::metadata(&folder.0).unwrap().permissions();
        fs::set_permissions(&folder.0, fs::Permissions::from_mode(0o000)).unwrap();
        let result = open(folder.0.to_str().unwrap());
        fs::set_permissions(&folder.0, permissions).unwrap();
        let error = result.unwrap_err();
        assert!(error.contains("quyền"), "{error}");
    }

    #[test]
    fn normalize_path_table() {
        for (input, expected) in [
            ("  /a/b  ", "/a/b"),
            ("\"/a b/c\"", "/a b/c"),
            ("'/a b/c'", "/a b/c"),
            ("/a/b/", "/a/b"),
            ("/", "/"),
            ("~", "/Users/an"),
            ("~/dự án", "/Users/an/dự án"),
            ("~khac/x", "~khac/x"),
            ("file:///a%20b/d%E1%BB%B1", "/a b/dự"),
        ] {
            assert_eq!(normalize_path(input, Some(Path::new("/Users/an"))), PathBuf::from(expected), "{input}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn normalize_path_windows_table() {
        for (input, expected) in [
            ("C:/a/b", r"C:\a\b"),
            (r"\\?\C:\a", r"C:\a"),
            (r"\\sv\share\a\", r"\\sv\share\a"),
            ("file:///C:/a%20b", r"C:\a b"),
        ] {
            assert_eq!(normalize_path(input, None).as_os_str(), std::ffi::OsStr::new(expected), "{input}");
        }
    }
}
