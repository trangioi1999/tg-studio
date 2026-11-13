//! TG Studio core: finds agent CLIs on this machine, runs them as child
//! processes and streams their output (and token usage) to the UI.

mod acp;
mod agents;
pub mod integrations;
mod store;
mod system;
mod tasks;
mod usage;
mod workspace;

/// The tg-bridge MCP server, run by `main.rs` before Tauri starts.
pub use integrations::bridge;

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
        system::env::login_path();
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
        .manage(workspace::project::OpenedProjects::default())
        .manage(tasks::headless::Runs::default())
        .manage(tasks::headless::HeadlessSessions::default())
        .manage(tasks::TaskRuns::default())
        .manage(system::terminal::Terminals::default())
        .manage(std::sync::Arc::new(tasks::delegate::Delegations::default()))
        .manage(tasks::SessionInboxes::default())
        .manage(tasks::warm::WarmPool::default())
        .manage(workspace::compose::Composites::default())
        .manage(std::sync::Arc::new(integrations::bridge::BridgeHub::default()))
        .setup(|app| {
            let path = app.path().app_data_dir().ok().map(|dir| dir.join("tg-studio.db"));
            if let Ok(dir) = app.path().app_data_dir() { system::attachments::init(dir.join("attachments")); }
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
            system::resources::resource_usage,
            system::attachments::save_attachment,
            system::attachments::read_attachment,
            system::terminal::terminal_open,
            system::terminal::terminal_write,
            system::terminal::terminal_resize,
            system::terminal::terminal_close,
            system::version::app_version,
            system::version::latest_version,
            system::resources::kill_process,
            tasks::warm::warm_task,
            agents::detect::detect_agents,
            tasks::headless::start_agent,
            tasks::headless::stop_agent,
            store::list_runs,
            store::account_limits,
            usage::claude::refresh_claude_limits,
            usage::ledger::usage_report,
            usage::ledger::bridge_notes,
            usage::ledger::list_prices,
            usage::ledger::add_price,
            usage::ledger::get_setting,
            usage::ledger::set_setting,
            usage::ledger::save_export,
            system::diagnostics::diagnostics,
            integrations::mcp::list_mcp_servers,
            integrations::mcp::save_mcp_server,
            integrations::mcp::delete_mcp_server,
            integrations::skills::list_skills,
            integrations::skills::save_skill,
            integrations::skills::delete_skill,
            integrations::skills::skill_targets,
            integrations::skills::install_skill,
            workspace::project::open_project,
            workspace::project::list_project_files,
            workspace::project::read_project_file,
            workspace::project::git_plan,
            workspace::project::git_prepare,
            workspace::sync::git_sync_status,
            workspace::sync::git_push,
            workspace::sync::commands::create_pr,
            workspace::sync::open_url,
            tasks::start_task,
            agents::options::agent_options,
            agents::options::agent_commands,
            tasks::set_approval,
            tasks::list_branches,
            tasks::send_message,
            tasks::respond_permission,
            tasks::changes::get_diff,
            tasks::changes::accept_all,
            tasks::changes::commit_accepted,
            tasks::changes::own_changes,
            tasks::changes::revert_files,
            tasks::changes::commit_files,
            tasks::changes::list_worktree_files,
            tasks::changes::read_worktree_file,
            tasks::changes::write_worktree_file,
            tasks::changes::run_dir,
            tasks::cleanup::discard_worktree,
            tasks::cleanup::delete_runs,
            workspace::hooks::project_settings,
            workspace::hooks::set_project_settings,
            workspace::hooks::run_project_check,
            workspace::compose::compose_runs,
            workspace::compose::check_composite,
            workspace::compose::apply_composite,
            workspace::compose::commit_composite,
            workspace::compose::discard_composite
        ])
        .run(tauri::generate_context!())
        .expect("error while running TG Studio");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::adapters::AgentKind;
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
