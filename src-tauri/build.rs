use std::process::Command;

fn main() {
    // Which commit this build came from (`version::app_version`): builds that share a
    // version number can still be told apart.
    let git = |args: &[&str]| {
        Command::new("git").args(args).current_dir("..").output().ok()
            .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    };
    let commit = match git(&["rev-parse", "--short", "HEAD"]) {
        Some(c) if git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty()) => format!("{c}-dirty"),
        Some(c) => c,
        None => "unknown".into(),
    };
    let built = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    println!("cargo:rustc-env=TG_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=TG_BUILT_AT={built}");
    // A new commit, a checkout or an edit to tracked files changes the commit shown.
    for path in ["../.git/HEAD", "../.git/refs/heads", "../.git/packed-refs", "../.git/index"] {
        println!("cargo:rerun-if-changed={path}");
    }
    tauri_build::build()
}
