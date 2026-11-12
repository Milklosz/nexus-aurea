use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::operation_registry::{
    OperationKind, OperationRegistry, SessionOperation, RETURN_HOME_TIMEOUT_MS,
};
use crate::session_store::{self, PersistedSession};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
    /// Revision of the session transition this launch context belongs to.
    /// Together with `launchId` it lets events be correlated across a
    /// restart or a repeated command without guessing from timestamps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_revision: Option<u64>,
}

impl SessionContext {
    pub(crate) fn for_launch(launch_id: &str, app_id: Option<&str>, process_id: Option<u32>) -> Self {
        Self {
            launch_id: Some(launch_id.to_string()),
            app_id: app_id.map(str::to_string),
            process_id,
            session_revision: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryReason {
    /// The previous process ended without writing a clean-shutdown marker.
    UnexpectedExit,
    /// The application was closed normally while an external session was active.
    CleanRestart,
    /// The persisted file was unreadable or from an unsupported version.
    CorruptState,
    /// The persisted launch context no longer exists in LaunchRegistry.
    OrphanedLaunch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecovery {
    pub recovered_at_ms: u64,
    pub previous_session: SessionId,
    pub previous_revision: u64,
    pub reason: RecoveryReason,
    pub message: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<SessionRecovery>,
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
    /// An optimistic-concurrency caller expected a different revision.
    StaleRevision,
    /// A queued command exceeded its validity window.
    ExpiredCommand,
    /// A command id was reused for a different target.
    InvalidCommand,
    /// The operation was cancelled before it completed.
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionError {
    pub code: SessionErrorCode,
    pub message: String,
    pub from: SessionId,
    pub target: SessionId,
    pub current_revision: u64,
    pub allowed_targets: Vec<SessionId>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionRequest {
    pub target: SessionId,
    pub cause: TransitionCause,
    #[serde(default)]
    pub context: Option<SessionContext>,
    /// Optional client-generated id. Replaying the same id returns the
    /// originally applied snapshot instead of transitioning twice.
    #[serde(default)]
    pub command_id: Option<String>,
    /// Optional optimistic-concurrency guard. A mismatch is rejected before
    /// the state machine is touched.
    #[serde(default)]
    pub expected_revision: Option<u64>,
    /// Millisecond timestamp supplied by a queued caller. Expired commands are
    /// rejected instead of being applied long after their user gesture.
    #[serde(default)]
    pub issued_at_ms: Option<u64>,
}

pub(crate) const COMMAND_TTL_MS: u64 = 10_000;
const MAX_APPLIED_COMMANDS: usize = 64;
const MAX_COMMAND_ID_LEN: usize = 128;

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
    pub operation_id: String,
    pub timed_out: bool,
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
struct AppliedCommand {
    id: String,
    target: SessionId,
    snapshot: SessionSnapshot,
}

#[derive(Clone, Debug)]
struct SessionMachine {
    current: SessionId,
    previous: Option<SessionId>,
    revision: u64,
    transitioned_at_ms: u64,
    context: Option<SessionContext>,
    recovery: Option<SessionRecovery>,
    applied_commands: VecDeque<AppliedCommand>,
}

impl Default for SessionMachine {
    fn default() -> Self {
        Self {
            current: SessionId::VeloraHome,
            previous: None,
            revision: 0,
            transitioned_at_ms: 0,
            context: None,
            recovery: None,
            applied_commands: VecDeque::new(),
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
            recovery: self.recovery.clone(),
        }
    }

    fn error(
        &self,
        code: SessionErrorCode,
        message: impl Into<String>,
        target: SessionId,
    ) -> SessionError {
        SessionError {
            code,
            message: message.into(),
            from: self.current,
            target,
            current_revision: self.revision,
            allowed_targets: allowed_targets(self.current).to_vec(),
        }
    }

    fn transition_at(
        &mut self,
        target: SessionId,
        cause: TransitionCause,
        mut context: Option<SessionContext>,
        at_ms: u64,
    ) -> Result<(SessionSnapshot, Option<SessionChangedEvent>), SessionError> {
        let from = self.current;
        if target == from {
            if let Some(context) = context.as_mut() {
                context.session_revision = Some(self.revision);
                self.context = Some(context.clone());
            }
            return Ok((self.snapshot(), None));
        }
        if !transition_is_allowed(from, target) {
            return Err(self.error(
                SessionErrorCode::InvalidTransition,
                format!(
                    "Przejście sesji {} → {} nie jest dozwolone.",
                    from.as_str(),
                    target.as_str()
                ),
                target,
            ));
        }
        self.previous = Some(from);
        self.current = target;
        self.revision = self.revision.saturating_add(1);
        if let Some(context) = context.as_mut() {
            context.session_revision = Some(self.revision);
            self.context = Some(context.clone());
        } else {
            self.context = None;
        }
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

    fn apply_command(
        &mut self,
        request: &TransitionRequest,
        at_ms: u64,
    ) -> Result<(SessionSnapshot, Option<SessionChangedEvent>), SessionError> {
        if let Some(command_id) = request.command_id.as_deref() {
            if command_id.is_empty() || command_id.len() > MAX_COMMAND_ID_LEN {
                return Err(self.error(
                    SessionErrorCode::InvalidCommand,
                    "Identyfikator komendy sesji jest nieprawidłowy.",
                    request.target,
                ));
            }
            if let Some(applied) = self
                .applied_commands
                .iter()
                .find(|entry| entry.id == command_id)
            {
                if applied.target != request.target {
                    return Err(self.error(
                        SessionErrorCode::InvalidCommand,
                        "Ten identyfikator komendy został już użyty dla innego przejścia.",
                        request.target,
                    ));
                }
                return Ok((applied.snapshot.clone(), None));
            }
        }
        if let Some(expected) = request.expected_revision {
            if expected != self.revision {
                return Err(self.error(
                    SessionErrorCode::StaleRevision,
                    format!(
                        "Oczekiwana rewizja sesji {expected} nie odpowiada bieżącej {}.",
                        self.revision
                    ),
                    request.target,
                ));
            }
        }
        if let Some(issued_at) = request.issued_at_ms {
            if at_ms.saturating_sub(issued_at) > COMMAND_TTL_MS {
                return Err(self.error(
                    SessionErrorCode::ExpiredCommand,
                    "Komenda sesji wygasła, zanim została zastosowana.",
                    request.target,
                ));
            }
        }
        let (snapshot, event) = self.transition_at(
            request.target,
            request.cause,
            request.context.clone(),
            at_ms,
        )?;
        if let Some(command_id) = request.command_id.as_deref() {
            self.applied_commands.push_back(AppliedCommand {
                id: command_id.to_string(),
                target: request.target,
                snapshot: snapshot.clone(),
            });
            while self.applied_commands.len() > MAX_APPLIED_COMMANDS {
                self.applied_commands.pop_front();
            }
        }
        Ok((snapshot, event))
    }
}

pub struct SessionOrchestrator {
    machine: Mutex<SessionMachine>,
    operations: Mutex<OperationRegistry>,
    last_persist_error: Mutex<Option<String>>,
}

impl Default for SessionOrchestrator {
    fn default() -> Self {
        Self {
            machine: Mutex::new(SessionMachine::default()),
            operations: Mutex::new(OperationRegistry::default()),
            last_persist_error: Mutex::new(None),
        }
    }
}

impl SessionOrchestrator {
    fn persist(&self, app: &AppHandle, snapshot: &SessionSnapshot) {
        let error = session_store::save(app, snapshot, false).err();
        *self
            .last_persist_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = error;
    }

    pub(crate) fn persistence_error(&self) -> Option<String> {
        self.last_persist_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn operation_snapshot(&self) -> Vec<SessionOperation> {
        let mut operations = self
            .operations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        operations.expire(now_ms());
        operations.snapshot()
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
        current_revision: 0,
        allowed_targets: allowed_targets(from).to_vec(),
    }
}

pub(crate) fn apply_transition(
    app: &AppHandle,
    target: SessionId,
    cause: TransitionCause,
    context: Option<SessionContext>,
) -> Result<SessionSnapshot, SessionError> {
    let orchestrator = app.state::<SessionOrchestrator>();
    let result = {
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
    };
    if let Ok(snapshot) = &result {
        orchestrator.persist(app, snapshot);
    }
    result
}

fn apply_transition_command(
    app: &AppHandle,
    request: &TransitionRequest,
) -> Result<SessionSnapshot, SessionError> {
    let orchestrator = app.state::<SessionOrchestrator>();
    let result = {
        let mut machine = orchestrator
            .machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match machine.apply_command(request, now_ms()) {
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
    };
    if let Ok(snapshot) = &result {
        orchestrator.persist(app, snapshot);
    }
    result
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

/// Rehydrates the last session after a restart. VELORA always resumes in its
/// own Home; the previous external session is reported, never silently claimed.
/// The revision continues from the persisted value so `launchId` plus
/// `sessionRevision` remain meaningful across restarts.
fn apply_persisted_recovery(
    machine: &mut SessionMachine,
    state: &PersistedSession,
    now: u64,
) -> Option<SessionRecovery> {
    let previous = state.snapshot.current;
    if state.clean_shutdown && previous == SessionId::VeloraHome {
        return None;
    }
    let reason = if state.clean_shutdown {
        RecoveryReason::CleanRestart
    } else {
        RecoveryReason::UnexpectedExit
    };
    let recovery = SessionRecovery {
        recovered_at_ms: now,
        previous_session: previous,
        previous_revision: state.snapshot.revision,
        reason,
        message: match reason {
            RecoveryReason::UnexpectedExit => {
                "Poprzednie uruchomienie VELORA zakończyło się nieoczekiwanie. Sesja wróciła do ekranu głównego."
                    .into()
            }
            _ => {
                "VELORA została uruchomiona ponownie. Poprzednia sesja zewnętrzna wymaga świadomego wyboru."
                    .into()
            }
        },
    };
    machine.current = SessionId::VeloraHome;
    machine.previous = (previous != SessionId::VeloraHome).then_some(previous);
    machine.revision = state.snapshot.revision.saturating_add(1);
    machine.transitioned_at_ms = now;
    // A persisted launch context is not trusted after a restart: the process
    // may have exited while VELORA was down.
    machine.context = None;
    machine.recovery = Some(recovery.clone());
    Some(recovery)
}

pub(crate) fn restore_persisted_session(
    app: &AppHandle,
) -> Result<Option<SessionRecovery>, String> {
    let loaded = session_store::load(app);
    let orchestrator = app.state::<SessionOrchestrator>();
    let now = now_ms();
    let mut machine = orchestrator
        .machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    match loaded {
        Ok(Some(state)) => {
            let Some(recovery) = apply_persisted_recovery(&mut machine, &state, now) else {
                return Ok(None);
            };
            let snapshot = machine.snapshot();
            drop(machine);
            let _ = session_store::save(app, &snapshot, false);
            Ok(Some(recovery))
        }
        Ok(None) => Ok(None),
        Err(error) => {
            let recovery = SessionRecovery {
                recovered_at_ms: now,
                previous_session: machine.current,
                previous_revision: machine.revision,
                reason: RecoveryReason::CorruptState,
                message: format!(
                    "{error} VELORA rozpoczęła od bezpiecznego ekranu głównego."
                ),
            };
            machine.recovery = Some(recovery.clone());
            let snapshot = machine.snapshot();
            drop(machine);
            let _ = session_store::save(app, &snapshot, false);
            Ok(Some(recovery))
        }
    }
}

pub(crate) fn mark_clean_shutdown(app: &AppHandle) {
    let snapshot = current_snapshot(app);
    let _ = session_store::save(app, &snapshot, true);
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
    let snapshot = {
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
        match machine.transition_at(
            SessionId::VeloraHome,
            TransitionCause::ProcessExit,
            None,
            now_ms(),
        ) {
            Ok((snapshot, event)) => {
                if let Some(event) = event {
                    let _ = app.emit(SESSION_CHANGED_EVENT, event);
                }
                snapshot
            }
            Err(_) => return,
        }
    };
    orchestrator.persist(app, &snapshot);
}

/// Called after resume and at startup. A persisted launch context that is not
/// present in LaunchRegistry is an orphan and must not keep VELORA in a game
/// session forever.
fn orphan_should_be_cleared(launch_id: Option<&str>, launch_active: bool) -> bool {
    launch_id.is_some() && !launch_active
}

pub(crate) fn reconcile_orphaned_launch(app: &AppHandle) -> bool {
    let snapshot = current_snapshot(app);
    let Some(launch_id) = snapshot
        .context
        .as_ref()
        .and_then(|context| context.launch_id.clone())
    else {
        return false;
    };
    if !orphan_should_be_cleared(
        Some(launch_id.as_str()),
        crate::launch_registry::is_launch_active(app, &launch_id),
    ) {
        return false;
    }
    {
        let orchestrator = app.state::<SessionOrchestrator>();
        let mut machine = orchestrator
            .machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if machine
            .context
            .as_ref()
            .and_then(|context| context.launch_id.as_deref())
            != Some(launch_id.as_str())
        {
            return false;
        }
        machine.recovery = Some(SessionRecovery {
            recovered_at_ms: now_ms(),
            previous_session: machine.current,
            previous_revision: machine.revision,
            reason: RecoveryReason::OrphanedLaunch,
            message: "Kontekst uruchomienia nie istnieje już w rejestrze; sesja wróciła do Home."
                .into(),
        });
    }
    finish_launch_session(app, &launch_id);
    true
}

pub(crate) fn return_home(
    app: &AppHandle,
    cause: TransitionCause,
) -> Result<ReturnHomeResult, SessionError> {
    let orchestrator = app.state::<SessionOrchestrator>();
    let operation = orchestrator
        .operations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .begin(
            OperationKind::ReturnHome,
            now_ms(),
            RETURN_HOME_TIMEOUT_MS,
        );

    if let Err(error) = apply_transition(app, SessionId::VeloraHome, cause, None) {
        let _ = orchestrator
            .operations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .finish(&operation.id, now_ms(), false);
        return Err(error);
    }

    let cancelled = orchestrator
        .operations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_cancelled(&operation.id);
    if cancelled {
        let _ = orchestrator
            .operations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .finish(&operation.id, now_ms(), false);
        let machine = orchestrator
            .machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut error = machine.error(
            SessionErrorCode::Cancelled,
            "Sesja wróciła do Home, ale przywracanie okna zostało anulowane.",
            SessionId::VeloraHome,
        );
        error.current_revision = machine.revision;
        let _ = app.emit(SESSION_ERROR_EVENT, error.clone());
        return Err(error);
    }

    let restore = window_broker::restore_velora(app, RestoreReason::UserRequest);
    // The restore can take up to ~100 ms. Re-read the authoritative snapshot
    // so a concurrent transition is not overwritten by a stale event payload.
    let session = current_snapshot(app);
    let timed_out = now_ms() > operation.deadline_at_ms;
    let _ = orchestrator
        .operations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .finish(&operation.id, now_ms(), timed_out);
    let event = ReturnHomeEvent {
        cause,
        session: session.clone(),
        restore: restore.clone(),
    };
    let _ = app.emit(RETURN_HOME_EVENT, event);
    Ok(ReturnHomeResult {
        session,
        restore,
        operation_id: operation.id,
        timed_out,
    })
}

#[tauri::command]
pub fn get_session_state(app: AppHandle) -> SessionSnapshot {
    current_snapshot(&app)
}

#[tauri::command]
pub fn get_session_operations(app: AppHandle) -> Vec<SessionOperation> {
    app.state::<SessionOrchestrator>().operation_snapshot()
}

#[tauri::command]
pub fn cancel_session_operation(app: AppHandle, operation_id: String) -> Option<SessionOperation> {
    app.state::<SessionOrchestrator>()
        .operations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .cancel(&operation_id, now_ms())
}

#[tauri::command]
pub async fn request_session_transition(
    app: AppHandle,
    request: TransitionRequest,
) -> Result<SessionSnapshot, SessionError> {
    let target = request.target;
    tauri::async_runtime::spawn_blocking(move || apply_transition_command(&app, &request))
        .await
        .unwrap_or_else(|_| Err(internal_error(SessionId::VeloraHome, target)))
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
        allowed_targets, apply_persisted_recovery, transition_is_allowed, SessionChangedEvent,
        SessionContext, SessionErrorCode, SessionId, SessionMachine, TransitionCause,
        TransitionRequest, COMMAND_TTL_MS,
    };
    use crate::session_store::PersistedSession;
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
        let mut expected = context;
        expected.session_revision = Some(1);
        assert_eq!(snapshot.context, Some(expected));
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
                    "sessionRevision": 1,
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
    fn unexpected_exit_recovery_returns_home_and_preserves_correlation() {
        let mut original = machine();
        original
            .transition_at(SessionId::Game, TransitionCause::Launch, None, 50)
            .unwrap();
        let persisted = PersistedSession {
            version: 1,
            snapshot: original.snapshot(),
            clean_shutdown: false,
            saved_at_ms: 60,
        };
        let mut recovered = machine();
        let recovery = apply_persisted_recovery(&mut recovered, &persisted, 1_000).unwrap();
        let snapshot = recovered.snapshot();
        assert_eq!(snapshot.current, SessionId::VeloraHome);
        assert_eq!(snapshot.previous, Some(SessionId::Game));
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.context, None);
        assert_eq!(recovery.reason, super::RecoveryReason::UnexpectedExit);
        assert_eq!(recovery.previous_revision, 1);
        assert_eq!(snapshot.recovery.as_ref().map(|entry| entry.reason), Some(super::RecoveryReason::UnexpectedExit));
    }

    #[test]
    fn clean_restart_at_home_does_not_create_recovery_noise() {
        let persisted = PersistedSession {
            version: 1,
            snapshot: machine().snapshot(),
            clean_shutdown: true,
            saved_at_ms: 1,
        };
        let mut recovered = machine();
        assert!(apply_persisted_recovery(&mut recovered, &persisted, 2).is_none());
    }

    #[test]
    fn clean_restart_from_an_external_session_reports_it_without_claiming_it() {
        let mut original = machine();
        original
            .transition_at(SessionId::Cinema, TransitionCause::User, None, 50)
            .unwrap();
        let persisted = PersistedSession {
            version: 1,
            snapshot: original.snapshot(),
            clean_shutdown: true,
            saved_at_ms: 60,
        };
        let mut recovered = machine();
        let recovery = apply_persisted_recovery(&mut recovered, &persisted, 70).unwrap();
        assert_eq!(recovery.reason, super::RecoveryReason::CleanRestart);
        assert_eq!(recovered.snapshot().current, SessionId::VeloraHome);
    }

    fn request(target: SessionId, command_id: &str) -> TransitionRequest {
        TransitionRequest {
            target,
            cause: TransitionCause::User,
            context: None,
            command_id: Some(command_id.into()),
            expected_revision: None,
            issued_at_ms: None,
        }
    }

    #[test]
    fn repeated_command_id_is_idempotent_and_returns_the_original_snapshot() {
        let mut state = machine();
        let first = state.apply_command(&request(SessionId::Cinema, "cmd-1"), 100).unwrap().0;
        let second = state.apply_command(&request(SessionId::Cinema, "cmd-1"), 200).unwrap().0;
        assert_eq!(first, second);
        assert_eq!(state.snapshot().revision, 1);
    }

    #[test]
    fn command_id_reuse_for_a_different_target_is_rejected() {
        let mut state = machine();
        state.apply_command(&request(SessionId::Cinema, "cmd-1"), 100).unwrap();
        let error = state
            .apply_command(&request(SessionId::Game, "cmd-1"), 200)
            .unwrap_err();
        assert_eq!(error.code, SessionErrorCode::InvalidCommand);
        assert_eq!(state.snapshot().revision, 1);
    }

    #[test]
    fn stale_revision_guard_rejects_the_transition_without_mutation() {
        let mut state = machine();
        state.apply_command(&request(SessionId::Cinema, "cmd-1"), 100).unwrap();
        let mut stale = request(SessionId::Game, "cmd-2");
        stale.expected_revision = Some(0);
        let error = state.apply_command(&stale, 200).unwrap_err();
        assert_eq!(error.code, SessionErrorCode::StaleRevision);
        assert_eq!(error.current_revision, 1);
        assert_eq!(error.allowed_targets, super::allowed_targets(SessionId::Cinema).to_vec());
        assert_eq!(state.snapshot().current, SessionId::Cinema);
    }

    #[test]
    fn expired_and_empty_command_ids_are_rejected() {
        let mut state = machine();
        let mut expired = request(SessionId::Cinema, "cmd-old");
        expired.issued_at_ms = Some(1);
        let error = state
            .apply_command(&expired, 1 + COMMAND_TTL_MS + 1)
            .unwrap_err();
        assert_eq!(error.code, SessionErrorCode::ExpiredCommand);
        let error = state
            .apply_command(&request(SessionId::Cinema, ""), 200)
            .unwrap_err();
        assert_eq!(error.code, SessionErrorCode::InvalidCommand);
        assert_eq!(state.snapshot().revision, 0);
    }

    #[test]
    fn orphan_detection_requires_a_context_and_an_inactive_launch() {
        assert!(!super::orphan_should_be_cleared(None, false));
        assert!(!super::orphan_should_be_cleared(Some("game-1"), true));
        assert!(super::orphan_should_be_cleared(Some("game-1"), false));
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
