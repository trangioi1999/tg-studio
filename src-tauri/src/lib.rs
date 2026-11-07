//! TG Studio core: finds agent CLIs on this machine, runs them as child
//! processes and streams their output (and token usage) to the UI.

mod acp;
mod acp_runner;
mod adapters;
pub mod bridge;
mod compose;
mod acp_tasks;
mod detect;
mod diagnostics;
mod diff;
mod env;
mod ledger;
mod mcp;
mod options;
mod skills;
mod policy;
mod project;
mod runner;
mod store;
mod usage;
mod warm;
mod workspace;
mod worktree;

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
        .plugin(tauri_plugin_dialog::init())
        .manage(project::OpenedProjects::default())
        .manage(runner::Runs::default())
        .manage(runner::HeadlessSessions::default())
        .manage(acp_tasks::TaskRuns::default())
        .manage(acp_tasks::SessionInboxes::default())
        .manage(warm::WarmPool::default())
        .manage(compose::Composites::default())
        .manage(std::sync::Arc::new(bridge::BridgeHub::default()))
        .setup(|app| {
            let path = app.path().app_data_dir().ok().map(|dir| dir.join("tg-studio.db"));
            app.manage(open_store(path));
            // Windows and Linux draw the app's own title bar (window buttons included);
            // macOS keeps its traffic lights over the overlay title bar.
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            warm::warm_task,
            detect::detect_agents,
            runner::start_agent,
            runner::stop_agent,
            store::list_runs,
            store::account_limits,
            ledger::usage_report,
            ledger::bridge_notes,
            ledger::list_prices,
            ledger::add_price,
            ledger::get_setting,
            ledger::set_setting,
            ledger::save_export,
            diagnostics::diagnostics,
            mcp::list_mcp_servers,
            mcp::save_mcp_server,
            mcp::delete_mcp_server,
            skills::list_skills,
            skills::save_skill,
            skills::delete_skill,
            skills::skill_targets,
            skills::install_skill,
            project::open_project,
            project::list_project_files,
            project::read_project_file,
            project::git_plan,
            project::git_prepare,
            acp_tasks::start_task,
            options::agent_options,
            acp_tasks::set_approval,
            acp_tasks::list_branches,
            acp_tasks::send_message,
            acp_tasks::respond_permission,
            acp_tasks::get_diff,
            acp_tasks::accept_hunk,
            acp_tasks::accept_all,
            acp_tasks::reject_hunk,
            acp_tasks::commit_accepted,
            acp_tasks::staged_files,
            acp_tasks::list_worktree_files,
            acp_tasks::read_worktree_file,
            acp_tasks::write_worktree_file,
            acp_tasks::discard_worktree,
            acp_tasks::delete_runs,
            compose::compose_runs,
            compose::check_composite,
            compose::apply_composite,
            compose::commit_composite,
            compose::discard_composite
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
