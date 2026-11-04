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
