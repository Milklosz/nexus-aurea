//! Explicit local desktop recovery. No watchdog, service or shell replacement.
use tauri::AppHandle;

#[tauri::command]
pub fn exit_velora(app: AppHandle) {
    crate::session_orchestrator::mark_clean_shutdown(&app);
    app.exit(0);
}

#[tauri::command]
pub fn restart_velora(app: AppHandle) {
    crate::session_orchestrator::mark_clean_shutdown(&app);
    app.restart();
}
