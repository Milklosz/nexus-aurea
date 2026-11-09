use tauri::Manager;

mod platform_launchers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            platform_launchers::get_platform_launcher_status,
            platform_launchers::launch_platform,
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
