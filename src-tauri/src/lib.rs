use tauri::Manager;

mod control_service;
mod remote_access;
mod app_manager;
mod music_service;
mod platform_launchers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(control_service::ControlService::default())
        .manage(remote_access::RemoteAccess::default())
        .invoke_handler(tauri::generate_handler![
            platform_launchers::get_platform_launcher_status,
            platform_launchers::launch_platform,
            control_service::get_control_service_status,
            control_service::start_control_service,
            control_service::set_control_game_mode,
            control_service::stop_control_service,
            remote_access::get_remote_access_status,
            remote_access::prepare_remote_trust_profile,
            remote_access::start_remote_access,
            remote_access::begin_remote_pairing,
            remote_access::stop_remote_access,
            remote_access::revoke_all_remote_devices,
            remote_access::revoke_remote_device,
            app_manager::get_app_manager_status,
            app_manager::launch_managed_app,
            app_manager::launch_managed_game,
            music_service::get_apple_music_status,
            music_service::control_apple_music,
            music_service::adjust_system_volume,
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
