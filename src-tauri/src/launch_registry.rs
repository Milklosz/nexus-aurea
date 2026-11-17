use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::process_table::{self, ProcessIdentity, ProcessTable};
use crate::session_orchestrator::{self, SessionContext, SessionId, TransitionCause};
use crate::window_broker::{self, ForegroundWindow, RestoreResult, TrackedWindow};

pub(crate) const LAUNCH_EVENT: &str = "velora-launch-event";
pub(crate) const LAUNCH_ERROR_EVENT: &str = "velora-launch-error";
pub(crate) const PLAYNITE_LEGACY_EVENT: &str = "managed-app-exited";

const EXIT_GRACE_MS: u64 = 5_000;
const START_TIMEOUT_MS: u64 = 60_000;
const MAX_RETAINED_SESSIONS: usize = 20;
pub(crate) const ACTIVE_POLL_MS: u64 = 600;
pub(crate) const IDLE_POLL_MS: u64 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchKind {
    Playnite,
    Steam,
    Game,
    Cinema,
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
    Cancelled,
}

impl LaunchPhase {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Ended | Self::Failed | Self::Cancelled)
    }

    pub(crate) fn is_active(self) -> bool {
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
    /// Last observed foreground entry of the exact captured process/window owner.
    /// Snapshot reads and failed activation requests never advance this timestamp.
    #[serde(default)]
    pub last_activation_at_ms: Option<u64>,
    pub error: Option<String>,
    pub restore: Option<RestoreResult>,
    /// Session revision at the launch transition, paired with `id` (the
    /// `launchId`) for cross-event correlation.
    pub session_revision: Option<u64>,
    /// A PID was reused by a different process while this launch was tracked.
    pub pid_reuse_detected: bool,
    /// Non-fatal condition that MSI diagnostics should show.
    pub attention: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRegistrySnapshot {
    pub windows: bool,
    pub sessions: Vec<LaunchSession>,
    pub last_error: Option<String>,
    pub active_sessions: usize,
    pub poll_interval_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchEvent {
    pub previous_phase: LaunchPhase,
    pub at_ms: u64,
    pub session: LaunchSession,
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
    /// End an active launch when the application window disappears even if a
    /// background process lingers (Edge Cinema keeps helper processes alive).
    pub end_on_window_gone: bool,
    /// Count a window owned by the root process itself. Edge Cinema needs this;
    /// Steam's root launcher must not widen the window set by default.
    pub include_root_window: bool,
    /// Time allowed for the first process to appear. Defaults to 60 s; Edge
    /// Cinema can use a shorter window because a failed app launch is visible.
    pub start_timeout_ms: u64,
    baseline_process_ids: HashSet<u32>,
    baseline_window_ids: HashSet<u64>,
    baseline_captured: bool,
    baseline_active: bool,
    root_identity: Option<ProcessIdentity>,
    root_reused: bool,
}

impl LaunchWatch {
    /// Seed the actual process instance captured at spawn/single-instance
    /// handoff time; never let a later PID lookup establish another owner.
    pub(crate) fn capture_root_identity(&mut self, identity: ProcessIdentity) -> bool {
        if self.root_process_id != Some(identity.process_id)
            || identity.process_id == 0
            || identity.created_at_100ns == 0
            || self
                .root_identity
                .is_some_and(|expected| !expected.matches(identity))
        {
            return false;
        }
        self.root_identity = Some(identity);
        true
    }

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
            end_on_window_gone: false,
            include_root_window: false,
            start_timeout_ms: START_TIMEOUT_MS,
            baseline_process_ids: HashSet::new(),
            baseline_window_ids: HashSet::new(),
            baseline_captured: false,
            baseline_active: false,
            root_identity: None,
            root_reused: false,
        }
    }

    /// Opt in to window-close session completion. A lingering Edge browser
    /// process must not keep VELORA in a Cinema session after its window closed.
    pub(crate) fn detect_window_close(mut self) -> Self {
        self.end_on_window_gone = true;
        self
    }

    /// Count the root process's own window as the application window. Only use
    /// this when the launch root is the real app process (Edge Cinema), not a
    /// launcher that owns unrelated windows (Steam).
    pub(crate) fn include_root_window(mut self) -> Self {
        self.include_root_window = true;
        self
    }

    /// Shorten the process-start deadline for app windows whose failure should
    /// return the user to Home quickly.
    pub(crate) fn with_start_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.start_timeout_ms = timeout_ms;
        self
    }
}

fn matching_pids(table: &ProcessTable, watch: &LaunchWatch) -> HashSet<u32> {
    let candidates: HashSet<u32> = if watch.descendants_only {
        if watch.root_reused {
            HashSet::new()
        } else {
            watch
                .root_process_id
                .map(|root| table.descendants_of(root))
                .unwrap_or_default()
        }
    } else {
        table
            .entries()
            .iter()
            .map(|entry| entry.process_id)
            .collect()
    };
    candidates
        .into_iter()
        .filter(|process_id| {
            watch.baseline_active || !watch.baseline_process_ids.contains(process_id)
        })
        .filter(|process_id| {
            let Some(name) = table.image_name(*process_id) else {
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

fn process_is_running(table: &ProcessTable, watch: &LaunchWatch, matching: &HashSet<u32>) -> bool {
    (watch.root_counts_as_running
        && !watch.root_reused
        && watch
            .root_process_id
            .is_some_and(|root| table.contains(root)))
        || !matching.is_empty()
}

#[derive(Clone, Debug, Default)]
struct Observation {
    table: Arc<ProcessTable>,
    windows: Vec<TrackedWindow>,
    foreground: ForegroundWindow,
    identities: HashMap<u32, ProcessIdentity>,
    at_ms: u64,
}

#[derive(Clone, Debug)]
struct TrackedLaunch {
    session: LaunchSession,
    watch: LaunchWatch,
    absent_since_ms: Option<u64>,
    window_absent_since_ms: Option<u64>,
    /// Creation time of every process this launch owned while it was observed.
    /// Handed to the focus restore when the launch ends, so only the ended
    /// session's own processes (and never a recycled PID) can receive focus.
    known_identities: HashMap<u32, u64>,
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
            active_sessions: self.active_count(),
            poll_interval_ms: ACTIVE_POLL_MS,
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
        LaunchKind::Cinema => "cinema",
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
        // Each Edge Cinema service is an independent launch group. Reopening
        // Netflix must not supersede a still-running Disney+ profile.
        LaunchKind::Cinema => {
            existing_kind == LaunchKind::Cinema
                && new_app_id.is_some()
                && existing_app_id == new_app_id
        }
        LaunchKind::ManagedApp => new_app_id.is_some() && existing_app_id == new_app_id,
    }
}

fn session_target_for(kind: LaunchKind, explicit: Option<SessionId>) -> Option<SessionId> {
    explicit.or(match kind {
        LaunchKind::Playnite => Some(SessionId::Playnite),
        LaunchKind::Steam | LaunchKind::Game => Some(SessionId::Game),
        LaunchKind::Cinema => Some(SessionId::Cinema),
        LaunchKind::ManagedApp => None,
    })
}

fn apply_baseline(watch: &mut LaunchWatch, table: &ProcessTable, windows: &[TrackedWindow]) {
    if watch.descendants_only && !watch.ignore_baseline_windows {
        watch.baseline_process_ids = matching_pids(table, watch);
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

pub(crate) fn capture_baseline(app: &AppHandle, watch: &mut LaunchWatch) -> Result<(), String> {
    let table = process_table::snapshot(true)?;
    let process_ids = if watch.descendants_only && !watch.ignore_baseline_windows {
        matching_pids(&table, watch)
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

/// A window-close terminal condition requires: no enumerated window, no
/// foreground match, and the last known HWND no longer exists. This avoids
/// ending a session when a window is merely cloaked or on another desktop.
fn window_close_is_terminal(
    no_window: bool,
    foreground_matches: bool,
    last_window_alive: bool,
) -> bool {
    no_window && !foreground_matches && !last_window_alive
}

fn advance(tracked: &mut TrackedLaunch, observation: &Observation) -> Option<LaunchEvent> {
    if tracked.session.phase.is_terminal() {
        return None;
    }
    let previous_foreground = tracked.session.foreground;
    let previous_activation = tracked.session.last_activation_at_ms;
    let previous_window = tracked.session.window_id;
    // A recycled PID is a different process. Detect it before matching
    // descendants or windows so an unrelated process cannot keep a dead
    // session alive.
    if let Some(root) = tracked.watch.root_process_id {
        if let Some(observed) = observation.identities.get(&root) {
            match tracked.watch.root_identity {
                Some(expected) if !expected.matches(*observed) => {
                    tracked.watch.root_reused = true;
                    tracked.session.pid_reuse_detected = true;
                    tracked.session.attention = Some(
                        "PID procesu głównego został ponownie użyty przez inny proces; sesja kończy się bezpiecznie."
                            .into(),
                    );
                }
                None => tracked.watch.root_identity = Some(*observed),
                _ => {}
            }
        }
    }
    let matching = matching_pids(&observation.table, &tracked.watch);
    let process_running = process_is_running(&observation.table, &tracked.watch, &matching);
    // A launch may own its root process window directly (Steam Big Picture,
    // Edge Cinema). `matching_pids` is descendant-only for those watches, so
    // the root must be included explicitly or its window would never count.
    let mut window_pids = matching.clone();
    if tracked.watch.include_root_window
        && tracked.watch.root_counts_as_running
        && !tracked.watch.root_reused
    {
        if let Some(root) = tracked.watch.root_process_id {
            window_pids.insert(root);
        }
    }
    let windows = observation
        .windows
        .iter()
        .filter(|window| window_pids.contains(&window.process_id))
        .filter(|window| {
            // Ignore a window whose PID now belongs to a newer process instance.
            match (
                observation.identities.get(&window.process_id),
                window.process_created_at_100ns,
            ) {
                (Some(identity), Some(created_at)) => identity.created_at_100ns == created_at,
                _ => true,
            }
        })
        .filter(|window| {
            tracked.watch.ignore_baseline_windows
                || !tracked.watch.baseline_window_ids.contains(&window.hwnd)
        })
        .collect::<Vec<_>>();
    // Match foreground by HWND only when Windows reports one. A PID alone is
    // not sufficient because Windows reuses PIDs and an unrelated process could
    // inherit the number while the old HWND is gone.
    let foreground_matches = match observation.foreground.hwnd {
        Some(hwnd) => windows.iter().any(|window| window.hwnd == hwnd),
        None => observation
            .foreground
            .process_id
            .is_some_and(|process_id| window_pids.contains(&process_id)),
    };

    // Remember the creation time of each process this launch owns while it is
    // still observed. The focus grant for an ended launch is keyed on these
    // identities, so a later PID reuse cannot inherit it. Matches only count as
    // owned when the watch is scoped to the root's descendants: an image-name
    // match across the whole machine could name the user's unrelated windows.
    // The root is always owned, because this launch started or attached to it.
    let mut owned_now: Vec<u32> = if tracked.watch.descendants_only {
        window_pids.iter().copied().collect()
    } else {
        Vec::new()
    };
    if !tracked.watch.root_reused {
        owned_now.extend(tracked.watch.root_process_id);
    }
    for process_id in owned_now {
        if let Some(identity) = observation.identities.get(&process_id) {
            tracked
                .known_identities
                .entry(process_id)
                .or_insert(identity.created_at_100ns);
        }
    }

    let mut process_ids = window_pids.into_iter().collect::<Vec<_>>();
    process_ids.sort_unstable();
    tracked.session.process_ids = process_ids;
    let previously_foreground = tracked.session.foreground;
    let verified_foreground_owner = !tracked.session.pid_reuse_detected
        && windows.iter().any(|window| {
            Some(window.hwnd) == observation.foreground.hwnd
                && observation
                    .identities
                    .get(&window.process_id)
                    .is_some_and(|live| {
                        live.created_at_100ns != 0
                            && tracked.known_identities.get(&window.process_id)
                                == Some(&live.created_at_100ns)
                            && window.process_created_at_100ns == Some(live.created_at_100ns)
                    })
        });
    if verified_foreground_owner
        && (!previously_foreground || tracked.session.last_activation_at_ms.is_none())
    {
        tracked.session.last_activation_at_ms = Some(observation.at_ms);
    }
    tracked.session.foreground = foreground_matches;
    // Keep the last known HWND when the window list is temporarily empty. The
    // close guard below must be able to distinguish a closed window from one
    // that is merely cloaked or on another virtual desktop.
    if let Some(window) = windows
        .iter()
        .find(|window| Some(window.hwnd) == observation.foreground.hwnd)
        .or_else(|| windows.first())
    {
        tracked.session.window_id = Some(window.hwnd);
    }

    // Edge Cinema may keep helper/browser processes alive after the visible app
    // window closes. For launches that opt in, a missing window is a terminal
    // condition even while a background process still exists. A known HWND that
    // still exists (cloaked/other virtual desktop) is not "closed".
    if tracked.watch.end_on_window_gone && process_running {
        let last_window_alive = tracked
            .session
            .window_id
            .is_some_and(crate::window_broker::is_window_alive);
        if window_close_is_terminal(windows.is_empty(), foreground_matches, last_window_alive)
            && matches!(
                tracked.session.phase,
                LaunchPhase::ProcessStarted
                    | LaunchPhase::WindowAppeared
                    | LaunchPhase::SessionActive
            )
        {
            let absent_since = *tracked
                .window_absent_since_ms
                .get_or_insert(observation.at_ms);
            let timeout = if tracked.session.phase == LaunchPhase::ProcessStarted {
                tracked.watch.start_timeout_ms
            } else {
                EXIT_GRACE_MS
            };
            if observation.at_ms.saturating_sub(absent_since) >= timeout {
                tracked.session.attention =
                    Some("Okno aplikacji zniknęło; sesja zakończona bezpiecznie.".into());
                return set_phase(tracked, LaunchPhase::Ended, observation.at_ms, None);
            }
        } else {
            tracked.window_absent_since_ms = None;
        }
    } else {
        tracked.window_absent_since_ms = None;
    }

    let next = match tracked.session.phase {
        LaunchPhase::Requested => {
            if process_running {
                Some(LaunchPhase::ProcessStarted)
            } else if observation
                .at_ms
                .saturating_sub(tracked.session.started_at_ms)
                >= tracked.watch.start_timeout_ms
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
        LaunchPhase::Ended | LaunchPhase::Failed | LaunchPhase::Cancelled => None,
    };

    if next == Some(LaunchPhase::ExitPending) && tracked.absent_since_ms.is_none() {
        tracked.absent_since_ms = Some(observation.at_ms);
    }
    if next != Some(LaunchPhase::ExitPending) && process_running {
        tracked.absent_since_ms = None;
    }
    next.and_then(|phase| set_phase(tracked, phase, observation.at_ms, None))
        .or_else(|| {
            // Reuse the existing event channel for visible ownership/focus changes.
            // Stable watcher ticks remain silent; no second polling loop is added.
            if tracked.session.foreground == previous_foreground
                && tracked.session.last_activation_at_ms == previous_activation
                && tracked.session.window_id == previous_window
            {
                return None;
            }
            tracked.session.updated_at_ms = observation.at_ms;
            Some(LaunchEvent {
                previous_phase: tracked.session.phase,
                at_ms: observation.at_ms,
                session: tracked.session.clone(),
            })
        })
}

impl LaunchRegistry {
    pub(crate) fn snapshot(&self) -> LaunchRegistrySnapshot {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot()
    }

    fn register(&self, app: &AppHandle, mut watch: LaunchWatch) -> Result<LaunchSession, String> {
        let _registration = self
            .registration
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let orchestrator = app.state::<session_orchestrator::SessionOrchestrator>();
        let _transaction = orchestrator.lock_transaction();
        if !watch.baseline_captured {
            capture_baseline(app, &mut watch)?;
        }
        if watch.root_identity.is_none() {
            watch.root_identity = watch.root_process_id.and_then(process_table::identity);
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
            last_activation_at_ms: None,
            error: None,
            restore: None,
            session_revision: None,
            pid_reuse_detected: false,
            attention: None,
        };
        let target = session_target_for(watch.kind, watch.session_target);
        let context = SessionContext::for_launch(&session.id, session.app_id.as_deref(), None);

        // The session transition is validated and applied before the launch is
        // published. A failed multi-step fallback therefore cannot leave an
        // active LaunchRegistry entry without a session owner.
        let mut session = session;
        if let Some(target) = target {
            let current = session_orchestrator::current_snapshot(app);
            let steps = session_orchestrator::transition_steps(current.current, target)?;
            let last_index = steps.len().saturating_sub(1);
            for (index, step) in steps.iter().enumerate() {
                let step_context = (index == last_index).then(|| context.clone());
                session_orchestrator::apply_transition(
                    app,
                    *step,
                    TransitionCause::Launch,
                    step_context,
                )
                .map_err(|error| error.message)?;
            }
            let applied = session_orchestrator::current_snapshot(app);
            if applied.current != target {
                return Err(
                    "Sesja nie osiągnęła stanu docelowego; uruchomienie nie zostało zarejestrowane."
                        .into(),
                );
            }
            session.session_revision = Some(applied.revision);
        }

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
                window_absent_since_ms: None,
                known_identities: HashMap::new(),
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
                        finished.push((event.session.clone(), tracked.known_identities.clone()));
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
        let orchestrator = app.state::<session_orchestrator::SessionOrchestrator>();
        let _transaction = orchestrator.lock_transaction();
        for launch_id in failed {
            session_orchestrator::finish_launch_session_inner(app, &launch_id);
        }

        for (session, owners) in finished {
            let owns_session = session_orchestrator::launch_owns_session(app, &session.id);
            let restore = if owns_session {
                Some(window_broker::restore_velora_after_session_end(
                    app, &owners,
                ))
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
                session_orchestrator::finish_launch_session_inner(app, &session.id);
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
static WATCHER_STOP: AtomicBool = AtomicBool::new(false);

fn ensure_watcher(app: AppHandle) {
    if WATCHER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    WATCHER_STOP.store(false, Ordering::Release);
    let spawned = std::thread::Builder::new()
        .name("velora-launch-registry".into())
        .spawn(move || {
            loop {
                if WATCHER_STOP.load(Ordering::Acquire) {
                    break;
                }
                let active = app.state::<LaunchRegistry>().active_count();
                if active > 0 {
                    match watcher_tick(&app) {
                        Ok(()) => {}
                        Err(error) => app.state::<LaunchRegistry>().observation_error(&app, error),
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(if active > 0 {
                    ACTIVE_POLL_MS
                } else {
                    IDLE_POLL_MS
                }));
            }
            WATCHER_STARTED.store(false, Ordering::Release);
        });
    if spawned.is_err() {
        WATCHER_STARTED.store(false, Ordering::Release);
    }
}

pub(crate) fn stop_watcher() {
    WATCHER_STOP.store(true, Ordering::Release);
}

fn watcher_tick(app: &AppHandle) -> Result<(), String> {
    let registry = app.state::<LaunchRegistry>();
    let watches = registry.tracker_watches();
    if watches.is_empty() {
        return Ok(());
    }
    let table = process_table::snapshot(false)?;
    let mut process_ids = HashSet::new();
    for (_, watch) in &watches {
        process_ids.extend(matching_pids(&table, watch));
        if let Some(root) = watch.root_process_id {
            process_ids.insert(root);
        }
    }
    // Creation times are read only for the handful of PIDs a launch owns, not
    // for every process in the snapshot.
    let identities = process_ids
        .iter()
        .filter_map(|process_id| process_table::identity(*process_id))
        .map(|identity| (identity.process_id, identity))
        .collect::<HashMap<_, _>>();
    let windows = window_broker::windows_for_processes(app, &process_ids);
    let foreground = window_broker::foreground(app);
    let observation = Observation {
        table,
        windows,
        foreground,
        identities,
        at_ms: now_ms(),
    };
    registry.apply_observation(app, observation);
    Ok(())
}

/// Resets the exit grace window after sleep/wake. A process that disappeared
/// during sleep gets a fresh five-second window instead of an immediate end,
/// and a process that survived keeps its session. Returns the active count.
fn reset_resume_state(launches: &mut [TrackedLaunch], at_ms: u64) -> usize {
    let mut active = 0;
    for tracked in launches {
        if tracked.session.phase.is_active() {
            tracked.absent_since_ms = None;
            tracked.session.updated_at_ms = at_ms;
            active += 1;
        }
    }
    active
}

pub(crate) fn handle_system_resume(app: &AppHandle, at_ms: u64) -> usize {
    let registry = app.state::<LaunchRegistry>();
    let active = {
        let mut state = registry
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_resume_state(&mut state.launches, at_ms)
    };
    if active > 0 {
        if let Err(error) = watcher_tick(app) {
            registry.observation_error(app, error);
        }
    }
    active
}

pub(crate) fn is_launch_active(app: &AppHandle, launch_id: &str) -> bool {
    app.state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .launches
        .iter()
        .any(|tracked| tracked.session.id == launch_id && tracked.session.phase.is_active())
}

/// Only an active launch may own a session. Used before starting a duplicate.
pub(crate) fn active_launch_for_app(app: &AppHandle, app_id: &str) -> Option<LaunchSession> {
    app.state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .launches
        .iter()
        .filter(|tracked| {
            tracked.session.app_id.as_deref() == Some(app_id) && tracked.session.phase.is_active()
        })
        .max_by_key(|tracked| tracked.session.started_at_ms)
        .map(|tracked| tracked.session.clone())
}

/// All active, service-scoped Edge Cinema launches. The LaunchRegistry remains
/// the sole lifecycle store; this is a read-only projection for the adapter's
/// per-service markers and status selection.
pub(crate) fn active_cinema_launches(app: &AppHandle) -> Vec<LaunchSession> {
    let mut launches = app
        .state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .launches
        .iter()
        .filter(|tracked| {
            tracked.session.kind == LaunchKind::Cinema
                && tracked
                    .session
                    .app_id
                    .as_deref()
                    .is_some_and(crate::edge_cinema::is_service_cinema_app_id)
                && tracked.session.phase.is_active()
        })
        .map(|tracked| tracked.session.clone())
        .collect::<Vec<_>>();
    launches.sort_by_key(|launch| launch.started_at_ms);
    launches
}

pub(crate) fn latest_cinema_launch(app: &AppHandle, active_only: bool) -> Option<LaunchSession> {
    app.state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .launches
        .iter()
        .filter(|tracked| {
            tracked.session.kind == LaunchKind::Cinema
                && tracked
                    .session
                    .app_id
                    .as_deref()
                    .is_some_and(crate::edge_cinema::is_service_cinema_app_id)
                && (!active_only || tracked.session.phase.is_active())
        })
        .max_by_key(|tracked| tracked.session.started_at_ms)
        .map(|tracked| tracked.session.clone())
}

/// Process identities captured by this exact active launch. Callers can use
/// them to validate an observed HWND without trusting a PID alone.
pub(crate) fn owned_process_identities_for_launch(
    app: &AppHandle,
    launch_id: &str,
) -> Vec<ProcessIdentity> {
    app.state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .launches
        .iter()
        .find(|tracked| {
            tracked.session.id == launch_id
                && tracked.session.kind == LaunchKind::Cinema
                && tracked.session.phase.is_active()
                && tracked
                    .session
                    .app_id
                    .as_deref()
                    .is_some_and(crate::edge_cinema::is_service_cinema_app_id)
        })
        .map(captured_active_identities)
        .unwrap_or_default()
}

fn captured_active_identities(tracked: &TrackedLaunch) -> Vec<ProcessIdentity> {
    if !tracked.session.phase.is_active()
        || tracked.session.pid_reuse_detected
        || tracked.watch.root_reused
    {
        return Vec::new();
    }
    let mut identities = tracked
        .known_identities
        .iter()
        .filter_map(|(process_id, created_at_100ns)| {
            (*process_id != 0 && *created_at_100ns != 0).then_some(ProcessIdentity {
                process_id: *process_id,
                created_at_100ns: *created_at_100ns,
            })
        })
        .collect::<Vec<_>>();
    if let Some(identity) = tracked.watch.root_identity {
        if identity.process_id != 0
            && identity.created_at_100ns != 0
            && !identities
                .iter()
                .any(|known| known.process_id == identity.process_id)
        {
            identities.push(identity);
        }
    }
    identities.sort_by_key(|identity| identity.process_id);
    identities
}

/// Captured identities for any one active launch, never a fresh process-name
/// match. Snapshots root and observed descendants while holding the registry
/// lock; callers still have to revalidate the live HWND and process timestamp.
pub(crate) fn owned_identities_for_active_launch(
    app: &AppHandle,
    launch_id: &str,
) -> Vec<ProcessIdentity> {
    app.state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .launches
        .iter()
        .find(|tracked| tracked.session.id == launch_id)
        .map(captured_active_identities)
        .unwrap_or_default()
}

/// Re-select a still-active service launch after Home or another launch. This
/// updates the authoritative SessionContext to the chosen launch without
/// creating a duplicate registry entry or superseding a sibling service.
pub(crate) fn select_existing_cinema_launch(
    app: &AppHandle,
    launch_id: &str,
) -> Result<LaunchSession, String> {
    let launch =
        launch_by_id(app, launch_id).ok_or_else(|| "Nie znaleziono sesji usługi.".to_string())?;
    if launch.kind != LaunchKind::Cinema
        || !launch
            .app_id
            .as_deref()
            .is_some_and(crate::edge_cinema::is_service_cinema_app_id)
    {
        return Err("Sesja nie jest usługą Edge Cinema.".into());
    }
    select_existing_launch(app, launch_id)
}

/// Re-select an existing managed session after Home without superseding another
/// registry entry. This native-only helper receives an already allowlisted app.
pub(crate) fn select_existing_launch(
    app: &AppHandle,
    launch_id: &str,
) -> Result<LaunchSession, String> {
    let registry = app.state::<LaunchRegistry>();
    let _registration = registry
        .registration
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let orchestrator = app.state::<session_orchestrator::SessionOrchestrator>();
    let _transaction = orchestrator.lock_transaction();
    let mut state = registry
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tracked_index = state
        .launches
        .iter()
        .position(|tracked| {
            tracked.session.id == launch_id
                && tracked.session.phase.is_active()
                && !tracked.session.pid_reuse_detected
        })
        .ok_or_else(|| "Nie znaleziono aktywnej sesji tej usługi Edge Cinema.".to_string())?;
    let mut session = state.launches[tracked_index].session.clone();
    let Some(target) = session_target_for(
        session.kind,
        state.launches[tracked_index].watch.session_target,
    ) else {
        return Ok(session);
    };

    let context = SessionContext::for_launch(&session.id, session.app_id.as_deref(), None);
    let current = session_orchestrator::current_snapshot(app);
    let steps = session_orchestrator::transition_steps(current.current, target)?;
    let last_index = steps.len().saturating_sub(1);
    let mut applied = current;
    for (index, step) in steps.iter().enumerate() {
        applied = session_orchestrator::apply_transition(
            app,
            *step,
            TransitionCause::Launch,
            (index == last_index).then(|| context.clone()),
        )
        .map_err(|error| error.message)?;
    }
    if applied.current != target
        || applied
            .context
            .as_ref()
            .and_then(|context| context.launch_id.as_deref())
            != Some(session.id.as_str())
    {
        return Err("Nie udało się przypisać wybranej usługi do aktywnej sesji.".into());
    }
    session.session_revision = Some(applied.revision);
    state.launches[tracked_index].session.session_revision = session.session_revision;
    state.launches[tracked_index].session.updated_at_ms = now_ms();
    Ok(session)
}

pub(crate) fn launch_by_id(app: &AppHandle, launch_id: &str) -> Option<LaunchSession> {
    app.state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .launches
        .iter()
        .find(|tracked| tracked.session.id == launch_id)
        .map(|tracked| tracked.session.clone())
}

/// Explicit cancellation. It is idempotent for terminal launches: a repeated
/// request returns the already-finished session instead of emitting again.
pub(crate) fn cancel_launch(app: &AppHandle, launch_id: &str) -> Result<LaunchSession, String> {
    let registry = app.state::<LaunchRegistry>();
    let _registration = registry
        .registration
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let orchestrator = app.state::<session_orchestrator::SessionOrchestrator>();
    let _transaction = orchestrator.lock_transaction();
    let (session, event) = {
        let mut state = registry
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let tracked = state
            .launches
            .iter_mut()
            .find(|tracked| tracked.session.id == launch_id)
            .ok_or_else(|| {
                "Nie znaleziono sesji uruchomienia o podanym identyfikatorze.".to_string()
            })?;
        if tracked.session.phase.is_terminal() {
            return Ok(tracked.session.clone());
        }
        let event = set_phase(
            tracked,
            LaunchPhase::Cancelled,
            now_ms(),
            Some("Uruchomienie zostało anulowane przez użytkownika.".into()),
        );
        (tracked.session.clone(), event)
    };
    for process_id in &session.process_ids {
        window_broker::release_process(app, *process_id);
    }
    if let Some(event) = event {
        let _ = app.emit(LAUNCH_EVENT, event);
    }
    session_orchestrator::finish_launch_session_inner(app, launch_id);
    Ok(session)
}

pub(crate) fn track_launch(app: &AppHandle, watch: LaunchWatch) -> Result<LaunchSession, String> {
    app.state::<LaunchRegistry>().register(app, watch)
}

pub(crate) fn find_process_id(image_name: &str) -> Option<u32> {
    process_table::snapshot(true)
        .ok()?
        .find_process_id(image_name)
}

#[tauri::command]
pub fn cancel_launch_session(app: AppHandle, launch_id: String) -> Result<LaunchSession, String> {
    cancel_launch(&app, &launch_id)
}

#[tauri::command]
pub fn get_launch_registry_status(app: AppHandle) -> LaunchRegistrySnapshot {
    app.state::<LaunchRegistry>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot()
}

#[cfg(test)]
mod tests {
    use super::{
        advance, apply_baseline, matching_pids, reset_resume_state, same_launch_group, set_phase,
        window_close_is_terminal, LaunchKind, LaunchPhase, LaunchSession, LaunchWatch, Observation,
        ProcessTable, TrackedLaunch, EXIT_GRACE_MS, START_TIMEOUT_MS,
    };
    use crate::process_table::ProcessIdentity;
    use crate::window_broker::{ForegroundWindow, TrackedWindow};
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;

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
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch: watch(),
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        }
    }

    #[test]
    fn captured_resume_owners_require_an_active_unrecycled_process_instance() {
        let mut launch = tracked();
        launch.watch.root_process_id = Some(10);
        assert!(launch.watch.capture_root_identity(ProcessIdentity {
            process_id: 10,
            created_at_100ns: 100
        }));
        assert!(!launch.watch.capture_root_identity(ProcessIdentity {
            process_id: 10,
            created_at_100ns: 101
        }));
        assert!(!launch.watch.capture_root_identity(ProcessIdentity {
            process_id: 11,
            created_at_100ns: 100
        }));
        launch.known_identities.insert(20, 200);
        assert_eq!(
            super::captured_active_identities(&launch),
            vec![
                ProcessIdentity {
                    process_id: 10,
                    created_at_100ns: 100
                },
                ProcessIdentity {
                    process_id: 20,
                    created_at_100ns: 200
                }
            ]
        );
        launch.session.pid_reuse_detected = true;
        assert!(super::captured_active_identities(&launch).is_empty());
        launch.session.pid_reuse_detected = false;
        launch.session.phase = LaunchPhase::Ended;
        assert!(super::captured_active_identities(&launch).is_empty());
    }

    fn observation(
        processes: Vec<(u32, u32, &str)>,
        windows: Vec<(u64, u32, &str)>,
        foreground: Option<u64>,
        at_ms: u64,
    ) -> Observation {
        Observation {
            table: Arc::new(ProcessTable::from_entries(processes)),
            windows: windows
                .into_iter()
                .map(|(hwnd, process_id, class_name)| TrackedWindow {
                    hwnd,
                    process_id,
                    process_name: None,
                    class_name: Some(class_name.into()),
                    process_created_at_100ns: None,
                    score: 0,
                    is_main: false,
                })
                .collect(),
            foreground: ForegroundWindow {
                hwnd: foreground,
                process_id: foreground.map(|_| 200),
                process_name: None,
                class_name: None,
                window_present: foreground.is_some(),
            },
            identities: HashMap::new(),
            at_ms,
        }
    }

    #[test]
    fn activation_time_records_owned_foreground_entries_not_observation_ticks() {
        let mut launch = tracked();
        launch.watch.root_process_id = Some(200);
        let observed = |foreground, at_ms, created_at| {
            let mut value = observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![(700, 200, "SDL_app")],
                foreground,
                at_ms,
            );
            value.windows[0].process_created_at_100ns = Some(created_at);
            value.identities.insert(
                200,
                ProcessIdentity {
                    process_id: 200,
                    created_at_100ns: created_at,
                },
            );
            value
        };
        advance(&mut launch, &observed(Some(700), 2_000, 123));
        assert_eq!(launch.session.last_activation_at_ms, Some(2_000));
        advance(&mut launch, &observed(Some(700), 3_000, 123));
        assert_eq!(launch.session.last_activation_at_ms, Some(2_000));
        advance(&mut launch, &observed(None, 4_000, 123));
        assert_eq!(launch.session.last_activation_at_ms, Some(2_000));
        advance(&mut launch, &observed(Some(700), 5_000, 123));
        assert_eq!(launch.session.last_activation_at_ms, Some(5_000));
        advance(&mut launch, &observed(None, 6_000, 123));
        advance(&mut launch, &observed(Some(700), 7_000, 999));
        assert!(launch.session.pid_reuse_detected);
        assert_eq!(launch.session.last_activation_at_ms, Some(5_000));
    }

    #[test]
    fn active_foreground_changes_notify_existing_subscribers_without_tick_spam() {
        let mut launch = tracked();
        launch.watch.root_process_id = Some(200);
        launch.session.phase = LaunchPhase::SessionActive;
        launch.session.foreground = true;
        launch.session.window_id = Some(700);
        launch.session.last_activation_at_ms = Some(1_500);
        let observed = |foreground, at_ms| {
            let mut value = observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![(700, 200, "SDL_app")],
                foreground,
                at_ms,
            );
            value.windows[0].process_created_at_100ns = Some(123);
            value.identities.insert(
                200,
                ProcessIdentity {
                    process_id: 200,
                    created_at_100ns: 123,
                },
            );
            value
        };
        assert!(advance(&mut launch, &observed(Some(700), 2_000)).is_none());
        let background = advance(&mut launch, &observed(None, 3_000)).unwrap();
        assert_eq!(background.previous_phase, LaunchPhase::SessionActive);
        assert_eq!(background.session.phase, LaunchPhase::SessionActive);
        assert!(!background.session.foreground);
        assert_eq!(background.session.last_activation_at_ms, Some(1_500));
        assert!(advance(&mut launch, &observed(None, 4_000)).is_none());
        let foreground = advance(&mut launch, &observed(Some(700), 5_000)).unwrap();
        assert!(foreground.session.foreground);
        assert_eq!(foreground.session.last_activation_at_ms, Some(5_000));
        assert!(advance(&mut launch, &observed(Some(700), 6_000)).is_none());
    }

    #[test]
    fn matching_an_unowned_process_name_does_not_record_an_activation() {
        let mut launch = tracked();
        let mut value = observation(
            vec![(200, 1, "Playnite.FullscreenApp.exe")],
            vec![(700, 200, "SDL_app")],
            Some(700),
            2_000,
        );
        value.windows[0].process_created_at_100ns = Some(123);
        value.identities.insert(
            200,
            ProcessIdentity {
                process_id: 200,
                created_at_100ns: 123,
            },
        );
        advance(&mut launch, &value);
        assert_eq!(launch.session.last_activation_at_ms, None);
    }

    #[test]
    fn distinguishes_process_window_active_and_exit_phases() {
        let mut session = tracked();
        assert_eq!(session.session.phase, LaunchPhase::Requested);

        let event = advance(
            &mut session,
            &observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![],
                None,
                2_000,
            ),
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

        let event = advance(&mut session, &observation(vec![], vec![], None, 10_000)).unwrap();
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
            &observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![],
                None,
                2_000,
            ),
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
            &observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![],
                None,
                2_000,
            ),
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
            &observation(
                vec![(200, 1, "Playnite.FullscreenApp.exe")],
                vec![],
                None,
                2_000,
            ),
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
                process_created_at_100ns: None,
                score: 0,
                is_main: false,
            },
            TrackedWindow {
                hwnd: 11,
                process_id: 102,
                process_name: Some("Cyberpunk2077.exe".into()),
                class_name: None,
                process_created_at_100ns: None,
                score: 0,
                is_main: false,
            },
        ];
        apply_baseline(&mut watch, &table, &windows);
        assert_eq!(watch.baseline_process_ids, HashSet::from([102]));
        assert_eq!(watch.baseline_window_ids, HashSet::from([10, 11]));
        assert!(watch.baseline_active);
        assert!(watch.baseline_captured);
        assert!(matching_pids(&table, &watch).contains(&102));

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
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch,
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        };
        let event = advance(
            &mut session,
            &Observation {
                table: Arc::new(ProcessTable::from_entries(vec![
                    (100, 0, "steam.exe"),
                    (101, 100, "steamwebhelper.exe"),
                    (103, 100, "Cyberpunk2077.exe"),
                ])),
                windows: vec![
                    TrackedWindow {
                        hwnd: 10,
                        process_id: 101,
                        process_name: Some("steam.exe".into()),
                        class_name: None,
                        process_created_at_100ns: None,
                        score: 0,
                        is_main: false,
                    },
                    TrackedWindow {
                        hwnd: 12,
                        process_id: 103,
                        process_name: Some("Cyberpunk2077.exe".into()),
                        class_name: None,
                        process_created_at_100ns: None,
                        score: 0,
                        is_main: false,
                    },
                ],
                foreground: ForegroundWindow::default(),
                identities: HashMap::new(),
                at_ms: 5_000,
            },
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::ProcessStarted);
        assert_eq!(event.session.process_ids, vec![103]);
        assert_eq!(event.session.window_id, Some(12));
    }

    #[test]
    fn cinema_root_window_counts_even_for_a_descendant_only_watch() {
        let mut watch = LaunchWatch::new(
            LaunchKind::Cinema,
            "Edge Cinema",
            Some("edge-cinema".into()),
            Vec::new(),
            Some(300),
            true,
            true,
            Vec::new(),
            true,
            Some(crate::session_orchestrator::SessionId::Cinema),
        )
        .detect_window_close()
        .include_root_window();
        watch.baseline_captured = true;
        let mut session = TrackedLaunch {
            session: LaunchSession {
                id: "cinema-1".into(),
                kind: LaunchKind::Cinema,
                display_name: "Edge Cinema".into(),
                app_id: Some("edge-cinema".into()),
                phase: LaunchPhase::Requested,
                process_ids: Vec::new(),
                foreground: false,
                window_id: None,
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch,
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        };
        let observation = observation(
            vec![(300, 1, "msedge.exe"), (301, 300, "msedge.exe")],
            vec![(700, 300, "Chrome_WidgetWin_1")],
            Some(700),
            2_000,
        );
        let event = advance(&mut session, &observation).unwrap();
        assert_eq!(event.session.phase, LaunchPhase::ProcessStarted);
        let event = advance(&mut session, &observation).unwrap();
        assert_eq!(event.session.phase, LaunchPhase::SessionActive);
        assert_eq!(event.session.window_id, Some(700));
        assert!(event.session.process_ids.contains(&300));
        assert!(event.session.process_ids.contains(&301));
        assert!(event.session.foreground);
    }

    #[test]
    fn cinema_window_close_ends_a_lingering_browser_process_after_grace() {
        let mut watch = LaunchWatch::new(
            LaunchKind::Cinema,
            "Edge Cinema",
            Some("edge-cinema".into()),
            Vec::new(),
            Some(300),
            true,
            true,
            Vec::new(),
            true,
            Some(crate::session_orchestrator::SessionId::Cinema),
        )
        .detect_window_close()
        .include_root_window();
        watch.baseline_captured = true;
        let mut session = TrackedLaunch {
            session: LaunchSession {
                id: "cinema-2".into(),
                kind: LaunchKind::Cinema,
                display_name: "Edge Cinema".into(),
                app_id: Some("edge-cinema".into()),
                phase: LaunchPhase::SessionActive,
                process_ids: vec![300],
                foreground: true,
                window_id: None,
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch,
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        };
        // The browser process still exists, but its visible app window is gone.
        let background = advance(
            &mut session,
            &observation(vec![(300, 1, "msedge.exe")], vec![], None, 2_000),
        )
        .unwrap();
        assert_eq!(background.previous_phase, LaunchPhase::SessionActive);
        assert_eq!(background.session.phase, LaunchPhase::SessionActive);
        assert!(!background.session.foreground);
        assert_eq!(session.session.phase, LaunchPhase::SessionActive);
        let event = advance(
            &mut session,
            &observation(
                vec![(300, 1, "msedge.exe")],
                vec![],
                None,
                2_000 + EXIT_GRACE_MS,
            ),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::Ended);
        assert!(event.session.attention.is_some());
    }

    #[test]
    fn cinema_window_reappearing_during_grace_keeps_the_session() {
        let mut watch = LaunchWatch::new(
            LaunchKind::Cinema,
            "Edge Cinema",
            Some("edge-cinema".into()),
            Vec::new(),
            Some(300),
            true,
            true,
            Vec::new(),
            true,
            Some(crate::session_orchestrator::SessionId::Cinema),
        )
        .detect_window_close()
        .include_root_window();
        watch.baseline_captured = true;
        let mut session = TrackedLaunch {
            session: LaunchSession {
                id: "cinema-3".into(),
                kind: LaunchKind::Cinema,
                display_name: "Edge Cinema".into(),
                app_id: Some("edge-cinema".into()),
                phase: LaunchPhase::SessionActive,
                process_ids: vec![300],
                foreground: true,
                window_id: None,
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch,
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        };
        let background = advance(
            &mut session,
            &observation(vec![(300, 1, "msedge.exe")], vec![], None, 2_000),
        )
        .unwrap();
        assert_eq!(background.previous_phase, LaunchPhase::SessionActive);
        assert_eq!(background.session.phase, LaunchPhase::SessionActive);
        assert!(!background.session.foreground);
        assert!(session.window_absent_since_ms.is_some());
        advance(
            &mut session,
            &observation(
                vec![(300, 1, "msedge.exe")],
                vec![(700, 300, "Chrome_WidgetWin_1")],
                Some(700),
                3_000,
            ),
        );
        assert!(session.window_absent_since_ms.is_none());
        assert_eq!(session.session.phase, LaunchPhase::SessionActive);
    }

    #[test]
    fn cinema_launches_coexist_across_services_and_deduplicate_within_a_service() {
        assert!(same_launch_group(
            LaunchKind::Cinema,
            Some("edge-cinema:netflix"),
            LaunchKind::Cinema,
            Some("edge-cinema:netflix"),
        ));
        assert!(!same_launch_group(
            LaunchKind::Cinema,
            Some("edge-cinema:netflix"),
            LaunchKind::Cinema,
            Some("edge-cinema:disney"),
        ));
        assert!(!same_launch_group(
            LaunchKind::Cinema,
            Some("edge-cinema"),
            LaunchKind::Cinema,
            Some("edge-cinema:netflix"),
        ));
        assert!(!same_launch_group(
            LaunchKind::Cinema,
            Some("edge-cinema:netflix"),
            LaunchKind::ManagedApp,
            Some("edge"),
        ));
        assert!(!same_launch_group(
            LaunchKind::ManagedApp,
            Some("edge"),
            LaunchKind::Cinema,
            Some("edge-cinema:netflix"),
        ));
        assert_eq!(
            super::session_target_for(
                LaunchKind::Cinema,
                Some(crate::session_orchestrator::SessionId::Cinema)
            ),
            Some(crate::session_orchestrator::SessionId::Cinema)
        );
        assert_eq!(
            crate::session_orchestrator::transition_steps(
                crate::session_orchestrator::SessionId::Cinema,
                crate::session_orchestrator::SessionId::Cinema,
            )
            .unwrap(),
            vec![crate::session_orchestrator::SessionId::Cinema],
            "selecting another active Cinema service still reapplies its context"
        );
    }

    #[test]
    fn missing_window_does_not_forget_the_last_known_hwnd() {
        let mut watch = LaunchWatch::new(
            LaunchKind::Cinema,
            "Edge Cinema",
            Some("edge-cinema".into()),
            Vec::new(),
            Some(300),
            true,
            true,
            Vec::new(),
            true,
            Some(crate::session_orchestrator::SessionId::Cinema),
        )
        .detect_window_close()
        .include_root_window();
        watch.baseline_captured = true;
        let mut session = TrackedLaunch {
            session: LaunchSession {
                id: "cinema-hwnd".into(),
                kind: LaunchKind::Cinema,
                display_name: "Edge Cinema".into(),
                app_id: Some("edge-cinema".into()),
                phase: LaunchPhase::SessionActive,
                process_ids: vec![300],
                foreground: true,
                window_id: Some(700),
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch,
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        };
        advance(
            &mut session,
            &observation(vec![(300, 1, "msedge.exe")], vec![], None, 2_000),
        );
        assert_eq!(
            session.session.window_id,
            Some(700),
            "the last HWND is needed to distinguish closed from cloaked"
        );
    }

    #[test]
    fn window_close_requires_no_window_no_focus_and_a_dead_last_hwnd() {
        assert!(window_close_is_terminal(true, false, false));
        assert!(!window_close_is_terminal(false, false, false));
        assert!(!window_close_is_terminal(true, true, false));
        assert!(
            !window_close_is_terminal(true, false, true),
            "a cloaked/other-desktop window is not closed"
        );
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
        assert_eq!(matching_pids(&table, &watch), HashSet::from([102]));
    }

    #[test]
    fn resume_resets_the_exit_grace_without_ending_a_session() {
        let mut session = tracked();
        session.session.phase = LaunchPhase::ExitPending;
        session.absent_since_ms = Some(1_000);
        let active = reset_resume_state(std::slice::from_mut(&mut session), 20_000);
        assert_eq!(active, 1);
        assert!(session.absent_since_ms.is_none());
        assert_eq!(session.session.updated_at_ms, 20_000);
    }

    #[test]
    fn a_recycled_root_pid_ends_the_old_session_after_grace() {
        let watch = LaunchWatch::new(
            LaunchKind::Game,
            "Game",
            None,
            Vec::new(),
            Some(100),
            true,
            true,
            Vec::new(),
            true,
            None,
        );
        let mut session = TrackedLaunch {
            session: LaunchSession {
                id: "game-reuse".into(),
                kind: LaunchKind::Game,
                display_name: "Game".into(),
                app_id: None,
                phase: LaunchPhase::Requested,
                process_ids: Vec::new(),
                foreground: false,
                window_id: None,
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch,
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        };
        let first_identity = ProcessIdentity {
            process_id: 100,
            created_at_100ns: 5_000,
        };
        let first = Observation {
            table: Arc::new(ProcessTable::from_entries(vec![
                (100, 0, "steam.exe"),
                (101, 100, "Game.exe"),
            ])),
            windows: Vec::new(),
            foreground: ForegroundWindow::default(),
            identities: HashMap::from([
                (100, first_identity),
                (
                    101,
                    ProcessIdentity {
                        process_id: 101,
                        created_at_100ns: 5_001,
                    },
                ),
            ]),
            at_ms: 2_000,
        };
        advance(&mut session, &first);
        assert_eq!(session.session.phase, LaunchPhase::ProcessStarted);
        assert_eq!(session.watch.root_identity, Some(first_identity));

        let reused = Observation {
            table: Arc::new(ProcessTable::from_entries(vec![(100, 0, "other.exe")])),
            windows: Vec::new(),
            foreground: ForegroundWindow::default(),
            identities: HashMap::from([(
                100,
                ProcessIdentity {
                    process_id: 100,
                    created_at_100ns: 9_000,
                },
            )]),
            at_ms: 3_000,
        };
        advance(&mut session, &reused);
        assert!(session.watch.root_reused);
        assert!(session.session.pid_reuse_detected);
        assert!(session.session.attention.is_some());
        assert_eq!(session.session.phase, LaunchPhase::ExitPending);
        advance(&mut session, &reused_at(3_000 + EXIT_GRACE_MS));
        assert_eq!(session.session.phase, LaunchPhase::Ended);
    }

    fn reused_at(at_ms: u64) -> Observation {
        Observation {
            table: Arc::new(ProcessTable::from_entries(vec![(100, 0, "other.exe")])),
            windows: Vec::new(),
            foreground: ForegroundWindow::default(),
            identities: HashMap::from([(
                100,
                ProcessIdentity {
                    process_id: 100,
                    created_at_100ns: 9_000,
                },
            )]),
            at_ms,
        }
    }

    #[test]
    fn a_window_from_a_reused_process_instance_is_ignored() {
        let mut session = tracked();
        let observation = Observation {
            table: Arc::new(ProcessTable::from_entries(vec![(
                200,
                1,
                "Playnite.FullscreenApp.exe",
            )])),
            windows: vec![TrackedWindow {
                hwnd: 700,
                process_id: 200,
                process_name: Some("Playnite.FullscreenApp.exe".into()),
                class_name: Some("SDL_app".into()),
                process_created_at_100ns: Some(111),
                score: 80,
                is_main: true,
            }],
            foreground: ForegroundWindow {
                hwnd: Some(700),
                process_id: Some(200),
                process_name: Some("Playnite.FullscreenApp.exe".into()),
                class_name: Some("SDL_app".into()),
                window_present: true,
            },
            identities: HashMap::from([(
                200,
                ProcessIdentity {
                    process_id: 200,
                    created_at_100ns: 222,
                },
            )]),
            at_ms: 2_000,
        };
        let event = advance(&mut session, &observation).unwrap();
        assert_eq!(event.session.phase, LaunchPhase::ProcessStarted);
        assert_eq!(event.session.window_id, None);
        assert!(
            !event.session.foreground,
            "a stale HWND must not count as the foreground window after PID reuse"
        );
        // A second tick with the same stale HWND still must not promote it.
        advance(&mut session, &observation);
        assert_eq!(session.session.phase, LaunchPhase::ProcessStarted);
        assert!(!session.session.foreground);
    }

    #[test]
    fn explicit_cancellation_is_terminal_and_idempotent() {
        let mut session = tracked();
        let event = set_phase(
            &mut session,
            LaunchPhase::Cancelled,
            2_000,
            Some("anulowane".into()),
        )
        .unwrap();
        assert_eq!(event.session.phase, LaunchPhase::Cancelled);
        assert!(session.session.phase.is_terminal());
        assert!(set_phase(&mut session, LaunchPhase::Cancelled, 2_100, None).is_none());
        assert!(set_phase(&mut session, LaunchPhase::Ended, 2_200, None).is_none());
    }

    #[test]
    fn malformed_or_empty_process_snapshot_does_not_fabricate_a_session() {
        let mut session = tracked();
        assert!(advance(&mut session, &observation(vec![], vec![], None, 1_500),).is_none());
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

    // ---- Deterministic simulated session workflows (no real processes) ----
    // Every pid/hwnd/creation time below is derived from the loop index. The
    // helpers drive the same pure `advance` state machine the watcher uses, so
    // the invariants hold without spawning Edge or touching the desktop.

    fn sim_cinema(id: &str, pid: u32) -> TrackedLaunch {
        let mut watch = LaunchWatch::new(
            LaunchKind::Cinema,
            "Edge Cinema",
            Some("edge-cinema:netflix".into()),
            Vec::new(),
            Some(pid),
            true,
            true,
            Vec::new(),
            true,
            Some(crate::session_orchestrator::SessionId::Cinema),
        )
        .detect_window_close()
        .include_root_window();
        watch.baseline_captured = true;
        TrackedLaunch {
            session: LaunchSession {
                id: id.into(),
                kind: LaunchKind::Cinema,
                display_name: "Edge Cinema".into(),
                app_id: Some("edge-cinema:netflix".into()),
                phase: LaunchPhase::Requested,
                process_ids: Vec::new(),
                foreground: false,
                window_id: None,
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch,
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        }
    }

    fn sim_obs(
        processes: Vec<(u32, u32, &str)>,
        windows: &[(u64, u32, u64)],
        foreground: Option<u64>,
        identities: &[(u32, u64)],
        at_ms: u64,
    ) -> Observation {
        let mut value = observation(
            processes,
            windows
                .iter()
                .map(|&(hwnd, process_id, _)| (hwnd, process_id, "Chrome_WidgetWin_1"))
                .collect(),
            foreground,
            at_ms,
        );
        for (window, &(_, _, created)) in value.windows.iter_mut().zip(windows.iter()) {
            window.process_created_at_100ns = Some(created);
        }
        value.identities.extend(identities.iter().map(|&(process_id, created)| {
            (
                process_id,
                ProcessIdentity {
                    process_id,
                    created_at_100ns: created,
                },
            )
        }));
        value
    }

    fn was_ended(event: &Option<super::LaunchEvent>) -> bool {
        event.as_ref().is_some_and(|event| event.session.phase == LaunchPhase::Ended)
    }

    /// Repeated Home → launch → window-close OR crash → restore → Home cycles.
    /// Each session ends with exactly one `Ended` transition — the single event
    /// that drives one focus restoration — and no later observation can reopen
    /// it or request focus a second time.
    #[test]
    fn soak_repeated_cinema_launch_close_and_crash_cycles_end_exactly_once() {
        // Duplicate launches of the same service are one group; sibling
        // services remain independent across the whole soak.
        for _ in 0..64u32 {
            assert!(same_launch_group(
                LaunchKind::Cinema,
                Some("edge-cinema:netflix"),
                LaunchKind::Cinema,
                Some("edge-cinema:netflix")
            ));
            assert!(!same_launch_group(
                LaunchKind::Cinema,
                Some("edge-cinema:netflix"),
                LaunchKind::Cinema,
                Some("edge-cinema:disney")
            ));
        }

        for iteration in 0..64u32 {
            let base = 1_000_000u64 + iteration as u64 * 100_000;
            let pid = 3_000 + iteration;
            let created = 500 + iteration as u64 * 13;
            let hwnd = 0x1000_0000u64 + iteration as u64 * 4;

            let mut launch = sim_cinema(&format!("cinema-soak-{iteration}"), pid);
            let processes = vec![(pid, 1u32, "msedge.exe")];
            let live_windows = [(hwnd, pid, created)];
            let ids = [(pid, created)];
            let no_windows: [(u64, u32, u64); 0] = [];
            let no_ids: [(u32, u64); 0] = [];

            // Home → launch: Requested → ProcessStarted → SessionActive.
            let live = sim_obs(processes.clone(), &live_windows, Some(hwnd), &ids, base + 1);
            assert_eq!(
                advance(&mut launch, &live).map(|e| e.session.phase),
                Some(LaunchPhase::ProcessStarted)
            );
            assert_eq!(
                advance(&mut launch, &live).map(|e| e.session.phase),
                Some(LaunchPhase::SessionActive)
            );
            assert_eq!(launch.session.window_id, Some(hwnd));

            let mut ended_events = 0u32;
            if iteration % 2 == 0 {
                // Crash: process disappears → ExitPending → Ended after grace.
                let end = advance(
                    &mut launch,
                    &sim_obs(vec![], &no_windows, None, &no_ids, base + 2),
                );
                assert_eq!(end.as_ref().map(|e| e.session.phase), Some(LaunchPhase::ExitPending));
                let end = advance(
                    &mut launch,
                    &sim_obs(vec![], &no_windows, None, &no_ids, base + 2 + EXIT_GRACE_MS + 1),
                );
                ended_events += u32::from(was_ended(&end));
            } else {
                // Window close: browser process lingers, app window is gone.
                let _ = advance(
                    &mut launch,
                    &sim_obs(processes.clone(), &no_windows, None, &ids, base + 2),
                );
                let end = advance(
                    &mut launch,
                    &sim_obs(processes.clone(), &no_windows, None, &ids, base + 2 + EXIT_GRACE_MS + 1),
                );
                ended_events += u32::from(was_ended(&end));
            }
            assert_eq!(ended_events, 1, "cycle {iteration}: exactly one Ended event");
            assert!(launch.session.phase.is_terminal());

            // Terminal: a resurrected window/process/foreground must not reopen
            // the launch or request a second restoration.
            assert!(!was_ended(&advance(
                &mut launch,
                &sim_obs(processes, &live_windows, Some(hwnd), &ids, base + 10_000)
            )));
            assert!(advance(
                &mut launch,
                &sim_obs(vec![], &no_windows, None, &no_ids, base + 20_000)
            )
            .is_none());
            assert!(launch.session.phase.is_terminal());
        }
    }

    /// Adversarial live sessions: a cloaked/other-desktop window and a recycled
    /// root PID must never yield an early Ended event or be recorded as an owned
    /// identity, so focus can never be handed to a foreign process.
    #[test]
    fn soak_cloaked_window_and_recycled_pid_never_end_a_live_cinema_session() {
        for iteration in 0..64u32 {
            let base = 2_000_000u64 + iteration as u64 * 50_000;
            let pid = 6_000 + iteration;
            let created = 900 + iteration as u64 * 3;
            let hwnd = 0x2000_0000u64 + iteration as u64 * 4;

            let mut launch = sim_cinema(&format!("cinema-live-{iteration}"), pid);
            let processes = vec![(pid, 1u32, "msedge.exe")];
            let ids = [(pid, created)];

            let live = sim_obs(processes.clone(), &[(hwnd, pid, created)], Some(hwnd), &ids, base + 1);
            advance(&mut launch, &live);
            advance(&mut launch, &live);
            assert_eq!(launch.session.phase, LaunchPhase::SessionActive);

            // Foreground lost but the exact HWND still exists: not a close.
            let cloaked = sim_obs(
                processes.clone(),
                &[(hwnd, pid, created)],
                None,
                &ids,
                base + 2,
            );
            assert!(!was_ended(&advance(&mut launch, &cloaked)));
            assert_eq!(launch.session.phase, LaunchPhase::SessionActive);

            // Same PID, new creation time: detected as reuse and never adopted.
            let recycled = sim_obs(
                processes,
                &[(hwnd, pid, created + 1)],
                Some(hwnd),
                &[(pid, created + 1)],
                base + 3,
            );
            let _ = advance(&mut launch, &recycled);
            assert!(launch.session.pid_reuse_detected, "iteration {iteration}");
            assert!(
                !launch.known_identities.values().any(|&value| value == created + 1),
                "iteration {iteration}: a recycled instance must not become an owner"
            );
        }
    }
}

#[cfg(test)]
mod session_owner_tests {
    use super::{
        advance, LaunchKind, LaunchPhase, LaunchSession, LaunchWatch, Observation, TrackedLaunch,
        EXIT_GRACE_MS,
    };
    use crate::process_table::{ProcessIdentity, ProcessTable};
    use crate::window_broker::ForegroundWindow;
    use std::collections::HashMap;
    use std::sync::Arc;

    const STEAM_PID: u32 = 900;
    const GAME_PID: u32 = 901;

    /// A Steam game watch: the Steam client is the root, the game is a
    /// descendant, and the root does not count as running by itself.
    fn steam_game_launch() -> TrackedLaunch {
        TrackedLaunch {
            session: LaunchSession {
                id: "game-1".into(),
                kind: LaunchKind::Game,
                display_name: "Test game".into(),
                app_id: Some("123".into()),
                phase: LaunchPhase::Requested,
                process_ids: Vec::new(),
                foreground: false,
                window_id: None,
                started_at_ms: 1_000,
                updated_at_ms: 1_000,
                last_activation_at_ms: None,
                error: None,
                restore: None,
                session_revision: None,
                pid_reuse_detected: false,
                attention: None,
            },
            watch: LaunchWatch::new(
                LaunchKind::Game,
                "Test game",
                Some("123".into()),
                Vec::new(),
                Some(STEAM_PID),
                true,
                false,
                Vec::new(),
                false,
                None,
            ),
            absent_since_ms: None,
            window_absent_since_ms: None,
            known_identities: HashMap::new(),
        }
    }

    fn observe(
        processes: Vec<(u32, u32, &str)>,
        identities: &[(u32, u64)],
        at_ms: u64,
    ) -> Observation {
        Observation {
            table: Arc::new(ProcessTable::from_entries(processes)),
            windows: Vec::new(),
            foreground: ForegroundWindow::default(),
            identities: identities
                .iter()
                .map(|(process_id, created_at_100ns)| {
                    (
                        *process_id,
                        ProcessIdentity {
                            process_id: *process_id,
                            created_at_100ns: *created_at_100ns,
                        },
                    )
                })
                .collect(),
            at_ms,
        }
    }

    #[test]
    fn an_ended_game_launch_keeps_the_identities_of_its_client_and_its_game() {
        let mut launch = steam_game_launch();
        advance(
            &mut launch,
            &observe(
                vec![
                    (STEAM_PID, 1, "steam.exe"),
                    (GAME_PID, STEAM_PID, "Game.exe"),
                ],
                &[(STEAM_PID, 7_000), (GAME_PID, 8_000)],
                2_000,
            ),
        );
        assert_eq!(launch.session.phase, LaunchPhase::ProcessStarted);

        // The game exits; the Steam client stays in front. The launch ends only
        // after the exit grace window, and it still remembers both identities.
        advance(
            &mut launch,
            &observe(
                vec![(STEAM_PID, 1, "steam.exe")],
                &[(STEAM_PID, 7_000)],
                3_000,
            ),
        );
        advance(
            &mut launch,
            &observe(
                vec![(STEAM_PID, 1, "steam.exe")],
                &[(STEAM_PID, 7_000)],
                3_000 + EXIT_GRACE_MS,
            ),
        );
        assert_eq!(launch.session.phase, LaunchPhase::Ended);
        assert_eq!(launch.known_identities.get(&STEAM_PID), Some(&7_000));
        assert_eq!(launch.known_identities.get(&GAME_PID), Some(&8_000));
    }

    #[test]
    fn a_recycled_root_pid_is_never_recorded_as_an_owner_of_the_ended_launch() {
        let mut launch = steam_game_launch();
        advance(
            &mut launch,
            &observe(
                vec![
                    (STEAM_PID, 1, "steam.exe"),
                    (GAME_PID, STEAM_PID, "Game.exe"),
                ],
                &[(STEAM_PID, 7_000), (GAME_PID, 8_000)],
                2_000,
            ),
        );
        // PID 900 now belongs to an unrelated process with a new creation time.
        advance(
            &mut launch,
            &observe(
                vec![
                    (STEAM_PID, 1, "chrome.exe"),
                    (GAME_PID, STEAM_PID, "Game.exe"),
                ],
                &[(STEAM_PID, 9_999), (GAME_PID, 8_000)],
                3_000,
            ),
        );
        assert!(launch.watch.root_reused, "the reused root must be detected");
        assert_eq!(
            launch.known_identities.get(&STEAM_PID),
            Some(&7_000),
            "only the original root identity is ever handed to the focus policy"
        );
        assert!(!launch
            .known_identities
            .values()
            .any(|created| *created == 9_999));
    }

    #[test]
    fn an_image_name_match_across_the_machine_is_never_recorded_as_owned() {
        // A managed Chrome watch matches every chrome.exe on the machine. The
        // user's own browser windows must never become owners of the launch.
        let mut launch = TrackedLaunch {
            watch: LaunchWatch::new(
                LaunchKind::ManagedApp,
                "Chrome",
                Some("chrome".into()),
                vec!["chrome.exe".into()],
                None,
                false,
                false,
                Vec::new(),
                true,
                None,
            ),
            ..steam_game_launch()
        };
        advance(
            &mut launch,
            &observe(
                vec![(5_000, 1, "chrome.exe"), (5_001, 5_000, "chrome.exe")],
                &[(5_000, 1_234), (5_001, 1_235)],
                2_000,
            ),
        );
        assert!(
            launch.known_identities.is_empty(),
            "foreign browser processes must never be recorded"
        );
    }

    #[test]
    fn a_root_the_launch_attached_to_is_owned_even_without_descendant_scope() {
        // Attaching to an already-running Playnite owns that process as the root.
        let mut launch = TrackedLaunch {
            watch: LaunchWatch::new(
                LaunchKind::Playnite,
                "Playnite Fullscreen",
                Some("playniteFullscreen".into()),
                vec!["Playnite.FullscreenApp.exe".into()],
                Some(700),
                false,
                true,
                Vec::new(),
                true,
                None,
            ),
            ..steam_game_launch()
        };
        advance(
            &mut launch,
            &observe(
                vec![(700, 1, "Playnite.FullscreenApp.exe")],
                &[(700, 42)],
                2_000,
            ),
        );
        assert_eq!(launch.known_identities.get(&700), Some(&42));
        assert_eq!(launch.known_identities.len(), 1);
    }
}
