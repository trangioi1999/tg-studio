//! Files the user attaches to a message (a pasted screenshot, a log, a spec).
//!
//! The UI saves each one here first and appends a line `📎 <path>` per file to the
//! message. The message stays plain text everywhere it already goes (history, recaps,
//! pipelines, sub-agents); each agent turn then adds what that agent can take: images
//! inline, small text files embedded, everything else as the path it can open itself.
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// What starts one attachment line.
pub const MARK: &str = "📎 ";
const MAX_SAVE: usize = 25 * 1024 * 1024;
/// Claude refuses larger images; the path still reaches the agent.
const MAX_IMAGE: u64 = 5 * 1024 * 1024;
const MAX_TEXT: u64 = 256 * 1024;

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where attachments live (`<app data>/attachments`). Set once at startup.
pub fn init(dir: PathBuf) { let _ = DIR.set(dir); }

fn dir() -> Result<&'static PathBuf, String> { DIR.get().ok_or_else(|| "Chưa có thư mục lưu tệp đính kèm.".to_string()) }

/// The message without its attachment lines, and the files those lines name.
pub fn split(text: &str) -> (String, Vec<PathBuf>) {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    let mut cut = lines.len();
    while cut > 0 && lines[cut - 1].starts_with(MARK) { cut -= 1; }
    let files = lines[cut..].iter().map(|l| PathBuf::from(l[MARK.len()..].trim())).collect();
    (lines[..cut].join("\n").trim_end().to_string(), files)
}

/// Only files the app saved itself are read and sent; a path typed into a message is not.
fn saved(path: &Path, root: &Path) -> Option<PathBuf> {
    let real = dunce::canonicalize(path).ok()?;
    let root = dunce::canonicalize(root).ok()?;
    (real.starts_with(&root) && real.is_file()).then_some(real)
}

fn image_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

enum Part { Image { mime: &'static str, data: String }, Text { path: PathBuf, text: String } }

fn parts(text: &str, root: Option<&Path>) -> Vec<Part> {
    let Some(root) = root else { return vec![] };
    split(text).1.iter().filter_map(|p| saved(p, root)).filter_map(|path| {
        let size = std::fs::metadata(&path).ok()?.len();
        if let Some(mime) = image_type(&path) {
            if size > MAX_IMAGE { return None; }
            let bytes = std::fs::read(&path).ok()?;
            return Some(Part::Image { mime, data: base64::engine::general_purpose::STANDARD.encode(bytes) });
        }
        if size > MAX_TEXT { return None; }
        let text = String::from_utf8(std::fs::read(&path).ok()?).ok().filter(|t| !t.contains('\0'))?;
        Some(Part::Text { path, text })
    }).collect()
}

fn file_uri(path: &Path) -> String {
    let p = path.to_string_lossy().replace('\\', "/");
    if p.starts_with('/') { format!("file://{p}") } else { format!("file:///{p}") }
}

/// The `session/prompt` content for an ACP agent, by what it said it accepts
/// (`promptCapabilities` from `initialize`).
pub fn acp_prompt(text: &str, caps: &Value) -> Vec<Value> {
    acp_prompt_in(text, caps, DIR.get().map(PathBuf::as_path))
}

fn acp_prompt_in(text: &str, caps: &Value, root: Option<&Path>) -> Vec<Value> {
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for part in parts(text, root) {
        match part {
            Part::Image { mime, data } if caps["image"] == true => blocks.push(json!({ "type": "image", "mimeType": mime, "data": data })),
            Part::Text { path, text } if caps["embeddedContext"] == true => blocks.push(json!({
                "type": "resource", "resource": { "uri": file_uri(&path), "mimeType": "text/plain", "text": text },
            })),
            _ => {}
        }
    }
    blocks
}

/// The `content` of a user message for Claude's stream-json input: the text alone when
/// nothing is attached, as before.
pub fn claude_content(text: &str) -> Value { claude_content_in(text, DIR.get().map(PathBuf::as_path)) }

fn claude_content_in(text: &str, root: Option<&Path>) -> Value {
    let parts = parts(text, root);
    if parts.is_empty() { return json!(text); }
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for part in parts {
        blocks.push(match part {
            Part::Image { mime, data } => json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": data } }),
            Part::Text { path, text } => json!({ "type": "text", "text": format!("<file path=\"{}\">\n{text}\n</file>", path.display()) }),
        });
    }
    Value::Array(blocks)
}

/// A name safe on every file system, keeping the extension.
fn safe_name(name: &str) -> String {
    let base = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("");
    let clean: String = base.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c }).collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "tep".into() } else { clean.chars().take(120).collect() }
}

fn save_in(root: &Path, name: &str, data: &str) -> Result<PathBuf, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "Tệp đính kèm hỏng.".to_string())?;
    if bytes.len() > MAX_SAVE { return Err(format!("Tệp {name} quá lớn (tối đa 25 MB).")); }
    let folder = root.join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&folder).map_err(|e| format!("Không lưu được tệp đính kèm: {e}"))?;
    let path = folder.join(safe_name(name));
    std::fs::write(&path, bytes).map_err(|e| format!("Không lưu được tệp đính kèm: {e}"))?;
    Ok(path)
}

fn read_in(root: &Path, path: &str) -> Result<String, String> {
    let path = saved(Path::new(path), root).ok_or("Không tìm thấy tệp đính kèm.")?;
    let mime = image_type(&path).ok_or("Tệp đính kèm không phải ảnh.")?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Không đọc được tệp đính kèm: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Saves one attached file (base64) and returns its full path for the message.
#[tauri::command]
pub fn save_attachment(name: String, data: String) -> Result<String, String> {
    save_in(dir()?, &name, &data).map(|p| p.to_string_lossy().into_owned())
}

/// An attached image as a data URL, for its preview in the conversation.
#[tauri::command]
pub fn read_attachment(path: String) -> Result<String, String> { read_in(dir()?, &path) }

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tg-attach-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn b64(bytes: &[u8]) -> String { base64::engine::general_purpose::STANDARD.encode(bytes) }

    #[test]
    fn attachment_lines_are_split_from_the_end_only() {
        let (body, files) = split("Sửa lỗi này\n📎 ở giữa vẫn là chữ\nthêm\n\n📎 /a/b.png\n📎 /a/c.log\n");
        assert_eq!(body, "Sửa lỗi này\n📎 ở giữa vẫn là chữ\nthêm");
        assert_eq!(files, [PathBuf::from("/a/b.png"), PathBuf::from("/a/c.log")]);
        assert_eq!(split("chỉ chữ"), ("chỉ chữ".to_string(), vec![]));
        assert_eq!(split("📎 /x.png").0, "");
    }

    #[test]
    fn saved_files_become_image_and_text_blocks() {
        let root = root();
        let png = save_in(&root, "chụp màn hình.png", &b64(b"\x89PNG fake")).unwrap();
        let log = save_in(&root, "../../lỗi.log", &b64("dòng 1\ndòng 2".as_bytes())).unwrap();
        assert!(log.starts_with(&root) && log.file_name().unwrap() == "lỗi.log", "{log:?}");
        let zip = save_in(&root, "a.zip", &b64(&[0, 1, 2])).unwrap();
        let text = format!("Sửa giao diện\n\n{MARK}{}\n{MARK}{}\n{MARK}{}", png.display(), log.display(), zip.display());

        let all = json!({ "image": true, "embeddedContext": true });
        let blocks = acp_prompt_in(&text, &all, Some(&root));
        assert_eq!(blocks.len(), 3, "{blocks:?}");
        assert_eq!(blocks[0]["text"], text);
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["mimeType"], "image/png");
        assert_eq!(blocks[1]["data"], b64(b"\x89PNG fake"));
        assert_eq!(blocks[2]["resource"]["text"], "dòng 1\ndòng 2");
        // An agent that takes neither still gets every path in the text.
        assert_eq!(acp_prompt_in(&text, &json!({}), Some(&root)).len(), 1);

        let content = claude_content_in(&text, Some(&root));
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert!(content[2]["text"].as_str().unwrap().contains("dòng 2"));
        assert_eq!(content.as_array().unwrap().len(), 3);
        assert_eq!(claude_content_in("chỉ chữ", Some(&root)), json!("chỉ chữ"));

        assert!(read_in(&root, &png.to_string_lossy()).unwrap().starts_with("data:image/png;base64,"));
        assert!(read_in(&root, &log.to_string_lossy()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn files_outside_the_attachments_folder_are_never_read() {
        let root = root();
        let outside = std::env::temp_dir().join(format!("tg-secret-{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&outside, b"secret").unwrap();
        let text = format!("xem\n{MARK}{}", outside.display());
        assert_eq!(acp_prompt_in(&text, &json!({ "image": true }), Some(&root)).len(), 1);
        assert_eq!(claude_content_in(&text, Some(&root)), json!(text));
        assert!(read_in(&root, &outside.to_string_lossy()).is_err());
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
