//! Sanitized projection of LaunchRegistry. No second tracker, polling thread or persisted HWND.
use serde::Serialize;
use tauri::AppHandle;

use crate::launch_registry::{self, LaunchKind, LaunchPhase, LaunchSession};
use crate::{process_table, window_broker};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedSessionState {
    Launching,
    Running,
    Foreground,
    Background,
    Unavailable,
    Exited,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSession {
    pub session_id: String,
    pub app_id: String,
    pub application_type: LaunchKind,
    pub name: String,
    pub state: ManagedSessionState,
    pub launched_at_ms: u64,
    pub last_observed_at_ms: u64,
    pub can_resume: bool,
    pub can_close: bool,
    pub last_failure: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSessionsSnapshot {
    pub supported: bool,
    pub sessions: Vec<ManagedSession>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSessionActionResult {
    pub accepted: bool,
    pub activated: bool,
    pub message: String,
}

/// Never project window titles, URLs, paths or error text from an external app.
fn application_label(launch: &LaunchSession) -> (&str, &str) {
    match launch.app_id.as_deref() {
        Some("edge-cinema:netflix") => ("netflix", "Netflix"),
        Some("edge-cinema:youtube") => ("youtube", "YouTube"),
        Some("edge-cinema:disney") => ("disney", "Disney+"),
        Some("edge-cinema:max") => ("max", "HBO Max"),
        Some("edge-cinema:prime") => ("prime", "Prime Video"),
        Some("steamBigPicture") => ("steam", "Steam"),
        Some("playniteFullscreen") => ("playnite", "Playnite"),
        Some("appleMusic") => ("appleMusic", "Apple Music"),
        _ if launch.kind == LaunchKind::Game => ("game", "Gra"),
        _ => ("managed", "Aplikacja VELORA"),
    }
}

fn projection(
    launch: &LaunchSession,
    owned_window_available: bool,
    supported: bool,
) -> ManagedSession {
    let (app_id, name) = application_label(launch);
    let state = match launch.phase {
        LaunchPhase::Ended | LaunchPhase::Cancelled => ManagedSessionState::Exited,
        LaunchPhase::Failed => ManagedSessionState::Failed,
        _ if launch.pid_reuse_detected => ManagedSessionState::Unavailable,
        LaunchPhase::Requested | LaunchPhase::ProcessStarted => ManagedSessionState::Launching,
        LaunchPhase::ExitPending => ManagedSessionState::Unavailable,
        _ if !owned_window_available => ManagedSessionState::Unavailable,
        _ if launch.foreground => ManagedSessionState::Foreground,
        LaunchPhase::SessionActive => ManagedSessionState::Background,
        _ => ManagedSessionState::Running,
    };
    let can_resume = supported
        && owned_window_available
        && matches!(
            state,
            ManagedSessionState::Running
                | ManagedSessionState::Foreground
                | ManagedSessionState::Background
        );
    ManagedSession {
        session_id: launch.id.clone(),
        app_id: app_id.into(),
        application_type: launch.kind,
        name: name.into(),
        state,
        launched_at_ms: launch.started_at_ms,
        last_observed_at_ms: launch.updated_at_ms,
        can_resume,
        can_close: can_resume
            && launch.kind == LaunchKind::Cinema
            && launch
                .app_id
                .as_deref()
                .is_some_and(crate::edge_cinema::is_service_cinema_app_id),
        last_failure: (launch.error.is_some()
            || launch.pid_reuse_detected
            || state == ManagedSessionState::Unavailable)
            .then(|| "Sesja jest niedostępna lub wymaga ponownego odczytu.".into()),
    }
}

fn owned_target(
    app: &AppHandle,
    launch: &LaunchSession,
) -> Option<(u64, process_table::ProcessIdentity)> {
    if !launch.phase.is_active() || launch.pid_reuse_detected {
        return None;
    }
    let window = launch.window_id.filter(|window| *window != 0)?;
    let pid = window_broker::window_process_id(window)?;
    let captured = launch_registry::owned_identities_for_active_launch(app, &launch.id)
        .into_iter()
        .find(|identity| identity.process_id == pid && identity.created_at_100ns != 0)?;
    let live = process_table::identity(pid)?;
    live.matches(captured).then_some((window, captured))
}

#[tauri::command]
pub fn get_managed_sessions(app: AppHandle) -> ManagedSessionsSnapshot {
    let registry = launch_registry::get_launch_registry_status(app.clone());
    let mut sessions: Vec<_> = registry
        .sessions
        .iter()
        .take(20)
        .map(|launch| {
            projection(
                launch,
                owned_target(&app, launch).is_some(),
                cfg!(target_os = "windows"),
            )
        })
        .collect();
    sessions.sort_by(|a, b| b.last_observed_at_ms.cmp(&a.last_observed_at_ms));
    ManagedSessionsSnapshot {
        supported: cfg!(target_os = "windows"),
        sessions,
    }
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err("Nieprawidłowy identyfikator sesji.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn resume_managed_session(
    app: AppHandle,
    session_id: String,
) -> Result<ManagedSessionActionResult, String> {
    validate_session_id(&session_id)?;
    let launch = launch_registry::launch_by_id(&app, &session_id)
        .ok_or_else(|| "Nie znaleziono sesji VELORA.".to_string())?;
    let (window, owner) = owned_target(&app, &launch)
        .ok_or_else(|| "Nie można bezpiecznie potwierdzić okna tej sesji.".to_string())?;
    // Reuses the existing orchestrator transaction; no launch or arbitrary PID can be supplied by IPC.
    launch_registry::select_existing_launch(&app, &session_id)?;
    if !window_broker::activate_owned_window(window, owner.process_id, owner.created_at_100ns)? {
        return Err("Windows odmówił przywrócenia okna. Sesja pozostaje śledzona.".into());
    }
    Ok(ManagedSessionActionResult {
        accepted: true,
        activated: true,
        message: "Przywrócono okno aplikacji.".into(),
    })
}

#[tauri::command]
pub fn close_managed_session(
    app: AppHandle,
    session_id: String,
    confirm: bool,
) -> Result<ManagedSessionActionResult, String> {
    validate_session_id(&session_id)?;
    if !confirm {
        return Err("Potwierdź zamknięcie wybranej sesji.".into());
    }
    // This adapter performs service marker, active launch, exact HWND/PID and creation-time checks,
    // then sends WM_CLOSE to that one window. Unsupported applications are refused.
    crate::edge_cinema::request_edge_cinema_close(app, session_id, true)?;
    Ok(ManagedSessionActionResult {
        accepted: true,
        activated: false,
        message: "Wysłano prośbę o zamknięcie okna; oczekiwanie na zakończenie sesji.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> LaunchSession {
        LaunchSession {
            id: "cinema-1".into(),
            kind: LaunchKind::Cinema,
            display_name: "private title C:\\Users\\secret".into(),
            app_id: Some("edge-cinema:netflix".into()),
            phase: LaunchPhase::SessionActive,
            process_ids: vec![42],
            foreground: false,
            window_id: Some(100),
            started_at_ms: 12,
            updated_at_ms: 14,
            error: None,
            restore: None,
            session_revision: None,
            pid_reuse_detected: false,
            attention: None,
        }
    }

    #[test]
    fn projection_preserves_lifecycle_and_denies_resume_for_missing_or_reused_owner() {
        let mut launch = launch();
        let session = projection(&launch, true, true);
        assert_eq!(session.state, ManagedSessionState::Background);
        assert!(session.can_resume && session.can_close);
        launch.foreground = true;
        assert_eq!(
            projection(&launch, true, true).state,
            ManagedSessionState::Foreground
        );
        assert!(!projection(&launch, false, true).can_resume);
        launch.pid_reuse_detected = true;
        assert_eq!(
            projection(&launch, true, true).state,
            ManagedSessionState::Unavailable
        );
        assert!(!projection(&launch, true, true).can_close);
    }

    #[test]
    fn terminal_and_launching_states_do_not_offer_stale_actions() {
        let mut launch = launch();
        for (phase, state) in [
            (LaunchPhase::Requested, ManagedSessionState::Launching),
            (LaunchPhase::Ended, ManagedSessionState::Exited),
            (LaunchPhase::Failed, ManagedSessionState::Failed),
            (LaunchPhase::Cancelled, ManagedSessionState::Exited),
            (LaunchPhase::ExitPending, ManagedSessionState::Unavailable),
        ] {
            launch.phase = phase;
            let session = projection(&launch, true, true);
            assert_eq!(session.state, state);
            assert!(!session.can_resume && !session.can_close);
        }
    }

    #[test]
    fn session_projection_redacts_external_names_errors_and_window_identity() {
        let mut launch = launch();
        launch.error = Some("token=secret https://private.invalid C:\\Users\\secret".into());
        let json = serde_json::to_string(&projection(&launch, true, true)).unwrap();
        assert!(json.contains("Netflix"));
        for private in [
            "secret",
            "private.invalid",
            "windowId",
            "processIds",
            "displayName",
        ] {
            assert!(!json.contains(private), "{private} leaked");
        }
        launch.kind = LaunchKind::Game;
        launch.app_id = Some("untrusted".into());
        assert!(!projection(&launch, true, true).can_close);
        assert!(!projection(&launch, true, false).can_resume);
    }

    #[test]
    fn ipc_session_ids_are_bounded_and_cannot_contain_control_characters() {
        assert!(validate_session_id("cinema-1").is_ok());
        for id in ["", "cinema\n1", &"x".repeat(129)] {
            assert!(validate_session_id(id).is_err());
        }
    }
}
