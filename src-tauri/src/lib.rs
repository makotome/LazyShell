mod commands;
mod commands_db;
mod crypto;
mod ssh;
mod ai;
mod learning;
mod memory;

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
            commands::update_server,
            commands::remove_server,
            commands::list_servers,
            commands::execute_command,
            commands::get_server_status,
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
            commands::list_remote_directory,
            commands::read_remote_file,
            commands::write_remote_file,
            commands::upload_remote_file,
            commands::download_remote_file,
            ai::call_ai,
            learning::save_learning_data,
            learning::load_learning_data,
            memory::load_chat_history,
            memory::save_chat_history,
            memory::append_chat_entry,
            memory::cleanup_chat_history,
            memory::load_command_history,
            memory::save_command_history,
            memory::append_command_history,
            memory::cleanup_command_history,
            memory::load_command_cards,
            memory::save_command_cards,
            memory::add_command_card,
            memory::remove_command_card,
            memory::update_command_card,
            memory::update_card_usage,
            memory::get_command_card,
            memory::cleanup_server_memory,
            memory::determine_command_danger_level,
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
            app.handle().plugin(tauri_plugin_dialog::init())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
