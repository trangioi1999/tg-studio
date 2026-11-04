//! Files of a task's worktree for the editor. Paths are relative to the worktree
//! and must stay inside it; `.git` is never readable or writable from here.

use std::{fs, path::{Component, Path, PathBuf}};

use crate::{acp::handlers::Sandbox, worktree::{self, Worktree}};

pub const MAX_FILES: usize = 5000;
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Tracked and untracked (not ignored) files that exist on disk, sorted.
pub fn list_files(wt: &Worktree) -> Result<Vec<String>, String> {
    let out = worktree::git(&wt.path, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"], None)?;
    let mut files: Vec<String> = out.split('\0')
        .filter(|p| !p.is_empty() && wt.path.join(p).is_file())
        .map(String::from)
        .collect();
    files.sort();
    files.dedup();
    files.truncate(MAX_FILES);
    Ok(files)
}

fn resolve(wt: &Worktree, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    let bad = path.is_empty() || path.contains('\0') || relative.is_absolute()
        || relative.components().any(|c| !matches!(c, Component::Normal(_)) || c.as_os_str() == ".git");
    if bad { return Err(format!("Đường dẫn không hợp lệ: {path}")); }
    let sandbox = Sandbox::new(&wt.path)?;
    sandbox.resolve(&wt.path.join(relative).to_string_lossy()).map_err(|e| e.message)
}

pub fn read_file(wt: &Worktree, path: &str) -> Result<String, String> {
    let file = resolve(wt, path)?;
    let meta = fs::metadata(&file).map_err(|e| format!("Không mở được {path}: {e}"))?;
    if !meta.is_file() { return Err(format!("{path} không phải là tệp.")); }
    if meta.len() > MAX_BYTES { return Err(format!("{path} lớn hơn 2 MB, không mở trong editor.")); }
    let bytes = fs::read(&file).map_err(|e| format!("Không đọc được {path}: {e}"))?;
    if bytes.contains(&0) { return Err(format!("{path} là tệp nhị phân, không mở trong editor.")); }
    String::from_utf8(bytes).map_err(|_| format!("{path} không phải văn bản UTF-8, không mở trong editor."))
}

/// Overwrites an existing file. New files come from the agent, not from the editor.
pub fn write_file(wt: &Worktree, path: &str, content: &str) -> Result<(), String> {
    let file = resolve(wt, path)?;
    if !file.is_file() { return Err(format!("{path} không còn trong worktree.")); }
    if content.len() as u64 > MAX_BYTES { return Err("Nội dung lớn hơn 2 MB, không lưu được.".into()); }
    fs::write(&file, content).map_err(|e| format!("Không lưu được {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{diff, worktree::tests::Repo};

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
