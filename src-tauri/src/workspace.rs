//! Files of a project or task worktree for the editor. Paths are relative to the root
//! and must stay inside it; `.git` is never readable or writable from here.

use std::{fs, path::{Component, Path, PathBuf}};

use crate::{acp::handlers::Sandbox, worktree::{self, Worktree}};

pub const MAX_FILES: usize = 5000;
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Tracked and untracked (not ignored) files that exist on disk, sorted.
pub fn list_files(wt: &Worktree) -> Result<Vec<String>, String> {
    list_git(&wt.path)
}

fn list_git(root: &Path) -> Result<Vec<String>, String> {
    let out = worktree::git(root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"], None)?;
    let files: Vec<String> = out.split('\0')
        .filter(|p| !p.is_empty() && root.join(p).is_file())
        .map(String::from)
        .collect();
    Ok(finish_listing(files))
}

fn finish_listing(mut files: Vec<String>) -> Vec<String> {
    files.sort();
    files.dedup();
    files.truncate(MAX_FILES);
    files
}

/// List source files in Git (including an unborn repository) or an ordinary folder.
pub fn list_root(root: &Path) -> Result<Vec<String>, String> {
    if worktree::git(root, &["rev-parse", "--git-dir"], None).is_ok() {
        return list_git(root);
    }
    let entries = fs::read_dir(root).map_err(|e| format!("Không đọc được thư mục {}: {e}", root.display()))?;
    let mut files = Vec::new();
    let mut pending = vec![(entries, String::new())];
    while let Some((entries, prefix)) = pending.pop() {
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if kind.is_dir() {
                if matches!(name.as_str(), ".git" | "node_modules" | ".tg" | "target" | "dist") {
                    continue;
                }
                // Unreadable children must not prevent browsing the rest of the project.
                if let Ok(children) = fs::read_dir(entry.path()) {
                    pending.push((children, relative));
                }
            } else if kind.is_file() {
                files.push(relative);
            }
            // file_type does not follow symlinks, including links to directories.
        }
    }
    Ok(finish_listing(files))
}

fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    let bad = path.is_empty() || path.contains('\0') || relative.is_absolute()
        || relative.components().any(|c| !matches!(c, Component::Normal(_)) || c.as_os_str() == ".git");
    if bad { return Err(format!("Đường dẫn không hợp lệ: {path}")); }
    let sandbox = Sandbox::new(root)?;
    sandbox.resolve(&root.join(relative).to_string_lossy()).map_err(|e| e.message)
}

pub fn read_file(wt: &Worktree, path: &str) -> Result<String, String> {
    read_root(&wt.path, path)
}

pub fn read_root(root: &Path, path: &str) -> Result<String, String> {
    let file = resolve(root, path)?;
    let meta = fs::metadata(&file).map_err(|e| format!("Không mở được {path}: {e}"))?;
    if !meta.is_file() { return Err(format!("{path} không phải là tệp.")); }
    if meta.len() > MAX_BYTES { return Err(format!("{path} lớn hơn 2 MB, không mở trong editor.")); }
    let bytes = fs::read(&file).map_err(|e| format!("Không đọc được {path}: {e}"))?;
    if bytes.contains(&0) { return Err(format!("{path} là tệp nhị phân, không mở trong editor.")); }
    String::from_utf8(bytes).map_err(|_| format!("{path} không phải văn bản UTF-8, không mở trong editor."))
}

/// Overwrites an existing file. New files come from the agent, not from the editor.
pub fn write_file(wt: &Worktree, path: &str, content: &str) -> Result<(), String> {
    let file = resolve(&wt.path, path)?;
    if !file.is_file() { return Err(format!("{path} không còn trong worktree.")); }
    if content.len() as u64 > MAX_BYTES { return Err("Nội dung lớn hơn 2 MB, không lưu được.".into()); }
    fs::write(&file, content).map_err(|e| format!("Không lưu được {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{diff, worktree::tests::Repo};

    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tg-source-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, path: &str, content: &[u8]) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn root_lists_git_with_and_without_commits() {
        for committed in [false, true] {
            let folder = Folder::new();
            worktree::git(&folder.0, &["init"], None).unwrap();
            folder.write(".gitignore", b"*.log\n");
            folder.write("gone.txt", b"x");
            worktree::git(&folder.0, &["add", "."], None).unwrap();
            if committed {
                worktree::git(&folder.0, &["-c", "user.name=Test", "-c", "user.email=test@example.com",
                    "commit", "-m", "initial"], None).unwrap();
            }
            fs::remove_file(folder.0.join("gone.txt")).unwrap();
            folder.write("debug.log", b"ignored");
            folder.write("thư mục có dấu cách/tệp mới.txt", b"hello");
            assert_eq!(list_root(&folder.0).unwrap(),
                vec![".gitignore", "thư mục có dấu cách/tệp mới.txt"]);
        }
    }

    #[test]
    fn root_walk_skips_generated_and_git_directories() {
        let folder = Folder::new();
        for dir in [".git", "node_modules", ".tg", "target", "dist", "nested/node_modules"] {
            folder.write(&format!("{dir}/hidden.txt"), b"x");
        }
        folder.write("z.txt", b"z");
        folder.write("thư mục/a.txt", b"a");
        assert_eq!(list_root(&folder.0).unwrap(), vec!["thư mục/a.txt", "z.txt"]);
    }

    #[test]
    fn root_read_checks_paths_and_content() {
        let folder = Folder::new();
        folder.write("hello.txt", "Xin chào".as_bytes());
        assert_eq!(read_root(&folder.0, "hello.txt").unwrap(), "Xin chào");
        for path in ["", "../x", ".git/config", "./hello.txt", folder.0.to_str().unwrap()] {
            assert!(read_root(&folder.0, path).is_err(), "{path}");
        }
        for (path, bytes, message) in [
            ("binary", vec![0], "nhị phân"),
            ("invalid", vec![0xff], "UTF-8"),
            ("large", vec![b'a'; MAX_BYTES as usize + 1], "2 MB"),
        ] {
            folder.write(path, &bytes);
            assert!(read_root(&folder.0, path).unwrap_err().contains(message));
        }
    }

    #[cfg(unix)]
    #[test]
    fn root_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let folder = Folder::new();
        let outside = Folder::new();
        outside.write("secret", b"secret");
        folder.write("real/file.txt", b"hello");
        symlink(&outside.0, folder.0.join("outside")).unwrap();
        symlink(outside.0.join("secret"), folder.0.join("secret")).unwrap();
        symlink(folder.0.join("real"), folder.0.join("inside")).unwrap();
        symlink(&folder.0, folder.0.join("cycle")).unwrap();
        assert_eq!(list_root(&folder.0).unwrap(), vec!["real/file.txt"]);
        assert!(read_root(&folder.0, "secret").is_err());
        assert!(read_root(&folder.0, "outside/secret").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn root_walk_skips_unreadable_subdirectory() {
        use std::os::unix::fs::PermissionsExt;
        let folder = Folder::new();
        folder.write("blocked/secret", b"secret");
        folder.write("visible", b"ok");
        let blocked = folder.0.join("blocked");
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = fs::read_dir(&blocked).is_err();
        let result = list_root(&folder.0);
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();
        if unreadable { assert_eq!(result.unwrap(), vec!["visible"]); }
        else { assert!(result.is_ok()); }
    }

    #[test]
    fn root_listing_is_sorted_and_capped() {
        let folder = Folder::new();
        for i in (0..MAX_FILES + 2).rev() {
            folder.write(&format!("{i:05}.txt"), b"");
        }
        let files = list_root(&folder.0).unwrap();
        assert_eq!(files.len(), MAX_FILES);
        assert_eq!(files.first().unwrap(), "00000.txt");
        assert_eq!(files.last().unwrap(), &format!("{:05}.txt", MAX_FILES - 1));
    }

    #[test]
    fn lists_tracked_and_untracked_but_not_ignored_or_deleted() {
        let repo = Repo::new();
        repo.write(".gitignore", "*.log\n");
        repo.write("gone.txt", "x\n");
        worktree::git(&repo.0, &["add", "."], None).unwrap();
        worktree::git(&repo.0, &["commit", "-m", "more"], None).unwrap();
        let wt = repo.wt();
        fs::write(wt.path.join("debug.log"), "x").unwrap();
        fs::create_dir_all(wt.path.join("thư mục có dấu cách")).unwrap();
        fs::write(wt.path.join("thư mục có dấu cách/tệp mới.txt"), "x").unwrap();
        fs::remove_file(wt.path.join("gone.txt")).unwrap();
        let files = list_files(&wt).unwrap();
        assert_eq!(files, vec![".gitignore", "file.txt", "thư mục có dấu cách/tệp mới.txt"]);
    }

    #[test]
    fn read_write_round_trip_shows_up_in_pending_diff() {
        let repo = Repo::new();
        let wt = repo.wt();
        let text = read_file(&wt, "file.txt").unwrap();
        write_file(&wt, "file.txt", &text.replace("line 3\n", "dòng ba\n")).unwrap();
        let pending = diff::pending(&wt).unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].hunks[0].lines.contains(&"+dòng ba".to_string()));
        // The user's repo is untouched until the hunk is accepted.
        assert!(fs::read_to_string(repo.0.join("file.txt")).unwrap().contains("line 3\n"));
    }

    #[test]
    fn rejects_escapes_git_dir_and_missing_files() {
        let repo = Repo::new();
        let wt = repo.wt();
        let outside = repo.0.join("file.txt");
        for path in ["", "../file.txt", "a/../../file.txt", ".git/config", "./file.txt", outside.to_str().unwrap()] {
            assert!(read_file(&wt, path).is_err(), "{path}");
            assert!(write_file(&wt, path, "x").is_err(), "{path}");
        }
        assert!(write_file(&wt, "new.txt", "x").is_err());
        assert!(!wt.path.join("new.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_out_of_worktree() {
        let repo = Repo::new();
        let wt = repo.wt();
        std::os::unix::fs::symlink(repo.0.join("file.txt"), wt.path.join("link.txt")).unwrap();
        assert!(read_file(&wt, "link.txt").is_err());
        assert!(write_file(&wt, "link.txt", "x").is_err());
        assert!(fs::read_to_string(repo.0.join("file.txt")).unwrap().starts_with("line 1"));
    }

    #[test]
    fn binary_large_and_non_utf8_files_are_refused() {
        let repo = Repo::new();
        let wt = repo.wt();
        fs::write(wt.path.join("bin.dat"), [1u8, 0, 2]).unwrap();
        fs::write(wt.path.join("latin1.txt"), [0xE9u8, b'\n']).unwrap();
        fs::write(wt.path.join("big.txt"), vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        assert!(read_file(&wt, "bin.dat").unwrap_err().contains("nhị phân"));
        assert!(read_file(&wt, "latin1.txt").unwrap_err().contains("UTF-8"));
        assert!(read_file(&wt, "big.txt").unwrap_err().contains("2 MB"));
    }
}
