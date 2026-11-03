//! TG Studio core: finds agent CLIs on this machine, runs them as child
//! processes and streams their output (and token usage) to the UI.

mod adapters;
mod detect;
mod env;
mod runner;
mod store;
mod usage;

use std::path::PathBuf;

use tauri::Manager;

use store::Store;

/// Opens the history database and closes off runs left over from a previous
/// session. Without a usable file the app still runs, only without history.
fn open_store(path: Option<PathBuf>) -> Store {
    let opened = path.ok_or_else(|| "không có thư mục dữ liệu".to_string()).and_then(|p| {
        let store = Store::open(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        store.mark_interrupted().map_err(|e| format!("{}: {e}", p.display()))?;
        Ok(store)
    });
    opened.unwrap_or_else(|e| {
        eprintln!("Không mở được lịch sử lượt chạy ({e}); lịch sử sẽ không được lưu.");
        Store::open_in_memory().expect("in-memory SQLite is always available")
    })
}

pub fn run() {
    // Read the login-shell PATH in the background so the first detection is fast.
    std::thread::spawn(|| {
        env::login_path();
    });

    tauri::Builder::default()
        // Must stay first. The run history has one owner: a second instance would mark
        // runs of the first as interrupted, so it hands over to the open window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(runner::Runs::default())
        .setup(|app| {
            let path = app.path().app_data_dir().ok().map(|dir| dir.join("tg-studio.db"));
            app.manage(open_store(path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect::detect_agents,
            detect::home_dir,
            runner::start_agent,
            runner::stop_agent,
            store::list_runs
        ])
        .run(tauri::generate_context!())
        .expect("error while running TG Studio");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::AgentKind;
    use crate::store::NewRun;

    fn temp_db() -> PathBuf {
        std::env::temp_dir().join(format!("tg-open-store-{}.db", uuid::Uuid::new_v4()))
    }

    #[test]
    fn corrupt_file_falls_back_to_a_working_store() {
        let path = temp_db();
        std::fs::write(&path, b"this is not a sqlite database, not even close").unwrap();
        let store = open_store(Some(path.clone()));
        store
            .insert_run(&NewRun { id: "a", agent: AgentKind::Claude, prompt: "p", cwd: "/", started_at: 1 })
            .unwrap();
        assert_eq!(store.list_runs(1).unwrap().len(), 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reopening_marks_unfinished_runs_interrupted() {
        let path = temp_db();
        open_store(Some(path.clone()))
            .insert_run(&NewRun { id: "a", agent: AgentKind::Claude, prompt: "p", cwd: "/", started_at: 1 })
            .unwrap();
        let store = open_store(Some(path.clone()));
        assert_eq!(store.list_runs(1).unwrap()[0].status, "interrupted");
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn missing_data_dir_falls_back_to_a_working_store() {
        assert!(open_store(None).list_runs(1).unwrap().is_empty());
    }
}
