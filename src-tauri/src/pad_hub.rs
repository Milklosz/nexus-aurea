//! Process-wide owner of the Windows Raw Input sink for game controllers.
//!
//! Windows allows exactly one target window per usage collection per process, and
//! `RIDEV_REMOVE` clears the registration for the whole process. Two independent
//! sinks (the DualSense Home chord in `gamepad_home`, DualShock 4 navigation here)
//! would silently break each other. This module therefore owns the ONE registration,
//! for the lifetime of the app, and fans reports out:
//!
//! * DualShock 4 (Sony pids 05C4 / 09CC / 0BA0): decoded here ([`crate::ds4`]) into
//!   semantic `velora-controller` events for the frontend, plus the PS + Options chord.
//! * Everything else: forwarded unchanged to whoever called [`PadHub::subscribe_raw`]
//!   (the DualSense chord runtime while the Control Service runs).
//!
//! Read-only by construction: nothing is ever written to a controller, no device
//! handle is opened, no feature report is requested, so a pad's report mode (USB or
//! Bluetooth basic/full) is never switched by VELORA. Raw packets and device paths
//! never leave this module; the frontend only sees hashed labels and semantic state.
//!
//! NOT TESTED ON HARDWARE.

use crate::ds4::{
    is_neutral, Ds4Buttons, Ds4Report, Ds4Revision, Ds4Snapshot, Ds4Tracker, Ds4Transport,
    PadEvent, PadInfo,
};
use crate::gamepad_home::{ChordOutcome, ComboTracker, DualSenseButtons};
#[path = "controller_supervisor.rs"]
mod controller_supervisor;
pub use controller_supervisor::{ControllerFallbackConfig, ControllerFallbackStatus};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub(crate) const CONTROLLER_EVENT: &str = "velora-controller";

/// While an input is held the current state is re-sent this often, so a lost release
/// event can never leave the frontend with a stuck direction.
pub(crate) const HEARTBEAT_MS: u64 = 250;

/// Event sent to the frontend. Mirrors `NativeControllerEvent` in
/// `src/services/nativeController.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ControllerEvent {
    Connected {
        device: String,
        revision: Ds4Revision,
        transport: Ds4Transport,
    },
    State(Ds4Snapshot),
    Disconnected {
        device: String,
    },
    Unavailable {
        reason: String,
    },
}

impl From<PadEvent> for ControllerEvent {
    fn from(event: PadEvent) -> Self {
        match event {
            PadEvent::Connected {
                label,
                revision,
                transport,
            } => Self::Connected {
                device: label,
                revision,
                transport,
            },
            PadEvent::State(snapshot) => Self::State(snapshot),
            PadEvent::Disconnected { label } => Self::Disconnected { device: label },
        }
    }
}

/// What the status command reports. Mirrors `NativeControllerStatus` in the frontend.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeControllerStatus {
    pub supported: bool,
    pub running: bool,
    pub last_error: Option<String>,
    pub pads: Vec<PadInfo>,
    pub ignored_reports: u64,
    pub dropped_raw_reports: u64,
    /// Effective Home chord state. A session override wins over Control Service.
    pub home_enabled: bool,
    /// `None` follows Control Service; `Some(false/true)` is this-session user intent.
    pub home_override: Option<bool>,
    pub received_reports: u64,
    pub valid_reports: u64,
    pub background_reports: u64,
    pub last_report_at_ms: Option<u64>,
    pub last_home_buttons: Option<NativeHomeButtons>,
    pub ps_rising_count: u64,
    pub last_ps_rising_at_ms: Option<u64>,
    pub options_rising_count: u64,
    pub last_options_rising_at_ms: Option<u64>,
    pub last_chord: Option<NativeChordDiagnostic>,
    pub last_restore: Option<NativeRestoreDiagnostic>,
    pub queue_rejected: u64,
    pub last_trace: Option<NativeHomeTrace>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeHomeStage {
    Report,
    Recognition,
    Dispatch,
    Restore,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeHomeOutcome {
    ReportReceived,
    ValidControllerReport,
    HomeButtonsChanged,
    HomeDisabled,
    ChordTriggered,
    ReturnQueued,
    QueueRejected,
    Restored,
    AlreadyFocused,
    BlockedUnsafeForeground,
    BlockedByWindows,
    WindowUnavailable,
    UnsupportedPlatform,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHomeTrace {
    pub stage: NativeHomeStage,
    pub outcome: NativeHomeOutcome,
    pub at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHomeButtons {
    pub ps: bool,
    pub options: bool,
    pub at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeChordDiagnostic {
    pub outcome: ChordOutcome,
    pub at_ms: u64,
    pub home_enabled: bool,
    pub action_requested: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRestoreDiagnostic {
    pub outcome: NativeHomeOutcome,
    pub at_ms: u64,
    pub own_window: Option<u64>,
    pub foreground_before_hwnd: Option<u64>,
    pub foreground_after_hwnd: Option<u64>,
    pub foreground_before_process_id: Option<u32>,
    pub foreground_after_process_id: Option<u32>,
    pub error_code: Option<u32>,
}

/// Output of feeding the core: events to emit and whether the Home chord fired.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct CoreOutput {
    pub events: Vec<ControllerEvent>,
    pub chord: bool,
    pub chord_outcome: Option<ChordOutcome>,
    /// Hashed device label and full semantic report for a bounded streaming route.
    pub streaming_report: Option<(String, Ds4Report)>,
    /// A valid report resumed after a long gap; invalidate queued bridge input first.
    pub streaming_reset: bool,
}

/// Platform-independent heart of the hub: DS4 tracking, chord detection, and the
/// decision of what the frontend is allowed to see. No Win32, no Tauri, no clock.
#[derive(Default)]
pub(crate) struct HubCore {
    tracker: Ds4Tracker,
    chord: ComboTracker,
    home_override: Option<bool>,
    legacy_chord_enabled: bool,
    chord_enabled: bool,
    primary_chord_suppressed: bool,
    foreground: bool,
    last_heartbeat_ms: u64,
    received_reports: u64,
    valid_reports: u64,
    background_reports: u64,
    last_report_at_ms: Option<u64>,
    streaming_report_at_ms: HashMap<String, u64>,
    silent_streaming_devices: HashSet<String>,
    streaming_silence_reset: bool,
    home_buttons: HashMap<String, DualSenseButtons>,
    last_home_buttons: Option<NativeHomeButtons>,
    ps_rising_count: u64,
    last_ps_rising_at_ms: Option<u64>,
    options_rising_count: u64,
    last_options_rising_at_ms: Option<u64>,
    last_home_buttons_label: Option<String>,
    last_chord: Option<NativeChordDiagnostic>,
    last_trace: Option<NativeHomeTrace>,
}

impl HubCore {
    pub(crate) fn set_chord_sources(&mut self, home_override: Option<bool>, legacy_enabled: bool) {
        self.home_override = home_override;
        self.legacy_chord_enabled = legacy_enabled;
        self.recompute_chord_enabled();
    }

    pub(crate) fn set_primary_chord_suppressed(&mut self, suppressed: bool) {
        self.primary_chord_suppressed = suppressed;
        self.recompute_chord_enabled();
    }

    fn recompute_chord_enabled(&mut self) {
        let enabled = self.home_override.unwrap_or(self.legacy_chord_enabled)
            && !self.primary_chord_suppressed;
        if enabled && !self.chord_enabled {
            self.chord.require_neutral_rearm();
        }
        self.chord_enabled = enabled;
    }

    #[cfg(test)]
    fn set_chord_enabled(&mut self, enabled: bool) {
        self.set_chord_sources(None, enabled);
    }

    #[cfg(test)]
    pub(crate) fn pad_count(&self) -> usize {
        self.tracker.pad_count()
    }

    pub(crate) fn ignored_reports(&self) -> u64 {
        self.tracker.ignored_reports()
    }

    pub(crate) fn pads(&self) -> Vec<PadInfo> {
        self.tracker.pads()
    }

    /// One DualShock 4 report. State events are only released to the frontend while
    /// VELORA is the foreground window: a game running with the pad must not flood IPC.
    /// Connection events are always released, they are rare and the UI needs them.
    pub(crate) fn on_report(
        &mut self,
        path: &str,
        revision: Ds4Revision,
        report: &[u8],
        at_ms: u64,
    ) -> CoreOutput {
        self.on_report_with_foreground(path, revision, report, at_ms, self.foreground)
    }

    pub(crate) fn on_report_with_foreground(
        &mut self,
        path: &str,
        revision: Ds4Revision,
        report: &[u8],
        at_ms: u64,
        foreground: bool,
    ) -> CoreOutput {
        self.received_reports = self.received_reports.saturating_add(1);
        if self.last_trace.is_none() {
            self.last_trace = Some(NativeHomeTrace {
                stage: NativeHomeStage::Report,
                outcome: NativeHomeOutcome::ReportReceived,
                at_ms,
            });
        }
        if !foreground {
            self.background_reports = self.background_reports.saturating_add(1);
        }
        let ingest = self.tracker.on_report(path, revision, report, at_ms);
        let mut out = CoreOutput::default();
        out.events = ingest
            .events
            .into_iter()
            .filter(|event| foreground || !matches!(event, PadEvent::State(_)))
            .map(ControllerEvent::from)
            .collect();
        if let (Some(label), Some(buttons)) = (ingest.label, ingest.buttons) {
            let previous_report_at = self.streaming_report_at_ms.get(&label).copied();
            let resumed_after_gap = previous_report_at
                .is_some_and(|last| at_ms.saturating_sub(last) >= crate::ds4::SILENCE_RELEASE_MS);
            let already_invalidated = self.silent_streaming_devices.remove(&label);
            out.streaming_reset = resumed_after_gap && !already_invalidated;
            self.streaming_report_at_ms.insert(label.clone(), at_ms);
            out.streaming_report = ingest.report.map(|report| (label.clone(), report));
            self.valid_reports = self.valid_reports.saturating_add(1);
            self.last_report_at_ms = Some(at_ms);
            let current_buttons = chord_buttons(buttons);
            let previous_buttons = self.home_buttons.insert(label.clone(), current_buttons);
            self.last_home_buttons_label = Some(label.clone());
            self.last_home_buttons = Some(NativeHomeButtons {
                ps: current_buttons.ps,
                options: current_buttons.options,
                at_ms,
            });
            if let Some(previous) = previous_buttons {
                if current_buttons.ps && !previous.ps {
                    self.ps_rising_count = self.ps_rising_count.saturating_add(1);
                    self.last_ps_rising_at_ms = Some(at_ms);
                }
                if current_buttons.options && !previous.options {
                    self.options_rising_count = self.options_rising_count.saturating_add(1);
                    self.last_options_rising_at_ms = Some(at_ms);
                }
            }
            let (triggered, outcome) =
                self.chord
                    .observe_diagnostic(&label, current_buttons, at_ms);
            out.chord_outcome = Some(outcome);
            if outcome != ChordOutcome::Ignored {
                let action_requested = triggered && self.chord_enabled;
                self.last_chord = Some(NativeChordDiagnostic {
                    outcome,
                    at_ms,
                    home_enabled: self.chord_enabled,
                    action_requested,
                });
            }
            if previous_buttons.is_none() && self.last_trace.is_none() {
                self.last_trace = Some(NativeHomeTrace {
                    stage: NativeHomeStage::Report,
                    outcome: NativeHomeOutcome::ValidControllerReport,
                    at_ms,
                });
            } else if previous_buttons.is_some_and(|previous| previous != current_buttons) {
                self.last_trace = Some(NativeHomeTrace {
                    stage: NativeHomeStage::Recognition,
                    outcome: if outcome == ChordOutcome::Triggered && !self.chord_enabled {
                        NativeHomeOutcome::HomeDisabled
                    } else if triggered {
                        NativeHomeOutcome::ChordTriggered
                    } else {
                        NativeHomeOutcome::HomeButtonsChanged
                    },
                    at_ms,
                });
            }
            // The chord is a global Home gesture. The session override controls
            // it independently from the keyboard Control Service setting.
            out.chord = triggered && self.chord_enabled;
        }
        out
    }

    pub(crate) fn on_removed(&mut self, path: &str) -> Vec<ControllerEvent> {
        let label = crate::gamepad_home::device_label(path);
        self.streaming_report_at_ms.remove(&label);
        self.silent_streaming_devices.remove(&label);
        self.chord.remove_device(&label);
        self.home_buttons.remove(&label);
        if self.last_home_buttons_label.as_deref() == Some(label.as_str()) {
            self.last_home_buttons = None;
            self.last_home_buttons_label = None;
        }
        self.tracker
            .on_removed(path)
            .into_iter()
            .map(ControllerEvent::from)
            .collect()
    }

    /// Periodic housekeeping: drops silent pads, resynchronises the frontend when VELORA
    /// becomes the foreground window, and re-sends held state as a heartbeat.
    pub(crate) fn tick(&mut self, at_ms: u64, foreground: bool) -> Vec<ControllerEvent> {
        self.streaming_silence_reset = false;
        for (label, last_report_at) in &self.streaming_report_at_ms {
            if at_ms.saturating_sub(*last_report_at) >= crate::ds4::SILENCE_RELEASE_MS
                && self.silent_streaming_devices.insert(label.clone())
            {
                self.streaming_silence_reset = true;
            }
        }
        let mut events: Vec<ControllerEvent> = Vec::new();
        for event in self.tracker.prune(at_ms) {
            if let PadEvent::Disconnected { label } = &event {
                self.streaming_report_at_ms.remove(label);
                self.silent_streaming_devices.remove(label);
                self.chord.remove_device(label);
                self.home_buttons.remove(label);
                if self.last_home_buttons_label.as_deref() == Some(label.as_str()) {
                    self.last_home_buttons = None;
                    self.last_home_buttons_label = None;
                }
            }
            events.push(event.into());
        }
        self.chord.prune(at_ms);
        // A silent pad that was holding an input is released, never heartbeated.
        let released = self
            .tracker
            .release_silent(at_ms, crate::ds4::SILENCE_RELEASE_MS);
        for snapshot in &released {
            // A partial PS + Options gesture may straddle a Bluetooth/report gap.
            // Treat the silent release as a fresh device epoch; other pads retain
            // their independent chord state.
            self.chord.remove_device(&snapshot.device);
            self.home_buttons.remove(&snapshot.device);
            if self.last_home_buttons_label.as_deref() == Some(snapshot.device.as_str()) {
                self.last_home_buttons = Some(NativeHomeButtons {
                    ps: false,
                    options: false,
                    at_ms,
                });
            }
        }
        if foreground {
            events.extend(released.into_iter().map(ControllerEvent::State));
            events.extend(
                self.tracker
                    .flush_analog(at_ms)
                    .into_iter()
                    .map(ControllerEvent::State),
            );
        }
        let gained = foreground && !self.foreground;
        self.foreground = foreground;
        if gained {
            // Anything pressed while the window was in the background is reported now.
            events.extend(
                self.tracker
                    .snapshots()
                    .into_iter()
                    .map(ControllerEvent::State),
            );
            self.last_heartbeat_ms = at_ms;
        } else if foreground && at_ms.saturating_sub(self.last_heartbeat_ms) >= HEARTBEAT_MS {
            self.last_heartbeat_ms = at_ms;
            events.extend(
                self.tracker
                    .snapshots()
                    .into_iter()
                    .filter(|snapshot| !is_neutral(snapshot))
                    .map(ControllerEvent::State),
            );
        }
        events
    }

    pub(crate) fn take_streaming_silence_reset(&mut self) -> bool {
        std::mem::take(&mut self.streaming_silence_reset)
    }

    /// Everything is released and every pad forgotten, e.g. when the hub stops.
    pub(crate) fn shutdown(&mut self) -> Vec<ControllerEvent> {
        self.tracker
            .clear()
            .into_iter()
            .map(ControllerEvent::from)
            .collect()
    }
}

fn chord_buttons(buttons: Ds4Buttons) -> DualSenseButtons {
    DualSenseButtons {
        ps: buttons.is_pressed(crate::ds4::Ds4Button::Ps),
        options: buttons.is_pressed(crate::ds4::Ds4Button::Options),
    }
}

#[cfg(target_os = "windows")]
pub(crate) use runtime::{PadHub, RawMessage, RawSubscription};

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
pub(crate) struct PadHub {
    fallback: std::sync::Mutex<controller_supervisor::ControllerSupervisor>,
}

#[cfg(not(target_os = "windows"))]
impl PadHub {
    pub(crate) fn start(&self, _app: tauri::AppHandle) {}
    pub(crate) fn stop(&self) {}
    pub(crate) fn set_chord_enabled(&self, _enabled: bool) {}
    pub(crate) fn set_home_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            Err("Natywny powrót pada jest dostępny tylko w aplikacji Windows.".into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn ds4_pad_count(&self) -> usize {
        0
    }
    pub(crate) fn status(&self) -> NativeControllerStatus {
        NativeControllerStatus::default()
    }

    pub(crate) fn controller_fallback_status(&self) -> ControllerFallbackStatus {
        self.fallback
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .status()
    }

    pub(crate) fn configure_controller_fallback(
        &self,
        config: ControllerFallbackConfig,
    ) -> Result<ControllerFallbackStatus, String> {
        if config.enabled {
            return Err("Fallback Home jest dostępny tylko w aplikacji Windows.".into());
        }
        self.fallback
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .configure(config)
    }
}

/// Current native controller state, so the frontend can seed itself after it starts
/// listening (events emitted before the WebView listens are lost).
#[tauri::command]
pub fn get_native_controller_status(hub: tauri::State<'_, PadHub>) -> NativeControllerStatus {
    hub.status()
}

#[tauri::command]
pub fn set_controller_home_enabled(
    hub: tauri::State<'_, PadHub>,
    enabled: bool,
) -> Result<NativeControllerStatus, String> {
    hub.set_home_enabled(enabled)?;
    Ok(hub.status())
}

#[tauri::command]
pub fn get_controller_fallback_status(hub: tauri::State<'_, PadHub>) -> ControllerFallbackStatus {
    hub.controller_fallback_status()
}

#[tauri::command]
pub fn configure_controller_fallback(
    hub: tauri::State<'_, PadHub>,
    config: ControllerFallbackConfig,
) -> Result<ControllerFallbackStatus, String> {
    hub.configure_controller_fallback(config)
}

#[cfg(target_os = "windows")]
mod runtime {
    use super::*;
    use crate::gamepad_home::native;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
    use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
    use std::sync::{Arc, Mutex, OnceLock, PoisonError, RwLock};
    use std::time::Instant;
    use tauri::{AppHandle, Emitter};

    /// Unmodified reports and device notifications for consumers other than DS4.
    pub(crate) enum RawMessage {
        Reports(Vec<native::RawReport>),
        DeviceChange { w_param: usize, device: usize },
    }

    const RAW_QUEUE_CAPACITY: usize = 64;
    pub(crate) struct RawEnvelope {
        pub epoch: u64,
        pub message: RawMessage,
    }

    #[derive(Default)]
    struct Shared {
        running: AtomicBool,
        /// Set by `stop()`; checked every loop turn so a stop that races thread start-up still ends it.
        quit: AtomicBool,
        home_override: AtomicU8,
        legacy_chord_enabled: AtomicBool,
        /// Serializes explicit Home policy changes with the dispatch decision.
        home_policy_gate: Mutex<()>,
        thread_id: AtomicU32,
        status: RwLock<NativeControllerStatus>,
        supervisor: Mutex<controller_supervisor::ControllerSupervisor>,
        /// (subscription id, sender). The id lets a dropped old subscription leave a newer one alone.
        subscriber: Mutex<Option<(u64, SyncSender<RawEnvelope>)>>,
        overflow_epoch: std::sync::atomic::AtomicU64,
        next_subscription: std::sync::atomic::AtomicU64,
    }

    /// Held by the one consumer of forwarded reports. Dropping it unsubscribes.
    pub(crate) struct RawSubscription {
        pub(crate) receiver: Receiver<RawEnvelope>,
        id: u64,
        shared: Arc<Shared>,
    }

    impl RawSubscription {
        pub(crate) fn epoch(&self) -> u64 {
            self.shared.overflow_epoch.load(Ordering::Acquire)
        }
    }

    impl Drop for RawSubscription {
        fn drop(&mut self) {
            let mut guard = self
                .shared
                .subscriber
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if guard.as_ref().is_some_and(|(id, _)| *id == self.id) {
                *guard = None;
            }
        }
    }

    #[derive(Default)]
    pub(crate) struct PadHub {
        shared: Arc<Shared>,
        join: Mutex<Option<std::thread::JoinHandle<()>>>,
    }

    fn now_ms() -> u64 {
        static START: OnceLock<Instant> = OnceLock::new();
        START
            .get_or_init(Instant::now)
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    fn session_home_override(shared: &Shared) -> Option<bool> {
        match shared.home_override.load(Ordering::Acquire) {
            1 => Some(false),
            2 => Some(true),
            _ => None,
        }
    }

    fn effective_home_enabled(shared: &Shared) -> bool {
        session_home_override(shared)
            .unwrap_or_else(|| shared.legacy_chord_enabled.load(Ordering::Acquire))
    }

    fn primary_home_chord_enabled(shared: &Shared) -> bool {
        effective_home_enabled(shared)
            && !shared
                .supervisor
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .suppress_primary_chord()
    }

    impl PadHub {
        /// Starts the sink thread. A failure is recorded in the status and announced to
        /// the frontend as `unavailable`; the Gamepad API path keeps working.
        pub(crate) fn start(&self, app: AppHandle) {
            let mut join = self.join.lock().unwrap_or_else(PoisonError::into_inner);
            if join.is_some() {
                return;
            }
            let shared = Arc::clone(&self.shared);
            let (started_tx, started_rx) = sync_channel::<Result<(), String>>(1);
            let spawned = std::thread::Builder::new()
                .name("velora-pad-input".into())
                .spawn(move || run(app, shared, started_tx));
            match spawned {
                Ok(handle) => {
                    *join = Some(handle);
                    // The thread reports success or failure right away; a failure is
                    // already recorded in the status and announced to the frontend.
                    let _ = started_rx.recv_timeout(std::time::Duration::from_secs(3));
                }
                Err(error) => {
                    self.record_failure(format!("Nie udało się uruchomić wątku pada: {error}"))
                }
            }
        }

        fn record_failure(&self, error: String) {
            let mut status = self
                .shared
                .status
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            status.supported = true;
            status.running = false;
            status.last_error = Some(error);
        }

        pub(crate) fn stop(&self) {
            self.shared.quit.store(true, Ordering::Release);
            let thread_id = self.shared.thread_id.load(Ordering::Acquire);
            if thread_id != 0 {
                native::post_quit(thread_id);
            }
            if let Some(handle) = self
                .join
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take()
            {
                let _ = handle.join();
            }
        }

        fn home_override(&self) -> Option<bool> {
            match self.shared.home_override.load(Ordering::Acquire) {
                1 => Some(false),
                2 => Some(true),
                _ => None,
            }
        }

        fn effective_home_enabled(&self) -> bool {
            effective_home_enabled(&self.shared)
        }

        fn publish_home_policy(&self) {
            let mut status = self
                .shared
                .status
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            status.home_override = self.home_override();
            status.home_enabled = self.effective_home_enabled();
        }

        pub(crate) fn controller_fallback_status(&self) -> ControllerFallbackStatus {
            self.shared
                .supervisor
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .status()
        }

        pub(crate) fn configure_controller_fallback(
            &self,
            config: ControllerFallbackConfig,
        ) -> Result<ControllerFallbackStatus, String> {
            let _policy = self
                .shared
                .home_policy_gate
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let status = self
                .shared
                .supervisor
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .configure(config)?;
            self.publish_home_policy();
            Ok(status)
        }

        pub(crate) fn set_chord_enabled(&self, enabled: bool) {
            let _policy = self
                .shared
                .home_policy_gate
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            self.shared
                .legacy_chord_enabled
                .store(enabled, Ordering::Release);
            self.publish_home_policy();
        }

        pub(crate) fn set_home_enabled(&self, enabled: bool) -> Result<(), String> {
            if !self.shared.running.load(Ordering::Acquire) {
                return Err("Natywny odczyt kontrolera jest niedostępny.".into());
            }
            let _policy = self
                .shared
                .home_policy_gate
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            self.shared
                .home_override
                .store(if enabled { 2 } else { 1 }, Ordering::Release);
            self.publish_home_policy();
            Ok(())
        }

        /// Number of DualShock 4 pads currently delivering reports.
        pub(crate) fn ds4_pad_count(&self) -> usize {
            self.shared
                .status
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .pads
                .len()
        }

        pub(crate) fn status(&self) -> NativeControllerStatus {
            let mut status = self
                .shared
                .status
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            status.supported = true;
            status
        }

        /// Starts forwarding non-DS4 reports to the caller. Fails when the sink is not
        /// running, so the Control Service reports a real reason instead of a silent no-op.
        pub(crate) fn subscribe_raw(&self) -> Result<RawSubscription, String> {
            if !self.shared.running.load(Ordering::Acquire) {
                return Err(self
                    .shared
                    .status
                    .read()
                    .unwrap_or_else(PoisonError::into_inner)
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "Odbiór Raw Input nie jest uruchomiony.".to_string()));
            }
            let (tx, rx) = sync_channel(RAW_QUEUE_CAPACITY);
            let id = self
                .shared
                .next_subscription
                .fetch_add(1, Ordering::Relaxed);
            *self
                .shared
                .subscriber
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some((id, tx));
            Ok(RawSubscription {
                receiver: rx,
                id,
                shared: Arc::clone(&self.shared),
            })
        }
    }

    fn run(
        app: AppHandle,
        shared: Arc<Shared>,
        started: std::sync::mpsc::SyncSender<Result<(), String>>,
    ) {
        let window = match native::create_message_window() {
            Ok(window) => window,
            Err(error) => {
                fail(&app, &shared, &started, error);
                return;
            }
        };
        if let Err(error) = native::register_raw_input(window) {
            native::destroy_message_window(window);
            fail(&app, &shared, &started, error);
            return;
        }
        shared
            .thread_id
            .store(native::current_thread_id(), Ordering::Release);
        shared.running.store(true, Ordering::Release);
        // If the pump ever unwinds, the status must not keep claiming the sink is alive.
        let mut guard = RunGuard {
            app: app.clone(),
            shared: Arc::clone(&shared),
            clean: false,
        };
        let initial_home_override = session_home_override(&shared);
        let initial_home_enabled = effective_home_enabled(&shared);
        {
            let mut status = shared
                .status
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            *status = NativeControllerStatus {
                supported: true,
                running: true,
                home_override: initial_home_override,
                home_enabled: initial_home_enabled,
                ..Default::default()
            };
        }
        let _ = started.send(Ok(()));

        let mut core = HubCore::default();
        // device handle -> (path, revision). A handle is only resolved once per arrival.
        let mut devices: std::collections::HashMap<usize, DeviceEntry> =
            std::collections::HashMap::new();
        'pump: loop {
            native::wait_for_messages(16);
            if shared.quit.load(Ordering::Acquire) {
                break 'pump;
            }
            for _ in 0..256 {
                let Some(message) = native::next_message() else {
                    break;
                };
                match message.message {
                    native::WM_QUIT => break 'pump,
                    native::WM_INPUT => {
                        handle_input(&app, &shared, &mut core, &mut devices, message.l_param);
                        native::def_window_proc(
                            message.window,
                            message.message,
                            message.w_param,
                            message.l_param,
                        );
                    }
                    native::WM_INPUT_DEVICE_CHANGE => {
                        let device = message.l_param as usize;
                        if message.w_param == native::GIDC_REMOVAL
                            || message.w_param == native::GIDC_ARRIVAL
                        {
                            // A same-path reconnect starts a new controller epoch.
                            // Drop queued stream reports before they can act on it.
                            crate::streaming_control::invalidate_controller_streaming(&app);
                            let mut dualsense = false;
                            if let Some(entry) = devices.remove(&device) {
                                dualsense = entry.dualsense;
                                if entry.ds4.is_some() {
                                    let label = crate::gamepad_home::device_label(&entry.path);
                                    shared
                                        .supervisor
                                        .lock()
                                        .unwrap_or_else(PoisonError::into_inner)
                                        .remove_device(&label);
                                    emit_all(&app, core.on_removed(&entry.path));
                                }
                            }
                            if dualsense {
                                let overflowed = forward(
                                    &shared,
                                    RawMessage::DeviceChange {
                                        w_param: message.w_param,
                                        device,
                                    },
                                );
                                if overflowed {
                                    crate::streaming_control::invalidate_controller_streaming(&app);
                                }
                            }
                            publish_status(&shared, &core);
                        }
                    }
                    _ => {}
                }
            }
            let at_ms = now_ms();
            let session_gate_open = crate::session_orchestrator::current_snapshot(&app).current
                != crate::session_orchestrator::SessionId::VeloraHome;
            let streaming_silence_reset = {
                let _policy = shared
                    .home_policy_gate
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                let mut supervisor = shared
                    .supervisor
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                supervisor.set_home_gate(effective_home_enabled(&shared));
                supervisor.set_session_gate(session_gate_open);
                let reset_streaming = supervisor.tick(at_ms);
                core.set_chord_sources(
                    session_home_override(&shared),
                    shared.legacy_chord_enabled.load(Ordering::Acquire),
                );
                core.set_primary_chord_suppressed(supervisor.suppress_primary_chord());
                reset_streaming
            };
            if streaming_silence_reset {
                crate::streaming_control::invalidate_controller_streaming(&app);
            }
            let events = core.tick(at_ms, native::foreground_is_own_process());
            if core.take_streaming_silence_reset() {
                crate::streaming_control::invalidate_controller_streaming(&app);
            }
            if !events.is_empty() {
                let disconnected: Vec<String> = events
                    .iter()
                    .filter_map(|event| match event {
                        ControllerEvent::Disconnected { device } => Some(device.clone()),
                        _ => None,
                    })
                    .collect();
                if !disconnected.is_empty() {
                    let mut supervisor = shared
                        .supervisor
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    for device in disconnected {
                        supervisor.remove_device(&device);
                    }
                }
                emit_all(&app, events);
                publish_status(&shared, &core);
            }
        }

        shared.running.store(false, Ordering::Release);
        *shared
            .subscriber
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
        shared.thread_id.store(0, Ordering::Release);
        emit_all(&app, core.shutdown());
        native::unregister_raw_input();
        native::destroy_message_window(window);
        {
            let mut status = shared
                .status
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            status.running = false;
            status.pads.clear();
        }
        guard.clean = true;
    }

    struct RunGuard {
        app: AppHandle,
        shared: Arc<Shared>,
        clean: bool,
    }

    impl Drop for RunGuard {
        fn drop(&mut self) {
            if self.clean {
                return;
            }
            self.shared.running.store(false, Ordering::Release);
            *self
                .shared
                .subscriber
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = None;
            self.shared.thread_id.store(0, Ordering::Release);
            let reason = "Odbiór pada zatrzymał się nieoczekiwanie.".to_string();
            {
                let mut status = self
                    .shared
                    .status
                    .write()
                    .unwrap_or_else(PoisonError::into_inner);
                status.running = false;
                status.pads.clear();
                status.last_error = Some(reason.clone());
            }
            let _ = self
                .app
                .emit(CONTROLLER_EVENT, ControllerEvent::Unavailable { reason });
        }
    }

    struct DeviceEntry {
        path: String,
        ds4: Option<Ds4Revision>,
        dualsense: bool,
    }

    fn fail(
        app: &AppHandle,
        shared: &Shared,
        started: &std::sync::mpsc::SyncSender<Result<(), String>>,
        error: String,
    ) {
        {
            let mut status = shared
                .status
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            *status = NativeControllerStatus {
                supported: true,
                running: false,
                last_error: Some(error.clone()),
                ..Default::default()
            };
        }
        let _ = app.emit(
            CONTROLLER_EVENT,
            ControllerEvent::Unavailable {
                reason: error.clone(),
            },
        );
        let _ = started.send(Err(error));
    }

    fn handle_input(
        app: &AppHandle,
        shared: &Arc<Shared>,
        core: &mut HubCore,
        devices: &mut std::collections::HashMap<usize, DeviceEntry>,
        l_param: isize,
    ) {
        let session_gate_open = crate::session_orchestrator::current_snapshot(app).current
            != crate::session_orchestrator::SessionId::VeloraHome;
        {
            let _policy = shared
                .home_policy_gate
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut supervisor = shared
                .supervisor
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            supervisor.set_home_gate(effective_home_enabled(shared));
            supervisor.set_session_gate(session_gate_open);
            core.set_chord_sources(
                session_home_override(shared),
                shared.legacy_chord_enabled.load(Ordering::Acquire),
            );
            core.set_primary_chord_suppressed(supervisor.suppress_primary_chord());
        }
        let Some(reports) = native::read_raw_input(l_param) else {
            return;
        };
        let at_ms = now_ms();
        let mut forwarded = Vec::new();
        for report in reports {
            let Some(handle) = report.device else {
                continue;
            };
            if !devices.contains_key(&handle) {
                if devices.len() >= 64 {
                    // Do not evict live handle-to-path mappings: doing so leaves
                    // tracker/chord state orphaned and can misidentify a report.
                    continue;
                }
                let Some(path) = native::device_path(handle) else {
                    continue;
                };
                // Vendor/product ids from RIDI_DEVICEINFO are authoritative; the path is a fallback.
                let ids = native::device_ids(handle);
                let ds4 = match ids {
                    Some((vendor, product)) => crate::ds4::ds4_revision_from_ids(vendor, product),
                    None => crate::ds4::ds4_revision_from_path(&path),
                };
                let dualsense = crate::gamepad_home::dualsense_identity(ids, &path).is_some();
                devices.insert(
                    handle,
                    DeviceEntry {
                        path,
                        ds4,
                        dualsense,
                    },
                );
            }
            let Some(entry) = devices.get(&handle) else {
                continue;
            };
            match entry.ds4 {
                Some(revision) => {
                    let trace_before_report = core.last_trace;
                    let out = core.on_report_with_foreground(
                        &entry.path,
                        revision,
                        &report.data,
                        at_ms,
                        native::foreground_is_own_process(),
                    );
                    {
                        let mut status = shared
                            .status
                            .write()
                            .unwrap_or_else(PoisonError::into_inner);
                        if core.last_trace != trace_before_report {
                            status.last_trace = core.last_trace;
                        }
                    }
                    let chord = out.chord;
                    let streaming_report = out.streaming_report;
                    let streaming_reset = out.streaming_reset;
                    emit_all(app, out.events);
                    if streaming_reset {
                        crate::streaming_control::invalidate_controller_streaming(app);
                    }
                    let fallback_triggered =
                        if let Some((label, parsed)) = streaming_report.as_ref() {
                            let _policy = shared
                                .home_policy_gate
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner);
                            let decision = {
                                let mut supervisor = shared
                                    .supervisor
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner);
                                supervisor.set_home_gate(effective_home_enabled(shared));
                                supervisor.set_session_gate(session_gate_open);
                                supervisor.observe_report(label, parsed.buttons, at_ms)
                            };
                            if decision.streaming_reset && !streaming_reset {
                                crate::streaming_control::invalidate_controller_streaming(app);
                            }
                            if decision.triggered {
                                // The configuration lock stays held through the bounded
                                // Home enqueue, so disabling fallback cannot race a dispatch.
                                trigger_home(app, shared, core, at_ms);
                            }
                            decision.triggered
                        } else {
                            false
                        };
                    if let Some((label, parsed)) = streaming_report.as_ref() {
                        // `route_controller_report` is required to be nonblocking;
                        // its consumer owns the bounded work queue.
                        crate::streaming_control::route_controller_report(
                            app, label, parsed, at_ms,
                        );
                    }
                    if chord && !fallback_triggered {
                        let _policy = shared
                            .home_policy_gate
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner);
                        if primary_home_chord_enabled(shared) {
                            trigger_home(app, shared, core, at_ms);
                        } else {
                            if let Some(mut chord) = core.last_chord {
                                chord.home_enabled = false;
                                chord.action_requested = false;
                                core.last_chord = Some(chord);
                            }
                            let trace = NativeHomeTrace {
                                stage: NativeHomeStage::Recognition,
                                outcome: NativeHomeOutcome::HomeDisabled,
                                at_ms,
                            };
                            core.last_trace = Some(trace);
                            let mut status = shared
                                .status
                                .write()
                                .unwrap_or_else(PoisonError::into_inner);
                            status.last_trace = Some(trace);
                        }
                    }
                    // Status advances for every native report, including when
                    // background navigation events are intentionally filtered.
                    publish_status(shared, core);
                }
                // A bounded queue also needs a bounded payload. Valid DualSense
                // reports fit in 78 bytes; allow padding up to 128 bytes.
                None if entry.dualsense && report.data.len() <= 128 => forwarded.push(report),
                None => {}
            }
        }
        if !forwarded.is_empty() {
            if forward(shared, RawMessage::Reports(forwarded)) {
                crate::streaming_control::invalidate_controller_streaming(app);
            }
        }
    }

    fn trigger_home(app: &AppHandle, shared: &Arc<Shared>, core: &mut HubCore, at_ms: u64) {
        use crate::session_orchestrator::{
            request_return_home, HomeRequestSource, TransitionCause,
        };
        // The native DS4 path is local physical intent. It uses the existing Home
        // transaction and one Windows foreground attempt, without input synthesis.
        let status_for_complete = Arc::clone(shared);
        let trace = NativeHomeTrace {
            stage: NativeHomeStage::Dispatch,
            outcome: NativeHomeOutcome::ReturnQueued,
            at_ms,
        };
        core.last_trace = Some(trace);
        {
            let mut status = shared
                .status
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            status.last_trace = Some(trace);
        }
        let queued = request_return_home(
            app.clone(),
            TransitionCause::GamepadHome,
            HomeRequestSource::LocalController,
            move |result| {
                let at_ms = now_ms();
                let diagnostic = match result {
                    Ok(result) => {
                        let restore = result.restore;
                        let outcome = match restore.outcome {
                            crate::window_broker::RestoreOutcome::Restored => {
                                NativeHomeOutcome::Restored
                            }
                            crate::window_broker::RestoreOutcome::AlreadyFocused => {
                                NativeHomeOutcome::AlreadyFocused
                            }
                            crate::window_broker::RestoreOutcome::BlockedUnsafeForeground => {
                                NativeHomeOutcome::BlockedUnsafeForeground
                            }
                            crate::window_broker::RestoreOutcome::BlockedByWindows => {
                                NativeHomeOutcome::BlockedByWindows
                            }
                            crate::window_broker::RestoreOutcome::WindowUnavailable => {
                                NativeHomeOutcome::WindowUnavailable
                            }
                            crate::window_broker::RestoreOutcome::UnsupportedPlatform => {
                                NativeHomeOutcome::UnsupportedPlatform
                            }
                        };
                        NativeRestoreDiagnostic {
                            outcome,
                            at_ms,
                            own_window: restore.own_window,
                            foreground_before_hwnd: restore.foreground_before.hwnd,
                            foreground_after_hwnd: restore.foreground_after.hwnd,
                            foreground_before_process_id: restore.foreground_before.process_id,
                            foreground_after_process_id: restore.foreground_after.process_id,
                            error_code: restore.error_code,
                        }
                    }
                    Err(_) => NativeRestoreDiagnostic {
                        outcome: NativeHomeOutcome::Failed,
                        at_ms,
                        own_window: None,
                        foreground_before_hwnd: None,
                        foreground_after_hwnd: None,
                        foreground_before_process_id: None,
                        foreground_after_process_id: None,
                        error_code: None,
                    },
                };
                let mut status = status_for_complete
                    .status
                    .write()
                    .unwrap_or_else(PoisonError::into_inner);
                status.last_restore = Some(diagnostic);
                status.last_trace = Some(NativeHomeTrace {
                    stage: NativeHomeStage::Restore,
                    outcome: diagnostic.outcome,
                    at_ms,
                });
            },
        );
        if !queued {
            let trace = NativeHomeTrace {
                stage: NativeHomeStage::Dispatch,
                outcome: NativeHomeOutcome::QueueRejected,
                at_ms,
            };
            core.last_trace = Some(trace);
            let mut status = shared
                .status
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            status.queue_rejected = status.queue_rejected.saturating_add(1);
            status.last_restore = Some(NativeRestoreDiagnostic {
                outcome: NativeHomeOutcome::QueueRejected,
                at_ms,
                own_window: None,
                foreground_before_hwnd: None,
                foreground_after_hwnd: None,
                foreground_before_process_id: None,
                foreground_after_process_id: None,
                error_code: None,
            });
            status.last_trace = Some(trace);
        }
    }

    /// Returns true when a full bounded queue dropped this message.
    fn forward(shared: &Shared, message: RawMessage) -> bool {
        let mut guard = shared
            .subscriber
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut overflowed = false;
        if let Some((_, sender)) = guard.as_ref() {
            let epoch = shared.overflow_epoch.load(Ordering::Acquire);
            match sender.try_send(RawEnvelope { epoch, message }) {
                Ok(()) => {}
                Err(TrySendError::Disconnected(_)) => *guard = None,
                Err(TrySendError::Full(_)) => {
                    // Invalidate every queued chord fragment after a lost edge.
                    shared.overflow_epoch.fetch_add(1, Ordering::AcqRel);
                    overflowed = true;
                    let mut status = shared
                        .status
                        .write()
                        .unwrap_or_else(PoisonError::into_inner);
                    status.dropped_raw_reports = status.dropped_raw_reports.saturating_add(1);
                }
            }
        }
        overflowed
    }

    #[cfg(test)]
    mod queue_tests {
        use super::*;
        #[test]
        fn queue_is_bounded_nonblocking_invalidates_on_overload_and_disconnects() {
            let shared = Arc::new(Shared::default());
            shared.running.store(true, Ordering::Release);
            let hub = PadHub {
                shared: Arc::clone(&shared),
                join: Mutex::new(None),
            };
            let subscription = hub.subscribe_raw().unwrap();
            for _ in 0..RAW_QUEUE_CAPACITY + 1 {
                forward(
                    &shared,
                    RawMessage::DeviceChange {
                        w_param: 0,
                        device: 1,
                    },
                );
            }
            assert_eq!(subscription.epoch(), 1);
            assert_eq!(hub.status().dropped_raw_reports, 1);
            assert_eq!(subscription.receiver.try_iter().count(), RAW_QUEUE_CAPACITY);
            drop(subscription);
            assert!(shared.subscriber.lock().unwrap().is_none());
        }
        #[test]
        fn replacing_subscription_does_not_let_old_drop_remove_new_one() {
            let shared = Arc::new(Shared::default());
            shared.running.store(true, Ordering::Release);
            let hub = PadHub {
                shared: Arc::clone(&shared),
                join: Mutex::new(None),
            };
            let old = hub.subscribe_raw().unwrap();
            let new = hub.subscribe_raw().unwrap();
            drop(old);
            forward(
                &shared,
                RawMessage::DeviceChange {
                    w_param: 0,
                    device: 1,
                },
            );
            assert!(new.receiver.try_recv().is_ok());
        }
    }

    fn emit_all(app: &AppHandle, events: Vec<ControllerEvent>) {
        for event in events {
            let _ = app.emit(CONTROLLER_EVENT, event);
        }
    }

    fn publish_status(shared: &Shared, core: &HubCore) {
        let mut status = shared
            .status
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        status.pads = core.pads();
        status.ignored_reports = core.ignored_reports();
        status.home_override = session_home_override(shared);
        status.home_enabled = effective_home_enabled(shared);
        status.received_reports = core.received_reports;
        status.valid_reports = core.valid_reports;
        status.background_reports = core.background_reports;
        status.last_report_at_ms = core.last_report_at_ms;
        status.last_home_buttons = core.last_home_buttons;
        status.ps_rising_count = core.ps_rising_count;
        status.last_ps_rising_at_ms = core.last_ps_rising_at_ms;
        status.options_rising_count = core.options_rising_count;
        status.last_options_rising_at_ms = core.last_options_rising_at_ms;
        status.last_chord = core.last_chord;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ds4::Ds4Button;

    const USB_PATH: &str = r"\\?\HID#VID_054C&PID_09CC#7&2a3b4c5d&0&0000#{4d1e55b2}";
    const USB_PATH_B: &str = r"\\?\HID#VID_054C&PID_09CC#7&2a3b4c5e&0&0000#{4d1e55b2}";

    fn usb(face: u8, shoulder: u8, special: u8) -> Vec<u8> {
        let mut report = vec![0u8; 64];
        report[0] = 0x01;
        report[1..5].copy_from_slice(&[128; 4]);
        report[5] = 0x08 | face;
        report[6] = shoulder;
        report[7] = special;
        report
    }

    fn states(events: &[ControllerEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, ControllerEvent::State(_)))
            .count()
    }

    #[test]
    fn events_serialize_to_the_frontend_contract_without_path_or_bytes() {
        let mut core = HubCore::default();
        core.tick(0, true);
        let out = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0x20, 0, 0), 1);
        let json: Vec<String> = out
            .events
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect();
        assert_eq!(json.len(), 2);
        assert!(
            json[0].starts_with(r#"{"kind":"connected","device":""#),
            "{}",
            json[0]
        );
        assert!(json[0].contains(r#""revision":"v2""#) && json[0].contains(r#""transport":"usb""#));
        assert!(
            json[1].starts_with(r#"{"kind":"state","device":""#),
            "{}",
            json[1]
        );
        assert!(json[1].contains(r#""buttons":["cross"]"#));
        assert!(json[1].contains(r#""dpad":{"up":false,"down":false,"left":false,"right":false}"#));
        assert!(json[1].contains(r#""leftX":0"#));
        for line in &json {
            let lower = line.to_ascii_lowercase();
            assert!(
                !lower.contains("hid#")
                    && !lower.contains("vid_054c")
                    && !lower.contains("2a3b4c5d")
            );
        }
        let unavailable =
            serde_json::to_string(&ControllerEvent::Unavailable { reason: "x".into() }).unwrap();
        assert_eq!(unavailable, r#"{"kind":"unavailable","reason":"x"}"#);
        let gone =
            serde_json::to_string(&ControllerEvent::Disconnected { device: "d".into() }).unwrap();
        assert_eq!(gone, r#"{"kind":"disconnected","device":"d"}"#);
    }

    #[test]
    fn state_is_withheld_while_velora_is_in_the_background_but_connection_is_not() {
        let mut core = HubCore::default();
        core.tick(0, false);
        let out = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0x20, 0, 0), 1);
        assert_eq!(out.events.len(), 1);
        assert!(matches!(out.events[0], ControllerEvent::Connected { .. }));
        // Gaining the foreground resynchronises with the current state in one event.
        let resync = core.tick(10, true);
        assert_eq!(states(&resync), 1);
        match &resync[0] {
            ControllerEvent::State(snapshot) => {
                assert_eq!(snapshot.buttons, vec![Ds4Button::Cross])
            }
            other => panic!("unexpected {other:?}"),
        }
        // From now on changes flow.
        let out = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 20);
        assert_eq!(states(&out.events), 1);
        // And losing the foreground stops them again.
        core.tick(30, false);
        assert_eq!(
            states(
                &core
                    .on_report(USB_PATH, Ds4Revision::V2, &usb(0x20, 0, 0), 40)
                    .events
            ),
            0
        );
    }

    #[test]
    fn a_held_input_is_re_sent_as_a_heartbeat_and_neutral_is_not() {
        let mut core = HubCore::default();
        core.tick(0, true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0x20, 0, 0), 1);
        assert!(core.tick(100, true).is_empty(), "too early");
        assert_eq!(states(&core.tick(HEARTBEAT_MS + 1, true)), 1);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 300);
        assert!(
            core.tick(HEARTBEAT_MS * 3, true).is_empty(),
            "neutral pads stay quiet"
        );
    }

    #[test]
    fn silent_pads_are_dropped_with_a_disconnect_event() {
        let mut core = HubCore::default();
        core.tick(0, true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        let events = core.tick(crate::ds4::PAD_STALE_MS + 1, true);
        assert!(events
            .iter()
            .any(|e| matches!(e, ControllerEvent::Disconnected { .. })));
        assert_eq!(core.pad_count(), 0);
    }

    #[test]
    fn streaming_invalidates_once_when_a_pad_goes_silent_or_resumes_after_gap() {
        let mut core = HubCore::default();
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        core.tick(crate::ds4::SILENCE_RELEASE_MS, false);
        assert!(core.take_streaming_silence_reset());
        assert!(!core.take_streaming_silence_reset());
        let resumed = core.on_report(
            USB_PATH,
            Ds4Revision::V2,
            &usb(0, 0, 0),
            crate::ds4::SILENCE_RELEASE_MS + 1,
        );
        assert!(
            !resumed.streaming_reset,
            "the silence tick already invalidated it"
        );

        let mut delayed_pump = HubCore::default();
        delayed_pump.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        let resumed = delayed_pump.on_report(
            USB_PATH,
            Ds4Revision::V2,
            &usb(0, 0, 0),
            crate::ds4::SILENCE_RELEASE_MS + 1,
        );
        assert!(
            resumed.streaming_reset,
            "a resumed report can race a delayed tick"
        );
    }

    #[test]
    fn removal_emits_disconnect_once() {
        let mut core = HubCore::default();
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        assert_eq!(core.on_removed(USB_PATH).len(), 1);
        assert!(core.on_removed(USB_PATH).is_empty());
    }

    #[test]
    fn ps_plus_options_chord_fires_once_only_when_enabled() {
        let mut core = HubCore::default();
        core.set_chord_enabled(false);
        let out = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 100);
        assert!(
            !out.chord,
            "disabled: the chord is detected but never acted on"
        );
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 150);
        core.set_chord_enabled(true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 1_900);
        // Options then PS within the 250 ms window, either order.
        let first = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 2_000);
        assert!(!first.chord);
        let second = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 2_100);
        assert!(second.chord);
        // Held: latched, no repeat.
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 2_200)
                .chord
        );
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 2_300)
                .chord
        );
    }

    #[test]
    fn ps_alone_or_options_alone_never_fires_the_chord() {
        let mut core = HubCore::default();
        core.set_chord_enabled(true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0x01), 100)
                .chord
        );
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 150);
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 5_000)
                .chord
        );
    }

    #[test]
    fn chord_buttons_far_apart_are_rejected() {
        let mut core = HubCore::default();
        core.set_chord_enabled(true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 1_000);
        let late = core.on_report(
            USB_PATH,
            Ds4Revision::V2,
            &usb(0, 0x20, 0x01),
            1_000 + crate::gamepad_home::CHORD_WINDOW_MS + 1,
        );
        assert!(!late.chord);
    }

    #[test]
    fn corrupt_reports_do_not_connect_or_fire() {
        let mut core = HubCore::default();
        core.set_chord_enabled(true);
        let out = core.on_report(USB_PATH, Ds4Revision::V2, &[0x01, 0xff], 0);
        assert!(out.events.is_empty() && !out.chord);
        assert_eq!(core.pad_count(), 0);
        assert_eq!(core.ignored_reports(), 1);
    }

    #[test]
    fn explicit_session_enable_is_independent_and_survives_legacy_stop() {
        let mut core = HubCore::default();
        core.set_chord_sources(Some(true), true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        core.set_chord_sources(Some(true), false);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 100);
        assert!(
            core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 150)
                .chord
        );
        assert_eq!(core.home_override, Some(true));
        assert!(!core.legacy_chord_enabled);
        assert!(core.chord_enabled);
    }

    #[test]
    fn explicit_session_disable_wins_while_legacy_control_service_is_on() {
        let mut core = HubCore::default();
        core.set_chord_sources(Some(false), true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 100);
        let chord = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 150);
        assert!(!chord.chord);
        assert_eq!(core.home_override, Some(false));
        assert!(core.legacy_chord_enabled);
        assert!(!core.chord_enabled);
        let diagnostic = core.last_chord.unwrap();
        assert!(!diagnostic.home_enabled && !diagnostic.action_requested);
    }

    #[test]
    fn startup_does_not_enable_home_and_reenable_requires_neutral() {
        let mut core = HubCore::default();
        core.set_chord_sources(None, false);
        assert!(!core.chord_enabled);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 10)
                .chord
        );
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 20)
                .chord
        );

        core.set_chord_sources(Some(true), false);
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 30)
                .chord
        );
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 40);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 50);
        assert!(
            core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 60)
                .chord
        );
    }

    #[test]
    fn enabled_home_chord_is_observed_in_background_without_frontend_state_events() {
        let mut core = HubCore::default();
        core.set_chord_sources(Some(true), false);
        core.on_report_with_foreground(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0, true);
        core.tick(1, false);
        core.on_report_with_foreground(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 10, false);
        let chord = core.on_report_with_foreground(
            USB_PATH,
            Ds4Revision::V2,
            &usb(0, 0x20, 0x01),
            20,
            false,
        );
        assert!(chord.chord);
        assert_eq!(states(&chord.events), 0);
        assert_eq!(core.background_reports, 2);
        assert_eq!(core.last_home_buttons.unwrap().ps, true);
        assert_eq!(core.last_home_buttons.unwrap().options, true);
    }

    #[test]
    fn full_ds4_report_is_available_to_streaming_even_in_the_background() {
        let mut core = HubCore::default();
        let mut report = usb(0, 0x20, 0x01);
        report[1] = 255;
        report[8] = 128;
        let out = core.on_report_with_foreground(USB_PATH, Ds4Revision::V2, &report, 10, false);
        assert_eq!(
            states(&out.events),
            0,
            "background navigation stays withheld"
        );
        let (device, parsed) = out.streaming_report.expect("parsed report route");
        assert_eq!(
            device.len(),
            16,
            "only a hashed device label leaves the hub"
        );
        assert_eq!(parsed.left_x, 1.0);
        assert!((parsed.l2 - 128.0 / 255.0).abs() < 0.001);
        assert!(parsed.buttons.is_pressed(Ds4Button::Options));
    }

    #[test]
    fn configured_fallback_suppresses_primary_and_reenable_requires_neutral() {
        let mut core = HubCore::default();
        core.set_chord_sources(Some(true), false);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        core.set_primary_chord_suppressed(true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 10);
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 20)
                .chord
        );
        core.set_primary_chord_suppressed(false);
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 30)
                .chord
        );
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 40);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 50);
        assert!(
            core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 60)
                .chord
        );
    }

    #[test]
    fn reconnect_with_buttons_held_waits_for_a_neutral_sample() {
        let mut core = HubCore::default();
        core.set_chord_sources(Some(true), false);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 1_000);
        assert!(
            core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 1_050)
                .chord
        );
        core.on_removed(USB_PATH);
        assert!(
            !core
                .on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 2_000)
                .chord
        );
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 2_010);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 2_020);
        assert!(
            core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 2_030)
                .chord
        );
    }

    #[test]
    fn removing_one_pad_does_not_invalidate_another_pads_pending_chord() {
        let mut core = HubCore::default();
        core.set_chord_sources(Some(true), false);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        core.on_report(USB_PATH_B, Ds4Revision::V2, &usb(0, 0, 0), 0);
        assert!(
            core.on_report(USB_PATH_B, Ds4Revision::V2, &usb(0, 0x20, 0x01), 10)
                .chord
        );
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0x01), 1_000);

        core.on_removed(USB_PATH_B);

        assert!(
            core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 1_050)
                .chord
        );
    }

    #[test]
    fn pruning_one_stale_pad_does_not_invalidate_another_pads_pending_chord() {
        let mut core = HubCore::default();
        core.set_chord_sources(Some(true), false);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        core.on_report(USB_PATH_B, Ds4Revision::V2, &usb(0, 0, 0), 0);
        assert!(
            core.on_report(USB_PATH_B, Ds4Revision::V2, &usb(0, 0x20, 0x01), 10)
                .chord
        );
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0x01), 5_000);

        core.tick(5_201, true);

        assert!(
            core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 5_202)
                .chord
        );
    }

    #[test]
    fn diagnostics_distinguish_invalid_reports_from_valid_background_buttons() {
        let mut core = HubCore::default();
        core.on_report_with_foreground(USB_PATH, Ds4Revision::V2, &[0x01, 0xff], 10, false);
        assert_eq!(core.received_reports, 1);
        assert_eq!(core.valid_reports, 0);
        assert_eq!(core.background_reports, 1);
        assert_eq!(core.last_home_buttons, None);

        core.on_report_with_foreground(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 15, false);
        core.on_report_with_foreground(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 20, false);
        assert_eq!(core.received_reports, 3);
        assert_eq!(core.valid_reports, 2);
        assert_eq!(core.background_reports, 3);
        assert_eq!(core.ps_rising_count, 1);
        assert_eq!(core.options_rising_count, 1);
        assert_eq!(core.last_ps_rising_at_ms, Some(20));
        assert_eq!(core.last_options_rising_at_ms, Some(20));
        let buttons = core.last_home_buttons.unwrap();
        assert!(buttons.ps && buttons.options);
        assert_eq!(buttons.at_ms, 20);
    }

    #[test]
    fn status_serializes_to_the_frontend_contract() {
        let status = NativeControllerStatus::default();
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains(r#""supported":false"#) && json.contains(r#""ignoredReports":0"#));
        assert!(json.contains(r#""pads":[]"#) && json.contains(r#""lastError":null"#));
    }

    #[test]
    fn a_pad_that_goes_silent_while_holding_is_released_once_and_never_heartbeated() {
        let mut core = HubCore::default();
        core.tick(0, true);
        let mut right = usb(0, 0, 0);
        right[5] = 0x02; // hat east
        core.on_report(USB_PATH, Ds4Revision::V2, &right, 1);
        // Reports stop (Bluetooth drop). Within the silence window heartbeats still flow.
        assert_eq!(states(&core.tick(HEARTBEAT_MS + 2, true)), 1);
        // Past the silence window: exactly one neutral state, then nothing while it stays silent.
        let released = core.tick(1 + crate::ds4::SILENCE_RELEASE_MS, true);
        assert_eq!(states(&released), 1);
        match &released[0] {
            ControllerEvent::State(snapshot) => assert!(crate::ds4::is_neutral(snapshot)),
            other => panic!("unexpected {other:?}"),
        }
        for at in [2_000, 2_500, 2_900] {
            assert_eq!(
                states(&core.tick(at, true)),
                0,
                "no heartbeat for a silent pad at {at}"
            );
        }
        // The pad returns and presses again: the change is reported normally.
        assert_eq!(
            states(
                &core
                    .on_report(USB_PATH, Ds4Revision::V2, &right, 2_950)
                    .events
            ),
            1
        );
    }

    #[test]
    fn the_usb_adapter_without_a_paired_pad_is_not_a_pad() {
        let mut core = HubCore::default();
        let adapter = r"\?HID#VID_054C&PID_0BA0#adapter";
        let mut idle = usb(0, 0, 0);
        idle[31] |= 0x04; // "no controller" flag
        let out = core.on_report(adapter, Ds4Revision::UsbAdapter, &idle, 0);
        assert!(out.events.is_empty() && !out.chord);
        assert_eq!(core.pad_count(), 0);
        // With a paired pad the flag is clear and it connects.
        let live = usb(0, 0, 0);
        assert!(!core
            .on_report(adapter, Ds4Revision::UsbAdapter, &live, 10)
            .events
            .is_empty());
        assert_eq!(core.pad_count(), 1);
    }
}
