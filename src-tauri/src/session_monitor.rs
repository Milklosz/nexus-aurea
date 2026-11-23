//! Sleep/wake and runtime-stall detection.
//!
//! Windows does not deliver a power broadcast to a console prompt, and adding a
//! second hidden message window just for `WM_POWERBROADCAST` would duplicate
//! the Control Service lifecycle. A monotonic-clock gap is a small, testable
//! signal: if the monitor thread wakes up much later than requested, the
//! machine slept or the process was suspended. The recovery action is explicit
//! and bounded.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub(crate) const SYSTEM_RESUME_EVENT: &str = "velora-system-resumed";
pub(crate) const MONITOR_TICK: Duration = Duration::from_millis(1_000);
/// A normal scheduling delay is milliseconds, not seconds. Six seconds avoids
/// false positives from a busy build while still catching every real sleep.
pub(crate) const RESUME_GAP: Duration = Duration::from_millis(6_000);
const ORPHAN_CHECK_INTERVAL: Duration = Duration::from_millis(5_000);
/// Sleep slice so the stop flag is observed within ~100 ms on shutdown.
const STOP_SLICE: Duration = Duration::from_millis(100);
/// Upper bound for the shutdown join — a monitor must never hang Exit.
const SHUTDOWN_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static MONITOR_STOP: AtomicBool = AtomicBool::new(false);
static MONITOR_HANDLE: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemResumeEvent {
    pub at_ms: u64,
    pub gap_ms: u64,
    pub active_launches: usize,
    pub session: crate::session_orchestrator::SessionSnapshot,
    /// Truthful, content-free one-line diagnostic for the resume event.
    pub diagnostic: String,
}

pub(crate) fn resume_detected(elapsed: Duration) -> bool {
    elapsed >= RESUME_GAP
}

/// One-line diagnostic for a detected sleep/resume. It reports only what the
/// monotonic-clock gap and the launch registry actually prove; it never claims
/// that a session's playback state survived (VELORA does not read provider
/// playback state) and never claims hardware verification.
pub(crate) fn resume_diagnostic(gap_ms: u64, active_launches: usize) -> String {
    format!(
        "Wykryto wybudzenie systemu po przerwie {gap_ms} ms; aktywne sesje zarządzane przez VELORA: {active_launches}. Stany sesji pochodzą wyłącznie z rejestru uruchomień."
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Sleeps `total` in short slices, returning early once the stop flag is set,
/// so `stop()` can join the thread promptly instead of waiting a full tick.
fn sleep_interruptible(total: Duration) {
    let deadline = Instant::now() + total;
    loop {
        if MONITOR_STOP.load(Ordering::Acquire) {
            return;
        }
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        std::thread::sleep(STOP_SLICE.min(deadline - now));
    }
}

/// Joins the monitor thread with a bounded wait (shutdown can never hang).
/// Returns false only when the timeout expired; the thread still exits on its
/// own because it sleeps in slices and observes the stop flag.
fn join_bounded(handle_slot: &Mutex<Option<JoinHandle<()>>>, timeout: Duration) -> bool {
    let handle = match handle_slot.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };
    let Some(handle) = handle else {
        return true;
    };
    let deadline = Instant::now() + timeout;
    while !handle.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if handle.is_finished() {
        let _ = handle.join();
        true
    } else {
        false
    }
}

pub(crate) fn start(app: AppHandle) {
    if MONITOR_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    MONITOR_STOP.store(false, Ordering::Release);
    let spawned = std::thread::Builder::new()
        .name("velora-session-monitor".into())
        .spawn(move || {
            let mut last_tick = Instant::now();
            let mut last_orphan_check = Instant::now();
            while !MONITOR_STOP.load(Ordering::Acquire) {
                sleep_interruptible(MONITOR_TICK);
                if MONITOR_STOP.load(Ordering::Acquire) {
                    break;
                }
                let elapsed = last_tick.elapsed();
                last_tick = Instant::now();
                if resume_detected(elapsed) {
                    let at_ms = now_ms();
                    let active_launches = crate::launch_registry::handle_system_resume(&app, at_ms);
                    crate::window_broker::handle_system_resume(&app);
                    crate::session_orchestrator::reconcile_orphaned_launch(&app);
                    crate::edge_cinema::reconcile_edge_marker(&app);
                    let gap_ms = elapsed.as_millis().min(u128::from(u64::MAX)) as u64;
                    let event = SystemResumeEvent {
                        at_ms,
                        gap_ms,
                        active_launches,
                        session: crate::session_orchestrator::current_snapshot(&app),
                        diagnostic: resume_diagnostic(gap_ms, active_launches),
                    };
                    let _ = app.emit(SYSTEM_RESUME_EVENT, event);
                    last_orphan_check = Instant::now();
                } else if last_orphan_check.elapsed() >= ORPHAN_CHECK_INTERVAL {
                    crate::session_orchestrator::reconcile_orphaned_launch(&app);
                    crate::edge_cinema::reconcile_edge_marker(&app);
                    last_orphan_check = Instant::now();
                }
            }
        });
    match spawned {
        Ok(handle) => {
            if let Ok(mut slot) = MONITOR_HANDLE.lock() {
                *slot = Some(handle);
            }
        }
        Err(_) => {
            MONITOR_STARTED.store(false, Ordering::Release);
        }
    }
}

pub(crate) fn stop() {
    MONITOR_STOP.store(true, Ordering::Release);
    // Bounded join: the thread sleeps in slices, so it is normally joined
    // within ~100 ms; the timeout is a hard guard so Exit can never hang.
    join_bounded(&MONITOR_HANDLE, SHUTDOWN_JOIN_TIMEOUT);
    MONITOR_STARTED.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::{
        MONITOR_STOP, join_bounded, resume_diagnostic, resume_detected, stop, RESUME_GAP,
    };
    use std::sync::Mutex;
    use std::thread::JoinHandle;
    use std::time::Duration;

    #[test]
    fn normal_ticks_do_not_report_a_resume() {
        assert!(!resume_detected(Duration::from_millis(1_000)));
        assert!(!resume_detected(RESUME_GAP - Duration::from_millis(1)));
    }

    #[test]
    fn a_multi_second_gap_reports_a_resume() {
        assert!(resume_detected(RESUME_GAP));
        assert!(resume_detected(Duration::from_secs(90)));
    }

    #[test]
    fn resume_diagnostic_reports_only_what_the_registry_proves() {
        let text = resume_diagnostic(6_500, 2);
        assert!(text.contains("6500 ms"));
        assert!(text.contains("aktywne sesje zarządzane przez VELORA: 2"));
        // Honest limitation: the diagnostic must not claim playback-state
        // survival or hardware verification.
        assert!(text.contains("rejestru uruchomień"));
        assert!(!text.contains("playback"));
        assert!(!text.contains("zweryfikowano"));
    }

    #[test]
    fn stop_is_idempotent_and_the_shutdown_join_is_bounded() {
        stop();
        stop();
        let handle = std::thread::spawn(|| {});
        std::thread::sleep(Duration::from_millis(10));
        let slot: Mutex<Option<JoinHandle<()>>> = Mutex::new(Some(handle));
        assert!(join_bounded(&slot, Duration::from_secs(2)));
        assert!(slot.lock().unwrap().is_none());
        // A stopped monitor returns promptly from an interruptible sleep.
        MONITOR_STOP.store(true, std::sync::atomic::Ordering::Release);
        let start = std::time::Instant::now();
        super::sleep_interruptible(Duration::from_secs(30));
        assert!(start.elapsed() < Duration::from_secs(2));
        MONITOR_STOP.store(false, std::sync::atomic::Ordering::Release);
    }
}
