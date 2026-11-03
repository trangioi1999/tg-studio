//! TG Studio core: finds agent CLIs on this machine, runs them as child
//! processes and streams their output (and token usage) to the UI.

mod adapters;
mod detect;
mod env;
mod runner;
mod usage;

pub fn run() {
    // Read the login-shell PATH in the background so the first detection is fast.
    std::thread::spawn(|| {
        env::login_path();
    });

    tauri::Builder::default()
        .manage(runner::Runs::default())
        .invoke_handler(tauri::generate_handler![
            detect::detect_agents,
            detect::home_dir,
            runner::start_agent,
            runner::stop_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running TG Studio");
}
