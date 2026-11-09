//! The app's own version, and the newest one published: the `vX.Y.Z` tags of the public
//! repository, read with `git ls-remote` (git is already required; no HTTP client needed).

use std::{process::Stdio, time::Duration};

use serde::Serialize;

use crate::env;

pub const REPO: &str = "https://github.com/trangioi1999/tg-studio.git";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
    pub version: String,
    /// Short commit the build came from, `-dirty` with uncommitted changes, so two builds
    /// with the same version can still be told apart.
    pub commit: String,
    /// When the build script last ran (epoch ms), 0 if unknown.
    pub built_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    pub latest: String,
    /// The published version is newer than this build.
    pub newer: bool,
}

pub fn current() -> AppVersion {
    AppVersion {
        version: env!("CARGO_PKG_VERSION").into(),
        commit: env!("TG_BUILD_COMMIT").into(),
        built_at: env!("TG_BUILT_AT").parse().unwrap_or(0),
    }
}

#[tauri::command]
pub fn app_version() -> AppVersion {
    current()
}

#[tauri::command]
pub async fn latest_version() -> Result<LatestVersion, String> {
    let run = env::command("git")
        .args(["ls-remote", "--tags", "--refs", REPO])
        .env("PATH", env::login_path())
        // A repo that turned private must fail, not wait for a password.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(15), run).await
        .map_err(|_| "Không kết nối được GitHub để kiểm tra bản mới.".to_string())?
        .map_err(|e| format!("Không chạy được Git: {e}"))?;
    if !out.status.success() {
        return Err(format!("Không đọc được danh sách phiên bản: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let latest = newest(&String::from_utf8_lossy(&out.stdout)).ok_or("Chưa có phiên bản nào được phát hành.")?;
    Ok(compare(env!("CARGO_PKG_VERSION"), latest))
}

/// `1.2.3` (a leading `v` allowed); pre-releases like `1.2.3-beta` are not offered.
fn parse(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.strip_prefix('v').unwrap_or(v).split('.');
    let n = |p: Option<&str>| p.and_then(|s| s.parse::<u64>().ok());
    let version = (n(parts.next())?, n(parts.next())?, n(parts.next())?);
    parts.next().is_none().then_some(version)
}

/// The highest `vX.Y.Z` tag in `git ls-remote --tags` output.
fn newest(listing: &str) -> Option<(u64, u64, u64)> {
    listing.lines().filter_map(|l| l.split_once("refs/tags/")).filter_map(|(_, tag)| parse(tag.trim())).max()
}

fn compare(current: &str, latest: (u64, u64, u64)) -> LatestVersion {
    LatestVersion { latest: format!("{}.{}.{}", latest.0, latest.1, latest.2), newer: parse(current).is_some_and(|c| latest > c) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn newest_tag_wins_by_number_not_by_text() {
        let listing = "a\trefs/tags/v0.4.0\nb\trefs/tags/v0.10.0\nc\trefs/tags/v0.9.3\nd\trefs/tags/v1.0.0-beta\ne\trefs/tags/notes\n";
        assert_eq!(newest(listing), Some((0, 10, 0)));
        assert_eq!(newest(""), None);
    }

    #[test] fn only_a_higher_version_is_newer() {
        assert_eq!(compare("0.5.1", (0, 6, 0)), LatestVersion { latest: "0.6.0".into(), newer: true });
        assert!(!compare("0.5.1", (0, 5, 1)).newer);
        assert!(!compare("0.6.0", (0, 5, 9)).newer);
    }

    #[test] fn the_build_knows_its_version_and_commit() {
        let v = current();
        assert_eq!(v.version, env!("CARGO_PKG_VERSION"));
        assert!(!v.commit.is_empty());
    }
}
