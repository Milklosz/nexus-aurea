use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::mpsc::{self, SyncSender};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HomeRequestSource {
    /// Local UI or the local keyboard fallback: the user is physically here.
    ExplicitUser,
    /// A physically attached local controller report forwarded by PadHub.
    /// This is a user gesture; remote IPC must never select this variant.
    LocalController,
    /// DualSense chord or paired iPhone: explicit intent, but potentially
    /// remote; never steal focus from a foreign foreground application.
    Device,
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
    pub(crate) fn for_launch(
        launch_id: &str,
        app_id: Option<&str>,
        process_id: Option<u32>,
    ) -> Self {
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
    /// A queued Home request was overtaken by a newer session transition.
    /// It must not pull a freshly launched game back into VELORA Home.
    SupersededHome,
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
/// A second Home request inside this window is the same user intent, not a new
/// operation. It must not restore focus twice or emit a duplicate event.
const HOME_DEDUPE_MS: u64 = 750;

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

/// Plans the shortest explicit path to `target`. Leaving states (`Desktop`,
/// `Ambient`) must pass through Home. Returning the whole plan lets the launch
/// registry validate both steps before it mutates either state machine.
pub(crate) fn transition_steps(
    from: SessionId,
    target: SessionId,
) -> Result<Vec<SessionId>, String> {
    if from == target || transition_is_allowed(from, target) {
        return Ok(vec![target]);
    }
    if from != SessionId::VeloraHome && transition_is_allowed(SessionId::VeloraHome, target) {
        return Ok(vec![SessionId::VeloraHome, target]);
    }
    Err(format!(
        "Przejście sesji {} → {} nie jest dozwolone.",
        from.as_str(),
        target.as_str()
    ))
}

/// True when another transition completed after the caller captured its
/// request. A Home press that waited behind a launch must not restore focus.
pub(crate) fn home_request_is_superseded(
    request: &SessionSnapshot,
    current: &SessionSnapshot,
) -> bool {
    if current.current == SessionId::VeloraHome {
        return false;
    }
    let request_launch = request
        .context
        .as_ref()
        .and_then(|context| context.launch_id.as_deref());
    let current_launch = current
        .context
        .as_ref()
        .and_then(|context| context.launch_id.as_deref());
    current.current != request.current
        || current.revision != request.revision
        || current.transitioned_at_ms != request.transitioned_at_ms
        || current_launch != request_launch
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
        // A real transition acknowledges the one-shot startup recovery notice.
        // Keeping it forever would surface stale "last recovery" on every view.
        self.recovery = None;
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
    /// Serializes the whole session transaction (transition + one focus
    /// restore / launch registration) so a stale Home cannot overtake a newly
    /// started game and launch fallbacks cannot interleave with Home.
    transaction_gate: Mutex<()>,
    last_home: Mutex<Option<HomeCompletion>>,
}

#[derive(Clone)]
struct HomeCompletion {
    revision: u64,
    at_ms: u64,
    result: ReturnHomeResult,
}

impl Default for SessionOrchestrator {
    fn default() -> Self {
        Self {
            machine: Mutex::new(SessionMachine::default()),
            operations: Mutex::new(OperationRegistry::default()),
            last_persist_error: Mutex::new(None),
            transaction_gate: Mutex::new(()),
            last_home: Mutex::new(None),
        }
    }
}

impl SessionOrchestrator {
    pub(crate) fn lock_transaction(&self) -> std::sync::MutexGuard<'_, ()> {
        self.transaction_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

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

/// A real session transition must revoke pending normalized controller input so
/// a packet carrying the previous generation/epoch cannot act on the new
/// session. Idempotent targets, deduplicated commands and rejected commands
/// produce no changed event and must leave the streaming generation untouched.
///
/// Kept pure so the policy is unit-testable without an `AppHandle`. The native
/// bridge below is the single place that calls
/// `streaming_control::invalidate_controller_streaming(app)`.
fn streaming_revocation_for_transition(event: Option<&SessionChangedEvent>) -> bool {
    event.is_some()
}

fn revoke_streaming_if_transitioned(app: &AppHandle, event: Option<&SessionChangedEvent>) {
    if streaming_revocation_for_transition(event) {
        crate::streaming_control::invalidate_controller_streaming(app);
    }
}

pub(crate) fn apply_transition(
    app: &AppHandle,
    target: SessionId,
    cause: TransitionCause,
    context: Option<SessionContext>,
) -> Result<SessionSnapshot, SessionError> {
    let orchestrator = app.state::<SessionOrchestrator>();
    let mut changed_event = None;
    let result = {
        let mut machine = orchestrator
            .machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Emit while the state lock is still held so concurrent transitions cannot
        // publish revision 2 before revision 1 to the WebView.
        match machine.transition_at(target, cause, context, now_ms()) {
            Ok((snapshot, event)) => {
                changed_event = event;
                if let Some(event) = &changed_event {
                    let _ = app.emit(SESSION_CHANGED_EVENT, event.clone());
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
        revoke_streaming_if_transitioned(app, changed_event.as_ref());
    }
    result
}

fn apply_transition_command(
    app: &AppHandle,
    request: &TransitionRequest,
) -> Result<SessionSnapshot, SessionError> {
    let orchestrator = app.state::<SessionOrchestrator>();
    let _gate = orchestrator.lock_transaction();
    let mut changed_event = None;
    let result = {
        let mut machine = orchestrator
            .machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match machine.apply_command(request, now_ms()) {
            Ok((snapshot, event)) => {
                changed_event = event;
                if let Some(event) = &changed_event {
                    let _ = app.emit(SESSION_CHANGED_EVENT, event.clone());
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
        revoke_streaming_if_transitioned(app, changed_event.as_ref());
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
                message: format!("{error} VELORA rozpoczęła od bezpiecznego ekranu głównego."),
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
    context_owned_by_launch(current_snapshot(app).context.as_ref(), launch_id)
}

/// Pure ownership rule behind [`launch_owns_session`]. Only the launch id that
/// is currently stored in the session context owns the session. A stale watcher
/// holding an older id, or a session with no context, never owns it.
pub(crate) fn context_owned_by_launch(context: Option<&SessionContext>, launch_id: &str) -> bool {
    context.and_then(|context| context.launch_id.as_deref()) == Some(launch_id)
}

/// Clears the session only when the ending launch still owns it. A stale or
/// superseded launch must not pull a newer session back to VELORA Home.
pub(crate) fn finish_launch_session(app: &AppHandle, launch_id: &str) {
    let orchestrator = app.state::<SessionOrchestrator>();
    let _gate = orchestrator.lock_transaction();
    finish_launch_session_inner(app, launch_id);
}

/// Same as [`finish_launch_session`] for callers that already hold the session
/// transaction gate.
pub(crate) fn finish_launch_session_inner(app: &AppHandle, launch_id: &str) {
    let orchestrator = app.state::<SessionOrchestrator>();
    let mut changed_event = None;
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
                changed_event = event;
                if let Some(event) = &changed_event {
                    let _ = app.emit(SESSION_CHANGED_EVENT, event.clone());
                }
                snapshot
            }
            Err(_) => return,
        }
    };
    orchestrator.persist(app, &snapshot);
    revoke_streaming_if_transitioned(app, changed_event.as_ref());
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
    let orchestrator = app.state::<SessionOrchestrator>();
    let _gate = orchestrator.lock_transaction();
    if !launch_owns_session(app, &launch_id) {
        return false;
    }
    let previous = current_snapshot(app);
    finish_launch_session_inner(app, &launch_id);
    let snapshot = {
        let mut machine = orchestrator
            .machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        machine.recovery = Some(SessionRecovery {
            recovered_at_ms: now_ms(),
            previous_session: previous.current,
            previous_revision: previous.revision,
            reason: RecoveryReason::OrphanedLaunch,
            message: "Kontekst uruchomienia nie istnieje już w rejestrze; sesja wróciła do Home."
                .into(),
        });
        machine.snapshot()
    };
    orchestrator.persist(app, &snapshot);
    true
}

pub(crate) fn return_home(
    app: &AppHandle,
    cause: TransitionCause,
    source: HomeRequestSource,
) -> Result<ReturnHomeResult, SessionError> {
    // Capture the observed revision before waiting for the transaction gate.
    // If a launch transition completes while this request is queued, the Home
    // is stale and must not pull the new game back to VELORA.
    let request_snapshot = current_snapshot(app);
    return_home_observed(app, cause, source, request_snapshot)
}

fn return_home_observed(
    app: &AppHandle,
    cause: TransitionCause,
    source: HomeRequestSource,
    request_snapshot: SessionSnapshot,
) -> Result<ReturnHomeResult, SessionError> {
    let orchestrator = app.state::<SessionOrchestrator>();
    let _gate = orchestrator.lock_transaction();

    let current = current_snapshot(app);
    if home_request_is_superseded(&request_snapshot, &current) {
        let error = SessionError {
            code: SessionErrorCode::SupersededHome,
            message:
                "Żądanie Home zostało zastąpione przez nowszą sesję. VELORA nie przejęła fokusu."
                    .into(),
            from: current.current,
            target: SessionId::VeloraHome,
            current_revision: current.revision,
            allowed_targets: current.allowed_targets.clone(),
        };
        let _ = app.emit(SESSION_ERROR_EVENT, error.clone());
        return Err(error);
    }

    // Repeated Home from a gamepad chord, remote and UI at the same moment is
    // one intent. Reuse the completed result only while VELORA is still in the
    // same Home revision; a newer session always produces a new operation.
    let now = now_ms();
    {
        let cached = orchestrator
            .last_home
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(completion) = cached.as_ref() {
            let current = current_snapshot(app);
            let foreground_hwnd = window_broker::foreground(app).hwnd;
            if home_completion_is_reusable(Some(completion), &current, now, foreground_hwnd) {
                return Ok(completion.result.clone());
            }
        }
    }

    let operation = orchestrator
        .operations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .begin(OperationKind::ReturnHome, now_ms(), RETURN_HOME_TIMEOUT_MS);

    // Claim the operation before the irreversible transition. A cancel that
    // arrives after this point returns `None` instead of falsely reporting
    // that a Home which already happened was cancelled.
    let committed = orchestrator
        .operations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .commit(&operation.id);
    if !committed {
        let machine = orchestrator
            .machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let error = machine.error(
            SessionErrorCode::Cancelled,
            "Operacja powrotu do Home została anulowana przed rozpoczęciem.",
            SessionId::VeloraHome,
        );
        let _ = app.emit(SESSION_ERROR_EVENT, error.clone());
        return Err(error);
    }

    if let Err(error) = apply_transition(app, SessionId::VeloraHome, cause, None) {
        let _ = orchestrator
            .operations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .finish(&operation.id, now_ms(), false);
        return Err(error);
    }

    let restore_reason = restore_reason_for_home_request(source);
    let restore = window_broker::restore_velora(app, restore_reason);
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
    let result = ReturnHomeResult {
        session,
        restore,
        operation_id: operation.id,
        timed_out,
    };
    *orchestrator
        .last_home
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(HomeCompletion {
        revision: result.session.revision,
        at_ms: now_ms(),
        result: result.clone(),
    });
    Ok(result)
}

fn restore_reason_for_home_request(source: HomeRequestSource) -> RestoreReason {
    match source {
        HomeRequestSource::ExplicitUser | HomeRequestSource::LocalController => {
            RestoreReason::UserRequest
        }
        HomeRequestSource::Device => RestoreReason::DeviceRequest,
    }
}

/// Compares the authoritative identity of two session states. Focus and a bare
/// revision counter are not enough: the exact target, revision, transition time
/// and launch must still match before a previous Home acknowledgement can be
/// treated as current.
fn session_identity_matches(left: &SessionSnapshot, right: &SessionSnapshot) -> bool {
    if left.current != right.current
        || left.revision != right.revision
        || left.transitioned_at_ms != right.transitioned_at_ms
    {
        return false;
    }
    let left_launch = left
        .context
        .as_ref()
        .and_then(|context| context.launch_id.as_deref());
    let right_launch = right
        .context
        .as_ref()
        .and_then(|context| context.launch_id.as_deref());
    left_launch == right_launch
}

fn home_completion_is_reusable(
    completion: Option<&HomeCompletion>,
    current: &SessionSnapshot,
    now: u64,
    foreground_hwnd: Option<u64>,
) -> bool {
    let Some(completion) = completion else {
        return false;
    };
    current.current == SessionId::VeloraHome
        // A completion captured at revision N is never reusable once the
        // session identity has changed to N+1, even if focus never moved.
        && session_identity_matches(&completion.result.session, current)
        && completion.revision == current.revision
        && now.saturating_sub(completion.at_ms) <= HOME_DEDUPE_MS
        && completion.result.restore.restored
        && completion.result.restore.own_window.is_some()
        && completion.result.restore.foreground_after.hwnd == completion.result.restore.own_window
        && foreground_hwnd == completion.result.restore.own_window
}

type HomeJob = (
    AppHandle,
    TransitionCause,
    HomeRequestSource,
    SessionSnapshot,
    Box<dyn FnOnce(Result<ReturnHomeResult, SessionError>) + Send>,
);

static HOME_WORKER: Mutex<Option<SyncSender<HomeJob>>> = Mutex::new(None);

fn home_worker() -> Option<SyncSender<HomeJob>> {
    let mut slot = HOME_WORKER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(sender) = slot.as_ref() {
        return Some(sender.clone());
    }
    let (sender, receiver) = mpsc::sync_channel::<HomeJob>(8);
    let spawned = std::thread::Builder::new()
        .name("velora-home-worker".into())
        .spawn(move || {
            while let Ok((app, cause, source, requested, on_complete)) = receiver.recv() {
                on_complete(return_home_observed(&app, cause, source, requested));
            }
        });
    if spawned.is_err() {
        return None;
    }
    *slot = Some(sender.clone());
    Some(sender)
}

/// Queues a Home transaction on a dedicated worker. The Control Service message
/// pump must keep processing WM_INPUT and the emergency shortcut while the
/// restore is in flight. Returns false when the bounded queue is full.
pub(crate) fn request_return_home<F>(
    app: AppHandle,
    cause: TransitionCause,
    source: HomeRequestSource,
    on_complete: F,
) -> bool
where
    F: FnOnce(Result<ReturnHomeResult, SessionError>) + Send + 'static,
{
    let Some(sender) = home_worker() else {
        return false;
    };
    let requested = current_snapshot(&app);
    sender
        .try_send((app, cause, source, requested, Box::new(on_complete)))
        .is_ok()
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
    tauri::async_runtime::spawn_blocking(move || {
        return_home(&app, TransitionCause::User, HomeRequestSource::ExplicitUser)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error(SessionId::VeloraHome, SessionId::VeloraHome)))
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_targets, apply_persisted_recovery, home_request_is_superseded,
        restore_reason_for_home_request, transition_is_allowed, transition_steps,
        HomeRequestSource, RestoreReason, SessionChangedEvent, SessionContext, SessionErrorCode,
        SessionId, SessionMachine, TransitionCause, TransitionRequest, COMMAND_TTL_MS,
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
    fn local_controller_requests_user_restore_while_remote_device_stays_conservative() {
        assert_eq!(
            restore_reason_for_home_request(HomeRequestSource::LocalController),
            RestoreReason::UserRequest
        );
        assert_eq!(
            restore_reason_for_home_request(HomeRequestSource::ExplicitUser),
            RestoreReason::UserRequest
        );
        assert_eq!(
            restore_reason_for_home_request(HomeRequestSource::Device),
            RestoreReason::DeviceRequest
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
            (SessionId::Playnite, SessionId::Desktop),
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
    fn cinema_session_is_owned_by_one_launch_context_and_returns_home_on_exit() {
        let mut state = machine();
        let context = SessionContext::for_launch("cinema-1", Some("edge-cinema"), Some(4242));
        let (entered, event) = state
            .transition_at(
                SessionId::Cinema,
                TransitionCause::Launch,
                Some(context),
                1_000,
            )
            .unwrap();
        assert_eq!(entered.current, SessionId::Cinema);
        assert_eq!(
            entered
                .context
                .as_ref()
                .and_then(|context| context.launch_id.as_deref()),
            Some("cinema-1")
        );
        assert_eq!(
            entered
                .context
                .as_ref()
                .and_then(|context| context.session_revision),
            Some(entered.revision)
        );
        assert_eq!(event.unwrap().cause, TransitionCause::Launch);

        let (ended, event) = state
            .transition_at(
                SessionId::VeloraHome,
                TransitionCause::ProcessExit,
                None,
                2_000,
            )
            .unwrap();
        assert_eq!(ended.current, SessionId::VeloraHome);
        assert_eq!(ended.previous, Some(SessionId::Cinema));
        assert_eq!(ended.context, None);
        assert_eq!(ended.revision, entered.revision + 1);
        assert_eq!(event.unwrap().cause, TransitionCause::ProcessExit);
    }

    #[test]
    fn game_launch_and_exit_do_not_regress_the_session_revision() {
        let mut state = machine();
        let context = SessionContext::for_launch("game-1", Some("1091500"), Some(900));
        let (entered, _) = state
            .transition_at(SessionId::Game, TransitionCause::Launch, Some(context), 10)
            .unwrap();
        let (returned, _) = state
            .transition_at(
                SessionId::VeloraHome,
                TransitionCause::ProcessExit,
                None,
                20,
            )
            .unwrap();
        assert_eq!(returned.revision, entered.revision + 1);
        assert_eq!(returned.current, SessionId::VeloraHome);
        assert!(returned.context.is_none());
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
        assert_eq!(
            snapshot.recovery.as_ref().map(|entry| entry.reason),
            Some(super::RecoveryReason::UnexpectedExit)
        );
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
        let first = state
            .apply_command(&request(SessionId::Cinema, "cmd-1"), 100)
            .unwrap()
            .0;
        let second = state
            .apply_command(&request(SessionId::Cinema, "cmd-1"), 200)
            .unwrap()
            .0;
        assert_eq!(first, second);
        assert_eq!(state.snapshot().revision, 1);
    }

    #[test]
    fn command_id_reuse_for_a_different_target_is_rejected() {
        let mut state = machine();
        state
            .apply_command(&request(SessionId::Cinema, "cmd-1"), 100)
            .unwrap();
        let error = state
            .apply_command(&request(SessionId::Game, "cmd-1"), 200)
            .unwrap_err();
        assert_eq!(error.code, SessionErrorCode::InvalidCommand);
        assert_eq!(state.snapshot().revision, 1);
    }

    #[test]
    fn stale_revision_guard_rejects_the_transition_without_mutation() {
        let mut state = machine();
        state
            .apply_command(&request(SessionId::Cinema, "cmd-1"), 100)
            .unwrap();
        let mut stale = request(SessionId::Game, "cmd-2");
        stale.expected_revision = Some(0);
        let error = state.apply_command(&stale, 200).unwrap_err();
        assert_eq!(error.code, SessionErrorCode::StaleRevision);
        assert_eq!(error.current_revision, 1);
        assert_eq!(
            error.allowed_targets,
            super::allowed_targets(SessionId::Cinema).to_vec()
        );
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

    #[test]
    fn launch_transition_plan_is_explicit_and_never_ignores_an_invalid_step() {
        assert_eq!(
            transition_steps(SessionId::VeloraHome, SessionId::Cinema).unwrap(),
            vec![SessionId::Cinema]
        );
        assert_eq!(
            transition_steps(SessionId::Game, SessionId::Cinema).unwrap(),
            vec![SessionId::Cinema]
        );
        assert_eq!(
            transition_steps(SessionId::Desktop, SessionId::Game).unwrap(),
            vec![SessionId::VeloraHome, SessionId::Game]
        );
        assert_eq!(
            transition_steps(SessionId::Ambient, SessionId::Playnite).unwrap(),
            vec![SessionId::VeloraHome, SessionId::Playnite]
        );
        assert!(transition_steps(SessionId::Desktop, SessionId::Desktop).is_ok());
        assert!(transition_steps(SessionId::VeloraHome, SessionId::VeloraHome).is_ok());
    }

    #[test]
    fn a_home_request_queued_behind_a_launch_is_superseded() {
        let request = {
            let mut state = machine();
            state
                .transition_at(SessionId::Game, TransitionCause::Launch, None, 100)
                .unwrap();
            state.snapshot()
        };
        let launched_again = {
            let mut state = machine();
            state
                .transition_at(SessionId::Game, TransitionCause::Launch, None, 100)
                .unwrap();
            state
                .transition_at(SessionId::Cinema, TransitionCause::Launch, None, 200)
                .unwrap();
            state.snapshot()
        };
        assert!(home_request_is_superseded(&request, &launched_again));
        assert!(!home_request_is_superseded(&request, &request));

        let mut home = launched_again.clone();
        home.current = SessionId::VeloraHome;
        assert!(!home_request_is_superseded(&request, &home));

        // A second launch into the same Game session keeps the revision but
        // replaces the launch context. That is still a newer session.
        let mut same_target_new_launch = request.clone();
        same_target_new_launch.context =
            Some(SessionContext::for_launch("game-2", Some("1091500"), None));
        assert!(home_request_is_superseded(
            &request,
            &same_target_new_launch
        ));
    }

    #[test]
    fn a_real_transition_clears_one_shot_startup_recovery() {
        let mut state = machine();
        state.recovery = Some(super::SessionRecovery {
            recovered_at_ms: 1,
            previous_session: SessionId::Game,
            previous_revision: 4,
            reason: super::RecoveryReason::UnexpectedExit,
            message: "Poprzednia sesja zakończyła się nieoczekiwanie.".into(),
        });
        state
            .transition_at(SessionId::Cinema, TransitionCause::User, None, 10)
            .unwrap();
        assert!(state.snapshot().recovery.is_none());
    }

    #[test]
    fn concurrent_home_requests_reuse_only_the_same_home_revision_within_the_window() {
        use crate::window_broker::{
            ForegroundWindow, RestoreOutcome, RestoreReason, RestoreResult,
        };
        let snapshot = machine().snapshot();
        let own_foreground = ForegroundWindow {
            hwnd: Some(10),
            ..ForegroundWindow::default()
        };
        let restore = RestoreResult {
            attempted: false,
            restored: true,
            outcome: RestoreOutcome::AlreadyFocused,
            reason: RestoreReason::UserRequest,
            own_window: Some(10),
            foreground_before: own_foreground.clone(),
            foreground_after: own_foreground,
            error_code: None,
            denial: None,
            message: "VELORA ma już fokus.".into(),
        };
        let result = super::ReturnHomeResult {
            session: snapshot.clone(),
            restore,
            operation_id: "op-1".into(),
            timed_out: false,
        };
        let completion = super::HomeCompletion {
            revision: snapshot.revision,
            at_ms: 1_000,
            result,
        };
        assert!(super::home_completion_is_reusable(
            Some(&completion),
            &snapshot,
            1_000 + super::HOME_DEDUPE_MS,
            Some(10),
        ));
        assert!(!super::home_completion_is_reusable(
            Some(&completion),
            &snapshot,
            1_000 + super::HOME_DEDUPE_MS + 1,
            Some(10),
        ));
        let mut newer = snapshot.clone();
        newer.revision = newer.revision.saturating_add(1);
        assert!(!super::home_completion_is_reusable(
            Some(&completion),
            &newer,
            1_100,
            Some(10),
        ));
        let mut game = snapshot.clone();
        game.current = SessionId::Game;
        assert!(!super::home_completion_is_reusable(
            Some(&completion),
            &game,
            1_100,
            Some(10),
        ));
        assert!(!super::home_completion_is_reusable(
            None,
            &snapshot,
            1_100,
            Some(10)
        ));

        let mut denied_remote = completion.clone();
        denied_remote.result.restore.restored = false;
        denied_remote.result.restore.outcome = RestoreOutcome::BlockedUnsafeForeground;
        denied_remote.result.restore.foreground_after.hwnd = Some(20);
        assert!(!super::home_completion_is_reusable(
            Some(&denied_remote),
            &snapshot,
            1_100,
            Some(20),
        ));
        assert!(
            super::home_completion_is_reusable(Some(&completion), &snapshot, 1_100, Some(10),),
            "a successful local retry is reusable while VELORA remains foreground"
        );
        assert!(
            !super::home_completion_is_reusable(Some(&completion), &snapshot, 1_100, Some(20),),
            "a later foreground change must permit another restore attempt"
        );
    }

    fn successful_home_completion(
        snapshot: &super::SessionSnapshot,
        at_ms: u64,
        hwnd: u64,
    ) -> super::HomeCompletion {
        use crate::window_broker::{
            ForegroundWindow, RestoreOutcome, RestoreReason, RestoreResult,
        };
        let foreground = ForegroundWindow {
            hwnd: Some(hwnd),
            ..ForegroundWindow::default()
        };
        let restore = RestoreResult {
            attempted: false,
            restored: true,
            outcome: RestoreOutcome::AlreadyFocused,
            reason: RestoreReason::UserRequest,
            own_window: Some(hwnd),
            foreground_before: foreground.clone(),
            foreground_after: foreground,
            error_code: None,
            denial: None,
            message: "VELORA ma już fokus.".into(),
        };
        let result = super::ReturnHomeResult {
            session: snapshot.clone(),
            restore,
            operation_id: "op-home".into(),
            timed_out: false,
        };
        super::HomeCompletion {
            revision: snapshot.revision,
            at_ms,
            result,
        }
    }

    #[test]
    fn a_home_completion_captured_at_revision_n_is_rejected_after_transition_to_n_plus_one() {
        let mut state = machine();
        state
            .transition_at(SessionId::Game, TransitionCause::Launch, None, 100)
            .unwrap();
        state
            .transition_at(
                SessionId::VeloraHome,
                TransitionCause::GamepadHome,
                None,
                200,
            )
            .unwrap();
        let home = state.snapshot();
        let completion = successful_home_completion(&home, 200, 10);
        assert!(super::home_completion_is_reusable(
            Some(&completion),
            &home,
            200 + super::HOME_DEDUPE_MS,
            Some(10),
        ));

        // A launch supersedes the queued/acknowledged Home. The request captured
        // at revision N must not pull revision N+1 back to VELORA.
        state
            .transition_at(
                SessionId::Game,
                TransitionCause::Launch,
                Some(SessionContext::for_launch("game-new", Some("1091500"), None)),
                300,
            )
            .unwrap();
        let launched = state.snapshot();
        assert_eq!(launched.revision, home.revision + 1);
        assert!(home_request_is_superseded(&home, &launched));
        assert!(!super::home_completion_is_reusable(
            Some(&completion),
            &launched,
            250,
            Some(10),
        ));

        // An optimistic caller pinning revision N is rejected with StaleRevision
        // instead of transitioning the newer session.
        let mut stale = request(SessionId::VeloraHome, "home-queued");
        stale.expected_revision = Some(home.revision);
        let error = state.apply_command(&stale, 350).unwrap_err();
        assert_eq!(error.code, SessionErrorCode::StaleRevision);
        assert_eq!(error.current_revision, launched.revision);

        // Even after a later Home the old acknowledgement stays stale: the
        // revision and the launch identity both moved on.
        state
            .transition_at(
                SessionId::Cinema,
                TransitionCause::Launch,
                Some(SessionContext::for_launch("cinema-new", Some("edge-cinema"), None)),
                400,
            )
            .unwrap();
        state
            .transition_at(SessionId::VeloraHome, TransitionCause::User, None, 500)
            .unwrap();
        let home_again = state.snapshot();
        assert!(!super::home_completion_is_reusable(
            Some(&completion),
            &home_again,
            250,
            Some(10),
        ));
        assert!(home.revision < home_again.revision);
    }

    #[test]
    fn home_reuse_requires_matching_session_identity_not_just_revision_and_focus() {
        let snapshot = machine().snapshot();
        let completion = successful_home_completion(&snapshot, 1_000, 10);

        // Same revision and same foreground, but a different launch identity:
        // the old acknowledgement must not be reused for this session.
        let mut different_launch = snapshot.clone();
        different_launch.context = Some(SessionContext::for_launch("other-launch", None, None));
        different_launch.context.as_mut().unwrap().session_revision = Some(snapshot.revision);
        assert!(!super::home_completion_is_reusable(
            Some(&completion),
            &different_launch,
            1_100,
            Some(10),
        ));

        // Same revision and launch, but a distinct transition timestamp is a
        // different session state as well.
        let mut different_time = snapshot.clone();
        different_time.transitioned_at_ms = snapshot.transitioned_at_ms + 1;
        assert!(!super::home_completion_is_reusable(
            Some(&completion),
            &different_time,
            1_100,
            Some(10),
        ));

        assert!(super::home_completion_is_reusable(
            Some(&completion),
            &snapshot,
            1_100,
            Some(10),
        ));
    }

    #[test]
    fn repeated_home_and_session_transitions_keep_monotonic_revisions_and_reject_stale_commands() {
        let mut state = machine();
        let mut revisions = Vec::new();
        let mut revision_three: Option<super::SessionSnapshot> = None;
        let mut at = 1_000u64;
        for (target, id) in [
            (SessionId::Game, "launch-a"),
            (SessionId::VeloraHome, "home-a"),
            (SessionId::Cinema, "launch-b"),
            (SessionId::VeloraHome, "home-b"),
            (SessionId::Playnite, "launch-c"),
            (SessionId::VeloraHome, "home-c"),
            (SessionId::Game, "launch-d"),
        ] {
            let snapshot = state.apply_command(&request(target, id), at).unwrap().0;
            if snapshot.revision == 3 {
                revision_three = Some(snapshot.clone());
            }
            revisions.push(snapshot.revision);
            at += 100;
        }
        for pair in revisions.windows(2) {
            assert_eq!(pair[1], pair[0] + 1, "revision grew twice for one transition");
        }
        assert_eq!(revisions, vec![1, 2, 3, 4, 5, 6, 7]);

        // A replayed id for the same target is idempotent: it returns the old
        // snapshot without moving the current session back.
        let before = state.snapshot();
        let replayed = state
            .apply_command(&request(SessionId::Game, "launch-a"), at)
            .unwrap()
            .0;
        assert_eq!(replayed.current, SessionId::Game);
        assert_eq!(replayed.revision, 1);
        assert_eq!(state.snapshot(), before);

        // Reusing that id for a different target and pinning a stale revision
        // are both rejected without mutation.
        let error = state
            .apply_command(&request(SessionId::Playnite, "launch-a"), at)
            .unwrap_err();
        assert_eq!(error.code, SessionErrorCode::InvalidCommand);
        let mut stale = request(SessionId::Cinema, "stale-cinema");
        stale.expected_revision = Some(3);
        let error = state.apply_command(&stale, at).unwrap_err();
        assert_eq!(error.code, SessionErrorCode::StaleRevision);
        assert_eq!(state.snapshot(), before);

        // A Home request captured mid-run is superseded by the final Game session.
        assert!(home_request_is_superseded(
            &revision_three.expect("revision 3 snapshot"),
            &state.snapshot()
        ));
    }

    #[test]
    fn a_real_transition_revokes_streaming_generation_but_deduped_and_stale_commands_do_not() {
        let mut state = machine();

        // A real launch transition revokes pending streaming input.
        let (_, entered) = state
            .transition_at(SessionId::Game, TransitionCause::Launch, None, 10)
            .unwrap();
        assert!(super::streaming_revocation_for_transition(entered.as_ref()));

        // A repeated target is idempotent: no changed event, no revocation.
        let (_, idempotent) = state
            .transition_at(SessionId::Game, TransitionCause::Launch, None, 20)
            .unwrap();
        assert!(!super::streaming_revocation_for_transition(idempotent.as_ref()));

        // A stale expected revision is rejected before the machine is touched.
        let mut stale = request(SessionId::VeloraHome, "stale-home");
        stale.expected_revision = Some(state.snapshot().revision + 10);
        let error = state.apply_command(&stale, 30).unwrap_err();
        assert_eq!(error.code, SessionErrorCode::StaleRevision);

        // A real Home transition revokes once; a replayed command id resolves
        // to the original snapshot with no changed event and must not revoke.
        let home_request = request(SessionId::VeloraHome, "home-1");
        let (_, real_home) = state.apply_command(&home_request, 40).unwrap();
        assert!(super::streaming_revocation_for_transition(real_home.as_ref()));
        let (_, deduped_home) = state.apply_command(&home_request, 50).unwrap();
        assert!(!super::streaming_revocation_for_transition(deduped_home.as_ref()));

        // Integration assertion for the owner of streaming_control.rs (not
        // editable from this crate module): after
        // `invalidate_controller_streaming(app)` the observable generation and
        // controller_epoch each advance by exactly one:
        //   let control = app.state::<StreamingControl>();
        //   let before_generation = control.generation.load(Ordering::Acquire);
        //   let before_epoch = control.controller_epoch.load(Ordering::Acquire);
        //   invalidate_controller_streaming(&app);
        //   assert_eq!(control.generation.load(Ordering::Acquire), before_generation + 1);
        //   assert_eq!(control.controller_epoch.load(Ordering::Acquire), before_epoch + 1);
    }
}

#[cfg(test)]
mod stale_watcher_tests {
    use super::{
        context_owned_by_launch, SessionContext, SessionId, SessionMachine, TransitionCause,
    };

    fn launch_context(launch_id: &str) -> SessionContext {
        SessionContext::for_launch(launch_id, Some("edge-cinema"), None)
    }

    #[test]
    fn only_the_current_launch_context_owns_the_session() {
        let mut machine = SessionMachine::default();
        machine
            .transition_at(
                SessionId::Cinema,
                TransitionCause::Launch,
                Some(launch_context("cinema-1")),
                1_000,
            )
            .unwrap();
        assert!(context_owned_by_launch(
            machine.snapshot().context.as_ref(),
            "cinema-1"
        ));
        assert!(!context_owned_by_launch(
            machine.snapshot().context.as_ref(),
            "cinema-0"
        ));
    }

    #[test]
    fn a_stale_watcher_cannot_finish_a_session_after_home_or_a_newer_launch() {
        let mut machine = SessionMachine::default();
        machine
            .transition_at(
                SessionId::Cinema,
                TransitionCause::Launch,
                Some(launch_context("cinema-1")),
                1_000,
            )
            .unwrap();
        // The user explicitly returns Home while the old launch's exit watcher
        // is still in its grace window. Home clears the owner.
        machine
            .transition_at(SessionId::VeloraHome, TransitionCause::User, None, 2_000)
            .unwrap();
        assert!(!context_owned_by_launch(
            machine.snapshot().context.as_ref(),
            "cinema-1"
        ));

        // A newer launch then takes the session. The old id must not own it,
        // so the stale watcher cannot pull the new session back to Home.
        machine
            .transition_at(
                SessionId::Cinema,
                TransitionCause::Launch,
                Some(launch_context("cinema-2")),
                3_000,
            )
            .unwrap();
        assert!(!context_owned_by_launch(
            machine.snapshot().context.as_ref(),
            "cinema-1"
        ));
        assert!(context_owned_by_launch(
            machine.snapshot().context.as_ref(),
            "cinema-2"
        ));
    }

    #[test]
    fn a_session_without_context_has_no_owner_to_finish() {
        assert!(!context_owned_by_launch(None, "anything"));
    }
}
