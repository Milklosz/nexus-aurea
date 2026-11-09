use tauri::Manager;

mod control_service;
mod app_manager;
mod platform_launchers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(control_service::ControlService::default())
        .invoke_handler(tauri::generate_handler![
            platform_launchers::get_platform_launcher_status,
            platform_launchers::launch_platform,
            control_service::get_control_service_status,
            control_service::start_control_service,
            control_service::set_control_game_mode,
            control_service::stop_control_service,
            app_manager::get_app_manager_status,
            app_manager::launch_managed_app,
        ])
        .setup(|app| {
            if std::env::args().any(|arg| arg == "--windowed") {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_fullscreen(false)?;
                    window.set_decorations(true)?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NEXUS AUREA");
}
