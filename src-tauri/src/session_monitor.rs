//! Sleep/wake and runtime-stall detection.
//!
//! Windows does not deliver a power broadcast to a console prompt, and adding a
//! second hidden message window just for `WM_POWERBROADCAST` would duplicate
//! the Control Service lifecycle. A monotonic-clock gap is a small, testable
//! signal: if the monitor thread wakes up much later than requested, the
//! machine slept or the process was suspended. The recovery action is explicit
//! and bounded.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub(crate) const SYSTEM_RESUME_EVENT: &str = "velora-system-resumed";
pub(crate) const MONITOR_TICK: Duration = Duration::from_millis(1_000);
/// A normal scheduling delay is milliseconds, not seconds. Six seconds avoids
/// false positives from a busy build while still catching every real sleep.
pub(crate) const RESUME_GAP: Duration = Duration::from_millis(6_000);
const ORPHAN_CHECK_INTERVAL: Duration = Duration::from_millis(5_000);

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static MONITOR_STOP: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemResumeEvent {
    pub at_ms: u64,
    pub gap_ms: u64,
    pub active_launches: usize,
    pub session: crate::session_orchestrator::SessionSnapshot,
}

pub(crate) fn resume_detected(elapsed: Duration) -> bool {
    elapsed >= RESUME_GAP
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
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
                std::thread::sleep(MONITOR_TICK);
                let elapsed = last_tick.elapsed();
                last_tick = Instant::now();
                if resume_detected(elapsed) {
                    let at_ms = now_ms();
                    let active_launches = crate::launch_registry::handle_system_resume(&app, at_ms);
                    crate::window_broker::handle_system_resume(&app);
                    crate::session_orchestrator::reconcile_orphaned_launch(&app);
                    let event = SystemResumeEvent {
                        at_ms,
                        gap_ms: elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
                        active_launches,
                        session: crate::session_orchestrator::current_snapshot(&app),
                    };
                    let _ = app.emit(SYSTEM_RESUME_EVENT, event);
                    last_orphan_check = Instant::now();
                } else if last_orphan_check.elapsed() >= ORPHAN_CHECK_INTERVAL {
                    crate::session_orchestrator::reconcile_orphaned_launch(&app);
                    last_orphan_check = Instant::now();
                }
            }
        });
    if spawned.is_err() {
        MONITOR_STARTED.store(false, Ordering::Release);
    }
}

pub(crate) fn stop() {
    MONITOR_STOP.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::{resume_detected, RESUME_GAP};
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
}
