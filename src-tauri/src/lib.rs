use tauri::Manager;

mod control_service;
mod remote_access;
mod app_manager;
mod music_service;
mod platform_launchers;
mod gamepad_home;
mod launch_registry;
mod session_orchestrator;
mod window_broker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(control_service::ControlService::default())
        .manage(remote_access::RemoteAccess::default())
        .manage(session_orchestrator::SessionOrchestrator::default())
        .manage(window_broker::WindowBroker::default())
        .manage(launch_registry::LaunchRegistry::default())
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
            app_manager::get_gaming_diagnostics,
            app_manager::launch_managed_app,
            app_manager::launch_managed_game,
            music_service::get_apple_music_status,
            music_service::control_apple_music,
            music_service::adjust_system_volume,
            session_orchestrator::get_session_state,
            session_orchestrator::request_session_transition,
            session_orchestrator::return_velora_home,
            window_broker::get_window_broker_status,
            window_broker::restore_velora_window,
            launch_registry::get_launch_registry_status,
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(hwnd) = window.hwnd() {
                    window_broker::attach_main_window(app.handle(), hwnd.0 as usize as u64);
                }
            }
            window_broker::start_foreground_monitor(app.handle().clone());
            if std::env::args().any(|arg| arg == "--windowed") {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_fullscreen(false)?;
                    window.set_decorations(true)?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running VELORA");
}
