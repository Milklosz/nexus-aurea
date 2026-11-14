use tauri::{Emitter, Manager};

mod autostart;
mod control_service;
mod diagnostics;
#[allow(dead_code)]
mod ds4;
mod display_audio;
mod edge_cinema;
mod remote_access;
mod app_manager;
mod gamepad_home;
mod pad_hub;
mod launch_registry;
mod music_service;
mod operation_registry;
mod platform_launchers;
mod playnite_library;
#[allow(dead_code)]
mod playnite_manifest;
mod process_table;
#[allow(dead_code)]
mod remote_reliability;
mod session_monitor;
mod session_orchestrator;
mod session_store;
mod single_instance;
mod window_broker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !single_instance::claim_or_activate_existing() {
        return;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(control_service::ControlService::default())
        .manage(remote_access::RemoteAccess::default())
        .manage(session_orchestrator::SessionOrchestrator::default())
        .manage(window_broker::WindowBroker::default())
        .manage(pad_hub::PadHub::default())
        .manage(launch_registry::LaunchRegistry::default())
        .invoke_handler(tauri::generate_handler![
            platform_launchers::get_platform_launcher_status,
            platform_launchers::launch_platform,
            pad_hub::get_native_controller_status,
            control_service::get_control_service_status,
            control_service::start_control_service,
            control_service::set_control_game_mode,
            control_service::stop_control_service,
            control_service::get_fallback_hotkey_options,
            control_service::set_fallback_hotkey,
            display_audio::get_display_audio_status,
            diagnostics::get_diagnostics_snapshot,
            diagnostics::export_diagnostics_report,
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
            session_orchestrator::get_session_operations,
            session_orchestrator::cancel_session_operation,
            session_orchestrator::request_session_transition,
            session_orchestrator::return_velora_home,
            window_broker::get_window_broker_status,
            window_broker::restore_velora_window,
            launch_registry::get_launch_registry_status,
            launch_registry::cancel_launch_session,
            edge_cinema::launch_edge_cinema,
            edge_cinema::get_edge_cinema_status,
            edge_cinema::get_edge_cinema_session,
            edge_cinema::request_edge_cinema_close,
            edge_cinema::report_edge_cinema_exit,
            edge_cinema::reset_edge_cinema_session,
            autostart::get_autostart_status,
            autostart::set_autostart_enabled,
            autostart::get_startup_mode,
            autostart::get_autostart_diagnostics,
            autostart::get_autostart_recovery,
            playnite_library::get_playnite_library,
            playnite_library::launch_playnite_game,
            playnite_manifest::get_playnite_manifest,
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(hwnd) = window.hwnd() {
                    window_broker::attach_main_window(app.handle(), hwnd.0 as usize as u64);
                }
            }
            if let Ok(Some(recovery)) = session_orchestrator::restore_persisted_session(app.handle()) {
                let _ = app.emit("velora-session-recovery", recovery);
            }
            // The one Raw Input sink for the whole app (DualShock 4 navigation, DualSense chord).
            app.state::<pad_hub::PadHub>().start(app.handle().clone());
            window_broker::start_foreground_monitor(app.handle().clone());
            edge_cinema::reconcile_edge_marker(app.handle());
            display_audio::start_monitor(app.handle().clone());
            session_monitor::start(app.handle().clone());
            if std::env::args().any(|arg| arg == "--windowed") {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_fullscreen(false)?;
                    window.set_decorations(true)?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building VELORA");

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            session_orchestrator::mark_clean_shutdown(app);
            app.state::<pad_hub::PadHub>().stop();
            launch_registry::stop_watcher();
            window_broker::stop_foreground_monitor();
            display_audio::stop_monitor();
            session_monitor::stop();
        }
    });
}
