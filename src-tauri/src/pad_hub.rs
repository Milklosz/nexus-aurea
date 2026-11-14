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
    is_neutral, Ds4Buttons, Ds4Revision, Ds4Snapshot, Ds4Tracker, Ds4Transport, PadEvent, PadInfo,
};
use crate::gamepad_home::{ChordOutcome, ComboTracker, DualSenseButtons};
use serde::Serialize;

pub(crate) const CONTROLLER_EVENT: &str = "velora-controller";

/// While an input is held the current state is re-sent this often, so a lost release
/// event can never leave the frontend with a stuck direction.
pub(crate) const HEARTBEAT_MS: u64 = 250;

/// Event sent to the frontend. Mirrors `NativeControllerEvent` in
/// `src/services/nativeController.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ControllerEvent {
    Connected { device: String, revision: Ds4Revision, transport: Ds4Transport },
    State(Ds4Snapshot),
    Disconnected { device: String },
    Unavailable { reason: String },
}

impl From<PadEvent> for ControllerEvent {
    fn from(event: PadEvent) -> Self {
        match event {
            PadEvent::Connected { label, revision, transport } => {
                Self::Connected { device: label, revision, transport }
            }
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
}

/// Output of feeding the core: events to emit and whether the Home chord fired.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct CoreOutput {
    pub events: Vec<ControllerEvent>,
    pub chord: bool,
    pub chord_outcome: Option<ChordOutcome>,
}

/// Platform-independent heart of the hub: DS4 tracking, chord detection, and the
/// decision of what the frontend is allowed to see. No Win32, no Tauri, no clock.
#[derive(Default)]
pub(crate) struct HubCore {
    tracker: Ds4Tracker,
    chord: ComboTracker,
    chord_enabled: bool,
    foreground: bool,
    last_heartbeat_ms: u64,
}

impl HubCore {
    pub(crate) fn set_chord_enabled(&mut self, enabled: bool) {
        self.chord_enabled = enabled;
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
        let ingest = self.tracker.on_report(path, revision, report, at_ms);
        let mut out = CoreOutput::default();
        out.events = ingest
            .events
            .into_iter()
            .filter(|event| self.foreground || !matches!(event, PadEvent::State(_)))
            .map(ControllerEvent::from)
            .collect();
        if let (Some(label), Some(buttons)) = (ingest.label, ingest.buttons) {
            let (triggered, outcome) = self.chord.observe_diagnostic(&label, chord_buttons(buttons), at_ms);
            out.chord_outcome = Some(outcome);
            // The chord is a global Home gesture: it is armed only while the Control
            // Service has enabled it, exactly like the DualSense chord.
            out.chord = triggered && self.chord_enabled;
        }
        out
    }

    pub(crate) fn on_removed(&mut self, path: &str) -> Vec<ControllerEvent> {
        let label = crate::gamepad_home::device_label(path);
        self.chord.remove_device(&label);
        self.tracker.on_removed(path).into_iter().map(ControllerEvent::from).collect()
    }

    /// Periodic housekeeping: drops silent pads, resynchronises the frontend when VELORA
    /// becomes the foreground window, and re-sends held state as a heartbeat.
    pub(crate) fn tick(&mut self, at_ms: u64, foreground: bool) -> Vec<ControllerEvent> {
        let mut events: Vec<ControllerEvent> = Vec::new();
        for event in self.tracker.prune(at_ms) {
            if let PadEvent::Disconnected { label } = &event {
                self.chord.remove_device(label);
            }
            events.push(event.into());
        }
        self.chord.prune(at_ms);
        let gained = foreground && !self.foreground;
        self.foreground = foreground;
        if gained {
            // Anything pressed while the window was in the background is reported now.
            events.extend(self.tracker.snapshots().into_iter().map(ControllerEvent::State));
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

    /// Everything is released and every pad forgotten, e.g. when the hub stops.
    pub(crate) fn shutdown(&mut self) -> Vec<ControllerEvent> {
        self.tracker.clear().into_iter().map(ControllerEvent::from).collect()
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
pub(crate) struct PadHub;

#[cfg(not(target_os = "windows"))]
impl PadHub {
    pub(crate) fn start(&self, _app: tauri::AppHandle) {}
    pub(crate) fn stop(&self) {}
    pub(crate) fn set_chord_enabled(&self, _enabled: bool) {}
    pub(crate) fn ds4_pad_count(&self) -> usize {
        0
    }
    pub(crate) fn status(&self) -> NativeControllerStatus {
        NativeControllerStatus::default()
    }
}

/// Current native controller state, so the frontend can seed itself after it starts
/// listening (events emitted before the WebView listens are lost).
#[tauri::command]
pub fn get_native_controller_status(hub: tauri::State<'_, PadHub>) -> NativeControllerStatus {
    hub.status()
}

#[cfg(target_os = "windows")]
mod runtime {
    use super::*;
    use crate::gamepad_home::native;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc::{channel, sync_channel, Receiver, Sender};
    use std::sync::{Arc, Mutex, PoisonError, RwLock};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::{AppHandle, Emitter};

    /// Unmodified reports and device notifications for consumers other than DS4.
    pub(crate) enum RawMessage {
        Reports(Vec<native::RawReport>),
        DeviceChange { w_param: usize, device: usize },
    }

    #[derive(Default)]
    struct Shared {
        running: AtomicBool,
        chord_enabled: AtomicBool,
        thread_id: AtomicU32,
        status: RwLock<NativeControllerStatus>,
        subscriber: Mutex<Option<Sender<RawMessage>>>,
    }

    /// Held by the one consumer of forwarded reports. Dropping it unsubscribes.
    pub(crate) struct RawSubscription {
        pub(crate) receiver: Receiver<RawMessage>,
        shared: Arc<Shared>,
    }

    impl Drop for RawSubscription {
        fn drop(&mut self) {
            *self.shared.subscriber.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
    }

    #[derive(Default)]
    pub(crate) struct PadHub {
        shared: Arc<Shared>,
        join: Mutex<Option<std::thread::JoinHandle<()>>>,
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0)
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
                Err(error) => self.record_failure(format!("Nie udało się uruchomić wątku pada: {error}")),
            }
        }

        fn record_failure(&self, error: String) {
            let mut status = self.shared.status.write().unwrap_or_else(PoisonError::into_inner);
            status.supported = true;
            status.running = false;
            status.last_error = Some(error);
        }

        pub(crate) fn stop(&self) {
            let thread_id = self.shared.thread_id.load(Ordering::Acquire);
            if thread_id != 0 {
                native::post_quit(thread_id);
            }
            if let Some(handle) = self.join.lock().unwrap_or_else(PoisonError::into_inner).take() {
                let _ = handle.join();
            }
        }

        pub(crate) fn set_chord_enabled(&self, enabled: bool) {
            self.shared.chord_enabled.store(enabled, Ordering::Release);
        }

        /// Number of DualShock 4 pads currently delivering reports.
        pub(crate) fn ds4_pad_count(&self) -> usize {
            self.shared.status.read().unwrap_or_else(PoisonError::into_inner).pads.len()
        }

        pub(crate) fn status(&self) -> NativeControllerStatus {
            let mut status = self.shared.status.read().unwrap_or_else(PoisonError::into_inner).clone();
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
            let (tx, rx) = channel();
            *self.shared.subscriber.lock().unwrap_or_else(PoisonError::into_inner) = Some(tx);
            Ok(RawSubscription { receiver: rx, shared: Arc::clone(&self.shared) })
        }
    }

    fn run(app: AppHandle, shared: Arc<Shared>, started: std::sync::mpsc::SyncSender<Result<(), String>>) {
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
        shared.thread_id.store(native::current_thread_id(), Ordering::Release);
        shared.running.store(true, Ordering::Release);
        {
            let mut status = shared.status.write().unwrap_or_else(PoisonError::into_inner);
            *status = NativeControllerStatus { supported: true, running: true, ..Default::default() };
        }
        let _ = started.send(Ok(()));

        let mut core = HubCore::default();
        // device handle -> (path, revision). A handle is only resolved once per arrival.
        let mut devices: std::collections::HashMap<usize, DeviceEntry> = std::collections::HashMap::new();
        'pump: loop {
            native::wait_for_messages(50);
            while let Some(message) = native::next_message() {
                match message.message {
                    native::WM_QUIT => break 'pump,
                    native::WM_INPUT => {
                        handle_input(&app, &shared, &mut core, &mut devices, message.l_param);
                        native::def_window_proc(message.window, message.message, message.w_param, message.l_param);
                    }
                    native::WM_INPUT_DEVICE_CHANGE => {
                        let device = message.l_param as usize;
                        if message.w_param == native::GIDC_REMOVAL || message.w_param == native::GIDC_ARRIVAL {
                            if let Some(entry) = devices.remove(&device) {
                                if entry.ds4.is_some() {
                                    emit_all(&app, core.on_removed(&entry.path));
                                }
                            }
                            forward(&shared, RawMessage::DeviceChange { w_param: message.w_param, device });
                            publish_status(&shared, &core);
                        }
                    }
                    _ => {}
                }
            }
            core.set_chord_enabled(shared.chord_enabled.load(Ordering::Acquire));
            let events = core.tick(now_ms(), native::foreground_is_own_process());
            if !events.is_empty() {
                emit_all(&app, events);
                publish_status(&shared, &core);
            }
        }

        shared.running.store(false, Ordering::Release);
        shared.thread_id.store(0, Ordering::Release);
        emit_all(&app, core.shutdown());
        native::unregister_raw_input();
        native::destroy_message_window(window);
        let mut status = shared.status.write().unwrap_or_else(PoisonError::into_inner);
        status.running = false;
        status.pads.clear();
    }

    struct DeviceEntry {
        path: String,
        ds4: Option<Ds4Revision>,
    }

    fn fail(app: &AppHandle, shared: &Shared, started: &std::sync::mpsc::SyncSender<Result<(), String>>, error: String) {
        {
            let mut status = shared.status.write().unwrap_or_else(PoisonError::into_inner);
            *status = NativeControllerStatus {
                supported: true,
                running: false,
                last_error: Some(error.clone()),
                ..Default::default()
            };
        }
        let _ = app.emit(CONTROLLER_EVENT, ControllerEvent::Unavailable { reason: error.clone() });
        let _ = started.send(Err(error));
    }

    fn handle_input(
        app: &AppHandle,
        shared: &Shared,
        core: &mut HubCore,
        devices: &mut std::collections::HashMap<usize, DeviceEntry>,
        l_param: isize,
    ) {
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
                    devices.clear();
                }
                let Some(path) = native::device_path(handle) else {
                    continue;
                };
                // Vendor/product ids from RIDI_DEVICEINFO are authoritative; the path is a fallback.
                let ds4 = native::device_ids(handle)
                    .and_then(|(vendor, product)| crate::ds4::ds4_revision_from_ids(vendor, product))
                    .or_else(|| crate::ds4::ds4_revision_from_path(&path));
                devices.insert(handle, DeviceEntry { path, ds4 });
            }
            let Some(entry) = devices.get(&handle) else {
                continue;
            };
            match entry.ds4 {
                Some(revision) => {
                    let out = core.on_report(&entry.path, revision, &report.data, at_ms);
                    let changed = !out.events.is_empty();
                    emit_all(app, out.events);
                    if out.chord {
                        trigger_home(app);
                    }
                    if changed {
                        publish_status(shared, core);
                    }
                }
                None => forwarded.push(report),
            }
        }
        if !forwarded.is_empty() {
            forward(shared, RawMessage::Reports(forwarded));
        }
    }

    fn trigger_home(app: &AppHandle) {
        use crate::session_orchestrator::{request_return_home, HomeRequestSource, TransitionCause};
        let app_for_event = app.clone();
        // Same pipeline and the same policy as the DualSense chord: one explicit attempt,
        // no focus tricks. The result is reported through the existing return-home event.
        let _ = request_return_home(
            app.clone(),
            TransitionCause::GamepadHome,
            HomeRequestSource::Device,
            move |_result| {
                let _ = &app_for_event;
            },
        );
    }

    fn forward(shared: &Shared, message: RawMessage) {
        let mut guard = shared.subscriber.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(sender) = guard.as_ref() {
            if sender.send(message).is_err() {
                *guard = None;
            }
        }
    }

    fn emit_all(app: &AppHandle, events: Vec<ControllerEvent>) {
        for event in events {
            let _ = app.emit(CONTROLLER_EVENT, event);
        }
    }

    fn publish_status(shared: &Shared, core: &HubCore) {
        let mut status = shared.status.write().unwrap_or_else(PoisonError::into_inner);
        status.pads = core.pads();
        status.ignored_reports = core.ignored_reports();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ds4::{Ds4Button, Ds4Transport};

    const USB_PATH: &str = r"\\?\HID#VID_054C&PID_09CC#7&2a3b4c5d&0&0000#{4d1e55b2}";

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
        events.iter().filter(|e| matches!(e, ControllerEvent::State(_))).count()
    }

    #[test]
    fn events_serialize_to_the_frontend_contract_without_path_or_bytes() {
        let mut core = HubCore::default();
        core.tick(0, true);
        let out = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0x20, 0, 0), 1);
        let json: Vec<String> = out.events.iter().map(|e| serde_json::to_string(e).unwrap()).collect();
        assert_eq!(json.len(), 2);
        assert!(json[0].starts_with(r#"{"kind":"connected","device":""#), "{}", json[0]);
        assert!(json[0].contains(r#""revision":"v2""#) && json[0].contains(r#""transport":"usb""#));
        assert!(json[1].starts_with(r#"{"kind":"state","device":""#), "{}", json[1]);
        assert!(json[1].contains(r#""buttons":["cross"]"#));
        assert!(json[1].contains(r#""dpad":{"up":false,"down":false,"left":false,"right":false}"#));
        assert!(json[1].contains(r#""leftX":0"#));
        for line in &json {
            let lower = line.to_ascii_lowercase();
            assert!(!lower.contains("hid#") && !lower.contains("vid_054c") && !lower.contains("2a3b4c5d"));
        }
        let unavailable = serde_json::to_string(&ControllerEvent::Unavailable { reason: "x".into() }).unwrap();
        assert_eq!(unavailable, r#"{"kind":"unavailable","reason":"x"}"#);
        let gone = serde_json::to_string(&ControllerEvent::Disconnected { device: "d".into() }).unwrap();
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
            ControllerEvent::State(snapshot) => assert_eq!(snapshot.buttons, vec![Ds4Button::Cross]),
            other => panic!("unexpected {other:?}"),
        }
        // From now on changes flow.
        let out = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 20);
        assert_eq!(states(&out.events), 1);
        // And losing the foreground stops them again.
        core.tick(30, false);
        assert_eq!(states(&core.on_report(USB_PATH, Ds4Revision::V2, &usb(0x20, 0, 0), 40).events), 0);
    }

    #[test]
    fn a_held_input_is_re_sent_as_a_heartbeat_and_neutral_is_not() {
        let mut core = HubCore::default();
        core.tick(0, true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0x20, 0, 0), 1);
        assert!(core.tick(100, true).is_empty(), "too early");
        assert_eq!(states(&core.tick(HEARTBEAT_MS + 1, true)), 1);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 300);
        assert!(core.tick(HEARTBEAT_MS * 3, true).is_empty(), "neutral pads stay quiet");
    }

    #[test]
    fn silent_pads_are_dropped_with_a_disconnect_event() {
        let mut core = HubCore::default();
        core.tick(0, true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 0);
        let events = core.tick(crate::ds4::PAD_STALE_MS + 1, true);
        assert!(events.iter().any(|e| matches!(e, ControllerEvent::Disconnected { .. })));
        assert_eq!(core.pad_count(), 0);
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
        assert!(!out.chord, "disabled: the chord is detected but never acted on");
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 150);
        core.set_chord_enabled(true);
        // Options then PS within the 250 ms window, either order.
        let first = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 2_000);
        assert!(!first.chord);
        let second = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 2_100);
        assert!(second.chord);
        // Held: latched, no repeat.
        assert!(!core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 2_200).chord);
        assert!(!core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 2_300).chord);
    }

    #[test]
    fn ps_alone_or_options_alone_never_fires_the_chord() {
        let mut core = HubCore::default();
        core.set_chord_enabled(true);
        assert!(!core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0x01), 100).chord);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0, 0), 150);
        assert!(!core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 5_000).chord);
    }

    #[test]
    fn chord_buttons_far_apart_are_rejected() {
        let mut core = HubCore::default();
        core.set_chord_enabled(true);
        core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0), 1_000);
        let late = core.on_report(USB_PATH, Ds4Revision::V2, &usb(0, 0x20, 0x01), 1_000 + crate::gamepad_home::CHORD_WINDOW_MS + 1);
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
    fn unavailable_and_transport_are_plain_data() {
        let status = NativeControllerStatus::default();
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains(r#""supported":false"#) && json.contains(r#""ignoredReports":0"#));
        let _ = Ds4Transport::Usb;
    }
}
