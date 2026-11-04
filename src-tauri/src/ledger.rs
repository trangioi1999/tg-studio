//! Usage ledger, price history, app settings and file export for the Usage screen.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::store::{PriceRow, Store, UsageRow};

/// Settings the UI may read and write. Anything else is refused.
const SETTING_KEYS: [&str; 2] = ["budgets", "bridge"];

#[tauri::command]
pub fn usage_report(store: State<'_, Store>, since: u64) -> Result<Vec<UsageRow>, String> {
    store.usage_rows(since).map_err(|e| format!("Không đọc được dữ liệu usage: {e}"))
}

#[tauri::command]
pub fn list_prices(store: State<'_, Store>) -> Result<Vec<PriceRow>, String> {
    store.prices().map_err(|e| format!("Không đọc được bảng giá: {e}"))
}

#[tauri::command]
pub fn add_price(store: State<'_, Store>, price: PriceRow) -> Result<(), String> {
    store.add_price(&price).map_err(|_| "Giá phải là số không âm.".to_string())
}

#[tauri::command]
pub fn get_setting(store: State<'_, Store>, key: String) -> Result<Option<String>, String> {
    if !SETTING_KEYS.contains(&key.as_str()) { return Err(format!("Không có cài đặt {key}.")); }
    store.setting(&key).map_err(|e| format!("Không đọc được cài đặt: {e}"))
}

#[tauri::command]
pub fn set_setting(store: State<'_, Store>, key: String, value: String) -> Result<(), String> {
    if !SETTING_KEYS.contains(&key.as_str()) { return Err(format!("Không có cài đặt {key}.")); }
    serde_json::from_str::<serde_json::Value>(&value).map_err(|_| "Cài đặt phải là JSON hợp lệ.".to_string())?;
    store.set_setting(&key, &value).map_err(|e| format!("Không lưu được cài đặt: {e}"))
}

/// Writes an export into the Downloads folder (home if there is none) and returns its path.
#[tauri::command]
pub fn save_export(app: AppHandle, name: String, content: String) -> Result<String, String> {
    let dir = app.path().download_dir().or_else(|_| app.path().home_dir()).map_err(|e| format!("Không tìm thấy thư mục để lưu: {e}"))?;
    let path = free_path(&dir, &name)?;
    std::fs::write(&path, content).map_err(|e| format!("Không lưu được {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// A safe file name in `dir` that does not overwrite anything: `name`, `name (2)`, ...
fn free_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' }).collect();
    let clean = clean.trim_matches(|c| c == '.' || c == '-');
    if clean.is_empty() { return Err("Tên tệp không hợp lệ.".into()); }
    let (stem, ext) = match clean.rsplit_once('.') { Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")), _ => (clean.to_string(), String::new()) };
    (1..1000).map(|i| dir.join(if i == 1 { format!("{stem}{ext}") } else { format!("{stem} ({i}){ext}") }))
        .find(|p| !p.exists()).ok_or_else(|| "Không tìm được tên tệp trống.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_names_are_sanitized_and_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("tg-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = free_path(&dir, "../usage 2026/11.csv").unwrap();
        assert_eq!(first.parent().unwrap(), dir);
        assert_eq!(first.file_name().unwrap(), "usage-2026-11.csv");
        std::fs::write(&first, "x").unwrap();
        assert_eq!(free_path(&dir, "usage-2026-11.csv").unwrap().file_name().unwrap(), "usage-2026-11 (2).csv");
        assert!(free_path(&dir, "../..").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
