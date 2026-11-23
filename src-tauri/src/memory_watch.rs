//! Read-only process / WebView2 memory sampler (VELORA 3.0 workstream S3.4).
//!
//! MEASURE FIRST, claim nothing: a periodic (>= 60 s) READ-ONLY sample of this
//! process's working set. When the working set reaches the DOCUMENTED threshold
//! below, a truthful "high memory" notice event is emitted (rate-limited by a
//! cooldown). No GC API is called — WebView2 exposes no supported GC entry
//! point through Tauri and none is faked; the notice is informational only.
//!
//! Shutdown cleanliness: the sampler thread sleeps in short slices and checks
//! the stop flag, and `stop()` joins it with a bounded wait, so a monitor can
//! never hang the Exit handler.
//!
//! The Win32 calls are declared by hand (as in `single_instance.rs`), so this
//! module needs no new crate and no new `windows` feature.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Sampling period. Deliberately >= 60 s: read-only diagnostics, no polling.
pub(crate) const MEMORY_SAMPLE_INTERVAL: Duration = Duration::from_secs(60);
/// Sleep slice so the stop flag is observed within ~100 ms.
const SLEEP_SLICE: Duration = Duration::from_millis(100);
/// Upper bound for the shutdown join — a monitor must never hang Exit.
pub(crate) const SHUTDOWN_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
/// DOCUMENTED high-memory threshold: 1 GiB working set of the VELORA process
/// (WebView2 renderer + Rust backend share it). At or above this the sampler
/// emits a truthful notice; it does NOT claim a leak, only the measured number.
pub(crate) const HIGH_MEMORY_WORKING_SET_BYTES: u64 = 1_073_741_824;
/// Frontend event name for the truthful high-memory notice.
pub(crate) const MEMORY_NOTICE_EVENT: &str = "velora-memory-notice";
/// Rate limit: at most one notice per 5 minutes.
const MEMORY_NOTICE_COOLDOWN: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryNotice {
    pub at_ms: u64,
    pub working_set_bytes: u64,
    pub threshold_bytes: u64,
    pub sample_count: u64,
    /// Truthful one-line diagnostic; states the measured numbers and that no
    /// GC was forced.
    pub notice: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWatchStatus {
    pub windows: bool,
    pub supported: bool,
    pub sample_interval_ms: u64,
    pub high_memory_threshold_bytes: u64,
    pub last_working_set_bytes: Option<u64>,
    pub sample_count: u64,
    pub notices_emitted: u64,
    pub last_notice: Option<String>,
}

static STARTED: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static HANDLE: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static LAST_WORKING_SET: AtomicU64 = AtomicU64::new(0);
static SAMPLE_COUNT: AtomicU64 = AtomicU64::new(0);
static NOTICES_EMITTED: AtomicU64 = AtomicU64::new(0);
static LAST_NOTICE_AT: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_NOTICE_TEXT: Mutex<Option<String>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// True when the measured working set reached the documented threshold.
pub(crate) fn high_memory(working_set_bytes: u64) -> bool {
    working_set_bytes >= HIGH_MEMORY_WORKING_SET_BYTES
}

/// Truthful notice text: only the measured numbers, the threshold, and the
/// explicit statement that no GC API was called.
pub(crate) fn notice_text(working_set_bytes: u64, threshold_bytes: u64) -> String {
    format!(
        "Wysokie zmierzone zużycie pamięci procesu VELORA (WebView2): working set {working_set_bytes} B (próg {threshold_bytes} B). \
         To wyłącznie odczyt — żadne API wymuszonego GC nie zostało wywołane."
    )
}

/// Read-only working-set sample of this process. `None` when the platform
/// cannot report it (never fabricated).
pub(crate) fn sample_working_set() -> Option<u64> {
    #[cfg(target_os = "windows")]
    {
        native::working_set_bytes()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
mod native {
    use std::ffi::c_void;

    #[repr(C)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }

    #[link(name = "psapi")]
    extern "system" {
        fn K32GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut ProcessMemoryCountersEx,
            size: u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }

    /// Working set of the current process via the read-only psapi query.
    pub(super) fn working_set_bytes() -> Option<u64> {
        // SAFETY: `counters` is a valid, correctly sized stack struct for the
        // duration of the call; GetCurrentProcess needs no cleanup (pseudo-handle).
        unsafe {
            let mut counters: ProcessMemoryCountersEx = std::mem::zeroed();
            counters.cb = std::mem::size_of::<ProcessMemoryCountersEx>() as u32;
            if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) == 0 {
                return None;
            }
            Some(counters.working_set_size as u64)
        }
    }
}

/// Joins the monitor thread with a bounded wait. Returns true when the thread
/// was joined; false when the timeout expired (the thread still observes the
/// stop flag within one sleep slice and exits on its own — shutdown is never
/// blocked longer than `timeout`).
pub(crate) fn join_bounded(
    handle_slot: &Mutex<Option<JoinHandle<()>>>,
    timeout: Duration,
) -> bool {
    let handle = {
        let mut guard = match handle_slot.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        guard.take()
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
        // Detached: STOP is already set and the loop sleeps in slices, so the
        // thread terminates promptly on its own.
        false
    }
}

pub(crate) fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    STOP.store(false, Ordering::Release);
    let spawned = std::thread::Builder::new()
        .name("velora-memory-watch".into())
        .spawn(move || {
            let mut next_sample = Instant::now();
            loop {
                if STOP.load(Ordering::Acquire) {
                    break;
                }
                if let Some(working_set) = sample_working_set() {
                    LAST_WORKING_SET.store(working_set, Ordering::Release);
                    let count = SAMPLE_COUNT.fetch_add(1, Ordering::AcqRel) + 1;
                    if high_memory(working_set) {
                        let mut last_notice = match LAST_NOTICE_AT.lock() {
                            Ok(guard) => guard,
                            Err(_) => break,
                        };
                        let cooldown_passed = match *last_notice {
                            Some(at) => at.elapsed() >= MEMORY_NOTICE_COOLDOWN,
                            None => true,
                        };
                        if cooldown_passed {
                            let text = notice_text(working_set, HIGH_MEMORY_WORKING_SET_BYTES);
                            let notice = MemoryNotice {
                                at_ms: now_ms(),
                                working_set_bytes: working_set,
                                threshold_bytes: HIGH_MEMORY_WORKING_SET_BYTES,
                                sample_count: count,
                                notice: text.clone(),
                            };
                            let _ = app.emit(MEMORY_NOTICE_EVENT, notice);
                            NOTICES_EMITTED.fetch_add(1, Ordering::AcqRel);
                            *last_notice = Some(Instant::now());
                            if let Ok(mut slot) = LAST_NOTICE_TEXT.lock() {
                                *slot = Some(text);
                            }
                        }
                    }
                }
                // Sleep until the next sample, in slices, so STOP is seen fast.
                next_sample += MEMORY_SAMPLE_INTERVAL;
                loop {
                    if STOP.load(Ordering::Acquire) {
                        return;
                    }
                    let now = Instant::now();
                    if now >= next_sample {
                        break;
                    }
                    std::thread::sleep(SLEEP_SLICE.min(next_sample - now));
                }
            }
        });
    match spawned {
        Ok(handle) => {
            if let Ok(mut slot) = HANDLE.lock() {
                *slot = Some(handle);
            }
        }
        Err(_) => {
            STARTED.store(false, Ordering::Release);
        }
    }
}

pub(crate) fn stop() {
    STOP.store(true, Ordering::Release);
    join_bounded(&HANDLE, SHUTDOWN_JOIN_TIMEOUT);
    STARTED.store(false, Ordering::Release);
}

fn read_status() -> MemoryWatchStatus {
    let last_working_set = LAST_WORKING_SET.load(Ordering::Acquire);
    MemoryWatchStatus {
        windows: cfg!(target_os = "windows"),
        supported: cfg!(target_os = "windows"),
        sample_interval_ms: MEMORY_SAMPLE_INTERVAL.as_millis() as u64,
        high_memory_threshold_bytes: HIGH_MEMORY_WORKING_SET_BYTES,
        last_working_set_bytes: if last_working_set > 0 {
            Some(last_working_set)
        } else {
            None
        },
        sample_count: SAMPLE_COUNT.load(Ordering::Acquire),
        notices_emitted: NOTICES_EMITTED.load(Ordering::Acquire),
        last_notice: LAST_NOTICE_TEXT
            .lock()
            .ok()
            .and_then(|slot| slot.clone()),
    }
}

/// Read-only diagnostics command: numbers only, no side effects.
#[tauri::command]
pub async fn get_memory_watch_status() -> MemoryWatchStatus {
    tauri::async_runtime::spawn_blocking(read_status)
        .await
        .unwrap_or_else(|_| read_status())
}

#[cfg(test)]
mod tests {
    use super::{
        HIGH_MEMORY_WORKING_SET_BYTES, MEMORY_SAMPLE_INTERVAL, SHUTDOWN_JOIN_TIMEOUT,
        high_memory, join_bounded, notice_text, stop,
    };
    use std::sync::Mutex;
    use std::thread::JoinHandle;
    use std::time::Duration;

    #[test]
    fn sampling_period_is_at_least_60_seconds() {
        assert!(MEMORY_SAMPLE_INTERVAL >= Duration::from_secs(60));
    }

    #[test]
    fn threshold_is_documented_at_one_gib() {
        assert_eq!(HIGH_MEMORY_WORKING_SET_BYTES, 1_073_741_824);
        assert!(SHUTDOWN_JOIN_TIMEOUT <= Duration::from_secs(5));
    }

    #[test]
    fn high_memory_only_at_or_above_the_threshold() {
        assert!(!high_memory(0));
        assert!(!high_memory(HIGH_MEMORY_WORKING_SET_BYTES - 1));
        assert!(high_memory(HIGH_MEMORY_WORKING_SET_BYTES));
        assert!(high_memory(HIGH_MEMORY_WORKING_SET_BYTES * 4));
    }

    #[test]
    fn notice_text_reports_only_measured_numbers_and_never_claims_a_gc() {
        let text = notice_text(2_000_000_000, HIGH_MEMORY_WORKING_SET_BYTES);
        assert!(text.contains("2000000000 B"));
        assert!(text.contains("1073741824 B"));
        assert!(text.contains("żadne API wymuszonego GC nie zostało wywołane"));
        assert!(!text.contains("wyciek"), "no leak claim — only the measurement");
    }

    #[test]
    fn join_bounded_returns_true_without_a_thread() {
        let slot: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
        assert!(join_bounded(&slot, Duration::from_millis(50)));
    }

    #[test]
    fn join_bounded_joins_a_finished_thread_quickly() {
        let handle = std::thread::spawn(|| {});
        std::thread::sleep(Duration::from_millis(20));
        let slot: Mutex<Option<JoinHandle<()>>> = Mutex::new(Some(handle));
        assert!(join_bounded(&slot, Duration::from_secs(2)));
        assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn stop_is_idempotent_and_never_panics_without_start() {
        stop();
        stop();
    }
}
