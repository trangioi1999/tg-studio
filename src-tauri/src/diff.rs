use crate::worktree::{git, Worktree};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub id: String,
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<String>,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub binary: bool,
    pub patch_header: String,
    pub hunks: Vec<Hunk>,
}

// Git quotes paths using C escapes, including octal UTF-8 bytes.
fn unquote(path: &str) -> String {
    if !path.starts_with('"') { return path.to_string(); }
    let mut out = Vec::new();
    let mut bytes = path.as_bytes()[1..].iter().copied().peekable();
    while let Some(b) = bytes.next() {
        if b == b'"' { break; }
        if b != b'\\' { out.push(b); continue; }
        let Some(b) = bytes.next() else { break };
        if (b'0'..=b'7').contains(&b) {
            let mut n = (b - b'0') as u16;
            for _ in 0..2 {
                match bytes.peek() {
                    Some(b'0'..=b'7') => n = n * 8 + (bytes.next().unwrap() - b'0') as u16,
                    _ => break,
                }
            }
            out.push(n as u8);
        } else {
            out.push(match b { b'n' => b'\n', b't' => b'\t', b'r' => b'\r', b'b' => 8, b'f' => 12, b'v' => 11, b'a' => 7, b => b });
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
fn patch_path(s: &str) -> String {
    let path = unquote(s.split('\t').next().unwrap_or(s));
    path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")).unwrap_or(&path).into()
}
fn range(s: &str) -> Option<(u32, u32)> {
    let s = s.get(1..)?;
    let (start, count) = s.split_once(',').unwrap_or((s, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}
fn hunk_id(path: &str, lines: &[String]) -> String {
    // FNV-1a, explicitly specified so IDs stay stable across process/Rust versions.
    let mut hash = 0xcbf29ce484222325u64;
    for b in path.bytes().chain(std::iter::once(0)).chain(lines.iter().flat_map(|s| s.bytes().chain(std::iter::once(b'\n')))) {
        hash = (hash ^ u64::from(b)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn parse_unified(text: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    for line in text.split_terminator('\n') {
        if let Some(paths) = line.strip_prefix("diff --git ") {
            let fallback = if paths.starts_with('"') {
                // For quoted paths, find the closing quote while respecting escapes.
                let mut escaped = false;
                let mut end = 0;
                for (i, c) in paths.char_indices().skip(1) {
                    if escaped { escaped = false; }
                    else if c == '\\' { escaped = true; }
                    else if c == '"' { end = i + 1; break; }
                }
                paths.get(end..).unwrap_or("").trim_start()
            } else { paths.rfind(" b/").map(|i| &paths[i + 1..]).unwrap_or(paths) };
            files.push(FileDiff { path: patch_path(fallback), status: "M".into(), binary: false, patch_header: format!("{line}\n"), hunks: vec![] });
            continue;
        }
        let Some(file) = files.last_mut() else { continue };
        if line.starts_with("@@ ") {
            let parts: Vec<_> = line.split_whitespace().collect();
            if let Some(((old_start, old_lines), (new_start, new_lines))) = parts.get(1).and_then(|s| range(s)).zip(parts.get(2).and_then(|s| range(s))) {
                file.hunks.push(Hunk { id: String::new(), header: line.into(), old_start, old_lines, new_start, new_lines, lines: vec![], added: 0, removed: 0 });
            }
        } else if let Some(hunk) = file.hunks.last_mut() {
            if line.starts_with([' ', '+', '-', '\\']) {
                hunk.added += u32::from(line.starts_with('+'));
                hunk.removed += u32::from(line.starts_with('-'));
                hunk.lines.push(line.into());
            }
        } else {
            file.patch_header.push_str(line); file.patch_header.push('\n');
            if line.starts_with("new file mode ") { file.status = "A".into(); }
            if line.starts_with("deleted file mode ") { file.status = "D".into(); }
            if line.starts_with("Binary files ") || line == "GIT binary patch" { file.binary = true; }
            if let Some(path) = line.strip_prefix("--- ").or_else(|| line.strip_prefix("+++ ")) {
                if path != "/dev/null" { file.path = patch_path(path); }
            }
        }
    }
    for file in &mut files {
        for hunk in &mut file.hunks { hunk.id = hunk_id(&file.path, &hunk.lines); }
    }
    files
}

pub fn pending(wt: &Worktree) -> Result<Vec<FileDiff>, String> {
    if git(&wt.path, &["rev-parse", "HEAD"], None)?.trim() != wt.base {
        git(&wt.path, &["reset", "--mixed", &wt.base], None)?;
    }
    // Without --ignore-removal, add -N stages deletions before the user approves.
    git(&wt.path, &["add", "-N", "--ignore-removal", "."], None)?;
    let patch = git(&wt.path, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3"], None)?;
    Ok(parse_unified(&patch))
}

fn selected_patch(wt: &Worktree, path: &str, id: &str) -> Result<String, String> {
    let files = pending(wt)?;
    let file = files.iter().find(|f| f.path == path).ok_or("Không tìm thấy tệp trong thay đổi đang chờ.")?;
    if file.binary { return Err("Không thể duyệt từng hunk của tệp nhị phân.".into()); }
    let matches: Vec<_> = file.hunks.iter().filter(|h| h.id == id).collect();
    if matches.len() != 1 { return Err("Hunk đã thay đổi, không tồn tại hoặc có nội dung trùng lặp; hãy tải lại diff.".into()); }
    let hunk = matches[0];
    Ok(format!("{}{}\n{}\n", file.patch_header, hunk.header, hunk.lines.join("\n")))
}

pub fn accept_hunk(repo: &Path, wt: &Worktree, path: &str, hunk_id: &str) -> Result<(), String> {
    let patch = selected_patch(wt, path, hunk_id)?;
    // Check the exact mode used below, including consistency with the user's index.
    git(repo, &["apply", "--check", "--index", "--recount"], Some(patch.as_bytes()))?;
    git(&wt.path, &["apply", "--check", "--cached", "--recount"], Some(patch.as_bytes()))?;
    git(repo, &["apply", "--index", "--recount"], Some(patch.as_bytes()))?;
    if let Err(error) = git(&wt.path, &["apply", "--cached", "--recount"], Some(patch.as_bytes())) {
        // Git has no cross-worktree transaction. Attempt rollback if the second apply fails.
        if let Err(rollback) = git(repo, &["apply", "-R", "--index", "--recount"], Some(patch.as_bytes())) {
            return Err(format!("{error}; Không hoàn tác được thay đổi đã duyệt: {rollback}"));
        }
        return Err(error);
    }
    Ok(())
}

pub fn reject_hunk(wt: &Worktree, path: &str, hunk_id: &str) -> Result<(), String> {
    let patch = selected_patch(wt, path, hunk_id)?;
    git(&wt.path, &["apply", "-R", "--recount"], Some(patch.as_bytes()))?;
    if patch.lines().any(|line| line.starts_with("new file mode ")) {
        // Reverse application deletes the file but leaves its intent-to-add entry.
        git(&wt.path, &["--literal-pathspecs", "rm", "--cached", "--", path], None)?;
    }
    Ok(())
}

pub fn commit(repo: &Path, message: &str) -> Result<String, String> {
    git(repo, &["commit", "-m", message], None)?;
    Ok(git(repo, &["rev-parse", "HEAD"], None)?.trim().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::{tests::Repo, git};
    use std::fs;
    fn change(w: &Worktree) {
        let p = w.path.join("file.txt");
        let s = fs::read_to_string(&p).unwrap().replace("line 2\n", "changed 2\n").replace("line 28\n", "changed 28\n");
        fs::write(p, s).unwrap();
    }

    #[test] fn hunk_id_ignores_line_numbers() {
        let a = parse_unified("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
        let b = parse_unified("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -20 +30 @@\n-a\n+b\n");
        assert_eq!(a[0].hunks[0].id, b[0].hunks[0].id);
    }
    #[test] fn binary_path_keeps_directory_named_b() {
        let files = parse_unified("diff --git a/b/image b/b/image\nBinary files a/b/image and b/b/image differ\n");
        assert_eq!(files[0].path, "b/image");
    }
    #[test] fn quoted_octal_paths_are_decoded() {
        let f = parse_unified("diff --git \"a/\\303\\251.txt\" \"b/\\303\\251.txt\"\n--- \"a/\\303\\251.txt\"\n+++ \"b/\\303\\251.txt\"\n@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(f[0].path, "é.txt");
    }
    #[test] fn binary_and_missing_hunk_return_errors() {
        let r = Repo::new(); let w = r.wt();
        fs::write(w.path.join("binary"), [0, 1, 2]).unwrap();
        let f = pending(&w).unwrap();
        assert!(f[0].binary);
        assert!(accept_hunk(&r.0, &w, "binary", "unknown").unwrap_err().contains("nhị phân"));
        assert!(reject_hunk(&w, "missing", "unknown").is_err());
    }
    #[test] fn no_newline_accept_and_reject() {
        for accept in [true, false] {
            let r = Repo::new(); let w = r.wt();
            fs::write(w.path.join("new.txt"), "no newline").unwrap();
            let f = pending(&w).unwrap();
            if accept {
                accept_hunk(&r.0, &w, "new.txt", &f[0].hunks[0].id).unwrap();
                assert_eq!(fs::read_to_string(r.0.join("new.txt")).unwrap(), "no newline");
            } else { reject_hunk(&w, "new.txt", &f[0].hunks[0].id).unwrap(); }
            assert!(pending(&w).unwrap().is_empty());
        }
    }
    #[test] fn index_mismatch_leaves_both_indexes_untouched() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap();
        let original = fs::read(r.0.join("file.txt")).unwrap();
        r.write("file.txt", "staged user change\n");
        git(&r.0, &["add", "file.txt"], None).unwrap();
        fs::write(r.0.join("file.txt"), &original).unwrap();
        let before = git(&r.0, &["diff", "--cached"], None).unwrap();
        let wt_before = git(&w.path, &["diff", "--cached"], None).unwrap();
        assert!(accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).is_err());
        assert_eq!(before, git(&r.0, &["diff", "--cached"], None).unwrap());
        assert_eq!(wt_before, git(&w.path, &["diff", "--cached"], None).unwrap());
        assert_eq!(fs::read(r.0.join("file.txt")).unwrap(), original);
    }
    #[test] fn parse_quoted_and_unicode_paths() {
        let f = parse_unified("diff --git \"a/a b\" \"b/a b\"\n--- \"a/a b\"\n+++ \"b/a b\"\n@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(f[0].path, "a b");
        let r = Repo::new(); let w = r.wt();
        fs::write(w.path.join("tệp.txt"), "hello\n").unwrap();
        assert_eq!(pending(&w).unwrap()[0].path, "tệp.txt");
    }
    #[test] fn parse_new_deleted_and_binary() {
        let f = parse_unified("diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x\ndiff --git a/y b/y\ndeleted file mode 100644\nBinary files a/y and /dev/null differ\n");
        assert_eq!(f[0].status, "A"); assert_eq!(f[1].status, "D"); assert!(f[1].binary);
    }
    #[test] fn parse_no_newline_marker() {
        let f = parse_unified("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");
        assert_eq!(f[0].hunks[0].lines.last().unwrap(), "\\ No newline at end of file");
        assert_eq!(f[0].hunks[0].added, 1);
    }
    #[test] fn accept_one_of_two_hunks_applies_only_that_hunk() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap(); assert_eq!(f[0].hunks.len(), 2);
        let remaining = f[0].hunks[1].id.clone();
        accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).unwrap();
        assert_eq!(pending(&w).unwrap()[0].hunks[0].id, remaining);
        let s = fs::read_to_string(r.0.join("file.txt")).unwrap();
        assert!(s.contains("changed 2\n")); assert!(s.contains("line 28\n"));
    }
    #[test] fn reject_removes_hunk_from_worktree() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap();
        reject_hunk(&w, "file.txt", &f[0].hunks[0].id).unwrap();
        assert_eq!(pending(&w).unwrap()[0].hunks.len(), 1);
    }
    #[test] fn new_file_accept_and_reject() {
        for accept in [true, false] {
            let r = Repo::new(); let w = r.wt();
            fs::write(w.path.join("new.txt"), "new\n").unwrap();
            let f = pending(&w).unwrap();
            if accept { accept_hunk(&r.0, &w, "new.txt", &f[0].hunks[0].id).unwrap(); }
            else { reject_hunk(&w, "new.txt", &f[0].hunks[0].id).unwrap(); }
            assert!(pending(&w).unwrap().is_empty());
            assert_eq!(r.0.join("new.txt").exists(), accept);
        }
    }
    #[test] fn deleted_file_accept() {
        let r = Repo::new(); let w = r.wt(); fs::remove_file(w.path.join("file.txt")).unwrap();
        let f = pending(&w).unwrap();
        accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).unwrap();
        assert!(!r.0.join("file.txt").exists()); assert!(pending(&w).unwrap().is_empty());
    }
    #[test] fn path_with_space_and_unicode_accepts() {
        let r = Repo::new(); let w = r.wt(); let path = "thư mục có dấu cách/tệp mới.txt";
        fs::create_dir_all(w.path.join("thư mục có dấu cách")).unwrap();
        fs::write(w.path.join(path), "hello\n").unwrap();
        let f = pending(&w).unwrap();
        assert_eq!(f[0].path, path);
        accept_hunk(&r.0, &w, path, &f[0].hunks[0].id).unwrap();
        assert_eq!(fs::read_to_string(r.0.join(path)).unwrap(), "hello\n");
    }
    #[test] fn accept_conflict_leaves_both_sides_untouched() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap(); r.write("file.txt", "user edit\n");
        let before = [git(&r.0, &["status", "--porcelain"], None).unwrap(), git(&w.path, &["status", "--porcelain"], None).unwrap()];
        let content = fs::read(w.path.join("file.txt")).unwrap();
        assert!(accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).is_err());
        assert_eq!(before, [git(&r.0, &["status", "--porcelain"], None).unwrap(), git(&w.path, &["status", "--porcelain"], None).unwrap()]);
        assert_eq!(fs::read(w.path.join("file.txt")).unwrap(), content);
        assert_eq!(fs::read_to_string(r.0.join("file.txt")).unwrap(), "user edit\n");
    }
    #[test] fn agent_commit_still_appears_in_pending() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        git(&w.path, &["add", "."], None).unwrap();
        git(&w.path, &["commit", "-m", "agent"], None).unwrap();
        assert_eq!(pending(&w).unwrap()[0].hunks.len(), 2);
        assert_eq!(crate::worktree::list(&r.0).unwrap()[0].base, w.base);
    }
    #[test] fn commit_only_contains_accepted_hunks() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap();
        accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).unwrap();
        r.write("untracked.txt", "keep");
        let hash = commit(&r.0, "accepted").unwrap();
        let s = git(&r.0, &["show", &format!("{hash}:file.txt")], None).unwrap();
        assert!(s.contains("changed 2\n")); assert!(s.contains("line 28\n"));
        assert!(git(&r.0, &["show", &format!("{hash}:untracked.txt")], None).is_err());
    }
}
