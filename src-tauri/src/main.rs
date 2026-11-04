// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // An agent started this executable as its tg-bridge MCP server: stdio only, no window.
    // Checked before Tauri starts, or the single-instance plugin would hand over to the app.
    if std::env::args().any(|a| a == tg_studio_lib::bridge::FLAG) {
        std::process::exit(tg_studio_lib::bridge::run_process());
    }
    tg_studio_lib::run()
}
