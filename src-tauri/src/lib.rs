mod commands;
mod commands_db;
mod crypto;
mod ssh;
mod ai;
mod learning;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::set_master_password,
            commands::verify_master_password,
            commands::has_master_password,
            commands::setup_master_password,
            commands::unlock_with_password,
            commands::add_server,
            commands::remove_server,
            commands::list_servers,
            commands::execute_command,
            commands::test_connection,
            commands::check_command_dangerous,
            commands::get_server_banner,
            commands::save_provider_config,
            commands::load_provider_config,
            commands::save_servers,
            commands::load_servers,
            commands::start_pty_session,
            commands::pty_input,
            commands::pty_output,
            commands::pty_resize,
            commands::close_pty_session,
            commands::create_shell_session,
            commands::shell_input,
            commands::shell_output,
            commands::shell_is_alive,
            commands::shell_resize,
            commands::reconnect_shell,
            commands::close_shell_session,
            ai::call_ai,
            learning::save_learning_data,
            learning::load_learning_data,
            commands_db::load_commands_db,
            commands_db::search_commands,
            commands_db::get_command_suggestions,
            commands_db::get_command_by_name,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
