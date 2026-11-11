use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::window_broker::{self, RestoreReason, RestoreResult};

pub(crate) const SESSION_CHANGED_EVENT: &str = "velora-session-changed";
pub(crate) const SESSION_ERROR_EVENT: &str = "velora-session-error";
pub(crate) const RETURN_HOME_EVENT: &str = "velora-return-home";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionId {
    VeloraHome,
    Game,
    Playnite,
    Cinema,
    Desktop,
    Ambient,
}

impl SessionId {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::VeloraHome => "veloraHome",
            Self::Game => "game",
            Self::Playnite => "playnite",
            Self::Cinema => "cinema",
            Self::Desktop => "desktop",
            Self::Ambient => "ambient",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionCause {
    User,
    GamepadHome,
    ControlService,
    Launch,
    ProcessExit,
    System,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
}

impl SessionContext {
    pub(crate) fn for_launch(launch_id: &str, app_id: Option<&str>, process_id: Option<u32>) -> Self {
        Self {
            launch_id: Some(launch_id.to_string()),
            app_id: app_id.map(str::to_string),
            process_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub current: SessionId,
    pub previous: Option<SessionId>,
    pub revision: u64,
    pub transitioned_at_ms: u64,
    pub context: Option<SessionContext>,
    pub allowed_targets: Vec<SessionId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChangedEvent {
    pub from: SessionId,
    pub to: SessionId,
    pub cause: TransitionCause,
    pub context: Option<SessionContext>,
    pub revision: u64,
    pub at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionErrorCode {
    InvalidTransition,
    InternalStateUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionError {
    pub code: SessionErrorCode,
    pub message: String,
    pub from: SessionId,
    pub target: SessionId,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionRequest {
    pub target: SessionId,
    pub cause: TransitionCause,
    #[serde(default)]
    pub context: Option<SessionContext>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnHomeEvent {
    pub cause: TransitionCause,
    pub session: SessionSnapshot,
    pub restore: RestoreResult,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnHomeResult {
    pub session: SessionSnapshot,
    pub restore: RestoreResult,
}

/// Explicit transition table. `Ambient` and `Desktop` are leaving states: the
/// user returns to VELORA Home before choosing another session. `VeloraHome`
/// may enter every session; the external-launch states may hand off to each
/// other because Steam, Playnite, and games can be launched from VELORA panels.
pub(crate) fn allowed_targets(from: SessionId) -> &'static [SessionId] {
    use SessionId::*;
    match from {
        VeloraHome => &[Game, Playnite, Cinema, Desktop, Ambient],
        Game => &[VeloraHome, Playnite, Cinema, Desktop, Ambient],
        Playnite => &[VeloraHome, Game, Cinema, Desktop, Ambient],
        Cinema => &[VeloraHome, Game, Playnite, Desktop, Ambient],
        Ambient => &[VeloraHome],
        Desktop => &[VeloraHome],
    }
}

pub(crate) fn transition_is_allowed(from: SessionId, target: SessionId) -> bool {
    from == target || allowed_targets(from).contains(&target)
}

#[derive(Clone, Debug)]
struct SessionMachine {
    current: SessionId,
    previous: Option<SessionId>,
    revision: u64,
    transitioned_at_ms: u64,
    context: Option<SessionContext>,
}

impl Default for SessionMachine {
    fn default() -> Self {
        Self {
            current: SessionId::VeloraHome,
            previous: None,
            revision: 0,
            transitioned_at_ms: 0,
            context: None,
        }
    }
}

impl SessionMachine {
    fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            current: self.current,
            previous: self.previous,
            revision: self.revision,
            transitioned_at_ms: self.transitioned_at_ms,
            context: self.context.clone(),
            allowed_targets: allowed_targets(self.current).to_vec(),
        }
    }

    fn transition_at(
        &mut self,
        target: SessionId,
        cause: TransitionCause,
        context: Option<SessionContext>,
        at_ms: u64,
    ) -> Result<(SessionSnapshot, Option<SessionChangedEvent>), SessionError> {
        let from = self.current;
        if target == from {
            if context.is_some() {
                self.context = context;
            }
            return Ok((self.snapshot(), None));
        }
        if !transition_is_allowed(from, target) {
            return Err(SessionError {
                code: SessionErrorCode::InvalidTransition,
                message: format!(
                    "Przejście sesji {} → {} nie jest dozwolone.",
                    from.as_str(),
                    target.as_str()
                ),
                from,
                target,
            });
        }
        self.previous = Some(from);
        self.current = target;
        self.context = context;
        self.revision = self.revision.saturating_add(1);
        self.transitioned_at_ms = at_ms;
        let snapshot = self.snapshot();
        let event = SessionChangedEvent {
            from,
            to: target,
            cause,
            context: self.context.clone(),
            revision: self.revision,
            at_ms,
        };
        Ok((snapshot, Some(event)))
    }
}

pub struct SessionOrchestrator {
    machine: Mutex<SessionMachine>,
}

impl Default for SessionOrchestrator {
    fn default() -> Self {
        Self {
            machine: Mutex::new(SessionMachine::default()),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn internal_error(from: SessionId, target: SessionId) -> SessionError {
    SessionError {
        code: SessionErrorCode::InternalStateUnavailable,
        message: "Stan sesji VELORA jest chwilowo niedostępny.".into(),
        from,
        target,
    }
}

pub(crate) fn apply_transition(
    app: &AppHandle,
    target: SessionId,
    cause: TransitionCause,
    context: Option<SessionContext>,
) -> Result<SessionSnapshot, SessionError> {
    let orchestrator = app.state::<SessionOrchestrator>();
    let mut machine = orchestrator
        .machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Emit while the state lock is still held so concurrent transitions cannot
    // publish revision 2 before revision 1 to the WebView.
    match machine.transition_at(target, cause, context, now_ms()) {
        Ok((snapshot, event)) => {
            if let Some(event) = event {
                let _ = app.emit(SESSION_CHANGED_EVENT, event);
            }
            Ok(snapshot)
        }
        Err(error) => {
            let _ = app.emit(SESSION_ERROR_EVENT, error.clone());
            Err(error)
        }
    }
}

pub(crate) fn current_snapshot(app: &AppHandle) -> SessionSnapshot {
    let orchestrator = app.state::<SessionOrchestrator>();
    let snapshot = orchestrator
        .machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot();
    snapshot
}

pub(crate) fn emit_automatic_return(app: &AppHandle, restore: RestoreResult) {
    let event = ReturnHomeEvent {
        cause: TransitionCause::ProcessExit,
        session: current_snapshot(app),
        restore,
    };
    let _ = app.emit(RETURN_HOME_EVENT, event);
}

pub(crate) fn launch_owns_session(app: &AppHandle, launch_id: &str) -> bool {
    current_snapshot(app)
        .context
        .as_ref()
        .and_then(|context| context.launch_id.as_deref())
        == Some(launch_id)
}

/// Clears the session only when the ending launch still owns it. A stale or
/// superseded launch must not pull a newer session back to VELORA Home.
pub(crate) fn finish_launch_session(app: &AppHandle, launch_id: &str) {
    let orchestrator = app.state::<SessionOrchestrator>();
    let mut machine = orchestrator
        .machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if machine
        .context
        .as_ref()
        .and_then(|context| context.launch_id.as_deref())
        != Some(launch_id)
    {
        return;
    }
    if let Ok((_, Some(event))) = machine.transition_at(
        SessionId::VeloraHome,
        TransitionCause::ProcessExit,
        None,
        now_ms(),
    ) {
        let _ = app.emit(SESSION_CHANGED_EVENT, event);
    }
}

pub(crate) fn return_home(app: &AppHandle, cause: TransitionCause) -> Result<ReturnHomeResult, SessionError> {
    apply_transition(app, SessionId::VeloraHome, cause, None)?;
    let restore = window_broker::restore_velora(app, RestoreReason::UserRequest);
    // The restore can take up to ~100 ms. Re-read the authoritative snapshot
    // so a concurrent transition is not overwritten by a stale event payload.
    let session = current_snapshot(app);
    let event = ReturnHomeEvent {
        cause,
        session: session.clone(),
        restore: restore.clone(),
    };
    let _ = app.emit(RETURN_HOME_EVENT, event);
    Ok(ReturnHomeResult { session, restore })
}

#[tauri::command]
pub fn get_session_state(app: AppHandle) -> SessionSnapshot {
    let orchestrator = app.state::<SessionOrchestrator>();
    let snapshot = orchestrator
        .machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot();
    snapshot
}

#[tauri::command]
pub fn request_session_transition(
    app: AppHandle,
    request: TransitionRequest,
) -> Result<SessionSnapshot, SessionError> {
    apply_transition(&app, request.target, request.cause, request.context)
}

#[tauri::command]
pub async fn return_velora_home(app: AppHandle) -> Result<ReturnHomeResult, SessionError> {
    tauri::async_runtime::spawn_blocking(move || return_home(&app, TransitionCause::User))
        .await
        .unwrap_or_else(|_| {
            Err(internal_error(SessionId::VeloraHome, SessionId::VeloraHome))
        })
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_targets, transition_is_allowed, SessionChangedEvent, SessionContext, SessionErrorCode,
        SessionId, SessionMachine, TransitionCause,
    };
    use serde_json::json;

    fn machine() -> SessionMachine {
        SessionMachine::default()
    }

    #[test]
    fn starts_at_the_explicit_velora_home_session() {
        let snapshot = machine().snapshot();
        assert_eq!(snapshot.current, SessionId::VeloraHome);
        assert_eq!(snapshot.previous, None);
        assert_eq!(snapshot.revision, 0);
        assert_eq!(
            snapshot.allowed_targets,
            vec![
                SessionId::Game,
                SessionId::Playnite,
                SessionId::Cinema,
                SessionId::Desktop,
                SessionId::Ambient,
            ]
        );
    }

    #[test]
    fn home_can_enter_every_declared_session() {
        for target in allowed_targets(SessionId::VeloraHome) {
            let mut state = machine();
            let (snapshot, event) = state
                .transition_at(*target, TransitionCause::User, None, 100)
                .unwrap();
            assert_eq!(snapshot.current, *target);
            assert_eq!(snapshot.previous, Some(SessionId::VeloraHome));
            assert_eq!(snapshot.revision, 1);
            assert_eq!(event.unwrap().to, *target);
        }
    }

    #[test]
    fn desktop_and_ambient_require_return_home_first() {
        for from in [SessionId::Desktop, SessionId::Ambient] {
            let mut state = machine();
            state
                .transition_at(from, TransitionCause::User, None, 1)
                .unwrap();
            for target in [
                SessionId::Game,
                SessionId::Playnite,
                SessionId::Cinema,
                SessionId::Desktop,
                SessionId::Ambient,
            ] {
                if target == from {
                    continue;
                }
                let error = state
                    .transition_at(target, TransitionCause::User, None, 2)
                    .unwrap_err();
                assert_eq!(error.code, SessionErrorCode::InvalidTransition);
                assert_eq!(error.from, from);
                assert_eq!(error.target, target);
                assert_eq!(state.snapshot().current, from);
                assert_eq!(state.snapshot().revision, 1);
            }
            state
                .transition_at(SessionId::VeloraHome, TransitionCause::User, None, 3)
                .unwrap();
            assert_eq!(state.snapshot().current, SessionId::VeloraHome);
            assert_eq!(state.snapshot().revision, 2);
        }
    }

    #[test]
    fn game_playnite_and_cinema_can_hand_off_without_an_intermediate_home() {
        for (from, target) in [
            (SessionId::Game, SessionId::Playnite),
            (SessionId::Playnite, SessionId::Game),
            (SessionId::Cinema, SessionId::Game),
            (SessionId::Game, SessionId::Cinema),
        ] {
            assert!(transition_is_allowed(from, target));
            let mut state = machine();
            state
                .transition_at(from, TransitionCause::Launch, None, 10)
                .unwrap();
            let (snapshot, _) = state
                .transition_at(target, TransitionCause::Launch, None, 20)
                .unwrap();
            assert_eq!(snapshot.current, target);
            assert_eq!(snapshot.previous, Some(from));
            assert_eq!(snapshot.transitioned_at_ms, 20);
        }
    }

    #[test]
    fn repeated_transition_is_idempotent_and_does_not_emit_an_event() {
        let mut state = machine();
        state
            .transition_at(SessionId::Cinema, TransitionCause::User, None, 50)
            .unwrap();
        let (snapshot, event) = state
            .transition_at(SessionId::Cinema, TransitionCause::User, None, 90)
            .unwrap();
        assert!(event.is_none());
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.transitioned_at_ms, 50);
    }

    #[test]
    fn idempotent_transition_may_refresh_launch_context_without_a_revision() {
        let mut state = machine();
        state
            .transition_at(SessionId::Game, TransitionCause::Launch, None, 50)
            .unwrap();
        let context = SessionContext::for_launch("launch-7", Some("steam"), Some(4242));
        let (snapshot, event) = state
            .transition_at(
                SessionId::Game,
                TransitionCause::Launch,
                Some(context.clone()),
                90,
            )
            .unwrap();
        assert!(event.is_none());
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.context, Some(context));
    }

    #[test]
    fn invalid_transition_preserves_the_current_state_and_revision() {
        let mut state = machine();
        state
            .transition_at(SessionId::Ambient, TransitionCause::User, None, 1)
            .unwrap();
        let snapshot_before = state.snapshot();
        let error = state
            .transition_at(SessionId::Playnite, TransitionCause::Launch, None, 2)
            .unwrap_err();
        assert_eq!(error.code, SessionErrorCode::InvalidTransition);
        assert_eq!(state.snapshot(), snapshot_before);
    }

    #[test]
    fn revision_increments_once_per_real_transition_and_saturates() {
        let mut state = machine();
        state.revision = u64::MAX - 1;
        state
            .transition_at(SessionId::Game, TransitionCause::User, None, 1)
            .unwrap();
        assert_eq!(state.snapshot().revision, u64::MAX);
        state
            .transition_at(SessionId::VeloraHome, TransitionCause::User, None, 2)
            .unwrap();
        assert_eq!(state.snapshot().revision, u64::MAX);
    }

    #[test]
    fn changed_event_carries_the_explicit_transition_and_context() {
        let mut state = machine();
        let context = SessionContext::for_launch("launch-1", Some("playnite"), Some(900));
        let (_, event) = state
            .transition_at(
                SessionId::Playnite,
                TransitionCause::Launch,
                Some(context.clone()),
                75,
            )
            .unwrap();
        let event = event.expect("changed event");
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "from": "veloraHome",
                "to": "playnite",
                "cause": "launch",
                "context": {
                    "launchId": "launch-1",
                    "appId": "playnite",
                    "processId": 900,
                },
                "revision": 1,
                "atMs": 75,
            })
        );
    }

    #[test]
    fn event_type_contract_is_serializable() {
        let event = SessionChangedEvent {
            from: SessionId::Game,
            to: SessionId::VeloraHome,
            cause: TransitionCause::GamepadHome,
            context: None,
            revision: 4,
            at_ms: 12,
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["cause"], "gamepadHome");
        assert_eq!(value["from"], "game");
        assert_eq!(value["to"], "veloraHome");
    }

    #[test]
    fn every_state_has_an_explicit_bounded_transition_table() {
        for from in [
            SessionId::VeloraHome,
            SessionId::Game,
            SessionId::Playnite,
            SessionId::Cinema,
            SessionId::Desktop,
            SessionId::Ambient,
        ] {
            let targets = allowed_targets(from);
            assert!(!targets.is_empty());
            assert!(!targets.contains(&from));
            assert!(targets.len() <= 5);
            for target in targets {
                assert!(transition_is_allowed(from, *target));
            }
        }
    }
}
