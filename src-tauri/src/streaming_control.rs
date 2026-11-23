//! Opt-in controller-to-keyboard/pointer bridge for owned Edge Cinema windows.
//! Raw Input only enqueues bounded semantic reports. No global mapping or hook.
//! SendInput is focus-sensitive: a final identity/foreground check narrows but
//! cannot eliminate a foreground race. Website behavior requires hardware QA.

use crate::ds4::{Ds4Button, Ds4Dpad, Ds4Report};
use crate::tv_navigation::{
    NavigationAction, NavigationActionReceipt, NavigationDiagnostics, NavigationMode,
    NavigationTargetSession, SpatialFailureKind, SpatialNavigationDiagnostics, TvNavigationStatus,
    PROFILES,
};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const MIN_ACTION_MS: u64 = 33;
const INITIAL_REPEAT_MS: u64 = 320;
const REPEAT_MS: u64 = 160;
const FAST_REPEAT_MS: u64 = 110;
const STALE_PACKET_MS: u64 = 200;
const ACTION_WAIT_MS: u64 = 700;
const MAX_ACTIONS_PER_SIMULATOR_LEASE: u64 = 1_000_000;
const LEFT_STICK_DEADZONE: f32 = 0.35;
const RIGHT_STICK_DEADZONE: f32 = 0.25;

/// EXPLICIT LIMITATION (DRM boundary): VELORA never reads, persists or
/// restores provider playback state for Netflix, YouTube, Disney+, Prime
/// Video or Max. Media keys (Space/K) are a BLIND TOGGLE — there is no
/// readback that would let VELORA know whether playback is paused — and no
/// DRM/HDCP/browser-security bypass exists anywhere in this module. When an
/// accessibility/readback API is unavailable, the truthful state is
/// "unknown", never a guess. Tests below pin this constant so it cannot be
/// silently flipped.
pub(crate) const PLAYBACK_STATE_READ_SUPPORTED: bool = false;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingControlStatus {
    pub windows: bool,
    pub enabled: bool,
    pub pointer_mode: bool,
    pub active_service: Option<String>,
    pub last_result: Option<String>,
    pub accepted_actions: u64,
    pub rejected_actions: u64,
    pub dropped_reports: u64,
}

struct Packet {
    epoch: u64,
    controller_epoch: u64,
    generation: u64,
    device: String,
    report: Ds4Report,
    at_ms: u64,
    queued_at: Instant,
}

struct ReportQueue {
    epoch: u64,
    sender: SyncSender<WorkerPacket>,
    last_sample_ms: Option<u64>,
    last_buttons: Option<u16>,
    last_dpad: Ds4Dpad,
}

#[derive(Default)]
pub struct StreamingControl {
    config_gate: Mutex<()>,
    epoch: AtomicU64,
    controller_epoch: AtomicU64,
    generation: AtomicU64,
    enabled: AtomicBool,
    dropped: AtomicU64,
    quiesce_count: AtomicU64,
    queue_depth: AtomicUsize,
    simulator_busy: AtomicBool,
    worker_running: AtomicBool,
    state: Mutex<RuntimeState>,
    sender: Mutex<Option<ReportQueue>>,
    worker_stop: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Default)]
struct RuntimeState {
    mode: NavigationMode,
    previous_mode: NavigationMode,
    media_controls_armed: bool,
    media_target_session: Option<String>,
    media_target_service_id: Option<&'static str>,
    simulator_target: Option<crate::edge_cinema::StreamingWindowTarget>,
    last_simulator_sequence: u64,
    active_service: Option<String>,
    last_result: Option<String>,
    accepted: u64,
    rejected: u64,
    last_source: Option<&'static str>,
    last_controller_id: Option<String>,
    last_repeat: bool,
    last_sequence: u64,
    last_target_session: Option<String>,
    last_routing_decision: Option<&'static str>,
    last_action_at_ms: Option<u64>,
    last_dispatch_elapsed_ms: Option<u64>,
    last_spatial_query_ms: Option<u64>,
    last_spatial_candidate_count: Option<usize>,
    last_spatial_diagnostics: Option<SpatialNavigationDiagnostics>,
    last_fallback_reason: Option<SpatialFailureKind>,
    last_fallback_activated: Option<bool>,
    simulator_home_request_id: u64,
    simulator_home_ready_revision: Option<u64>,
    engine: InteractionEngine,
    last_remote_at: Option<Instant>,
    engine_controller_epoch: u64,
}

impl RuntimeState {
    fn rearm_controller_generation(&mut self, epoch: u64) {
        if self.engine_controller_epoch != epoch {
            self.engine = InteractionEngine::default();
            self.engine_controller_epoch = epoch;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Up,
    Down,
    Left,
    Right,
    Select,
    NextFocus,
    PreviousFocus,
    Back,
    Click,
    Move(i32, i32),
    Scroll(i32),
    TogglePointer,
    PlayPause,
    OpenControlCenter,
    MediaKey(u16),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActionSource {
    Controller,
    Remote,
    Simulator,
}

impl ActionSource {
    fn name(self) -> &'static str {
        match self {
            Self::Controller => "controller",
            Self::Remote => "remote",
            Self::Simulator => "simulator",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TargetRoute {
    ForegroundOwned,
    CapturedSession(String),
    LocalControlCenter,
    LocalHome,
}

/// One bounded semantic action. The device label is already a salted/hash
/// identity from PadHub and is never a HID path or caller-provided string.
#[derive(Clone, Debug)]
struct NormalizedAction {
    action: NavigationAction,
    source: ActionSource,
    controller_id: Option<String>,
    timestamp_ms: u64,
    generation: u64,
    config_epoch: u64,
    controller_epoch: u64,
    repeat: bool,
    target_session: Option<String>,
    route: TargetRoute,
    sequence: u64,
    queued_at: Instant,
    reply: Option<SyncSender<Result<ActionResult, String>>>,
}

#[derive(Clone, Debug, Default)]
struct ActionResult {
    accepted: Option<bool>,
    effect: String,
    ownership: Option<String>,
    elapsed_ms: u64,
    spatial_query_ms: Option<u64>,
    spatial_candidate_count: Option<usize>,
    spatial_diagnostics: Option<SpatialNavigationDiagnostics>,
    fallback_reason: Option<SpatialFailureKind>,
    fallback_activated: Option<bool>,
    mode_changed_by_fallback: Option<bool>,
    fallback_notice: Option<String>,
}

enum WorkerPacket {
    Controller(Packet),
    Action(NormalizedAction),
}

struct WorkerLease(AppHandle);
impl Drop for WorkerLease {
    fn drop(&mut self) {
        self.0
            .state::<StreamingControl>()
            .worker_running
            .store(false, Ordering::Release);
    }
}

#[derive(Default)]
struct InteractionEngine {
    device: Option<String>,
    target: Option<u64>,
    primed: bool,
    last_buttons: u16,
    last_direction: Option<Action>,
    last_direction_at: Option<u64>,
    repeated_direction_count: u8,
    last_action_at: Option<u64>,
    last_report_at: Option<u64>,
    pending_action: Option<Action>,
    options_pending: bool,
    options_seen_reserved_chord: bool,
}

fn reserved_home_constituent(report: &Ds4Report, mode: NavigationMode) -> bool {
    [
        Ds4Button::Ps,
        Ds4Button::Share,
        Ds4Button::L3,
        Ds4Button::R3,
        Ds4Button::L1,
        Ds4Button::R1,
    ]
    .into_iter()
    .any(|button| {
        // R3 is a deliberate precision modifier only while pointer mode is
        // active. It remains reserved in every other mode/Home gesture.
        !(mode == NavigationMode::Pointer && button == Ds4Button::R3)
            && report.buttons.is_pressed(button)
    })
}

fn is_options(report: &Ds4Report) -> bool {
    report.buttons.is_pressed(Ds4Button::Options)
}

fn option_only(report: &Ds4Report) -> bool {
    report.buttons.bits() == (1 << Ds4Button::Options as u16)
        && !report.dpad.up
        && !report.dpad.down
        && !report.dpad.left
        && !report.dpad.right
        && report.left_x.abs() < LEFT_STICK_DEADZONE
        && report.left_y.abs() < LEFT_STICK_DEADZONE
        && report.right_x.abs() < RIGHT_STICK_DEADZONE
        && report.right_y.abs() < RIGHT_STICK_DEADZONE
        && report.l2 < 0.2
        && report.r2 < 0.2
}

fn neutral_except_options(report: &Ds4Report) -> bool {
    report.buttons.bits() == 0
        && !report.dpad.up
        && !report.dpad.down
        && !report.dpad.left
        && !report.dpad.right
        && report.left_x.abs() < LEFT_STICK_DEADZONE
        && report.left_y.abs() < LEFT_STICK_DEADZONE
        && report.right_x.abs() < RIGHT_STICK_DEADZONE
        && report.right_y.abs() < RIGHT_STICK_DEADZONE
        && report.l2 < 0.2
        && report.r2 < 0.2
}

fn neutral(report: &Ds4Report) -> bool {
    report.buttons.bits() == 0
        && !report.dpad.up
        && !report.dpad.down
        && !report.dpad.left
        && !report.dpad.right
        && report.left_x.abs() < 0.35
        && report.left_y.abs() < 0.35
        && report.right_x.abs() < 0.25
        && report.right_y.abs() < 0.25
        && report.l2 < 0.2
        && report.r2 < 0.2
}

impl InteractionEngine {
    fn update(
        &mut self,
        device: &str,
        report: &Ds4Report,
        target: u64,
        mode: NavigationMode,
        at_ms: u64,
    ) -> Vec<Action> {
        // The first observed pad owns this short lease. A second real pad
        // cannot alternate reports to combine buttons or continually re-prime
        // another pad; disconnect/silence expires ownership without persistence.
        if self.device.as_deref().is_some_and(|owner| owner != device)
            && self
                .last_report_at
                .is_some_and(|last| at_ms.saturating_sub(last) <= STALE_PACKET_MS)
        {
            return Vec::new();
        }
        let discontinuity = self.device.as_deref() != Some(device)
            || self.target != Some(target)
            || self
                .last_report_at
                .is_some_and(|last| at_ms.saturating_sub(last) > STALE_PACKET_MS);
        self.last_report_at = Some(at_ms);
        if discontinuity {
            *self = Self {
                device: Some(device.to_string()),
                target: Some(target),
                last_report_at: Some(at_ms),
                ..Self::default()
            };
        }
        // No held input crosses config, focus, reconnect or Home chord boundaries.
        if reserved_home_constituent(report, mode) {
            if self.options_pending {
                self.options_seen_reserved_chord = true;
            }
            self.primed = false;
            self.pending_action = None;
            self.options_pending = false;
            self.last_buttons = report.buttons.bits();
            return Vec::new();
        }
        let option_now = is_options(report);
        let previous = self.last_buttons;
        if option_now {
            if previous & (1 << Ds4Button::Options as u16) == 0 {
                self.options_pending = self.primed && option_only(report);
                self.options_seen_reserved_chord = false;
            }
            self.last_buttons = report.buttons.bits();
            // Options is delayed until release so PS+Options and the existing
            // L1+R1+Options fallback keep exclusive ownership of the gesture.
            return Vec::new();
        }
        if self.options_pending {
            let chord_seen = self.options_seen_reserved_chord;
            self.options_pending = false;
            self.options_seen_reserved_chord = false;
            if !chord_seen
                && self.primed
                && neutral_except_options(report)
                && previous & (1 << Ds4Button::Options as u16) != 0
            {
                self.pending_action = Some(Action::OpenControlCenter);
            }
        }
        if !self.primed {
            self.primed = neutral(report);
            self.last_buttons = report.buttons.bits();
            return Vec::new();
        }
        self.last_buttons = report.buttons.bits();
        let rising = |button: Ds4Button| {
            report.buttons.is_pressed(button) && previous & (1 << button as u16) == 0
        };
        let pressed_action = if rising(Ds4Button::Triangle) {
            Some(Action::TogglePointer)
        } else if rising(Ds4Button::Cross) {
            Some(Action::Select)
        } else if rising(Ds4Button::Circle) {
            Some(Action::Back)
        } else if rising(Ds4Button::Square) {
            Some(Action::PlayPause)
        } else if rising(Ds4Button::Touchpad) {
            Some(Action::NextFocus)
        } else {
            None
        };
        // Keep one deliberate tap through a frame limiter; a release must not
        // erase a Cross pressed shortly after a navigation tick.
        if self.pending_action.is_none() {
            self.pending_action = pressed_action;
        }
        if self
            .last_action_at
            .is_some_and(|last| at_ms.saturating_sub(last) < MIN_ACTION_MS)
        {
            return Vec::new();
        }
        let mut actions = Vec::with_capacity(3);
        if let Some(action) = self.pending_action.take() {
            actions.push(action);
        }
        let analog_direction = left_stick_direction(report.left_x, report.left_y);
        let direction = if report.dpad.up {
            Some(Action::Up)
        } else if report.dpad.down {
            Some(Action::Down)
        } else if report.dpad.left {
            Some(Action::Left)
        } else if report.dpad.right {
            Some(Action::Right)
        } else {
            analog_direction
        };
        if let Some(direction) = direction {
            let due = if self.last_direction != Some(direction) {
                true
            } else {
                self.last_direction_at.is_some_and(|last| {
                    let interval = if self.repeated_direction_count >= 2 {
                        FAST_REPEAT_MS
                    } else if self.repeated_direction_count == 1 {
                        REPEAT_MS
                    } else {
                        INITIAL_REPEAT_MS
                    };
                    at_ms.saturating_sub(last) >= interval
                })
            };
            if due {
                actions.push(direction);
                self.last_direction_at = Some(at_ms);
                if self.last_direction == Some(direction) {
                    self.repeated_direction_count = self.repeated_direction_count.saturating_add(1);
                } else {
                    self.repeated_direction_count = 0;
                }
            }
        } else {
            self.repeated_direction_count = 0;
        }
        self.last_direction = direction;
        if mode == NavigationMode::Pointer {
            let max_step = if report.buttons.is_pressed(Ds4Button::R3) {
                8
            } else {
                32
            };
            let (x, y) = (
                pointer_axis_step(report.right_x, RIGHT_STICK_DEADZONE, max_step),
                pointer_axis_step(report.right_y, RIGHT_STICK_DEADZONE, max_step),
            );
            if x != 0 || y != 0 {
                actions.push(Action::Move(x, y));
            }
        } else if report.right_y.is_finite() && report.right_y.abs() >= RIGHT_STICK_DEADZONE {
            let amount = scroll_axis_amount(report.right_y, RIGHT_STICK_DEADZONE);
            actions.push(if report.right_y < 0.0 {
                Action::Scroll(amount)
            } else {
                Action::Scroll(-amount)
            });
        }
        if actions.len() < 3 && (report.l2 > 0.5 || report.r2 > 0.5) {
            actions.push(Action::Scroll(if report.l2 > report.r2 {
                120
            } else {
                -120
            }));
        }
        actions.truncate(3);
        if !actions.is_empty() {
            self.last_action_at = Some(at_ms);
        }
        actions
    }
}

fn left_stick_direction(x: f32, y: f32) -> Option<Action> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let x = x.clamp(-1.0, 1.0);
    let y = y.clamp(-1.0, 1.0);
    if x.abs().max(y.abs()) < LEFT_STICK_DEADZONE {
        None
    } else if x.abs() > y.abs() {
        Some(if x < 0.0 { Action::Left } else { Action::Right })
    } else {
        Some(if y < 0.0 { Action::Up } else { Action::Down })
    }
}

fn pointer_axis_step(value: f32, deadzone: f32, max_step: i32) -> i32 {
    if !value.is_finite()
        || !deadzone.is_finite()
        || !(0.0..1.0).contains(&deadzone)
        || max_step <= 0
    {
        return 0;
    }
    let bounded = value.clamp(-1.0, 1.0);
    let magnitude = bounded.abs();
    if magnitude <= deadzone {
        return 0;
    }
    let normalized = ((magnitude - deadzone) / (1.0 - deadzone)).clamp(0.0, 1.0);
    let accelerated = normalized * normalized;
    let step = (1.0 + accelerated * (max_step - 1) as f32).round() as i32;
    step.max(1).min(max_step) * if bounded < 0.0 { -1 } else { 1 }
}

fn scroll_axis_amount(value: f32, deadzone: f32) -> i32 {
    if !value.is_finite()
        || !deadzone.is_finite()
        || !(0.0..1.0).contains(&deadzone)
        || value.abs() < deadzone
    {
        return 0;
    }
    let normalized = ((value.abs().clamp(0.0, 1.0) - deadzone) / (1.0 - deadzone)).clamp(0.0, 1.0);
    (120.0 + 120.0 * normalized * normalized).round() as i32
}

fn scale_pointer_delta(delta: i32, client_extent: i32, reference_extent: i32) -> i32 {
    if delta == 0 || client_extent <= 0 || reference_extent <= 0 {
        return delta.clamp(-64, 64);
    }
    let scale = (client_extent as f64 / reference_extent as f64).clamp(1.0, 2.0);
    ((f64::from(delta) * scale).round() as i32).clamp(-64, 64)
}

/// Bounded scaling reference derived from the owned window's measured client
/// extent and its effective DPI (96 = 100%). The reference is the logical
/// client extent, so `scale_pointer_delta` scales by the DPI ratio rather than
/// by a hard-coded 1920/1080 desktop. Returns 0 for unusable geometry, which
/// makes `scale_pointer_delta` leave the bounded delta unchanged.
fn pointer_scale_reference(client_extent: i32, dpi: u32) -> i32 {
    if client_extent <= 0 || dpi == 0 {
        return 0;
    }
    let dpi = dpi.clamp(48, 384);
    (i64::from(client_extent) * 96 / i64::from(dpi)).clamp(1, i64::from(i32::MAX)) as i32
}

impl StreamingControl {
    fn status(&self) -> StreamingControlStatus {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        StreamingControlStatus {
            windows: cfg!(target_os = "windows"),
            enabled: self.enabled.load(Ordering::Acquire),
            pointer_mode: state.mode == NavigationMode::Pointer,
            active_service: state.active_service.clone(),
            last_result: state.last_result.clone(),
            accepted_actions: state.accepted,
            rejected_actions: state.rejected,
            dropped_reports: self.dropped.load(Ordering::Relaxed),
        }
    }
}

fn status_snapshot(
    app: &AppHandle,
    control: &StreamingControl,
    simulator_available: bool,
) -> TvNavigationStatus {
    let state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let target = state
        .simulator_target
        .as_ref()
        .map(|target| (target.launch_id.clone(), target.service_id));
    let target_session = target.map(|(session_id, service_id)| NavigationTargetSession {
        session_id,
        service_id: service_id.into(),
        label: crate::tv_navigation::profile(service_id)
            .map(|profile| profile.label)
            .unwrap_or("Streaming service")
            .into(),
    });
    let media_control_session = state.media_target_session.as_ref().and_then(|session_id| {
        let service_id = state.media_target_service_id?;
        Some(NavigationTargetSession {
            session_id: session_id.clone(),
            service_id: service_id.into(),
            label: crate::tv_navigation::profile(service_id)
                .map(|profile| profile.label)
                .unwrap_or("Streaming service")
                .into(),
        })
    });
    let active_service = state.active_service.clone();
    let mode = state.mode;
    let media_controls_armed = state.media_controls_armed;
    let generation = control.generation.load(Ordering::Acquire);
    let last_result = state.last_result.clone();
    let last_simulator_sequence = state.last_simulator_sequence;
    let ready_revision = state.simulator_home_ready_revision;
    let strategy = match state.mode {
        NavigationMode::Automatic => active_service
            .as_deref()
            .and_then(crate::tv_navigation::profile)
            .map(|profile| profile.automatic_strategy)
            .unwrap_or("keyboard")
            .to_string(),
        NavigationMode::Keyboard => "keyboard".into(),
        NavigationMode::Spatial => "spatial".into(),
        NavigationMode::Pointer => "pointer".into(),
    };
    let diagnostics = NavigationDiagnostics {
        accepted_actions: state.accepted,
        rejected_actions: state.rejected,
        dropped_reports: control.dropped.load(Ordering::Relaxed),
        queue_depth: control.queue_depth.load(Ordering::Relaxed),
        last_source: state.last_source.map(str::to_string),
        last_controller_id: state.last_controller_id.clone(),
        last_repeat: state.last_repeat,
        last_sequence: state.last_sequence,
        last_routing_decision: state.last_routing_decision.map(str::to_string),
        last_target_present: state.last_target_session.is_some(),
        last_action_at_ms: state.last_action_at_ms,
        dispatch_elapsed_ms: state.last_dispatch_elapsed_ms,
        spatial_query_ms: state.last_spatial_query_ms,
        spatial_candidate_count: state.last_spatial_candidate_count,
        last_spatial_diagnostics: state.last_spatial_diagnostics,
        last_fallback_reason: state.last_fallback_reason.clone(),
        last_fallback_activated: state.last_fallback_activated,
    };
    drop(state);
    TvNavigationStatus {
        windows: cfg!(target_os = "windows"),
        enabled: control.enabled.load(Ordering::Acquire),
        simulator_available,
        mode,
        active_strategy: strategy,
        active_service,
        target_session,
        media_control_session,
        generation,
        media_controls_armed,
        last_result,
        profiles: PROFILES,
        diagnostics,
        last_simulator_sequence,
        simulator_home_ready: simulator_home_ready(app, control, simulator_available, ready_revision),
    }
}

fn simulator_home_ready(
    app: &AppHandle,
    control: &StreamingControl,
    simulator_available: bool,
    ready_revision: Option<u64>,
) -> bool {
    if !simulator_available || !control.enabled.load(Ordering::Acquire) {
        return false;
    }
    let Some(ready_revision) = ready_revision else {
        return false;
    };
    let snapshot = crate::session_orchestrator::get_session_state(app.clone());
    if snapshot.current != crate::session_orchestrator::SessionId::VeloraHome
        || snapshot.revision != ready_revision
    {
        return false;
    }
    app.get_webview_window("main")
        .filter(|window| local_main_origin(window))
        .is_some_and(|window| window.is_focused().unwrap_or(false))
}

fn active_strategy_for(mode: NavigationMode, service_id: Option<&str>) -> String {
    match mode {
        NavigationMode::Automatic => service_id
            .and_then(crate::tv_navigation::profile)
            .map(|profile| profile.automatic_strategy)
            .unwrap_or("keyboard")
            .to_string(),
        NavigationMode::Keyboard => "keyboard".into(),
        NavigationMode::Spatial => "spatial".into(),
        NavigationMode::Pointer => "pointer".into(),
    }
}

fn local_main_origin_parts(
    label: &str,
    scheme: &str,
    host: Option<&str>,
    port: Option<u16>,
    credentials: bool,
    debug_build: bool,
) -> bool {
    if label != "main" || credentials {
        return false;
    }
    let bundled = (scheme == "tauri" && host == Some("localhost") && port.is_none())
        || (scheme == "https"
            && host == Some("tauri.localhost")
            && matches!(port, None | Some(443)))
        || (scheme == "http" && host == Some("tauri.localhost") && matches!(port, None | Some(80)));
    if bundled {
        return true;
    }
    debug_build
        && scheme == "http"
        && matches!(host, Some("localhost" | "127.0.0.1"))
        && port == Some(1420)
}

fn local_main_origin(window: &WebviewWindow) -> bool {
    let Ok(url) = window.url() else {
        return false;
    };
    local_main_origin_parts(
        window.label(),
        url.scheme(),
        url.host_str(),
        url.port(),
        !url.username().is_empty() || url.password().is_some(),
        cfg!(debug_assertions),
    )
}

fn simulator_available(window: &WebviewWindow) -> bool {
    cfg!(debug_assertions) && local_main_origin(window)
}

#[tauri::command]
pub fn get_streaming_control_status(app: AppHandle) -> StreamingControlStatus {
    let mut status = app.state::<StreamingControl>().status();
    status.active_service = if status.enabled {
        crate::edge_cinema::foreground_owned_streaming_target(&app)
            .map(|target| target.service_id.to_string())
    } else {
        None
    };
    status
}

#[tauri::command(async)]
pub fn get_tv_navigation_status(app: AppHandle, window: WebviewWindow) -> TvNavigationStatus {
    let simulator = simulator_available(&window);
    let mut status = status_snapshot(&app, app.state::<StreamingControl>().inner(), simulator);
    status.active_service = if status.enabled {
        crate::edge_cinema::foreground_owned_streaming_target(&app)
            .map(|target| target.service_id.to_string())
    } else {
        None
    };
    status.active_strategy = active_strategy_for(status.mode, status.active_service.as_deref());
    status
}

#[tauri::command]
pub fn configure_streaming_control(
    app: AppHandle,
    enabled: bool,
    pointer_mode: bool,
) -> Result<StreamingControlStatus, String> {
    configure_router(
        &app,
        enabled,
        if pointer_mode {
            NavigationMode::Pointer
        } else {
            NavigationMode::Keyboard
        },
    )
}

#[tauri::command(async)]
pub fn configure_tv_navigation(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
    mode: String,
) -> Result<TvNavigationStatus, String> {
    if !local_main_origin(&window) {
        return Err("Konfiguracja nawigacji jest dostępna tylko w lokalnym oknie VELORA.".into());
    }
    let mode = NavigationMode::parse(&mode)?;
    if enabled && control_enabled(&app) {
        return set_tv_navigation_mode(app, window, mode.as_str().into());
    }
    configure_router(&app, enabled, mode)?;
    Ok(status_snapshot(
        &app,
        app.state::<StreamingControl>().inner(),
        simulator_available(&window),
    ))
}

#[tauri::command(async)]
pub fn set_tv_navigation_mode(
    app: AppHandle,
    window: WebviewWindow,
    mode: String,
) -> Result<TvNavigationStatus, String> {
    if !local_main_origin(&window) {
        return Err("Tryb nawigacji można zmienić tylko w lokalnym oknie VELORA.".into());
    }
    let control = app.state::<StreamingControl>();
    let _config = control
        .config_gate
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mode = NavigationMode::parse(&mode)?;
    control.generation.fetch_add(1, Ordering::AcqRel);
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    crate::spatial_navigation::invalidate();
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.mode = mode;
    state.previous_mode = if mode == NavigationMode::Pointer {
        state.previous_mode
    } else {
        mode
    };
    state.engine = InteractionEngine::default();
    state.last_result = Some(format!("Tryb nawigacji ustawiono: {}.", mode.as_str()));
    drop(state);
    Ok(status_snapshot(&app, &control, simulator_available(&window)))
}

#[tauri::command(async)]
pub fn set_tv_navigation_media_controls(
    app: AppHandle,
    window: WebviewWindow,
    armed: bool,
    session_id: Option<String>,
) -> Result<TvNavigationStatus, String> {
    if !local_main_origin(&window) {
        return Err("Sterowanie odtwarzaniem można zmienić tylko w lokalnym oknie VELORA.".into());
    }
    let control = app.state::<StreamingControl>();
    let _config = control
        .config_gate
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if armed {
        let session_id = session_id
            .or_else(|| {
                state
                    .simulator_target
                    .as_ref()
                    .map(|target| target.launch_id.clone())
            })
            .ok_or_else(|| "Wybierz aktywną sesję Edge Cinema przed odtwarzaniem.".to_string())?;
        let target = crate::edge_cinema::streaming_target_for_session(&app, &session_id)
            .ok_or_else(|| {
                "Sesja Edge Cinema nie jest już aktywna ani własnością VELORA.".to_string()
            })?;
        state.media_controls_armed = true;
        state.media_target_session = Some(target.launch_id);
        state.media_target_service_id = Some(target.service_id);
        state.last_result = Some("Sterowanie odtwarzaniem uzbrojono dla wybranej sesji.".into());
    } else {
        state.media_controls_armed = false;
        state.media_target_session = None;
        state.media_target_service_id = None;
        state.last_result = Some("Sterowanie odtwarzaniem wyłączono.".into());
    }
    control.generation.fetch_add(1, Ordering::AcqRel);
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    crate::spatial_navigation::invalidate();
    state.engine = InteractionEngine::default();
    drop(state);
    Ok(status_snapshot(&app, &control, simulator_available(&window)))
}

#[tauri::command(async)]
pub fn capture_tv_navigation_target(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
) -> Result<TvNavigationStatus, String> {
    if !simulator_available(&window) {
        return Err(
            "Symulator działa tylko w debugowej kompilacji i lokalnym oknie głównym.".into(),
        );
    }
    if !control_enabled(&app) {
        return Err("Najpierw włącz sterowanie streamingiem.".into());
    }
    let target =
        crate::edge_cinema::streaming_target_for_session(&app, &session_id).ok_or_else(|| {
            "Wybrana sesja nie jest aktywną usługą Edge Cinema własnością VELORA.".to_string()
        })?;
    let control = app.state::<StreamingControl>();
    control.generation.fetch_add(1, Ordering::AcqRel);
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    crate::spatial_navigation::invalidate();
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.simulator_target = Some(target);
    if state.media_target_session.as_ref() != Some(&session_id) {
        state.media_controls_armed = false;
        state.media_target_session = None;
        state.media_target_service_id = None;
    }
    state.last_result = Some("Przypięto dokładną, aktywną sesję Edge Cinema do symulatora.".into());
    drop(state);
    Ok(status_snapshot(&app, &control, true))
}

#[tauri::command(async)]
pub fn cancel_tv_navigation_simulation(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<TvNavigationStatus, String> {
    if !simulator_available(&window) {
        return Err("Anulowanie symulatora wymaga lokalnego debugowego okna głównego.".into());
    }
    let control = app.state::<StreamingControl>();
    control.simulator_busy.store(false, Ordering::Release);
    control.generation.fetch_add(1, Ordering::AcqRel);
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    crate::spatial_navigation::invalidate();
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.engine = InteractionEngine::default();
    state.last_result =
        Some("Akcja symulatora anulowana; kolejne wejście wymaga neutralnego stanu pada.".into());
    drop(state);
    Ok(status_snapshot(&app, &control, true))
}

fn configure_router(
    app: &AppHandle,
    enabled: bool,
    mode: NavigationMode,
) -> Result<StreamingControlStatus, String> {
    let control = app.state::<StreamingControl>();
    let _config = control
        .config_gate
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if enabled && !cfg!(target_os = "windows") {
        return Err("Sterowanie streamingiem wymaga Windows.".into());
    }
    if enabled {
        let home =
            crate::pad_hub::get_native_controller_status(app.state::<crate::pad_hub::PadHub>());
        if !home.running || !home.home_enabled {
            return Err("Najpierw włącz natywny powrót Home w tej sesji.".into());
        }
    }
    stop_internal(app);
    {
        let mut state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.mode = mode;
        if mode != NavigationMode::Pointer {
            state.previous_mode = mode;
        }
        state.engine = InteractionEngine::default();
        state.last_remote_at = None;
        state.last_result = Some(
            if enabled {
                "Oczekiwanie na neutralny pad i własne okno Edge Cinema."
            } else {
                "Sterowanie wyłączone."
            }
            .into(),
        );
    }
    if enabled {
        if control
            .worker_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("Previous navigation worker is still stopping; Home remains available. Retry after it finishes.".into());
        }
        let (sender, receiver) = mpsc::sync_channel::<WorkerPacket>(8);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let worker_app = app.clone();
        *control
            .sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ReportQueue {
            epoch: control.epoch.load(Ordering::Acquire),
            sender,
            last_sample_ms: None,
            last_buttons: None,
            last_dpad: Ds4Dpad::default(),
        });
        *control
            .worker_stop
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(stop);
        control.enabled.store(true, Ordering::Release);
        if std::thread::Builder::new()
            .name("velora-streaming-control".into())
            .spawn(move || {
                let _lease = WorkerLease(worker_app.clone());
                while !thread_stop.load(Ordering::Acquire) {
                    let packet = match receiver.recv_timeout(Duration::from_millis(50)) {
                        Ok(packet) => packet,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    if thread_stop.load(Ordering::Acquire) {
                        break;
                    }
                    control_queue_dequeued(&worker_app);
                    match packet {
                        WorkerPacket::Controller(packet) => {
                            if packet.queued_at.elapsed() <= Duration::from_millis(STALE_PACKET_MS)
                            {
                                dispatch_packet(&worker_app, packet);
                            }
                        }
                        WorkerPacket::Action(action) => {
                            let simulator = action.source == ActionSource::Simulator;
                            let reply = action.reply.clone();
                            let action_generation = action.generation;
                            let result = dispatch_normalized_action(&worker_app, action);
                            let fallback_activated = result.as_ref().is_ok_and(|result| {
                                result.fallback_activated == Some(true)
                            });
                            let current_generation = worker_app
                                .state::<StreamingControl>()
                                .generation
                                .load(Ordering::Acquire);
                            if simulator
                                && (current_generation == action_generation
                                    || (fallback_activated
                                        && current_generation
                                            == action_generation.saturating_add(1)))
                            {
                                worker_app
                                    .state::<StreamingControl>()
                                    .simulator_busy
                                    .store(false, Ordering::Release);
                            }
                            if let Some(reply) = reply {
                                let _ = reply.send(result);
                            }
                        }
                    }
                }
            })
            .is_err()
        {
            control.worker_running.store(false, Ordering::Release);
            stop_internal(app);
            return Err("Nie uruchomiono ograniczonego wątku sterowania.".into());
        }
    }
    Ok(control.status())
}

pub(crate) fn stop_streaming_control(app: &AppHandle) {
    let control = app.state::<StreamingControl>();
    let _config = control
        .config_gate
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    stop_internal(app);
}

fn stop_internal(app: &AppHandle) {
    crate::pointer_indicator::update(0, false);
    let control = app.state::<StreamingControl>();
    control.enabled.store(false, Ordering::Release);
    control.epoch.fetch_add(1, Ordering::AcqRel);
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    control.generation.fetch_add(1, Ordering::AcqRel);
    if let Some(stop) = control
        .worker_stop
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
    {
        stop.store(true, Ordering::Release);
    }
    control
        .sender
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.active_service = None;
    state.engine = InteractionEngine::default();
    state.media_controls_armed = false;
    state.media_target_session = None;
    state.media_target_service_id = None;
    state.simulator_target = None;
    control.queue_depth.store(0, Ordering::Release);
    control.simulator_busy.store(false, Ordering::Release);
    crate::spatial_navigation::invalidate();
}

/// Called by PadHub. No OS calls, waiting, unbounded queue or raw bytes.
pub(crate) fn route_controller_report(
    app: &AppHandle,
    device: &str,
    report: &Ds4Report,
    at_ms: u64,
) {
    let control = app.state::<StreamingControl>();
    if !control.enabled.load(Ordering::Acquire) || control.simulator_busy.load(Ordering::Acquire) {
        return;
    }
    if let Ok(mut sender) = control.sender.try_lock() {
        if let Some(queue) = sender.as_mut() {
            // Preserve button/release edges rather than coalescing them away.
            // Unchanged state/analog is sampled at 30 Hz, not the HID packet rate.
            let changed =
                queue.last_buttons != Some(report.buttons.bits()) || queue.last_dpad != report.dpad;
            if !changed
                && queue
                    .last_sample_ms
                    .is_some_and(|last| at_ms.saturating_sub(last) < MIN_ACTION_MS)
            {
                return;
            }
            control.queue_depth.fetch_add(1, Ordering::Relaxed);
            if queue
                .sender
                .try_send(WorkerPacket::Controller(Packet {
                    epoch: queue.epoch,
                    controller_epoch: control.controller_epoch.load(Ordering::Acquire),
                    generation: control.generation.load(Ordering::Acquire),
                    device: device.to_string(),
                    report: *report,
                    at_ms,
                    queued_at: Instant::now(),
                }))
                .is_err()
            {
                control_queue_dequeued(app);
                control.dropped.fetch_add(1, Ordering::Relaxed);
                // A lost release invalidates the whole controller generation.
                // Never continue a held action from an incomplete report stream.
                control.controller_epoch.fetch_add(1, Ordering::AcqRel);
                control.generation.fetch_add(1, Ordering::AcqRel);
                crate::spatial_navigation::invalidate();
                queue.last_sample_ms = None;
                queue.last_buttons = None;
            } else {
                queue.last_sample_ms = Some(at_ms);
                queue.last_buttons = Some(report.buttons.bits());
                queue.last_dpad = report.dpad;
            }
        }
    } else {
        control.dropped.fetch_add(1, Ordering::Relaxed);
        control.controller_epoch.fetch_add(1, Ordering::AcqRel);
        control.generation.fetch_add(1, Ordering::AcqRel);
    };
}

fn dispatch_packet(app: &AppHandle, packet: Packet) {
    let control = app.state::<StreamingControl>();
    if !normalized_generation_active(
        &control,
        packet.epoch,
        packet.controller_epoch,
        packet.generation,
    ) {
        return;
    }
    let home = crate::pad_hub::get_native_controller_status(app.state::<crate::pad_hub::PadHub>());
    let target = if home.running && home.home_enabled {
        crate::edge_cinema::foreground_owned_streaming_target(app)
    } else {
        None
    };
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !normalized_generation_active(
        &control,
        packet.epoch,
        packet.controller_epoch,
        packet.generation,
    ) {
        return;
    }
    // Generation is the reset signal itself. A separate flag could be observed
    // after the first packet of a new device generation was already processed.
    state.rearm_controller_generation(packet.controller_epoch);
    let Some(target) = target else {
        crate::pointer_indicator::update(0, false);
        state.active_service = None;
        state.engine = InteractionEngine::default();
        return;
    };
    state.active_service = Some(target.service_id.to_string());
    let mode = state.mode;
    let target_session = target.launch_id.clone();
    let mut repeat_direction = state.engine.last_direction;
    let actions = state.engine.update(
        &packet.device,
        &packet.report,
        target.hwnd,
        mode,
        packet.at_ms,
    );
    drop(state);
    for action in actions {
        if !normalized_generation_active(
            &control,
            packet.epoch,
            packet.controller_epoch,
            packet.generation,
        ) {
            break;
        }
        let repeat = is_direction_action(action) && repeat_direction == Some(action);
        if is_direction_action(action) {
            repeat_direction = Some(action);
        }
        let normalized = NormalizedAction {
            action: action_to_navigation(action),
            source: ActionSource::Controller,
            controller_id: Some(packet.device.clone()),
            timestamp_ms: now_ms(),
            generation: packet.generation,
            config_epoch: packet.epoch,
            controller_epoch: packet.controller_epoch,
            repeat,
            target_session: Some(target_session.clone()),
            route: if action == Action::OpenControlCenter {
                TargetRoute::LocalControlCenter
            } else {
                TargetRoute::ForegroundOwned
            },
            sequence: 0,
            queued_at: packet.queued_at,
            reply: None,
        };
        let result = dispatch_normalized_action(app, normalized);
        let mut state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match result {
            Ok(result) => {
                state.last_result = Some(result.effect.clone());
            }
            Err(error) => {
                state.last_result = Some(error);
                state.engine.primed = false;
                break;
            }
        }
        if state.mode == NavigationMode::Pointer {
            crate::pointer_indicator::update(
                target.hwnd,
                normalized_generation_active(
                    &control,
                    packet.epoch,
                    packet.controller_epoch,
                    packet.generation,
                ),
            );
        } else {
            crate::pointer_indicator::update(0, false);
        }
    }
}

fn is_direction_action(action: Action) -> bool {
    matches!(
        action,
        Action::Up | Action::Down | Action::Left | Action::Right
    )
}

fn action_to_navigation(action: Action) -> NavigationAction {
    match action {
        Action::Up => NavigationAction::Up,
        Action::Down => NavigationAction::Down,
        Action::Left => NavigationAction::Left,
        Action::Right => NavigationAction::Right,
        Action::Select => NavigationAction::Confirm,
        Action::NextFocus => NavigationAction::NextSection,
        Action::PreviousFocus => NavigationAction::PreviousSection,
        Action::Back => NavigationAction::Back,
        Action::Click => NavigationAction::PointerClick,
        Action::Move(x, y) => NavigationAction::PointerMove(x, y),
        Action::Scroll(value) => NavigationAction::ScrollAmount(value.clamp(-240, 240) as i16),
        Action::TogglePointer => NavigationAction::PointerToggle,
        Action::PlayPause => NavigationAction::PlayPause,
        Action::OpenControlCenter => NavigationAction::OpenControlCenter,
        Action::MediaKey(_) => unreachable!("Media keys are internal to native dispatch"),
    }
}

fn generation_active(control: &StreamingControl, epoch: u64, controller_epoch: u64) -> bool {
    control.enabled.load(Ordering::Acquire)
        && control.epoch.load(Ordering::Acquire) == epoch
        && control.controller_epoch.load(Ordering::Acquire) == controller_epoch
}

fn normalized_generation_active(
    control: &StreamingControl,
    epoch: u64,
    controller_epoch: u64,
    generation: u64,
) -> bool {
    generation_active(control, epoch, controller_epoch)
        && control.generation.load(Ordering::Acquire) == generation
}

fn activate_pointer_fallback(
    control: &StreamingControl,
    expected_mode: NavigationMode,
    epoch: u64,
    controller_epoch: u64,
    generation: u64,
) -> bool {
    let _config = control
        .config_gate
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !normalized_generation_active(control, epoch, controller_epoch, generation) {
        return false;
    }
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if state.mode != expected_mode
        || !matches!(expected_mode, NavigationMode::Automatic | NavigationMode::Spatial)
    {
        return false;
    }
    state.mode = NavigationMode::Pointer;
    // Avoid silently retrying an unavailable spatial provider if the user
    // later exits pointer mode. Choosing Automatic again is an explicit probe.
    state.previous_mode = NavigationMode::Keyboard;
    state.engine = InteractionEngine::default();
    control.generation.fetch_add(1, Ordering::AcqRel);
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    crate::spatial_navigation::invalidate();
    true
}

/// Pure fallback decision. Ownership/authorization/target failures are never
/// fallback-eligible, Remote input is always excluded, and every guard must
/// still hold at the moment of the decision.
fn fallback_permitted(
    source: ActionSource,
    kind: Option<SpatialFailureKind>,
    still_authorized: bool,
    target_current: bool,
) -> bool {
    source != ActionSource::Remote
        && kind.is_some_and(SpatialFailureKind::fallback_eligible)
        && still_authorized
        && target_current
}

/// Fixed, non-sensitive notice attached to the receipt when sticky fallback
/// activates. The original action is never replayed as a pointer action.
fn fallback_notice() -> &'static str {
    "sticky pointer fallback enabled — original action was not repeated"
}

/// User-visible effect for an activated fallback, rendered from the typed
/// failure's safe display label (never the raw native error string).
fn fallback_effect(kind: Option<SpatialFailureKind>) -> String {
    format!(
        "Spatial provider did not confirm the action ({}). Pointer mode is active; the original action was not repeated. Inspect the page before using the pointer.",
        kind.map(SpatialFailureKind::display_label)
            .unwrap_or("provider unavailable")
    )
}

/// Neutralise all media-arming state that could survive a session boundary.
/// Pure over `RuntimeState` so the quiesce is unit-testable without an
/// `AppHandle`. A held Play/Pause edge in the input engine is cleared here:
/// media keys are a blind toggle, so a stray edge after re-focus must never
/// inherit an armed target from the previous service. No playback state is
/// read, persisted or restored, and no key is injected.
fn quiesce_runtime_media_state(state: &mut RuntimeState) {
    state.media_controls_armed = false;
    state.media_target_session = None;
    state.media_target_service_id = None;
    state.simulator_target = None;
    state.engine = InteractionEngine::default();
}

/// Full quiesce shared by the native hook and unit tests. Bumps the controller
/// epoch and generation exactly once, clears media arming under the existing
/// state lock, and returns the new generation for the sanitized receipt.
fn quiesce_streaming_control(control: &StreamingControl) -> u64 {
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    let generation = control
        .generation
        .fetch_add(1, Ordering::AcqRel)
        .saturating_add(1);
    control.quiesce_count.fetch_add(1, Ordering::AcqRel);
    {
        let mut state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        quiesce_runtime_media_state(&mut state);
    }
    crate::spatial_navigation::invalidate();
    generation
}

/// Raw Input removal/arrival and real session transitions use this bounded
/// hook, never wait on the input worker. Old queued packets are invalid
/// immediately; same-path reconnects and first-vs-repeated launches must
/// observe neutral media arming before another action is permitted.
pub(crate) fn invalidate_controller_streaming(app: &AppHandle) -> u64 {
    let control = app.state::<StreamingControl>();
    quiesce_streaming_control(&control)
}

/// Content-free counter for diagnostics: how many full quiesces have run.
pub(crate) fn streaming_quiesce_count(app: &AppHandle) -> u64 {
    app.state::<StreamingControl>()
        .quiesce_count
        .load(Ordering::Acquire)
}

/// Called only after RemoteAccess has authenticated/authorized its command.
/// Returns false when VELORA should handle normal local navigation itself.
/// No script, remote-provided HWND, arbitrary key, process, or pointer is accepted.
pub(crate) fn route_remote_navigation(app: &AppHandle, command: &str) -> Result<bool, String> {
    let action = match command {
        "up" => NavigationAction::Up,
        "down" => NavigationAction::Down,
        "left" => NavigationAction::Left,
        "right" => NavigationAction::Right,
        "select" => NavigationAction::Confirm,
        "back" => NavigationAction::Back,
        _ => return Err("Niedozwolona akcja sterowania streamingiem.".into()),
    };
    let control = app.state::<StreamingControl>();
    if !control.enabled.load(Ordering::Acquire) {
        return Ok(false);
    }
    let Some(target) = crate::edge_cinema::foreground_owned_streaming_target(app) else {
        return Ok(false);
    };
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let epoch = control.epoch.load(Ordering::Acquire);
    let controller_epoch = control.controller_epoch.load(Ordering::Acquire);
    let generation = control.generation.load(Ordering::Acquire);
    if !normalized_generation_active(&control, epoch, controller_epoch, generation) {
        return Ok(false);
    }
    if state
        .last_remote_at
        .is_some_and(|last| last.elapsed() < Duration::from_millis(50))
    {
        return Err("Sterowanie jest zbyt częste; odczekaj chwilę.".into());
    }
    state.last_remote_at = Some(Instant::now());
    state.active_service = Some(target.service_id.to_string());
    drop(state);
    let (reply, receiver) = mpsc::sync_channel(1);
    let normalized = NormalizedAction {
        action,
        source: ActionSource::Remote,
        controller_id: None,
        timestamp_ms: now_ms(),
        generation,
        config_epoch: epoch,
        controller_epoch,
        repeat: false,
        target_session: Some(target.launch_id),
        route: TargetRoute::ForegroundOwned,
        sequence: 0,
        queued_at: Instant::now(),
        reply: Some(reply),
    };
    match enqueue_action_and_wait(app, normalized, receiver) {
        Ok(result) if result.accepted.unwrap_or(true) => Ok(true),
        Ok(result) => Err(result.effect),
        Err(error) => Err(error),
    }
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // Tauri injects app/window; remaining fields are a closed scalar IPC contract.
pub fn simulate_tv_navigation_action(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
    sequence: u64,
    generation: u64,
    target_session: Option<String>,
    delta_x: Option<i32>,
    delta_y: Option<i32>,
) -> Result<NavigationActionReceipt, String> {
    if !simulator_available(&window) {
        return Err(
            "Symulator jest dostępny tylko w lokalnym oknie głównym debugowej kompilacji.".into(),
        );
    }
    let parsed =
        NavigationAction::from_simulator_name(&action, delta_x.unwrap_or(0), delta_y.unwrap_or(0))?;
    let control = app.state::<StreamingControl>();
    let current_generation = control.generation.load(Ordering::Acquire);
    if generation != current_generation {
        return Err(
            "Symulator ma nieaktualną generację. Odśwież status przed kolejną akcją.".into(),
        );
    }
    if sequence == 0 || sequence > MAX_ACTIONS_PER_SIMULATOR_LEASE {
        return Err("Numer akcji symulatora jest poza dozwolonym zakresem.".into());
    }
    let home_or_menu = matches!(
        parsed,
        NavigationAction::Home | NavigationAction::OpenControlCenter
    );
    let (pinned_target, local_action_target) = {
        let state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if sequence <= state.last_simulator_sequence {
            return Err("Numer akcji musi rosnąć; ponowne odtworzenie jest zabronione.".into());
        }
        if !home_or_menu {
            let session_id = target_session
                .as_deref()
                .ok_or_else(|| "Wybierz przypiętą sesję Edge Cinema.".to_string())?;
            let captured = state
                .simulator_target
                .as_ref()
                .ok_or_else(|| "Najpierw przypnij aktywną sesję Edge Cinema.".to_string())?;
            if captured.launch_id != session_id {
                return Err("Sesja akcji różni się od przypiętej sesji symulatora.".into());
            }
            (Some(captured.clone()), None)
        } else if let Some(session_id) = target_session.as_deref() {
            let captured = state
                .simulator_target
                .as_ref()
                .ok_or_else(|| "Najpierw przypnij aktywną sesję Edge Cinema.".to_string())?;
            if captured.launch_id != session_id {
                return Err("Sesja akcji różni się od przypiętej sesji symulatora.".into());
            }
            (None, Some(captured.clone()))
        } else {
            (None, None)
        }
    };
    if !control.enabled.load(Ordering::Acquire) {
        return Err("Włącz sterowanie streamingiem przed użyciem symulatora.".into());
    }
    let home = crate::pad_hub::get_native_controller_status(app.state::<crate::pad_hub::PadHub>());
    if !home.running || !home.home_enabled {
        return Err("Symulator wymaga aktywnego natywnego Home w tej sesji.".into());
    }
    if home_or_menu {
        let main_focused = local_main_origin(&window) && window.is_focused().unwrap_or(false);
        let foreground = crate::edge_cinema::foreground_owned_streaming_target(&app);
        if !simulator_local_action_context_matches(
            main_focused,
            target_session.as_deref(),
            local_action_target.as_ref(),
            foreground.as_ref(),
        ) {
            return Err(
                "Home or Control Center requires the local VELORA window or the exact foreground pinned Edge Cinema session.".into(),
            );
        }
    } else if !simulator_focus_context_ok(&app, &window, pinned_target.as_ref().unwrap()) {
        return Err("Fokus zmienił się na inne okno; symulator nie przywróci sesji.".into());
    }
    if control
        .simulator_busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Jedna akcja symulatora jest nadal in corso.".into());
    }
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    let (reply, receiver) = mpsc::sync_channel(1);
    let route = match parsed {
        NavigationAction::Home => TargetRoute::LocalHome,
        NavigationAction::OpenControlCenter => TargetRoute::LocalControlCenter,
        _ => TargetRoute::CapturedSession(target_session.clone().unwrap_or_default()),
    };
    let action = NormalizedAction {
        action: parsed,
        source: ActionSource::Simulator,
        controller_id: None,
        timestamp_ms: now_ms(),
        generation,
        config_epoch: control.epoch.load(Ordering::Acquire),
        controller_epoch: control.controller_epoch.load(Ordering::Acquire),
        repeat: false,
        target_session: target_session.clone(),
        route,
        sequence,
        queued_at: Instant::now(),
        reply: Some(reply),
    };
    if let Err(error) = enqueue_action(&app, action) {
        control.simulator_busy.store(false, Ordering::Release);
        return Err(error);
    }
    {
        let mut state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.last_simulator_sequence = sequence;
    }
    let (accepted, result) = match receiver.recv_timeout(Duration::from_millis(ACTION_WAIT_MS)) {
        Ok(Ok(result)) => (result.accepted.unwrap_or(true), result),
        Ok(Err(error)) => (
            false,
            ActionResult {
                accepted: Some(false),
                effect: error,
                ownership: Some("denied".into()),
                ..ActionResult::default()
            },
        ),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            revoke_action_generation(&control);
            return Err("Native dispatch timed out; the action may have reached Windows. Further input was revoked.".into());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            control.simulator_busy.store(false, Ordering::Release);
            return Err("Native action worker stopped before returning a receipt.".into());
        }
    };
    let status = status_snapshot(&app, &control, true);
    Ok(NavigationActionReceipt {
        accepted,
        effect: result.effect,
        sequence,
        generation: status.generation,
        mode: status.mode,
        active_strategy: active_strategy_for(status.mode, status.active_service.as_deref()),
        target_session: target_session
            .or_else(|| status.target_session.map(|target| target.session_id)),
        last_result: status.last_result,
        ownership: result.ownership,
        dispatch_elapsed_ms: result.elapsed_ms,
        spatial_query_ms: result.spatial_query_ms,
        spatial_candidate_count: result.spatial_candidate_count,
        spatial_diagnostics: result.spatial_diagnostics,
        fallback_reason: result.fallback_reason,
        fallback_activated: result.fallback_activated,
        mode_changed_by_fallback: result.mode_changed_by_fallback,
        fallback_notice: result.fallback_notice,
    })
}

fn simulator_focus_context_ok(
    app: &AppHandle,
    window: &WebviewWindow,
    target: &crate::edge_cinema::StreamingWindowTarget,
) -> bool {
    window.is_focused().unwrap_or(false)
        || crate::edge_cinema::foreground_owned_streaming_target(app)
            .is_some_and(|foreground| same_target(&foreground, target))
}

fn simulator_local_action_context_matches(
    main_trusted_and_focused: bool,
    requested_session: Option<&str>,
    captured_target: Option<&crate::edge_cinema::StreamingWindowTarget>,
    foreground_target: Option<&crate::edge_cinema::StreamingWindowTarget>,
) -> bool {
    if main_trusted_and_focused {
        return requested_session.map_or(true, |session_id| {
            captured_target.is_some_and(|target| target.launch_id == session_id)
        });
    }
    let Some(session_id) = requested_session else {
        return false;
    };
    let Some(captured) = captured_target else {
        return false;
    };
    captured.launch_id == session_id
        && foreground_target.is_some_and(|foreground| same_target(captured, foreground))
}

fn simulator_local_action_context_current(app: &AppHandle, action: &NormalizedAction) -> bool {
    let Some(main) = app.get_webview_window("main") else {
        return false;
    };
    if !local_main_origin(&main) {
        return false;
    }
    let main_focused = main.is_focused().unwrap_or(false);
    let captured = app
        .state::<StreamingControl>()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .simulator_target
        .clone();
    let foreground = crate::edge_cinema::foreground_owned_streaming_target(app);
    let matches = simulator_local_action_context_matches(
        main_focused,
        action.target_session.as_deref(),
        captured.as_ref(),
        foreground.as_ref(),
    );
    matches
        && foreground.as_ref().map_or(true, |target| {
            crate::edge_cinema::streaming_target_is_current(app, target)
        })
}

fn complete_simulator_home_request(
    app: AppHandle,
    request_id: u64,
    result: Result<crate::session_orchestrator::ReturnHomeResult, crate::session_orchestrator::SessionError>,
) {
    let ready_revision = result.ok().and_then(|completion| {
        let snapshot = crate::session_orchestrator::get_session_state(app.clone());
        let focused = app
            .get_webview_window("main")
            .filter(|window| local_main_origin(window))
            .is_some_and(|window| window.is_focused().unwrap_or(false));
        let restore_confirmed = completion.restore.restored
            && completion.restore.own_window.is_some()
            && completion.restore.foreground_after.hwnd == completion.restore.own_window;
        (!completion.timed_out
            && completion.session.current == crate::session_orchestrator::SessionId::VeloraHome
            && snapshot.current == crate::session_orchestrator::SessionId::VeloraHome
            && snapshot.revision == completion.session.revision
            && restore_confirmed
            && focused)
            .then_some(completion.session.revision)
    });
    let control = app.state::<StreamingControl>();
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if state.simulator_home_request_id == request_id {
        state.simulator_home_ready_revision = ready_revision;
    }
}

fn same_target(
    left: &crate::edge_cinema::StreamingWindowTarget,
    right: &crate::edge_cinema::StreamingWindowTarget,
) -> bool {
    left.launch_id == right.launch_id
        && left.hwnd == right.hwnd
        && left.process_id == right.process_id
        && left.process_created_at_100ns == right.process_created_at_100ns
        && left.service_id == right.service_id
}

fn control_enabled(app: &AppHandle) -> bool {
    app.state::<StreamingControl>()
        .enabled
        .load(Ordering::Acquire)
}

#[allow(deprecated)] // fetch_update remains supported by the repository's older Rust floor.
fn control_queue_dequeued(app: &AppHandle) {
    let control = app.state::<StreamingControl>();
    let _ = control
        .queue_depth
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |depth| {
            Some(depth.saturating_sub(1))
        });
}

fn enqueue_action(app: &AppHandle, action: NormalizedAction) -> Result<(), String> {
    let control = app.state::<StreamingControl>();
    let mut sender = control
        .sender
        .try_lock()
        .map_err(|_| "Native action queue is busy.".to_string())?;
    let queue = sender
        .as_mut()
        .ok_or_else(|| "Streaming action worker is unavailable.".to_string())?;
    control.queue_depth.fetch_add(1, Ordering::Relaxed);
    queue
        .sender
        .try_send(WorkerPacket::Action(action))
        .map_err(|_| {
            control_queue_dequeued(app);
            control.dropped.fetch_add(1, Ordering::Relaxed);
            "Native action queue is full.".to_string()
        })?;
    Ok(())
}

fn enqueue_action_and_wait(
    app: &AppHandle,
    action: NormalizedAction,
    receiver: Receiver<Result<ActionResult, String>>,
) -> Result<ActionResult, String> {
    let control = app.state::<StreamingControl>();
    enqueue_action(app, action)?;
    match receiver.recv_timeout(Duration::from_millis(ACTION_WAIT_MS)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            revoke_action_generation(&control);
            Err("Native dispatch timed out; the action may have reached Windows. Further input was revoked.".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Native action worker stopped before returning a receipt.".into())
        }
    }
}

fn revoke_action_generation(control: &StreamingControl) {
    control.simulator_busy.store(false, Ordering::Release);
    control.generation.fetch_add(1, Ordering::AcqRel);
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    crate::spatial_navigation::invalidate();
}

fn now_ms() -> u64 {
    static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    ORIGIN
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn dispatch_normalized_action(
    app: &AppHandle,
    action: NormalizedAction,
) -> Result<ActionResult, String> {
    let started = Instant::now();
    let control = app.state::<StreamingControl>();
    let result = dispatch_normalized_action_inner(app, &control, &action);
    let elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let mut state = control
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.last_source = Some(action.source.name());
    state.last_controller_id = action.controller_id.clone();
    state.last_repeat = action.repeat;
    state.last_sequence = action.sequence;
    state.last_target_session = action.target_session.clone();
    state.last_action_at_ms = Some(action.timestamp_ms);
    state.last_dispatch_elapsed_ms = Some(elapsed);
    if let Ok(result) = &result {
        if result.accepted.unwrap_or(true) {
            state.accepted = state.accepted.saturating_add(1);
        } else {
            state.rejected = state.rejected.saturating_add(1);
        }
        state.last_result = Some(result.effect.clone());
        state.last_spatial_query_ms = result.spatial_query_ms;
        state.last_spatial_candidate_count = result.spatial_candidate_count;
        state.last_spatial_diagnostics = result.spatial_diagnostics;
        state.last_fallback_reason = result.fallback_reason.clone();
        state.last_fallback_activated = result.fallback_activated;
    } else if let Err(error) = &result {
        state.rejected = state.rejected.saturating_add(1);
        state.last_result = Some(error.clone());
        state.last_spatial_query_ms = None;
        state.last_spatial_candidate_count = None;
        state.last_spatial_diagnostics = None;
        state.last_fallback_reason = None;
        state.last_fallback_activated = None;
    }
    state.last_routing_decision = Some(match action.route {
        TargetRoute::ForegroundOwned => "foregroundOwned",
        TargetRoute::CapturedSession(_) => "capturedSession",
        TargetRoute::LocalControlCenter => "veloraControlCenter",
        TargetRoute::LocalHome => "existingHomeMechanism",
    });
    result.map(|mut result| {
        result.elapsed_ms = elapsed;
        result
    })
}

fn dispatch_normalized_action_inner(
    app: &AppHandle,
    control: &StreamingControl,
    action: &NormalizedAction,
) -> Result<ActionResult, String> {
    if action.queued_at.elapsed() > Duration::from_millis(STALE_PACKET_MS) {
        return Err("Native action expired in the bounded queue.".into());
    }
    if !normalized_generation_active(
        control,
        action.config_epoch,
        action.controller_epoch,
        action.generation,
    ) {
        return Err("Input generation was revoked before dispatch.".into());
    }
    let home = crate::pad_hub::get_native_controller_status(app.state::<crate::pad_hub::PadHub>());
    if !home.running || !home.home_enabled {
        return Err("Streaming input paused because native Home is unavailable.".into());
    }
    match action.action {
        NavigationAction::Home => {
            if action.source != ActionSource::Simulator || action.route != TargetRoute::LocalHome {
                return Err(
                    "Home is handled only through the existing local Home mechanism.".into(),
                );
            }
            if !simulator_local_action_context_current(app, action) {
                return Err(
                    "Home was rejected because focus left the trusted VELORA window or exact pinned Edge Cinema session.".into(),
                );
            }
            let request_id = {
                let mut state = control
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.simulator_home_request_id =
                    state.simulator_home_request_id.saturating_add(1);
                state.simulator_home_ready_revision = None;
                state.simulator_home_request_id
            };
            let home_app = app.clone();
            let queued = crate::session_orchestrator::request_return_home(
                app.clone(),
                crate::session_orchestrator::TransitionCause::User,
                crate::session_orchestrator::HomeRequestSource::Device,
                move |result| complete_simulator_home_request(home_app, request_id, result),
            );
            if !queued {
                return Err("The existing Home worker queue is unavailable.".into());
            }
            let mut state = control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.media_controls_armed = false;
            state.media_target_session = None;
            state.media_target_service_id = None;
            state.simulator_target = None;
            state.engine = InteractionEngine::default();
            drop(state);
            revoke_action_generation(control);
            return Ok(ActionResult {
                effect: "Existing Home mechanism accepted the request; completion is asynchronous."
                    .into(),
                ownership: Some("VELORA Home worker".into()),
                ..ActionResult::default()
            });
        }
        NavigationAction::OpenControlCenter => {
            if action.route != TargetRoute::LocalControlCenter
                || action.source == ActionSource::Remote
            {
                return Err(
                    "Control Center is available only from a local controller or simulator action."
                        .into(),
                );
            }
            if action.source == ActionSource::Controller {
                let Some(target) = crate::edge_cinema::foreground_owned_streaming_target(app)
                else {
                    return Err(
                        "Owned streaming window changed before Options was released.".into(),
                    );
                };
                if action.target_session.as_deref() != Some(target.launch_id.as_str()) {
                    return Err(
                        "Options target session changed before Control Center dispatch.".into(),
                    );
                }
            }
            if action.source == ActionSource::Simulator {
                if !simulator_local_action_context_current(app, action) {
                    return Err(
                        "Control Center was rejected because focus left the trusted VELORA window or exact pinned Edge Cinema session.".into(),
                    );
                }
            }
            let main = app
                .get_webview_window("main")
                .ok_or_else(|| "VELORA main window is unavailable.".to_string())?;
            main.show()
                .map_err(|_| "VELORA main window could not be shown.".to_string())?;
            main.set_focus()
                .map_err(|_| "VELORA Control Center did not receive focus.".to_string())?;
            if !main.is_focused().unwrap_or(false) {
                return Err("Windows denied VELORA focus; no menu event dispatched.".into());
            }
            app.emit("nexus-remote-command", "menu")
                .map_err(|_| "Control Center event was not delivered.".to_string())?;
            return Ok(ActionResult {
                effect: "VELORA Control Center opened from the local Options action.".into(),
                ownership: Some("VELORA main window".into()),
                ..ActionResult::default()
            });
        }
        _ => {}
    }

    let target = match &action.route {
        TargetRoute::ForegroundOwned => {
            let target =
                crate::edge_cinema::foreground_owned_streaming_target(app).ok_or_else(|| {
                    "No currently focused VELORA-owned Edge Cinema session.".to_string()
                })?;
            if action
                .target_session
                .as_deref()
                .is_some_and(|id| id != target.launch_id)
            {
                return Err("Foreground streaming session changed before dispatch.".into());
            }
            target
        }
        TargetRoute::CapturedSession(session_id) => {
            if action.source != ActionSource::Simulator
                || action.target_session.as_deref() != Some(session_id.as_str())
            {
                return Err("Captured target routing is reserved for the local simulator.".into());
            }
            let pinned = crate::edge_cinema::streaming_target_for_session(app, session_id)
                .ok_or_else(|| {
                    "Captured Edge Cinema session is no longer active or owned.".to_string()
                })?;
            let captured = control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .simulator_target
                .clone()
                .ok_or_else(|| "Simulator target was cleared.".to_string())?;
            if !same_target(&pinned, &captured) {
                return Err("Captured window identity changed; recapture the session.".into());
            }
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "VELORA main window is unavailable.".to_string())?;
            if !local_main_origin(&window) || !simulator_focus_context_ok(app, &window, &pinned) {
                return Err(
                    "Focus moved to an unrelated application; target recovery was denied.".into(),
                );
            }
            if !normalized_generation_active(
                control,
                action.config_epoch,
                action.controller_epoch,
                action.generation,
            ) {
                return Err("Input was cancelled before focus recovery.".into());
            }
            if !crate::edge_cinema::streaming_target_is_current(app, &pinned) {
                let focused = crate::window_broker::activate_owned_window(
                    pinned.hwnd,
                    pinned.process_id,
                    pinned.process_created_at_100ns,
                )?;
                if !focused || !crate::edge_cinema::streaming_target_is_current(app, &pinned) {
                    return Err("Exact captured Edge Cinema window did not regain focus.".into());
                }
            }
            let verified = crate::edge_cinema::streaming_target_for_session(app, session_id)
                .ok_or_else(|| "Captured target changed during focus recovery.".to_string())?;
            if !same_target(&pinned, &verified)
                || !crate::edge_cinema::streaming_target_is_current(app, &verified)
            {
                return Err(
                    "Target HWND, PID, process creation or foreground changed during recovery."
                        .into(),
                );
            }
            verified
        }
        TargetRoute::LocalControlCenter | TargetRoute::LocalHome => {
            return Err("Local-only action was routed to a streaming window.".into())
        }
    };
    if !normalized_generation_active(
        control,
        action.config_epoch,
        action.controller_epoch,
        action.generation,
    ) {
        return Err("Input generation was revoked after target resolution.".into());
    }
    if !crate::edge_cinema::streaming_target_is_current(app, &target) {
        return Err("Streaming focus or process ownership changed before dispatch.".into());
    }
    {
        let mut state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active_service = Some(target.service_id.to_string());
        if state.media_controls_armed
            && state.media_target_session.as_deref() != Some(target.launch_id.as_str())
        {
            state.media_controls_armed = false;
            state.media_target_session = None;
            state.media_target_service_id = None;
        }
    }
    if is_media_action(action.action) {
        let state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.media_controls_armed
            || state.media_target_session.as_deref() != Some(target.launch_id.as_str())
        {
            return Err(
                "Arm playback controls for this exact service session in Control Center first."
                    .into(),
            );
        }
    }
    let native_action = match action.action {
        NavigationAction::Up => Some(Action::Up),
        NavigationAction::Down => Some(Action::Down),
        NavigationAction::Left => Some(Action::Left),
        NavigationAction::Right => Some(Action::Right),
        NavigationAction::Confirm => Some(
            if control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode
                == NavigationMode::Pointer
            {
                Action::Click
            } else {
                Action::Select
            },
        ),
        NavigationAction::Back | NavigationAction::PointerBack => Some(Action::Back),
        NavigationAction::ScrollUp => Some(Action::Scroll(120)),
        NavigationAction::ScrollDown => Some(Action::Scroll(-120)),
        NavigationAction::ScrollAmount(amount) => {
            Some(Action::Scroll(i32::from(amount).clamp(-240, 240)))
        }
        NavigationAction::PointerMove(x, y) => {
            if control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode
                != NavigationMode::Pointer
            {
                return Err("Pointer movement requires explicit pointer mode.".into());
            }
            Some(Action::Move(x.clamp(-32, 32), y.clamp(-32, 32)))
        }
        NavigationAction::PointerClick => {
            if control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode
                != NavigationMode::Pointer
            {
                return Err("Pointer click requires explicit pointer mode.".into());
            }
            Some(Action::Click)
        }
        NavigationAction::PointerToggle => {
            let mut state = control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.mode == NavigationMode::Pointer {
                state.mode = state.previous_mode;
            } else {
                state.previous_mode = state.mode;
                state.mode = NavigationMode::Pointer;
            }
            state.engine.primed = false;
            crate::pointer_indicator::update(target.hwnd, state.mode == NavigationMode::Pointer);
            return Ok(ActionResult {
                effect: format!("Pointer mode changed to {}.", state.mode.as_str()),
                ownership: Some("VELORA streaming session".into()),
                ..ActionResult::default()
            });
        }
        NavigationAction::PreviousSection | NavigationAction::NextSection => {
            Some(if action.action == NavigationAction::PreviousSection {
                Action::PreviousFocus
            } else {
                Action::NextFocus
            })
        }
        NavigationAction::Captions
        | NavigationAction::PlayPause
        | NavigationAction::SeekBackward
        | NavigationAction::SeekForward
        | NavigationAction::Fullscreen
        | NavigationAction::PlayerMute => {
            let vk = service_media_key(target.service_id, action.action).ok_or_else(|| {
                format!(
                    "{} shortcut is unsupported for this service profile.",
                    media_action_name(action.action)
                )
            })?;
            let editable = crate::spatial_navigation::is_editable_focus(app, &target)?;
            if editable {
                return Err("Media shortcut blocked because a search, login, or editable control has focus.".into());
            }
            Some(Action::MediaKey(vk))
        }
        NavigationAction::SystemVolumeUp
        | NavigationAction::SystemVolumeDown
        | NavigationAction::SystemMute => {
            return adjust_system_audio(action.action);
        }
        NavigationAction::Home | NavigationAction::OpenControlCenter => unreachable!(),
    };
    if let Some(action_to_send) = native_action {
        let mode = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mode;
        if matches!(mode, NavigationMode::Automatic | NavigationMode::Spatial)
            && matches!(
                action.action,
                NavigationAction::Up
                    | NavigationAction::Down
                    | NavigationAction::Left
                    | NavigationAction::Right
                    | NavigationAction::Confirm
            )
        {
            let still_authorized = || {
                action.queued_at.elapsed() <= Duration::from_millis(STALE_PACKET_MS)
                    && normalized_generation_active(
                        control,
                        action.config_epoch,
                        action.controller_epoch,
                        action.generation,
                    )
            };
            let outcome = match action.action {
                NavigationAction::Up => crate::spatial_navigation::navigate(
                    app,
                    &target,
                    crate::spatial_navigation::Direction::Up,
                    &still_authorized,
                )?,
                NavigationAction::Down => crate::spatial_navigation::navigate(
                    app,
                    &target,
                    crate::spatial_navigation::Direction::Down,
                    &still_authorized,
                )?,
                NavigationAction::Left => crate::spatial_navigation::navigate(
                    app,
                    &target,
                    crate::spatial_navigation::Direction::Left,
                    &still_authorized,
                )?,
                NavigationAction::Right => crate::spatial_navigation::navigate(
                    app,
                    &target,
                    crate::spatial_navigation::Direction::Right,
                    &still_authorized,
                )?,
                NavigationAction::Confirm => {
                    crate::spatial_navigation::activate(app, &target, &still_authorized)?
                }
                _ => unreachable!(),
            };
            if outcome.accepted {
                return Ok(ActionResult {
                    accepted: Some(true),
                    effect: outcome.effect,
                    ownership: Some("UI Automation candidates within the owned window".into()),
                    spatial_query_ms: Some(outcome.diagnostics.query_ms),
                    spatial_candidate_count: Some(outcome.diagnostics.candidate_count),
                    spatial_diagnostics: Some(outcome.diagnostics),
                    ..ActionResult::default()
                });
            }

            let failure_reason = outcome.failure_reason;
            let may_switch_to_pointer = fallback_permitted(
                action.source,
                failure_reason,
                still_authorized(),
                crate::edge_cinema::streaming_target_is_current(app, &target),
            );
            let switched_to_pointer = may_switch_to_pointer
                && activate_pointer_fallback(
                    control,
                    mode,
                    action.config_epoch,
                    action.controller_epoch,
                    action.generation,
                );
            if switched_to_pointer {
                crate::pointer_indicator::update(target.hwnd, true);
            }
            let effect = if switched_to_pointer {
                fallback_effect(failure_reason)
            } else {
                outcome.effect
            };
            // A failed spatial action is returned as a rejected receipt. No
            // pointer Move/Click is constructed on this path: switching mode is
            // the only fallback effect and the original action is not replayed.
            return Ok(ActionResult {
                accepted: Some(false),
                effect,
                ownership: Some("UI Automation candidates within the owned window".into()),
                spatial_query_ms: Some(outcome.diagnostics.query_ms),
                spatial_candidate_count: Some(outcome.diagnostics.candidate_count),
                spatial_diagnostics: Some(outcome.diagnostics),
                fallback_reason: failure_reason,
                fallback_activated: Some(switched_to_pointer),
                mode_changed_by_fallback: Some(switched_to_pointer),
                fallback_notice: switched_to_pointer.then(|| fallback_notice().to_string()),
                ..ActionResult::default()
            });
        }
        if !normalized_generation_active(
            control,
            action.config_epoch,
            action.controller_epoch,
            action.generation,
        ) {
            return Err("Input generation was revoked before SendInput.".into());
        }
        if action.queued_at.elapsed() > Duration::from_millis(STALE_PACKET_MS) {
            return Err("Input expired before native dispatch.".into());
        }
        #[cfg(target_os = "windows")]
        native::send(
            &target,
            action_to_send,
            control,
            action.config_epoch,
            action.controller_epoch,
            action.generation,
            action.source == ActionSource::Simulator,
        )?;
        #[cfg(not(target_os = "windows"))]
        return Err("Streaming input requires Windows.".into());
    }
    Ok(ActionResult {
        effect: "effectUnverified".into(),
        ownership: Some("foreground VELORA-owned Edge Cinema window".into()),
        ..ActionResult::default()
    })
}

fn is_media_action(action: NavigationAction) -> bool {
    matches!(
        action,
        NavigationAction::PlayPause
            | NavigationAction::SeekBackward
            | NavigationAction::SeekForward
            | NavigationAction::Fullscreen
            | NavigationAction::PlayerMute
            | NavigationAction::Captions
    )
}

fn media_action_name(action: NavigationAction) -> &'static str {
    match action {
        NavigationAction::PlayPause => "Play/pause",
        NavigationAction::SeekBackward => "Seek backward",
        NavigationAction::SeekForward => "Seek forward",
        NavigationAction::Fullscreen => "Fullscreen",
        NavigationAction::PlayerMute => "Player mute",
        NavigationAction::Captions => "Captions",
        NavigationAction::SystemVolumeUp => "Volume up",
        NavigationAction::SystemVolumeDown => "Volume down",
        NavigationAction::SystemMute => "Mute",
        NavigationAction::PreviousSection => "Previous section",
        NavigationAction::NextSection => "Next section",
        _ => "Media",
    }
}

fn service_media_key(service: &str, action: NavigationAction) -> Option<u16> {
    match (service, action) {
        ("netflix", NavigationAction::PlayPause) => Some(0x20),
        ("netflix", NavigationAction::SeekBackward) => Some(0x25),
        ("netflix", NavigationAction::PlayerMute) => Some(0x4d),
        ("netflix", NavigationAction::SeekForward) => Some(0x27),
        ("netflix", NavigationAction::Fullscreen) => Some(0x46),
        ("youtube", NavigationAction::PlayPause) => Some(0x4b),
        ("youtube", NavigationAction::SeekBackward) => Some(0x4a),
        ("youtube", NavigationAction::SeekForward) => Some(0x4c),
        ("youtube", NavigationAction::Fullscreen) => Some(0x46),
        ("youtube", NavigationAction::PlayerMute) => Some(0x4d),
        ("youtube", NavigationAction::Captions) => Some(0x43),
        ("prime", NavigationAction::PlayPause) => Some(0x20),
        ("prime", NavigationAction::SeekBackward) => Some(0x25),
        ("prime", NavigationAction::SeekForward) => Some(0x27),
        ("prime", NavigationAction::Fullscreen) => Some(0x46),
        ("prime", NavigationAction::PlayerMute) => Some(0x4d),
        ("prime", NavigationAction::Captions) => Some(0x43),
        _ => None,
    }
}

fn adjust_system_audio(action: NavigationAction) -> Result<ActionResult, String> {
    let current = crate::display_audio::control_default_audio(None, None, None)?;
    let expected = current.id.clone();
    let updated = match action {
        NavigationAction::SystemVolumeUp | NavigationAction::SystemVolumeDown => {
            let value = current.volume_percent.ok_or_else(|| {
                "Windows did not return the current default output volume.".to_string()
            })?;
            let amount = if action == NavigationAction::SystemVolumeUp {
                5
            } else {
                -5
            };
            let next = value.saturating_add_signed(amount).min(100);
            crate::display_audio::control_default_audio(
                Some(next as f32 / 100.0),
                None,
                Some(&expected),
            )?
        }
        NavigationAction::SystemMute => {
            let muted = current
                .muted
                .ok_or_else(|| "Windows did not return the current mute state.".to_string())?;
            crate::display_audio::control_default_audio(None, Some(!muted), Some(&expected))?
        }
        _ => return Err("Unsupported system audio action.".into()),
    };
    let effect = match (updated.volume_percent, updated.muted) {
        (Some(volume), Some(muted)) => {
            format!("Core Audio accepted the command; readback is {volume}% and muted={muted}.")
        }
        (Some(volume), _) => format!("Core Audio accepted the command; readback is {volume}%."),
        (_, Some(muted)) => format!("Core Audio accepted the command; readback muted={muted}."),
        _ => "Core Audio accepted the command; readback is unavailable.".into(),
    };
    Ok(ActionResult {
        effect,
        ownership: Some("default Core Audio endpoint; identity checked and read back".into()),
        ..ActionResult::default()
    })
}

fn normalize_pointer_coordinate(position: i32, origin: i32, extent: i32) -> Option<i32> {
    (extent > 1).then(|| {
        ((i64::from(position) - i64::from(origin)) * 65535 / i64::from(extent - 1)).clamp(0, 65535)
            as i32
    })
}

#[cfg(target_os = "windows")]
mod native {
    use super::{normalized_generation_active, scale_pointer_delta, Action, StreamingControl};
    use crate::edge_cinema::StreamingWindowTarget;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Mouse {
        dx: i32,
        dy: i32,
        data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Keyboard {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    union InputData {
        mouse: Mouse,
        keyboard: Keyboard,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Input {
        kind: u32,
        data: InputData,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(window: *mut c_void, process: *mut u32) -> u32;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn GetCursorPos(point: *mut Point) -> i32;
        fn GetClientRect(window: *mut c_void, rect: *mut Rect) -> i32;
        fn ClientToScreen(window: *mut c_void, point: *mut Point) -> i32;
        fn WindowFromPoint(point: Point) -> *mut c_void;
        fn GetAncestor(window: *mut c_void, flags: u32) -> *mut c_void;
        fn GetSystemMetrics(index: i32) -> i32;
        fn SetThreadDpiAwarenessContext(context: *mut c_void) -> *mut c_void;
        fn GetDpiForWindow(window: *mut c_void) -> u32;
    }
    struct DpiContextGuard(*mut c_void);
    impl DpiContextGuard {
        fn enter() -> Result<Self, String> {
            const PER_MONITOR_V2: *mut c_void = -4isize as *mut c_void;
            let previous = unsafe { SetThreadDpiAwarenessContext(PER_MONITOR_V2) };
            if previous.is_null() {
                Err("Per-monitor pointer coordinates are unavailable.".into())
            } else {
                Ok(Self(previous))
            }
        }
    }
    impl Drop for DpiContextGuard {
        fn drop(&mut self) {
            unsafe { SetThreadDpiAwarenessContext(self.0) };
        }
    }
    fn key(vk: u16, up: bool, extended: bool) -> Input {
        Input {
            kind: 1,
            data: InputData {
                keyboard: Keyboard {
                    vk,
                    scan: 0,
                    flags: if up { 2 } else { 0 } | if extended { 1 } else { 0 },
                    time: 0,
                    extra: 0,
                },
            },
        }
    }
    fn mouse(flags: u32, dx: i32, dy: i32, data: u32) -> Input {
        Input {
            kind: 0,
            data: InputData {
                mouse: Mouse {
                    dx,
                    dy,
                    data,
                    flags,
                    time: 0,
                    extra: 0,
                },
            },
        }
    }
    thread_local! { static SIM_CURSOR: std::cell::RefCell<Option<(StreamingWindowTarget, u64, u64, Point)>> = const { std::cell::RefCell::new(None) }; }
    fn absolute_move(point: Point) -> Result<Input, String> {
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(76),
                GetSystemMetrics(77),
                GetSystemMetrics(78),
                GetSystemMetrics(79),
            )
        };
        let x = super::normalize_pointer_coordinate(point.x, left, width)
            .ok_or("Brak geometrii pulpitu.")?;
        let y = super::normalize_pointer_coordinate(point.y, top, height)
            .ok_or("Brak geometrii pulpitu.")?;
        Ok(mouse(0xc001, x, y, 0))
    }
    fn pointer_inside(target: &StreamingWindowTarget) -> Result<(Point, Point, Point), String> {
        let hwnd = target.hwnd as usize as *mut c_void;
        let mut rect = Rect::default();
        let mut cursor = Point::default();
        if unsafe { GetClientRect(hwnd, &mut rect) } == 0
            || unsafe { GetCursorPos(&mut cursor) } == 0
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return Err("Brak bezpiecznego obszaru wskaźnika.".into());
        }
        let mut first = Point {
            x: rect.left,
            y: rect.top,
        };
        let mut last = Point {
            x: rect.right - 1,
            y: rect.bottom - 1,
        };
        if unsafe { ClientToScreen(hwnd, &mut first) } == 0
            || unsafe { ClientToScreen(hwnd, &mut last) } == 0
        {
            return Err("Nie odczytano obszaru okna.".into());
        }
        if first.x > last.x || first.y > last.y {
            return Err("Invalid pointer bounds.".into());
        }
        Ok((cursor, first, last))
    }
    pub(super) fn send(
        target: &StreamingWindowTarget,
        action: Action,
        control: &StreamingControl,
        epoch: u64,
        controller_epoch: u64,
        generation: u64,
        simulated: bool,
    ) -> Result<(), String> {
        let _dpi_context = if matches!(action, Action::Click | Action::Scroll(_) | Action::Move(..))
        {
            Some(DpiContextGuard::enter()?)
        } else {
            None
        };
        // Do not combine generated taps with an actual keyboard shortcut/drag.
        if [0x10, 0x11, 0x12, 0x5b, 0x5c, 0x01, 0x02]
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(*key) } < 0)
        {
            return Err(
                "Sterowanie wstrzymane podczas klawisza modyfikującego lub przeciągania.".into(),
            );
        }
        let cached = if simulated {
            SIM_CURSOR.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .filter(|(t, e, g, _)| t == target && *e == epoch && *g == generation)
                    .map(|(_, _, _, point)| *point)
            })
        } else {
            None
        };
        let mut next_cursor = None;
        let inputs: Vec<Input> = match action {
            Action::Up
            | Action::Down
            | Action::Left
            | Action::Right
            | Action::Select
            | Action::NextFocus => {
                let vk = match action {
                    Action::Up => 0x26,
                    Action::Down => 0x28,
                    Action::Left => 0x25,
                    Action::Right => 0x27,
                    Action::NextFocus => 0x09,
                    _ => 0x0d,
                };
                if unsafe { GetAsyncKeyState(vk) } < 0 {
                    return Err("Klawisz jest już naciśnięty.".into());
                }
                vec![
                    key(
                        vk as u16,
                        false,
                        matches!(
                            action,
                            Action::Up | Action::Down | Action::Left | Action::Right
                        ),
                    ),
                    key(
                        vk as u16,
                        true,
                        matches!(
                            action,
                            Action::Up | Action::Down | Action::Left | Action::Right
                        ),
                    ),
                ]
            }
            Action::MediaKey(vk) => {
                if unsafe { GetAsyncKeyState(i32::from(vk)) } < 0 {
                    return Err("Playback key is already pressed.".into());
                }
                let extended = (0x25..=0x28).contains(&vk);
                vec![key(vk, false, extended), key(vk, true, extended)]
            }
            Action::Back => {
                if unsafe { GetAsyncKeyState(0x25) } < 0 {
                    return Err("Klawisz Wstecz jest już naciśnięty.".into());
                }
                vec![
                    key(0xa4, false, false),
                    key(0x25, false, true),
                    key(0x25, true, true),
                    key(0xa4, true, false),
                ]
            }
            Action::PreviousFocus => {
                if unsafe { GetAsyncKeyState(0x09) } < 0 {
                    return Err("Klawisz Tab jest już naciśnięty.".into());
                }
                vec![
                    key(0xa0, false, false),
                    key(0x09, false, false),
                    key(0x09, true, false),
                    key(0xa0, true, false),
                ]
            }
            Action::Click | Action::Scroll(_) => {
                let (actual, first, last) = pointer_inside(target)?;
                if simulated && action == Action::Click && cached.is_none() {
                    return Err(
                        "Move the simulated pointer before clicking; no guessed click is sent."
                            .into(),
                    );
                }
                let cursor = if simulated {
                    cached.unwrap_or(Point {
                        x: first.x + (last.x - first.x) / 2,
                        y: first.y + (last.y - first.y) / 2,
                    })
                } else {
                    actual
                };
                next_cursor = Some(cursor);
                if cursor.x < first.x
                    || cursor.x > last.x
                    || cursor.y < first.y
                    || cursor.y > last.y
                {
                    return Err(
                        "Przesuń wskaźnik do okna usługi przed kliknięciem lub przewijaniem."
                            .into(),
                    );
                }
                // An unrelated always-on-top window can cover a foreground
                // browser without owning focus. Do not click through that case.
                let hit = unsafe { GetAncestor(WindowFromPoint(cursor), 2) };
                if hit as usize as u64 != target.hwnd {
                    return Err("Wskaźnik zasłania inne okno; kliknięcie wstrzymane.".into());
                }
                if action == Action::Click {
                    let mut events = if simulated {
                        vec![absolute_move(cursor)?]
                    } else {
                        Vec::new()
                    };
                    events.extend([mouse(2, 0, 0, 0), mouse(4, 0, 0, 0)]);
                    events
                } else if let Action::Scroll(amount) = action {
                    let mut events = if simulated {
                        vec![absolute_move(cursor)?]
                    } else {
                        Vec::new()
                    };
                    events.push(mouse(0x800, 0, 0, amount as u32));
                    events
                } else {
                    unreachable!()
                }
            }
            Action::Move(dx, dy) => {
                let (actual, first, last) = pointer_inside(target)?;
                let cursor = if simulated {
                    cached.unwrap_or(Point {
                        x: first.x + (last.x - first.x) / 2,
                        y: first.y + (last.y - first.y) / 2,
                    })
                } else {
                    actual
                };
                let client_width = last.x.saturating_sub(first.x).saturating_add(1);
                let client_height = last.y.saturating_sub(first.y).saturating_add(1);
                // Reference comes from the owned window's measured client
                // extent and its DPI, not a hard-coded 1920/1080 desktop.
                let dpi = unsafe { GetDpiForWindow(target.hwnd as usize as *mut c_void) };
                let reference_width = super::pointer_scale_reference(client_width, dpi);
                let reference_height = super::pointer_scale_reference(client_height, dpi);
                let dx = scale_pointer_delta(dx, client_width, reference_width);
                let dy = scale_pointer_delta(dy, client_height, reference_height);
                let point = Point {
                    x: cursor.x.saturating_add(dx).clamp(first.x, last.x),
                    y: cursor.y.saturating_add(dy).clamp(first.y, last.y),
                };
                next_cursor = Some(point);
                vec![absolute_move(point)?]
            }
            _ => return Err("Unresolved action cannot reach native input.".into()),
        };
        let foreground = unsafe { GetForegroundWindow() };
        let mut process = 0;
        unsafe { GetWindowThreadProcessId(foreground, &mut process) };
        if foreground as usize as u64 != target.hwnd
            || process != target.process_id
            || !crate::process_table::identity(process).is_some_and(|identity| {
                identity.created_at_100ns == target.process_created_at_100ns
            })
        {
            return Err("Fokus zmienił się przed wysłaniem sterowania.".into());
        }
        if !normalized_generation_active(control, epoch, controller_epoch, generation) {
            return Err("Sterowanie zostało anulowane przed wysłaniem.".into());
        }
        let inserted = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            )
        };
        if inserted == inputs.len() as u32 {
            if action == Action::Click {
                crate::pointer_indicator::click_feedback(target.hwnd);
            }
            if simulated {
                if let Some(point) = next_cursor {
                    SIM_CURSOR.with(|cell| {
                        *cell.borrow_mut() = Some((target.clone(), epoch, generation, point))
                    });
                }
            }
            return Ok(());
        }
        if simulated {
            SIM_CURSOR.with(|cell| *cell.borrow_mut() = None);
        }
        // A bounded cleanup releases only downs this call actually inserted.
        // Never leave an injected Alt/key/mouse button held after a partial call.
        let mut releases = Vec::new();
        for input in inputs.iter().take(inserted as usize) {
            if input.kind == 1 {
                let keyboard = unsafe { input.data.keyboard };
                if keyboard.flags & 2 == 0 {
                    releases.push(key(keyboard.vk, true, keyboard.flags & 1 != 0));
                }
            } else {
                let data = unsafe { input.data.mouse };
                if data.flags & 2 != 0 {
                    releases.push(mouse(4, 0, 0, 0));
                }
            }
        }
        releases.reverse();
        if !releases.is_empty() {
            unsafe {
                SendInput(
                    releases.len() as u32,
                    releases.as_ptr(),
                    std::mem::size_of::<Input>() as i32,
                )
            };
        }
        Err("Windows nie przyjął pełnego sterowania (możliwa granica uprawnień).".into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn input_layout_matches_win32_abi() {
            assert_eq!(
                std::mem::size_of::<Input>(),
                if cfg!(target_pointer_width = "64") {
                    40
                } else {
                    28
                }
            );
            assert_eq!(std::mem::align_of::<Input>(), std::mem::align_of::<usize>());
        }
        #[test]
        fn keyboard_tap_packets_are_paired_without_persistent_modifiers() {
            let down = key(0x25, false, true);
            let up = key(0x25, true, true);
            assert_eq!(unsafe { down.data.keyboard.flags }, 1);
            assert_eq!(unsafe { up.data.keyboard.flags }, 3);
            assert_eq!(unsafe { down.data.keyboard.vk }, unsafe {
                up.data.keyboard.vk
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn report() -> Ds4Report {
        let mut bytes = [0u8; 64];
        bytes[0] = 1;
        bytes[1..5].fill(128);
        bytes[5] = 8;
        crate::ds4::parse_report(&bytes).unwrap()
    }
    fn streaming_target(id: &str, hwnd: u64) -> crate::edge_cinema::StreamingWindowTarget {
        crate::edge_cinema::StreamingWindowTarget {
            service_id: "youtube",
            launch_id: id.into(),
            hwnd,
            process_id: 7,
            process_created_at_100ns: 99,
        }
    }

    #[test]
    fn quiesce_clears_media_arming_and_advances_generation_exactly_once() {
        let control = StreamingControl::default();
        {
            let mut state = control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.media_controls_armed = true;
            state.media_target_session = Some("netflix-session".into());
            state.media_target_service_id = Some("netflix");
            state.simulator_target = Some(streaming_target("netflix-session", 10));
            // Park a half-pressed Cross in the engine: a blind media key edge
            // must not carry across the quiesce into the next service.
            let mut input = report();
            input.buttons.set(Ds4Button::Cross, true);
            state
                .engine
                .update("pad", &input, 1, NavigationMode::Keyboard, 0);
        }
        let before_generation = control.generation.load(Ordering::Acquire);
        let before_epoch = control.controller_epoch.load(Ordering::Acquire);

        let generation = quiesce_streaming_control(&control);

        assert_eq!(generation, before_generation + 1);
        assert_eq!(
            control.generation.load(Ordering::Acquire),
            before_generation + 1
        );
        assert_eq!(
            control.controller_epoch.load(Ordering::Acquire),
            before_epoch + 1
        );
        assert_eq!(control.quiesce_count.load(Ordering::Acquire), 1);

        let mut state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(!state.media_controls_armed);
        assert!(state.media_target_session.is_none());
        assert!(state.media_target_service_id.is_none());
        assert!(state.simulator_target.is_none());
        let mut input = report();
        input.buttons.set(Ds4Button::Cross, false);
        assert!(state
            .engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 50)
            .is_empty());
    }

    #[test]
    fn quiesce_rejects_replayed_and_stale_generations() {
        let control = StreamingControl::default();
        control.enabled.store(true, Ordering::Release);
        let epoch = control.epoch.load(Ordering::Acquire);
        let stale_generation = control.generation.load(Ordering::Acquire);
        let stale_controller_epoch = control.controller_epoch.load(Ordering::Acquire);
        assert!(normalized_generation_active(
            &control,
            epoch,
            stale_controller_epoch,
            stale_generation
        ));

        let generation = quiesce_streaming_control(&control);

        // The pre-quiesce token is now stale even though it was once current.
        assert!(!normalized_generation_active(
            &control,
            epoch,
            stale_controller_epoch,
            stale_generation
        ));
        assert!(!normalized_generation_active(
            &control,
            epoch,
            stale_controller_epoch,
            generation
        ));
        // A fresh read with a deduplicated (unchanged) token is still current.
        assert!(normalized_generation_active(
            &control,
            epoch,
            control.controller_epoch.load(Ordering::Acquire),
            generation
        ));
    }

    #[test]
    fn simulator_home_and_control_center_require_local_or_exact_owned_focus() {
        let captured = streaming_target("session-a", 10);
        let same_session_other_identity = streaming_target("session-a", 11);
        let other_session = streaming_target("session-b", 10);
        assert!(simulator_local_action_context_matches(true, None, None, None));
        assert!(simulator_local_action_context_matches(
            true,
            Some("session-a"),
            Some(&captured),
            None
        ));
        assert!(!simulator_local_action_context_matches(
            true,
            Some("session-b"),
            Some(&captured),
            None
        ));
        assert!(simulator_local_action_context_matches(
            false,
            Some("session-a"),
            Some(&captured),
            Some(&captured)
        ));
        assert!(!simulator_local_action_context_matches(
            false,
            Some("session-a"),
            Some(&captured),
            Some(&same_session_other_identity)
        ));
        assert!(!simulator_local_action_context_matches(
            false,
            Some("session-a"),
            Some(&captured),
            Some(&other_session)
        ));
        assert!(!simulator_local_action_context_matches(
            false,
            None,
            Some(&captured),
            Some(&captured)
        ));
    }
    #[test]
    fn held_cross_never_crosses_focus_or_reconnect() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        input.buttons.set(Ds4Button::Cross, true);
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 0)
            .is_empty());
        input.buttons.set(Ds4Button::Cross, false);
        engine.update("pad", &input, 1, NavigationMode::Keyboard, 10);
        input.buttons.set(Ds4Button::Cross, true);
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Keyboard, 50),
            vec![Action::Select]
        );
        assert!(engine
            .update("pad", &input, 2, NavigationMode::Keyboard, 100)
            .is_empty());
        assert!(engine
            .update("pad", &input, 2, NavigationMode::Keyboard, 500)
            .is_empty());
    }
    #[test]
    fn generation_change_requires_neutral_even_without_a_separate_reset_signal() {
        let mut state = RuntimeState::default();
        let mut input = report();
        state
            .engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 0);
        state.rearm_controller_generation(1);
        input.buttons.set(Ds4Button::Cross, true);
        assert!(state
            .engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 50)
            .is_empty());
        input.buttons.set(Ds4Button::Cross, false);
        state
            .engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 100);
        state.rearm_controller_generation(1);
        input.buttons.set(Ds4Button::Cross, true);
        assert_eq!(
            state
                .engine
                .update("pad", &input, 1, NavigationMode::Keyboard, 150),
            vec![Action::Select]
        );
        state.rearm_controller_generation(2);
        assert!(state
            .engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 200)
            .is_empty());
    }

    #[test]
    fn home_constituents_suppress_controls_until_neutral() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, NavigationMode::Keyboard, 0);
        input.buttons.set(Ds4Button::Options, true);
        input.buttons.set(Ds4Button::Cross, true);
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 50)
            .is_empty());
        input.buttons.set(Ds4Button::Options, false);
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 100)
            .is_empty());
        input.buttons.set(Ds4Button::Cross, false);
        engine.update("pad", &input, 1, NavigationMode::Keyboard, 150);
        input.buttons.set(Ds4Button::Cross, true);
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Keyboard, 200),
            vec![Action::Select]
        );
    }
    #[test]
    fn pointer_is_opt_in_and_deadzone_rejects_noise() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, NavigationMode::Keyboard, 0);
        input.right_x = 0.2;
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Pointer, 50)
            .is_empty());
        input.right_x = 1.0;
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 100)
            .is_empty());
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Pointer, 150),
            vec![Action::Move(32, 0)]
        );
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Pointer, 160)
            .is_empty());
    }
    #[test]
    fn right_stick_click_activates_precision_only_in_pointer_mode() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, NavigationMode::Pointer, 0);
        input.buttons.set(Ds4Button::R3, true);
        input.right_x = 1.0;
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Pointer, 50),
            vec![Action::Move(8, 0)]
        );
        input.buttons.set(Ds4Button::R3, false);
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Pointer, 100),
            vec![Action::Move(32, 0)]
        );
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 150)
            .is_empty());
    }
    #[test]
    fn repeat_is_bounded_and_does_not_hold_os_keys() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, NavigationMode::Keyboard, 0);
        input.dpad.down = true;
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Keyboard, 50),
            vec![Action::Down]
        );
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 100)
            .is_empty());
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 250)
            .is_empty());
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Keyboard, 370),
            vec![Action::Down]
        );
    }
    #[test]
    fn alternate_device_cannot_inherit_armed_input() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad-a", &input, 1, NavigationMode::Keyboard, 0);
        input.buttons.set(Ds4Button::Circle, true);
        assert!(engine
            .update("pad-b", &input, 1, NavigationMode::Keyboard, 50)
            .is_empty());
    }

    #[test]
    fn a_short_tap_after_navigation_survives_frame_pacing_and_release() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, NavigationMode::Keyboard, 0);
        input.dpad.down = true;
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Keyboard, 50),
            vec![Action::Down]
        );
        input.dpad.down = false;
        input.buttons.set(Ds4Button::Cross, true);
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 60)
            .is_empty());
        input.buttons.set(Ds4Button::Cross, false);
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Keyboard, 90),
            vec![Action::Select]
        );
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 130)
            .is_empty());
    }

    #[test]
    fn queued_input_generation_is_revoked_on_disable_and_device_reconnect() {
        let control = StreamingControl::default();
        control.enabled.store(true, Ordering::Release);
        assert!(generation_active(&control, 0, 0));
        control.controller_epoch.fetch_add(1, Ordering::AcqRel);
        assert!(!generation_active(&control, 0, 0));
        assert!(generation_active(&control, 0, 1));
        control.epoch.fetch_add(1, Ordering::AcqRel);
        assert!(!generation_active(&control, 0, 1));
        control.enabled.store(false, Ordering::Release);
        assert!(!generation_active(&control, 1, 1));
    }

    #[test]
    fn local_origin_rejects_remote_pages_ports_credentials_and_release_development_url() {
        assert!(local_main_origin_parts(
            "main",
            "http",
            Some("tauri.localhost"),
            None,
            false,
            false
        ));
        assert!(local_main_origin_parts(
            "main",
            "http",
            Some("127.0.0.1"),
            Some(1420),
            false,
            true
        ));
        for (label, host, port, credentials, debug) in [
            ("other", "tauri.localhost", None, false, true),
            ("main", "example.com", None, false, true),
            ("main", "127.0.0.1", Some(9999), false, true),
            ("main", "127.0.0.1", Some(1420), false, false),
            ("main", "tauri.localhost", None, true, true),
        ] {
            assert!(!local_main_origin_parts(
                label,
                "http",
                Some(host),
                port,
                credentials,
                debug
            ));
        }
    }
    #[test]
    fn playback_state_read_is_explicitly_unsupported_blind_toggle_only() {
        // Pinned limitation: no provider playback-state read/persist/restore
        // exists (DRM boundary). Media control stays a blind toggle and the
        // truthful fallback state is "unknown".
        assert!(!super::PLAYBACK_STATE_READ_SUPPORTED);
        // Play/Pause maps to a single key (Space = 0x20) for Netflix/Prime —
        // a toggle, not a state command; there is no readback path at all.
        assert_eq!(
            service_media_key("netflix", NavigationAction::PlayPause),
            Some(0x20)
        );
    }

    #[test]
    fn media_profiles_never_confuse_rewind_with_pause_or_enable_unknown_service() {
        assert_eq!(
            service_media_key("netflix", NavigationAction::PlayPause),
            Some(0x20)
        );
        assert_eq!(
            service_media_key("netflix", NavigationAction::SeekBackward),
            Some(0x25)
        );
        assert_eq!(
            service_media_key("youtube", NavigationAction::SeekBackward),
            Some(0x4a)
        );
        assert_eq!(
            service_media_key("youtube", NavigationAction::Captions),
            Some(0x43)
        );
        assert_eq!(
            service_media_key("prime", NavigationAction::Fullscreen),
            Some(0x46)
        );
        for id in ["disney", "max", "unknown"] {
            assert_eq!(service_media_key(id, NavigationAction::PlayPause), None);
        }
        assert!(!is_media_action(NavigationAction::NextSection));
    }
    #[test]
    fn analog_axes_are_finite_dead_zoned_accelerated_and_bounded() {
        for x in [f32::NAN, f32::INFINITY, 0.0, 0.24] {
            assert_eq!(pointer_axis_step(x, 0.25, 32), 0);
        }
        assert_eq!(left_stick_direction(0.2, 0.2), None);
        assert_eq!(left_stick_direction(-1.0, 0.2), Some(Action::Left));
        assert!(pointer_axis_step(0.5, 0.25, 32) < pointer_axis_step(1.0, 0.25, 32));
        assert_eq!(pointer_axis_step(4.0, 0.25, 32), 32);
        assert_eq!(pointer_axis_step(-4.0, 0.25, 32), -32);
    }
    #[test]
    fn pointer_and_scroll_motion_scale_for_4k_without_unbounded_deltas() {
        assert_eq!(scale_pointer_delta(32, 1920, 1920), 32);
        assert_eq!(scale_pointer_delta(32, 3840, 1920), 64);
        assert_eq!(scale_pointer_delta(-8, 3840, 1920), -16);
        assert_eq!(scale_pointer_delta(100, 7680, 1920), 64);
        assert_eq!(scale_pointer_delta(32, 0, 1920), 32);
        assert_eq!(normalize_pointer_coordinate(-1920, -1920, 1920), Some(0));
        assert_eq!(normalize_pointer_coordinate(-1, -1920, 1920), Some(65535));
        assert_eq!(scroll_axis_amount(0.2, RIGHT_STICK_DEADZONE), 0);
        assert_eq!(scroll_axis_amount(0.4, RIGHT_STICK_DEADZONE), 125);
        assert!(scroll_axis_amount(1.0, RIGHT_STICK_DEADZONE) <= 240);
        assert_eq!(
            action_to_navigation(Action::Scroll(999)),
            NavigationAction::ScrollAmount(240)
        );
        assert_eq!(
            action_to_navigation(Action::Scroll(-999)),
            NavigationAction::ScrollAmount(-240)
        );
    }
    #[test]
    fn options_opens_only_on_clean_release_and_never_after_home_constituents() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, NavigationMode::Keyboard, 0);
        input.buttons.set(Ds4Button::Options, true);
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 50)
            .is_empty());
        input.buttons.set(Ds4Button::Options, false);
        assert_eq!(
            engine.update("pad", &input, 1, NavigationMode::Keyboard, 100),
            vec![Action::OpenControlCenter]
        );
        input.buttons.set(Ds4Button::Options, true);
        input.buttons.set(Ds4Button::L1, true);
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 150)
            .is_empty());
        input.buttons.set(Ds4Button::L1, false);
        input.buttons.set(Ds4Button::Options, false);
        assert!(engine
            .update("pad", &input, 1, NavigationMode::Keyboard, 200)
            .is_empty());
    }
    #[test]
    fn cancellation_revokes_queued_sources_and_allows_a_fresh_simulator_lease() {
        let control = StreamingControl::default();
        control.enabled.store(true, Ordering::Release);
        control.simulator_busy.store(true, Ordering::Release);
        assert!(normalized_generation_active(&control, 0, 0, 0));
        revoke_action_generation(&control);
        assert!(!normalized_generation_active(&control, 0, 0, 0));
        assert!(!control.simulator_busy.load(Ordering::Acquire));
        assert!(normalized_generation_active(&control, 0, 1, 1));
    }

    #[test]
    fn sticky_pointer_fallback_revokes_queued_input_and_requires_a_fresh_mode_choice() {
        let control = StreamingControl::default();
        control.enabled.store(true, Ordering::Release);
        control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mode = NavigationMode::Automatic;
        assert!(activate_pointer_fallback(
            &control,
            NavigationMode::Automatic,
            0,
            0,
            0
        ));
        assert!(!normalized_generation_active(&control, 0, 0, 0));
        let state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(state.mode, NavigationMode::Pointer);
        assert_eq!(state.previous_mode, NavigationMode::Keyboard);
        assert!(!state.engine.primed);

        drop(state);
        let rejected = StreamingControl::default();
        rejected.enabled.store(true, Ordering::Release);
        rejected.generation.store(1, Ordering::Release);
        rejected
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mode = NavigationMode::Spatial;
        assert!(!activate_pointer_fallback(
            &rejected,
            NavigationMode::Spatial,
            0,
            0,
            0
        ));
        assert_eq!(
            rejected
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode,
            NavigationMode::Spatial
        );
    }

    #[test]
    fn pointer_coordinates_support_negative_monitors_and_physical_dpi() {
        assert_eq!(normalize_pointer_coordinate(-1920, -1920, 1920), Some(0));
        assert_eq!(normalize_pointer_coordinate(-1, -1920, 1920), Some(65535));
        assert_eq!(normalize_pointer_coordinate(0, 0, 1), None);
        assert_eq!(
            normalize_pointer_coordinate(i32::MAX, i32::MIN, 1920),
            Some(65535)
        );
        let a = normalize_pointer_coordinate(960, 0, 1921).unwrap();
        let b = normalize_pointer_coordinate(1920, 0, 3841).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn pointer_reference_is_dpi_derived_and_negative_desktop_origins_normalize() {
        assert_eq!(pointer_scale_reference(1920, 96), 1920);
        assert_eq!(pointer_scale_reference(3840, 192), 1920);
        assert_eq!(pointer_scale_reference(3840, 144), 2560);
        assert_eq!(pointer_scale_reference(3840, 0), 0);
        assert_eq!(pointer_scale_reference(0, 96), 0);
        // Scale stays within [1.0, 2.0] and the delta within ±64.
        assert_eq!(
            scale_pointer_delta(32, 1920, pointer_scale_reference(1920, 96)),
            32
        );
        assert_eq!(
            scale_pointer_delta(32, 3840, pointer_scale_reference(3840, 192)),
            64
        );
        assert_eq!(
            scale_pointer_delta(-8, 3840, pointer_scale_reference(3840, 192)),
            -16
        );
        assert_eq!(
            scale_pointer_delta(100, 7680, pointer_scale_reference(7680, 192)),
            64
        );
        // Virtual desktop spanning a monitor at a negative origin.
        assert_eq!(normalize_pointer_coordinate(-2560, -2560, 5120), Some(0));
        assert_eq!(
            normalize_pointer_coordinate(-1920, -2560, 5120),
            Some((i64::from(640) * 65535 / 5119).clamp(0, 65535) as i32)
        );
    }

    #[test]
    fn ownership_failures_never_activate_pointer_fallback() {
        for kind in [
            SpatialFailureKind::FocusOutsideOwnedWindow,
            SpatialFailureKind::ScopeChanged,
            SpatialFailureKind::AuthorizationRevoked,
            SpatialFailureKind::TargetChanged,
            SpatialFailureKind::UnsupportedPlatform,
        ] {
            assert!(
                !fallback_permitted(ActionSource::Controller, Some(kind), true, true),
                "{kind:?} must not activate fallback"
            );
        }
        // A recoverable failure with all guards satisfied may switch modes.
        assert!(fallback_permitted(
            ActionSource::Controller,
            Some(SpatialFailureKind::QueryBudgetExhausted),
            true,
            true
        ));
        // An unclassified (absent) failure never activates fallback.
        assert!(!fallback_permitted(
            ActionSource::Controller,
            None,
            true,
            true
        ));
    }

    #[test]
    fn failed_spatial_confirm_is_not_replayed_as_a_pointer_click() {
        // A failed spatial activation is recoverable, so the mode may switch —
        // but the only product is a rejected receipt: no pointer Click is sent.
        assert!(fallback_permitted(
            ActionSource::Controller,
            Some(SpatialFailureKind::NoCandidateInDirection),
            true,
            true
        ));
        let effect = fallback_effect(Some(SpatialFailureKind::NoCandidateInDirection));
        assert!(effect.contains("was not repeated"));
        assert!(effect.contains("no control in that direction"));
        assert!(!effect.contains("click"));
        assert_eq!(
            fallback_notice(),
            "sticky pointer fallback enabled — original action was not repeated"
        );
    }

    #[test]
    fn remote_source_and_stale_guards_never_fall_back() {
        for kind in [
            SpatialFailureKind::QueryBudgetExhausted,
            SpatialFailureKind::ProviderUnavailable,
            SpatialFailureKind::NoEligibleCandidates,
        ] {
            assert!(!fallback_permitted(
                ActionSource::Remote,
                Some(kind),
                true,
                true
            ));
        }
        // Revoked authorization or a stale target blocks an otherwise
        // recoverable controller failure.
        assert!(!fallback_permitted(
            ActionSource::Controller,
            Some(SpatialFailureKind::QueryBudgetExhausted),
            false,
            true
        ));
        assert!(!fallback_permitted(
            ActionSource::Controller,
            Some(SpatialFailureKind::QueryBudgetExhausted),
            true,
            false
        ));
    }

    #[test]
    fn activate_pointer_fallback_rejects_stale_generation_and_wrong_mode() {
        let control = StreamingControl::default();
        control.enabled.store(true, Ordering::Release);
        control.generation.store(4, Ordering::Release);
        control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mode = NavigationMode::Automatic;
        // Stale generation is rejected before any mode change or epoch bump.
        assert!(!activate_pointer_fallback(
            &control,
            NavigationMode::Automatic,
            0,
            0,
            3
        ));
        assert_eq!(control.generation.load(Ordering::Acquire), 4);
        assert_eq!(
            control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode,
            NavigationMode::Automatic
        );
        // A mismatched expected mode is also rejected.
        assert!(!activate_pointer_fallback(
            &control,
            NavigationMode::Spatial,
            0,
            0,
            4
        ));
        assert_eq!(
            control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode,
            NavigationMode::Automatic
        );
        // Correct epoch/generation and expected mode succeed and bump generation.
        assert!(activate_pointer_fallback(
            &control,
            NavigationMode::Automatic,
            0,
            0,
            4
        ));
        assert_eq!(control.generation.load(Ordering::Acquire), 5);
        assert_eq!(
            control
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode,
            NavigationMode::Pointer
        );
    }
}
