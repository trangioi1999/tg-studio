//! Skills library (SKILL.md) kept in the app's data folder, installable into Claude Code
//! per project (`<repo>/.claude/skills`) or per user (`~/.claude/skills`). An existing,
//! different file is backed up before it is replaced.

use std::{fs, path::{Path, PathBuf}};

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub content: String,
}

/// Where a library skill stands in one install location.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTarget {
    pub scope: String,
    pub path: String,
    /// "missing", "same" or "different".
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub path: String,
    pub backup: Option<String>,
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-') && !name.ends_with('-')
}

/// `description:` from the YAML front matter; SKILL.md needs `name` and `description`.
pub fn front_matter(content: &str) -> Result<(String, String), String> {
    let body = content.strip_prefix("---\n").or_else(|| content.strip_prefix("---\r\n")).ok_or("SKILL.md phải bắt đầu bằng front matter (---).")?;
    let end = body.find("\n---").ok_or("Thiếu dòng --- đóng front matter.")?;
    let field = |key: &str| body[..end].lines().find_map(|l| l.strip_prefix(&format!("{key}:")).map(|v| v.trim().trim_matches('"').to_string())).filter(|v| !v.is_empty());
    let name = field("name").ok_or("Front matter thiếu name.")?;
    let description = field("description").ok_or("Front matter thiếu description.")?;
    Ok((name, description))
}

fn library(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills"))
}

pub fn list_in(dir: &Path) -> Vec<Skill> {
    let mut out: Vec<Skill> = fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|entry| {
        let content = fs::read_to_string(entry.path().join("SKILL.md")).ok()?;
        let (name, description) = front_matter(&content).ok()?;
        Some(Skill { name, description, content })
    }).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn save_in(dir: &Path, content: &str) -> Result<Skill, String> {
    let (name, description) = front_matter(content)?;
    if !valid_name(&name) { return Err("name chỉ gồm chữ thường, số và -, tối đa 64 ký tự.".into()); }
    let folder = dir.join(&name);
    fs::create_dir_all(&folder).map_err(|e| format!("Không tạo được thư mục skill: {e}"))?;
    fs::write(folder.join("SKILL.md"), content).map_err(|e| format!("Không lưu được skill: {e}"))?;
    Ok(Skill { name, description, content: content.to_string() })
}

fn state(target: &Path, content: &str) -> &'static str {
    // Compare bytes: a file in another encoding is different, and must be backed up.
    match fs::read(target) {
        Ok(existing) if existing == content.as_bytes() => "same",
        Ok(_) => "different",
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "missing",
        Err(_) => "different",
    }
}

/// Writes `content` to `<root>/<name>/SKILL.md`, backing up a different existing file.
pub fn install_into(root: &Path, name: &str, content: &str, stamp: u64) -> Result<Installed, String> {
    let target = root.join(name).join("SKILL.md");
    let mut backup = None;
    if state(&target, content) == "different" {
        let copy = target.with_file_name(format!("SKILL.md.bak-{stamp}"));
        fs::copy(&target, &copy).map_err(|e| format!("Không sao lưu được bản cũ: {e}"))?;
        backup = Some(copy.to_string_lossy().into_owned());
    }
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| format!("Không tạo được thư mục: {e}"))?;
    fs::write(&target, content).map_err(|e| format!("Không ghi được {}: {e}", target.display()))?;
    Ok(Installed { path: target.to_string_lossy().into_owned(), backup })
}

fn roots(app: &AppHandle, repo: Option<&str>) -> Result<Vec<(String, PathBuf)>, String> {
    let mut roots = Vec::new();
    if let Some(repo) = repo.filter(|r| !r.trim().is_empty()) {
        let info = crate::workspace::worktree::info(Path::new(repo))?;
        roots.push(("project".to_string(), PathBuf::from(info.root).join(".claude/skills")));
    }
    roots.push(("user".to_string(), app.path().home_dir().map_err(|e| e.to_string())?.join(".claude/skills")));
    Ok(roots)
}

#[tauri::command(async)]
pub fn list_skills(app: AppHandle) -> Result<Vec<Skill>, String> {
    Ok(list_in(&library(&app)?))
}

#[tauri::command(async)]
pub fn save_skill(app: AppHandle, content: String) -> Result<Skill, String> {
    save_in(&library(&app)?, &content)
}

#[tauri::command(async)]
pub fn delete_skill(app: AppHandle, name: String) -> Result<(), String> {
    if !valid_name(&name) { return Err("Tên skill không hợp lệ.".into()); }
    fs::remove_dir_all(library(&app)?.join(name)).map_err(|e| format!("Không xóa được skill: {e}"))
}

#[tauri::command(async)]
pub fn skill_targets(app: AppHandle, name: String, repo: Option<String>) -> Result<Vec<SkillTarget>, String> {
    let skill = list_in(&library(&app)?).into_iter().find(|s| s.name == name).ok_or("Không có skill này trong thư viện.")?;
    Ok(roots(&app, repo.as_deref())?.into_iter().map(|(scope, root)| {
        let path = root.join(&name).join("SKILL.md");
        SkillTarget { state: state(&path, &skill.content).into(), path: path.to_string_lossy().into_owned(), scope }
    }).collect())
}

#[tauri::command(async)]
pub fn install_skill(app: AppHandle, name: String, scope: String, repo: Option<String>) -> Result<Installed, String> {
    let skill = list_in(&library(&app)?).into_iter().find(|s| s.name == name).ok_or("Không có skill này trong thư viện.")?;
    let (_, root) = roots(&app, repo.as_deref())?.into_iter().find(|(s, _)| *s == scope).ok_or("Chọn một repo Git để cài ở mức project.")?;
    install_into(&root, &skill.name, &skill.content, crate::system::clock::now_ms())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_file_in_another_encoding_is_backed_up_before_writing() {
        let root = std::env::temp_dir().join(format!("tg-skill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("x")).unwrap();
        let old = [0xFFu8, 0xFE, b'a', 0];
        std::fs::write(root.join("x/SKILL.md"), old).unwrap();
        let installed = super::install_into(&root, "x", "mới", 7).unwrap();
        assert_eq!(std::fs::read(installed.backup.unwrap()).unwrap(), old);
        assert_eq!(std::fs::read_to_string(root.join("x/SKILL.md")).unwrap(), "mới");
        std::fs::remove_dir_all(root).unwrap();
    }

    use super::*;

    const SKILL: &str = "---\nname: review-checklist\ndescription: \"Checklist khi review\"\n---\n\n# Review\n- test\n";

    #[test]
    fn front_matter_and_names() {
        assert_eq!(front_matter(SKILL).unwrap(), ("review-checklist".into(), "Checklist khi review".into()));
        assert!(front_matter("# no front matter").is_err());
        assert!(front_matter("---\nname: x\n---\n").unwrap_err().contains("description"));
        assert!(valid_name("a-b-1") && !valid_name("A") && !valid_name("../x") && !valid_name("-x") && !valid_name(""));
    }

    #[test]
    fn library_round_trip_and_install_with_backup() {
        let dir = std::env::temp_dir().join(format!("tg-skills-{}", uuid::Uuid::new_v4()));
        let lib = dir.join("lib");
        assert!(save_in(&lib, &SKILL.replace("review-checklist", "../evil")).is_err());
        let skill = save_in(&lib, SKILL).unwrap();
        assert_eq!(list_in(&lib), vec![skill.clone()]);
        let root = dir.join("project/.claude/skills");
        let first = install_into(&root, &skill.name, &skill.content, 1).unwrap();
        assert_eq!(first.backup, None);
        assert_eq!(state(Path::new(&first.path), &skill.content), "same");
        // Same content again: nothing to back up.
        assert_eq!(install_into(&root, &skill.name, &skill.content, 2).unwrap().backup, None);
        fs::write(&first.path, "user edits").unwrap();
        let again = install_into(&root, &skill.name, &skill.content, 3).unwrap();
        assert_eq!(fs::read_to_string(again.backup.unwrap()).unwrap(), "user edits");
        assert_eq!(fs::read_to_string(&again.path).unwrap(), SKILL);
        fs::remove_dir_all(dir).unwrap();
    }
}
