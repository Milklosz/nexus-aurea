use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::session_orchestrator::{self, SessionContext, SessionId, TransitionCause};
use crate::window_broker::{self, ForegroundWindow, RestoreReason, RestoreResult, TrackedWindow};

pub(crate) const LAUNCH_EVENT: &str = "velora-launch-event";
pub(crate) const LAUNCH_ERROR_EVENT: &str = "velora-launch-error";
pub(crate) const PLAYNITE_LEGACY_EVENT: &str = "managed-app-exited";

const EXIT_GRACE_MS: u64 = 5_000;
const START_TIMEOUT_MS: u64 = 60_000;
const MAX_RETAINED_SESSIONS: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchKind {
    Playnite,
    Steam,
    Game,
    ManagedApp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchPhase {
    Requested,
    ProcessStarted,
    WindowAppeared,
    SessionActive,
    ExitPending,
    Ended,
    Failed,
}

impl LaunchPhase {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Ended | Self::Failed)
    }

    fn is_active(self) -> bool {
        !self.is_terminal()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSession {
    pub id: String,
    pub kind: LaunchKind,
    pub display_name: String,
    pub app_id: Option<String>,
    pub phase: LaunchPhase,
    pub process_ids: Vec<u32>,
    pub foreground: bool,
    pub window_id: Option<u64>,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub error: Option<String>,
    pub restore: Option<RestoreResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRegistrySnapshot {
    pub windows: bool,
    pub sessions: Vec<LaunchSession>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchEvent {
    pub previous_phase: LaunchPhase,
    pub at_ms: u64,
    pub session: LaunchSession,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessEntry {
    process_id: u32,
    parent_process_id: u32,
    image_name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProcessTable {
    entries: Vec<ProcessEntry>,
}

impl ProcessTable {
    #[cfg(test)]
    fn from_entries(entries: Vec<(u32, u32, &str)>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|(process_id, parent_process_id, image_name)| ProcessEntry {
                    process_id,
                    parent_process_id,
                    image_name: image_name.to_string(),
                })
                .collect(),
        }
    }

    fn contains(&self, process_id: u32) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.process_id == process_id)
    }

    fn descendants_of(&self, root_process_id: u32) -> HashSet<u32> {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for entry in &self.entries {
            children
                .entry(entry.parent_process_id)
                .or_default()
                .push(entry.process_id);
        }
        let mut descendants = HashSet::new();
        let mut pending = vec![root_process_id];
        while let Some(parent) = pending.pop() {
            for child in children.get(&parent).into_iter().flatten() {
                if *child != root_process_id && descendants.insert(*child) {
                    pending.push(*child);
                }
            }
        }
        descendants
    }

    fn image_name(&self, process_id: u32) -> Option<&str> {
        self.entries
            .iter()
            .find(|entry| entry.process_id == process_id)
            .map(|entry| entry.image_name.as_str())
    }

    fn matching_pids(&self, watch: &LaunchWatch) -> HashSet<u32> {
        let candidates: HashSet<u32> = if watch.descendants_only {
            watch
                .root_process_id
                .map(|root| self.descendants_of(root))
                .unwrap_or_default()
        } else {
            self.entries.iter().map(|entry| entry.process_id).collect()
        };
        candidates
            .into_iter()
            .filter(|process_id| {
                watch.baseline_active || !watch.baseline_process_ids.contains(process_id)
            })
            .filter(|process_id| {
                let Some(name) = self.image_name(*process_id) else {
                    return false;
                };
                if watch
                    .excluded_image_names
                    .iter()
                    .any(|excluded| name.eq_ignore_ascii_case(excluded))
                {
                    return false;
                }
                watch.descendants_only
                    || watch
                        .image_names
                        .iter()
                        .any(|image| name.eq_ignore_ascii_case(image))
            })
            .collect()
    }

    fn is_running(&self, watch: &LaunchWatch, matching: &HashSet<u32>) -> bool {
        (watch.root_counts_as_running
            && watch.root_process_id.is_some_and(|root| self.contains(root)))
            || !matching.is_empty()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct LaunchWatch {
    pub kind: LaunchKind,
    pub display_name: String,
    pub app_id: Option<String>,
    pub image_names: Vec<String>,
    pub root_process_id: Option<u32>,
    pub descendants_only: bool,
    pub root_counts_as_running: bool,
    pub excluded_image_names: Vec<String>,
    pub ignore_baseline_windows: bool,
    pub session_target: Option<SessionId>,
    baseline_process_ids: HashSet<u32>,
    baseline_window_ids: HashSet<u64>,
    baseline_captured: bool,
    baseline_active: bool,
}

impl LaunchWatch {
    pub(crate) fn new(
        kind: LaunchKind,
        display_name: impl Into<String>,
        app_id: Option<String>,
        image_names: Vec<String>,
        root_process_id: Option<u32>,
        descendants_only: bool,
        root_counts_as_running: bool,
        excluded_image_names: Vec<String>,
        ignore_baseline_windows: bool,
        session_target: Option<SessionId>,
    ) -> Self {
        Self {
            kind,
            display_name: display_name.into(),
            app_id,
            image_names,
            root_process_id,
            descendants_only,
            root_counts_as_running,
            excluded_image_names,
            ignore_baseline_windows,
            session_target,
            baseline_process_ids: HashSet::new(),
            baseline_window_ids: HashSet::new(),
            baseline_captured: false,
            baseline_active: false,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Observation {
    table: ProcessTable,
    windows: Vec<TrackedWindow>,
    foreground: ForegroundWindow,
    at_ms: u64,
}

#[derive(Clone, Debug)]
struct TrackedLaunch {
    session: LaunchSession,
    watch: LaunchWatch,
    absent_since_ms: Option<u64>,
}

#[derive(Default)]
struct RegistryState {
    launches: Vec<TrackedLaunch>,
    last_error: Option<String>,
}

impl RegistryState {
    fn snapshot(&self) -> LaunchRegistrySnapshot {
        let mut sessions = self
            .launches
            .iter()
            .map(|tracked| tracked.session.clone())
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| session.started_at_ms);
        LaunchRegistrySnapshot {
            windows: cfg!(target_os = "windows"),
            sessions,
            last_error: self.last_error.clone(),
        }
    }

    fn active_count(&self) -> usize {
        self.launches
            .iter()
            .filter(|tracked| tracked.session.phase.is_active())
            .count()
    }

    fn retain_recent(&mut self) {
        while self.launches.len() > MAX_RETAINED_SESSIONS {
            let Some(index) = self
                .launches
                .iter()
                .position(|tracked| tracked.session.phase.is_terminal())
            else {
                break;
            };
            self.launches.remove(index);
        }
    }
}

pub struct LaunchRegistry {
    state: Mutex<RegistryState>,
    registration: Mutex<()>,
}

impl Default for LaunchRegistry {
    fn default() -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
            registration: Mutex::new(()),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

static NEXT_LAUNCH_ID: AtomicU64 = AtomicU64::new(1);

fn next_launch_id(kind: LaunchKind) -> String {
    let prefix = match kind {
        LaunchKind::Playnite => "playnite",
        LaunchKind::Steam => "steam",
        LaunchKind::Game => "game",
        LaunchKind::ManagedApp => "app",
    };
    format!(
        "{prefix}-{}-{}",
        now_ms(),
        NEXT_LAUNCH_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn same_launch_group(
    existing_kind: LaunchKind,
    existing_app_id: Option<&str>,
    new_kind: LaunchKind,
    new_app_id: Option<&str>,
) -> bool {
    match new_kind {
        LaunchKind::Playnite => existing_kind == LaunchKind::Playnite,
        LaunchKind::Steam | LaunchKind::Game => {
            matches!(existing_kind, LaunchKind::Steam | LaunchKind::Game)
        }
        LaunchKind::ManagedApp => {
            new_app_id.is_some() && existing_app_id == new_app_id
        }
    }
}

fn session_target_for(kind: LaunchKind, explicit: Option<SessionId>) -> Option<SessionId> {
    explicit.or(match kind {
        LaunchKind::Playnite => Some(SessionId::Playnite),
        LaunchKind::Steam | LaunchKind::Game => Some(SessionId::Game),
        LaunchKind::ManagedApp => None,
    })
}

fn apply_baseline(
    watch: &mut LaunchWatch,
    table: &ProcessTable,
    windows: &[TrackedWindow],
) {
    if watch.descendants_only && !watch.ignore_baseline_windows {
        watch.baseline_process_ids = table.matching_pids(watch);
    }
    if !watch.ignore_baseline_windows {
        watch.baseline_window_ids = windows.iter().map(|window| window.hwnd).collect();
    }
    // A Steam game relaunch can delegate to an already-running process. Attach
    // to those pre-existing descendants instead of timing out as a new launch.
    watch.baseline_active =
        watch.kind == LaunchKind::Game && !watch.baseline_process_ids.is_empty();
    watch.baseline_captured = true;
}

pub(crate) fn capture_baseline(
    app: &AppHandle,
    watch: &mut LaunchWatch,
) -> Result<(), String> {
    let table = native::process_table()?;
    let process_ids = if watch.descendants_only && !watch.ignore_baseline_windows {
        table.matching_pids(watch)
    } else {
        HashSet::new()
    };
    let windows = if watch.ignore_baseline_windows {
        Vec::new()
    } else {
        window_broker::windows_for_processes(app, &process_ids)
    };
    apply_baseline(watch, &table, &windows);
    Ok(())
}

fn set_phase(
    tracked: &mut TrackedLaunch,
    next: LaunchPhase,
    now_ms: u64,
    error: Option<String>,
) -> Option<LaunchEvent> {
    if tracked.session.phase == next {
        tracked.session.updated_at_ms = now_ms;
        return None;
    }
    let previous_phase = tracked.session.phase;
    if previous_phase.is_terminal() {
        return None;
    }
    tracked.session.phase = next;
    tracked.session.updated_at_ms = now_ms;
    tracked.session.error = error;
    Some(LaunchEvent {
        previous_phase,
        at_ms: now_ms,
        session: tracked.session.clone(),
    })
}

fn advance(
    tracked: &mut TrackedLaunch,
    observation: &Observation,
) -> Option<LaunchEvent> {
    if tracked.session.phase.is_terminal() {
        return None;
    }
    let matching = observation.table.matching_pids(&tracked.watch);
    let process_running = observation.table.is_running(&tracked.watch, &matching);
    let windows = observation
        .windows
        .iter()
        .filter(|window| matching.contains(&window.process_id))
        .filter(|window| {
            tracked.watch.ignore_baseline_windows
                || !tracked.watch.baseline_window_ids.contains(&window.hwnd)
        })
        .collect::<Vec<_>>();
    let foreground_matches = observation
        .foreground
        .process_id
        .is_some_and(|process_id| matching.contains(&process_id))
        || observation
            .foreground
            .hwnd
            .is_some_and(|hwnd| windows.iter().any(|window| window.hwnd == hwnd));

    let mut process_ids = matching.into_iter().collect::<Vec<_>>();
    process_ids.sort_unstable();
    tracked.session.process_ids = process_ids;
    tracked.session.foreground = foreground_matches;
    tracked.session.window_id = windows
        .iter()
        .find(|window| Some(window.hwnd) == observation.foreground.hwnd)
        .or_else(|| windows.first())
        .map(|window| window.hwnd);

    let next = match tracked.session.phase {
        LaunchPhase::Requested => {
            if process_running {
                Some(LaunchPhase::ProcessStarted)
            } else if observation.at_ms.saturating_sub(tracked.session.started_at_ms)
                >= START_TIMEOUT_MS
            {
                return set_phase(
                    tracked,
                    LaunchPhase::Failed,
                    observation.at_ms,
                    Some("Proces nie wystartował w ciągu 60 sekund.".into()),
                );
            } else {
                None
            }
        }
        LaunchPhase::ProcessStarted => {
            if !process_running {
                Some(LaunchPhase::ExitPending)
            } else if foreground_matches {
                Some(LaunchPhase::SessionActive)
            } else if !windows.is_empty() {
                Some(LaunchPhase::WindowAppeared)
            } else {
                None
            }
        }
        LaunchPhase::WindowAppeared => {
            if !process_running {
                Some(LaunchPhase::ExitPending)
            } else if foreground_matches {
                Some(LaunchPhase::SessionActive)
            } else {
                None
            }
        }
        LaunchPhase::SessionActive => {
            if !process_running {
                Some(LaunchPhase::ExitPending)
            } else {
                None
            }
        }
        LaunchPhase::ExitPending => {
            if process_running {
                tracked.absent_since_ms = None;
                if foreground_matches {
                    Some(LaunchPhase::SessionActive)
                } else if !windows.is_empty() {
                    Some(LaunchPhase::WindowAppeared)
                } else {
                    Some(LaunchPhase::ProcessStarted)
                }
            } else {
                let absent_since = *tracked.absent_since_ms.get_or_insert(observation.at_ms);
                if observation.at_ms.saturating_sub(absent_since) >= EXIT_GRACE_MS {
                    Some(LaunchPhase::Ended)
                } else {
                    None
                }
            }
        }
        LaunchPhase::Ended | LaunchPhase::Failed => None,
    };

    if next == Some(LaunchPhase::ExitPending) && tracked.absent_since_ms.is_none() {
        tracked.absent_since_ms = Some(observation.at_ms);
    }
    if next != Some(LaunchPhase::ExitPending) && process_running {
        tracked.absent_since_ms = None;
    }
    next.and_then(|phase| set_phase(tracked, phase, observation.at_ms, None))
}

impl LaunchRegistry {
    fn register(
        &self,
        app: &AppHandle,
        mut watch: LaunchWatch,
    ) -> Result<LaunchSession, String> {
        let _registration = self
            .registration
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !watch.baseline_captured {
            capture_baseline(app, &mut watch)?;
        }

        let at_ms = now_ms();
        let mut initial_process_ids = watch
            .baseline_process_ids
            .iter()
            .copied()
            .collect::<Vec<_>>();
        initial_process_ids.sort_unstable();
        let session = LaunchSession {
            id: next_launch_id(watch.kind),
            kind: watch.kind,
            display_name: watch.display_name.clone(),
            app_id: watch.app_id.clone(),
            phase: if watch.baseline_active {
                LaunchPhase::SessionActive
            } else {
                LaunchPhase::Requested
            },
            process_ids: initial_process_ids,
            foreground: false,
            window_id: None,
            started_at_ms: at_ms,
            updated_at_ms: at_ms,
            error: None,
            restore: None,
        };
        let target = session_target_for(watch.kind, watch.session_target);
        let context = SessionContext::for_launch(&session.id, session.app_id.as_deref(), None);

        let mut superseded = Vec::new();
        let mut released_process_ids = Vec::new();
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for tracked in &mut state.launches {
                if !tracked.session.phase.is_active() {
                    continue;
                }
                if same_launch_group(
                    tracked.session.kind,
                    tracked.session.app_id.as_deref(),
                    watch.kind,
                    watch.app_id.as_deref(),
                ) {
                    let previous_phase = tracked.session.phase;
                    tracked.session.phase = LaunchPhase::Ended;
                    tracked.session.updated_at_ms = at_ms;
                    tracked.session.error = Some("Zastąpiono nowszym uruchomieniem.".into());
                    tracked.absent_since_ms = None;
                    released_process_ids.extend(tracked.session.process_ids.iter().copied());
                    superseded.push(LaunchEvent {
                        previous_phase,
                        at_ms,
                        session: tracked.session.clone(),
                    });
                }
            }
            state.launches.push(TrackedLaunch {
                session: session.clone(),
                watch,
                absent_since_ms: None,
            });
            state.retain_recent();
            state.last_error = None;
        }

        for process_id in released_process_ids {
            window_broker::release_process(app, process_id);
        }
        for event in &superseded {
            let _ = app.emit(LAUNCH_EVENT, event);
        }
        if let Some(target) = target {
            if session_orchestrator::apply_transition(
                app,
                target,
                TransitionCause::Launch,
                Some(context.clone()),
            )
            .is_err()
            {
                // A launch started from Desktop/Ambient cannot jump directly to
                // the target session. Clear the leaving state first, then
                // attach the new launch context to the target.
                let _ = session_orchestrator::apply_transition(
                    app,
                    SessionId::VeloraHome,
                    TransitionCause::Launch,
                    None,
                );
                let _ = session_orchestrator::apply_transition(
                    app,
                    target,
                    TransitionCause::Launch,
                    Some(context),
                );
            }
        }
        ensure_watcher(app.clone());
        Ok(session)
    }

    fn observation_error(&self, app: &AppHandle, error: String) {
        let changed = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.last_error.as_deref() == Some(error.as_str()) {
                false
            } else {
                state.last_error = Some(error.clone());
                true
            }
        };
        if changed {
            let _ = app.emit(LAUNCH_ERROR_EVENT, error);
        }
    }

    fn tracker_watches(&self) -> Vec<(String, LaunchWatch)> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .launches
            .iter()
            .filter(|tracked| tracked.session.phase.is_active())
            .map(|tracked| (tracked.session.id.clone(), tracked.watch.clone()))
            .collect()
    }

    fn active_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_count()
    }

    fn apply_observation(&self, app: &AppHandle, observation: Observation) -> Vec<LaunchEvent> {
        let mut events = Vec::new();
        let mut finished = Vec::new();
        let mut failed = Vec::new();
        let mut process_ids_to_track = Vec::new();
        let mut released_process_ids = Vec::new();
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for tracked in &mut state.launches {
                let previous_process_ids = tracked.session.process_ids.clone();
                if let Some(event) = advance(tracked, &observation) {
                    if event.session.phase == LaunchPhase::Ended {
                        finished.push(event.session.clone());
                    } else if event.session.phase == LaunchPhase::Failed {
                        failed.push(event.session.id.clone());
                    }
                    events.push(event);
                }
                if tracked.session.phase.is_terminal() {
                    released_process_ids.extend(previous_process_ids);
                } else {
                    released_process_ids.extend(
                        previous_process_ids
                            .into_iter()
                            .filter(|process_id| !tracked.session.process_ids.contains(process_id)),
                    );
                    process_ids_to_track.extend(tracked.session.process_ids.iter().copied());
                }
            }
            if state
                .launches
                .iter()
                .any(|tracked| tracked.session.phase.is_active())
            {
                state.last_error = None;
            }
        }

        // Never hold the registry lock while touching the broker; the watcher
        // observes the broker before it observes the registry.
        for process_id in released_process_ids {
            window_broker::release_process(app, process_id);
        }
        for process_id in process_ids_to_track {
            window_broker::track_process(app, process_id);
        }
        for event in events
            .iter()
            .filter(|event| event.session.phase != LaunchPhase::Ended)
        {
            let _ = app.emit(LAUNCH_EVENT, event);
        }
        // Serialise ownership checks and session completion with new launch
        // registration, so an old session cannot clear a newer launch context.
        let _transition = self
            .registration
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for launch_id in failed {
            session_orchestrator::finish_launch_session(app, &launch_id);
        }

        for session in finished {
            let owns_session = session_orchestrator::launch_owns_session(app, &session.id);
            let restore = if owns_session {
                Some(window_broker::restore_velora(app, RestoreReason::SessionEnded))
            } else {
                None
            };
            let should_focus = restore.as_ref().is_some_and(|restore| {
                !matches!(
                    restore.outcome,
                    window_broker::RestoreOutcome::BlockedUnsafeForeground
                        | window_broker::RestoreOutcome::WindowUnavailable
                        | window_broker::RestoreOutcome::UnsupportedPlatform
                )
            });
            for process_id in &session.process_ids {
                window_broker::release_process(app, *process_id);
            }
            if owns_session {
                session_orchestrator::finish_launch_session(app, &session.id);
            }
            if session.kind == LaunchKind::Playnite {
                let _ = app.emit(
                    PLAYNITE_LEGACY_EVENT,
                    PlayniteExitEvent {
                        id: "playniteFullscreen".into(),
                        foreground_process: restore
                            .as_ref()
                            .and_then(|result| result.foreground_before.process_name.clone()),
                        should_focus,
                    },
                );
            }
            let updated_session = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(tracked) = state
                    .launches
                    .iter_mut()
                    .find(|tracked| tracked.session.id == session.id)
                {
                    tracked.session.restore = restore.clone();
                }
                state
                    .launches
                    .iter()
                    .find(|tracked| tracked.session.id == session.id)
                    .map(|tracked| tracked.session.clone())
                    .unwrap_or(session)
            };
            if let Some(restore) = restore {
                session_orchestrator::emit_automatic_return(app, restore);
            }
            let _ = app.emit(
                LAUNCH_EVENT,
                LaunchEvent {
                    previous_phase: LaunchPhase::ExitPending,
                    at_ms: now_ms(),
                    session: updated_session,
                },
            );
        }
        events
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayniteExitEvent {
    id: String,
    foreground_process: Option<String>,
    should_focus: bool,
}

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

fn ensure_watcher(app: AppHandle) {
    if WATCHER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("velora-launch-registry".into())
        .spawn(move || loop {
            if app.state::<LaunchRegistry>().active_count() == 0 {
                std::thread::sleep(std::time::Duration::from_millis(1_000));
                continue;
            }
            match watcher_tick(&app) {
                Ok(()) => {}
                Err(error) => app.state::<LaunchRegistry>().observation_error(&app, error),
            }
            std::thread::sleep(std::time::Duration::from_millis(350));
        });
    if spawned.is_err() {
        WATCHER_STARTED.store(false, Ordering::Release);
    }
}

fn watcher_tick(app: &AppHandle) -> Result<(), String> {
    let registry = app.state::<LaunchRegistry>();
    let watches = registry.tracker_watches();
    if watches.is_empty() {
        return Ok(());
    }
    let table = native::process_table()?;
    let mut process_ids = HashSet::new();
    for (_, watch) in &watches {
        process_ids.extend(table.matching_pids(watch));
        if let Some(root) = watch.root_process_id {
            process_ids.insert(root);
        }
    }
    let windows = window_broker::windows_for_processes(app, &process_ids);
    let foreground = window_broker::foreground(app);
    let observation = Observation {
        table,
        windows,
        foreground,
        at_ms: now_ms(),
    };
    registry.apply_observation(app, observation);
    Ok(())
}

pub(crate) fn track_launch(app: &AppHandle, watch: LaunchWatch) -> Result<LaunchSession, String> {
    app.state::<LaunchRegistry>().register(app, watch)
}

pub(crate) fn find_process_id(image_name: &str) -> Option<u32> {
    native::process_table()
        .ok()?
        .entries
        .iter()
        .find(|entry| entry.image_name.eq_ignore_ascii_case(image_name))
        .map(|entry| entry.process_id)
}

#[tauri::command]
pub fn get_launch_registry_status(app: AppHandle) -> LaunchRegistrySnapshot {
    app.state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot()
}

#[cfg(target_os = "windows")]
mod native {
    use super::{ProcessEntry, ProcessTable};

    pub(super) fn process_table() -> Result<ProcessTable, String> {
        use windows::core::HRESULT;
        use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES};
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|_| "Nie można odczytać stanu procesów Windows.".to_string())?;
        let no_more_files = HRESULT::from_win32(ERROR_NO_MORE_FILES.0);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let first = unsafe { Process32FirstW(snapshot, &mut entry) };
        let mut entries = Vec::new();
        let result = match first {
            Ok(()) => loop {
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|character| *character == 0)
                    .unwrap_or(entry.szExeFile.len());
                entries.push(ProcessEntry {
                    process_id: entry.th32ProcessID,
                    parent_process_id: entry.th32ParentProcessID,
                    image_name: String::from_utf16_lossy(&entry.szExeFile[..length]),
                });
                match unsafe { Process32NextW(snapshot, &mut entry) } {
                    Ok(()) => {}
                    Err(error) if error.code() == no_more_files => break Ok(()),
                    Err(_) => break Err("Nie udało się odczytać stanu procesów Windows.".into()),
                }
            },
            Err(error) if error.code() == no_more_files => Ok(()),
            Err(_) => Err("Nie udało się odczytać stanu procesów Windows.".into()),
        };
        let close_result = unsafe { CloseHandle(snapshot) };
        if result.is_ok() && close_result.is_err() {
            return Err("Nie udało się zamknąć migawki procesów Windows.".into());
        }
        result.map(|_| ProcessTable { entries })
    }
}

#[cfg(not(target_os = "windows"))]
mod native {
    use super::ProcessTable;

    pub(super) fn process_table() -> Result<ProcessTable, String> {
        Err("Rejestr uruchomień jest dostępny tylko w natywnej aplikacji Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advance, apply_baseline, same_launch_group, ProcessTable, LaunchKind, LaunchPhase,
        LaunchSession, LaunchWatch, Observation, TrackedLaunch, EXIT_GRACE_MS, START_TIMEOUT_MS,
    };
    use crate::window_broker::{ForegroundWindow, TrackedWindow};
    use std::collections::HashSet;

    fn watch() -> LaunchWatch {
        LaunchWatch::new(
            LaunchKind::Playnite,
            "Playnite Fullscreen",
            Some("playnite".into()),
            vec![
                "Playnite.FullscreenApp.exe".into(),
                "Playnite.DesktopApp.exe".into(),
            ],
            None,
            false,
            false,
            Vec::new(),
            true,
            None,
        )
    }

    fn tracked() -> TrackedLaunch {
        TrackedLaunch {
            session: LaunchSession {
                id: "launch-1".into(),
                kind: LaunchKind::Playnite,
                display_name: "Playnite Fullscreen".into(),
                app_id: Some("playnite".into()),
                phase: LaunchPhase::Requested,
                process_ids: Vec::new(),
                foreground: false,
                window_id: None,
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                error: None,
                restore: None,
            },
            watch: watch(),
            absent_since_ms: None,
        }
    }

    fn observation(
        processes: Vec<(u32, u32, &str)>,
        windows: Vec<(u64, u32, &str)>,
        foreground: Option<u64>,
        at_ms: u64,
    ) -> Observation {
        Observation {
            table: ProcessTable::from_entries(processes),
            windows: windows
                .into_iter()
                .map(|(hwnd, process_id, class_name)| TrackedWindow {
                    hwnd,
                    process_id,
                    process_name: None,
                    class_name: Some(class_name.into()),
                })
                .collect(),
            foreground: ForegroundWindow {
                hwnd: foreground,
                process_id: foreground.map(|_| 200),
                process_name: None,
                class_name: None,
                window_present: foreground.is_some(),
            },
            at_ms,
        }
    }

    #[test]
    fn distinguishes_process_window_active_and_exit_phases() {
        let mut session = tracked();
        assert_eq!(session.session.phase, LaunchPhase::Requested);

        let event = advance(
            &mut session,
            &observation(vec![(200, 1, "Playnite.FullscreenApp.exe")], vec![], None, 2_000),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::ProcessStarted);

        let event = advance(
            &mut session,
            &observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![(700, 200, "SDL_app")],
                None,
                3_000,
            ),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::WindowAppeared);

        let event = advance(
            &mut session,
            &observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![(700, 200, "SDL_app")],
                Some(700),
                4_000,
            ),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::SessionActive);
        assert!(event.session.foreground);
        assert_eq!(event.session.window_id, Some(700));

        let event = advance(
            &mut session,
            &observation(vec![], vec![], None, 10_000),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::ExitPending);

        assert!(advance(
            &mut session,
            &observation(vec![], vec![], None, 10_000 + EXIT_GRACE_MS - 1),
        )
        .is_none());
        assert_eq!(session.session.phase, LaunchPhase::ExitPending);

        advance(
            &mut session,
            &observation(vec![], vec![], None, 10_000 + EXIT_GRACE_MS),
        );
        assert_eq!(session.session.phase, LaunchPhase::Ended);
    }

    #[test]
    fn process_exit_is_detected_even_without_a_window() {
        let mut session = tracked();
        advance(
            &mut session,
            &observation(vec![(200, 1, "Playnite.FullscreenApp.exe")], vec![], None, 2_000),
        );
        advance(&mut session, &observation(vec![], vec![], None, 3_000));
        assert_eq!(session.session.phase, LaunchPhase::ExitPending);
        // `advance` advances the phase first and only records `absent_since`
        // on the same transition. A second tick at the grace boundary ends it.
        advance(
            &mut session,
            &observation(vec![], vec![], None, 3_000 + EXIT_GRACE_MS),
        );
        assert_eq!(session.session.phase, LaunchPhase::Ended);
    }

    #[test]
    fn process_reappearing_during_exit_grace_recovers_the_session() {
        let mut session = tracked();
        advance(
            &mut session,
            &observation(vec![(200, 1, "Playnite.FullscreenApp.exe")], vec![], None, 2_000),
        );
        advance(&mut session, &observation(vec![], vec![], None, 3_000));
        let event = advance(
            &mut session,
            &observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![(700, 200, "SDL_app")],
                Some(700),
                4_000,
            ),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::SessionActive);
        assert!(session.absent_since_ms.is_none());
    }

    #[test]
    fn playnite_fullscreen_to_desktop_handoff_is_not_a_session_end() {
        let mut session = tracked();
        advance(
            &mut session,
            &observation(vec![(200, 1, "Playnite.FullscreenApp.exe")], vec![], None, 2_000),
        );
        let event = advance(
            &mut session,
            &observation(
                vec![(201, 1, "Playnite.DesktopApp.exe")],
                vec![(701, 201, "SDL_app")],
                Some(701),
                3_000,
            ),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::SessionActive);
    }

    #[test]
    fn launch_timeout_marks_the_session_failed_without_claiming_a_window() {
        let mut session = tracked();
        let event = advance(
            &mut session,
            &observation(vec![], vec![], None, 1_000 + START_TIMEOUT_MS),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::Failed);
        assert!(event.session.error.is_some());
        assert_eq!(event.session.window_id, None);
    }

    #[test]
    fn baseline_windows_prevent_an_existing_steam_window_from_counting_as_a_game() {
        let mut watch = LaunchWatch::new(
            LaunchKind::Game,
            "Cyberpunk 2077",
            Some("1091500".into()),
            Vec::new(),
            Some(100),
            true,
            false,
            vec!["steamwebhelper.exe".into()],
            false,
            None,
        );
        let table = ProcessTable::from_entries(vec![
            (100, 0, "steam.exe"),
            (101, 100, "steamwebhelper.exe"),
            (102, 100, "Cyberpunk2077.exe"),
        ]);
        let windows = vec![
            TrackedWindow {
                hwnd: 10,
                process_id: 101,
                process_name: Some("steam.exe".into()),
                class_name: None,
            },
            TrackedWindow {
                hwnd: 11,
                process_id: 102,
                process_name: Some("Cyberpunk2077.exe".into()),
                class_name: None,
            },
        ];
        apply_baseline(&mut watch, &table, &windows);
        assert_eq!(watch.baseline_process_ids, HashSet::from([102]));
        assert_eq!(watch.baseline_window_ids, HashSet::from([10, 11]));
        assert!(watch.baseline_active);
        assert!(watch.baseline_captured);
        assert!(table.matching_pids(&watch).contains(&102));

        let mut session = TrackedLaunch {
            session: LaunchSession {
                id: "game-1".into(),
                kind: LaunchKind::Game,
                display_name: "Cyberpunk 2077".into(),
                app_id: Some("1091500".into()),
                phase: LaunchPhase::Requested,
                process_ids: Vec::new(),
                foreground: false,
                window_id: None,
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                error: None,
                restore: None,
            },
            watch,
            absent_since_ms: None,
        };
        let event = advance(
            &mut session,
            &Observation {
                table: ProcessTable::from_entries(vec![
                    (100, 0, "steam.exe"),
                    (101, 100, "steamwebhelper.exe"),
                    (103, 100, "Cyberpunk2077.exe"),
                ]),
                windows: vec![
                    TrackedWindow {
                        hwnd: 10,
                        process_id: 101,
                        process_name: Some("steam.exe".into()),
                        class_name: None,
                    },
                    TrackedWindow {
                        hwnd: 12,
                        process_id: 103,
                        process_name: Some("Cyberpunk2077.exe".into()),
                        class_name: None,
                    },
                ],
                foreground: ForegroundWindow::default(),
                at_ms: 5_000,
            },
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::ProcessStarted);
        assert_eq!(event.session.process_ids, vec![103]);
        assert_eq!(event.session.window_id, Some(12));
    }

    #[test]
    fn only_the_same_launcher_or_app_group_is_superseded() {
        assert!(same_launch_group(
            LaunchKind::Playnite,
            Some("playnite"),
            LaunchKind::Playnite,
            Some("playnite"),
        ));
        assert!(same_launch_group(
            LaunchKind::Steam,
            Some("steamBigPicture"),
            LaunchKind::Game,
            Some("1091500"),
        ));
        assert!(same_launch_group(
            LaunchKind::ManagedApp,
            Some("chrome"),
            LaunchKind::ManagedApp,
            Some("chrome"),
        ));
        assert!(!same_launch_group(
            LaunchKind::ManagedApp,
            Some("chrome"),
            LaunchKind::ManagedApp,
            Some("edge"),
        ));
        assert!(!same_launch_group(
            LaunchKind::Playnite,
            Some("playnite"),
            LaunchKind::Game,
            Some("1091500"),
        ));
    }

    #[test]
    fn descendant_watch_rejects_helper_processes_and_unrelated_apps() {
        let watch = LaunchWatch::new(
            LaunchKind::Game,
            "Game",
            None,
            Vec::new(),
            Some(100),
            true,
            false,
            vec!["steamwebhelper.exe".into(), "gameoverlayui.exe".into()],
            true,
            None,
        );
        let table = ProcessTable::from_entries(vec![
            (100, 0, "steam.exe"),
            (101, 100, "steamwebhelper.exe"),
            (102, 100, "Game.exe"),
            (200, 0, "chrome.exe"),
        ]);
        assert_eq!(table.matching_pids(&watch), HashSet::from([102]));
    }

    #[test]
    fn malformed_or_empty_process_snapshot_does_not_fabricate_a_session() {
        let mut session = tracked();
        assert!(advance(
            &mut session,
            &observation(vec![], vec![], None, 1_500),
        )
        .is_none());
        assert_eq!(session.session.phase, LaunchPhase::Requested);
    }

    #[test]
    fn baseline_watch_with_ignore_windows_keeps_existing_playnite_window_visible() {
        let mut watch = watch();
        let table = ProcessTable::from_entries(vec![(200, 1, "Playnite.FullscreenApp.exe")]);
        apply_baseline(&mut watch, &table, &[]);
        assert!(watch.baseline_process_ids.is_empty());
        assert!(watch.baseline_window_ids.is_empty());
    }
}
