//! Sanitized projection of LaunchRegistry. No second tracker, polling thread or persisted HWND.
use serde::Serialize;
use tauri::AppHandle;

use crate::launch_registry::{
    self, LaunchKind, LaunchPhase, LaunchSession, LifecycleEvent, SessionLifecycleState,
    SessionTransitionReceipt,
};
use crate::{process_table, window_broker};

/// How many transition receipts are projected per session (bounded read).
pub(crate) const PROJECTED_RECEIPTS_PER_SESSION: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedSessionState {
    NotRunning,
    Launching,
    Running,
    Foreground,
    Background,
    Unavailable,
    Exited,
    Failed,
}

/// The native launch adapter family, never an executable path, URI or arguments.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedLaunchMethod {
    OwnedBrowserWindow,
    SteamClient,
    GameLauncher,
    PlayniteClient,
    ManagedExecutable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSession {
    pub session_id: String,
    pub app_id: String,
    pub application_type: LaunchKind,
    pub launch_method: ManagedLaunchMethod,
    pub name: String,
    pub state: ManagedSessionState,
    pub launched_at_ms: u64,
    pub last_observed_at_ms: u64,
    pub last_activation_at_ms: Option<u64>,
    pub can_resume: bool,
    pub can_close: bool,
    pub last_failure: Option<String>,
    /// The owning launch id. For registry-tracked sessions this equals
    /// `session_id`; the field exists so ownership is explicit in the wire
    /// contract instead of implied.
    pub launch_id: String,
    /// True only for launches registered by VELORA itself. Every session in
    /// this snapshot is registry-owned, so this is always true here; foreign
    /// windows never appear in the registry at all.
    pub managed_by_velora: bool,
    /// The shared deterministic lifecycle state
    /// (idle|launching|active|closing|exited|error) of this session.
    pub lifecycle: SessionLifecycleState,
    /// Launch generation within the service/app group; idempotent launches are
    /// keyed by `<app>#<generation>`.
    pub generation: u64,
    /// Newest transition receipt (diagnostics for exit/crash reporting).
    pub last_transition: Option<SessionTransitionReceipt>,
    /// Bounded transition receipts of this session, oldest first.
    pub transition_receipts: Vec<SessionTransitionReceipt>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSessionsSnapshot {
    pub supported: bool,
    pub sessions: Vec<ManagedSession>,
    /// Application-level state is separate: no fictional launch IDs or ownership.
    pub applications: Vec<ManagedApplicationState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedApplicationState {
    pub app_id: String,
    pub name: String,
    pub state: ManagedSessionState,
    pub session_id: Option<String>,
}

const HOME_APPLICATIONS: &[(&str, &str)] = &[
    ("netflix", "Netflix"),
    ("disney", "Disney+"),
    ("max", "HBO Max"),
    ("prime", "Prime Video"),
    ("youtube", "YouTube"),
    ("steam", "Steam"),
    ("playnite", "Playnite"),
    ("appleMusic", "Apple Music"),
];

fn application_states(sessions: &[ManagedSession]) -> Vec<ManagedApplicationState> {
    HOME_APPLICATIONS
        .iter()
        .map(|(app_id, name)| {
            // A retained ended launch must not hide a newer active session.
            let latest = sessions
                .iter()
                .filter(|session| session.app_id == *app_id)
                .max_by_key(|session| {
                    (
                        matches!(
                            session.state,
                            ManagedSessionState::Launching
                                | ManagedSessionState::Running
                                | ManagedSessionState::Foreground
                                | ManagedSessionState::Background
                                | ManagedSessionState::Unavailable
                        ),
                        session.launched_at_ms,
                    )
                });
            ManagedApplicationState {
                app_id: (*app_id).into(),
                name: (*name).into(),
                state: latest.map_or(ManagedSessionState::NotRunning, |session| session.state),
                session_id: latest.map(|session| session.session_id.clone()),
            }
        })
        .collect()
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
        launch_method: match launch.kind {
            LaunchKind::Cinema => ManagedLaunchMethod::OwnedBrowserWindow,
            LaunchKind::Steam => ManagedLaunchMethod::SteamClient,
            LaunchKind::Game => ManagedLaunchMethod::GameLauncher,
            LaunchKind::Playnite => ManagedLaunchMethod::PlayniteClient,
            LaunchKind::ManagedApp => ManagedLaunchMethod::ManagedExecutable,
        },
        name: name.into(),
        state,
        launched_at_ms: launch.started_at_ms,
        last_observed_at_ms: launch.updated_at_ms,
        last_activation_at_ms: launch.last_activation_at_ms,
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
        launch_id: launch.id.clone(),
        managed_by_velora: true,
        lifecycle: SessionLifecycleState::from_phase(launch.phase),
        generation: 0,
        last_transition: None,
        transition_receipts: Vec::new(),
    }
}

/// Full projection used by the IPC read: attaches the deterministic lifecycle
/// machine state, the launch generation and the bounded transition receipts of
/// the owning launch. The exit/crash diagnostic is derived truthfully from the
/// last receipt cause — never from provider playback state (which VELORA does
/// not read) — and stays content-free.
fn projection_full(
    app: &AppHandle,
    launch: &LaunchSession,
    owned_window_available: bool,
    supported: bool,
) -> ManagedSession {
    let mut session = projection(launch, owned_window_available, supported);
    let lifecycle = launch_registry::lifecycle_for_launch(app, &launch.id)
        .unwrap_or_else(|| SessionLifecycleState::from_phase(launch.phase));
    let generation = launch_registry::generation_for_launch(app, &launch.id).unwrap_or(0);
    let receipts =
        launch_registry::transition_receipts_for_launch(app, &launch.id, PROJECTED_RECEIPTS_PER_SESSION);
    let last_transition = receipts.last().cloned();
    if let Some(receipt) = &last_transition {
        if matches!(
            receipt.cause,
            LifecycleEvent::CrashObserved | LifecycleEvent::LaunchFailed
        ) || launch.pid_reuse_detected
        {
            session.last_failure =
                Some(format!("{}.", launch_registry::lifecycle_cause_label(receipt.cause)));
        }
    }
    session.lifecycle = lifecycle;
    session.generation = generation;
    session.last_transition = last_transition;
    session.transition_receipts = receipts;
    session
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
            projection_full(
                &app,
                launch,
                owned_target(&app, launch).is_some(),
                cfg!(target_os = "windows"),
            )
        })
        .collect();
    sessions.sort_by_key(|session| {
        std::cmp::Reverse(
            session
                .last_activation_at_ms
                .unwrap_or(session.launched_at_ms),
        )
    });
    let applications = application_states(&sessions);
    ManagedSessionsSnapshot {
        supported: cfg!(target_os = "windows"),
        sessions,
        applications,
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
            last_activation_at_ms: None,
            error: None,
            restore: None,
            session_revision: None,
            pid_reuse_detected: false,
            attention: None,
        }
    }

    #[test]
    fn projection_preserves_observed_activation_and_adapter_family_without_paths() {
        let mut launch = launch();
        launch.last_activation_at_ms = Some(13);
        let session = projection(&launch, true, true);
        assert_eq!(session.last_activation_at_ms, Some(13));
        assert_eq!(
            session.launch_method,
            ManagedLaunchMethod::OwnedBrowserWindow
        );
        assert_eq!(
            projection(&launch, true, true).last_activation_at_ms,
            Some(13)
        );
        launch.kind = LaunchKind::Steam;
        assert_eq!(
            projection(&launch, true, true).launch_method,
            ManagedLaunchMethod::SteamClient
        );
        launch.kind = LaunchKind::Playnite;
        assert_eq!(
            projection(&launch, true, true).launch_method,
            ManagedLaunchMethod::PlayniteClient
        );
        launch.kind = LaunchKind::Game;
        launch.app_id = Some("opaque-game-id".into());
        assert_eq!(
            projection(&launch, true, true).launch_method,
            ManagedLaunchMethod::GameLauncher
        );
        launch.kind = LaunchKind::ManagedApp;
        assert_eq!(
            projection(&launch, true, true).launch_method,
            ManagedLaunchMethod::ManagedExecutable
        );
    }

    #[test]
    fn idle_applications_have_no_invented_sessions_and_retained_exits_do_not_hide_active_ones() {
        let empty = application_states(&[]);
        assert!(empty
            .iter()
            .all(|app| app.state == ManagedSessionState::NotRunning && app.session_id.is_none()));
        let active = projection(&launch(), true, true);
        let mut ended = launch();
        ended.id = "cinema-ended".into();
        ended.started_at_ms = 15;
        ended.phase = LaunchPhase::Ended;
        let apps = application_states(&[active, projection(&ended, false, true)]);
        let netflix = apps.iter().find(|app| app.app_id == "netflix").unwrap();
        assert_eq!(netflix.state, ManagedSessionState::Background);
        assert_eq!(netflix.session_id.as_deref(), Some("cinema-1"));
        let youtube = apps.iter().find(|app| app.app_id == "youtube").unwrap();
        assert_eq!(youtube.state, ManagedSessionState::NotRunning);
        assert!(youtube.session_id.is_none());
        let unavailable = projection(&launch(), false, true);
        let apps = application_states(&[unavailable, projection(&ended, false, true)]);
        assert_eq!(
            apps.iter()
                .find(|app| app.app_id == "netflix")
                .unwrap()
                .state,
            ManagedSessionState::Unavailable
        );
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

    #[test]
    fn projection_exposes_ownership_fields_and_shared_lifecycle_state() {
        let launch = launch();
        let session = projection(&launch, true, true);
        // session id == owning launch id, and the flag is explicit on the wire.
        assert_eq!(session.launch_id, "cinema-1");
        assert_eq!(session.session_id, session.launch_id);
        assert!(session.managed_by_velora);
        // The shared machine maps the watcher phase: SessionActive -> active.
        assert_eq!(
            session.lifecycle,
            crate::launch_registry::SessionLifecycleState::Active
        );
        assert_eq!(session.lifecycle.as_str(), "active");
        assert!(session.generation == 0, "pure projection defaults to generation 0");
        assert!(session.last_transition.is_none());
        assert!(session.transition_receipts.is_empty());
        let json = serde_json::to_string(&session).unwrap();
        assert!(json.contains("\"managedByVelora\":true"));
        assert!(json.contains("\"launchId\":\"cinema-1\""));
        assert!(json.contains("\"lifecycle\":\"active\""));
    }

    #[test]
    fn lifecycle_mapping_covers_every_watcher_phase_exactly_once() {
        use crate::launch_registry::LaunchPhase as P;
        use crate::launch_registry::SessionLifecycleState as S;
        let expected = [
            (P::Requested, S::Launching),
            (P::ProcessStarted, S::Launching),
            (P::WindowAppeared, S::Launching),
            (P::SessionActive, S::Active),
            (P::ExitPending, S::Closing),
            (P::Ended, S::Exited),
            (P::Cancelled, S::Exited),
            (P::Failed, S::Error),
        ];
        for (phase, lifecycle) in expected {
            assert_eq!(SessionLifecycleState::from_phase(phase), lifecycle);
            assert_eq!(SessionLifecycleState::from_phase(phase).as_str().len() > 0, true);
        }
        assert!(S::Exited.is_terminal() && S::Error.is_terminal());
        assert!(!S::Idle.is_terminal() && !S::Active.is_terminal());
        assert!(S::Launching.blocks_launch() && S::Active.blocks_launch() && S::Closing.blocks_launch());
        assert!(!S::Idle.blocks_launch() && !S::Exited.blocks_launch() && !S::Error.blocks_launch());
    }
}
