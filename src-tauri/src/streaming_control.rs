//! Opt-in controller-to-keyboard/pointer bridge for owned Edge Cinema windows.
//! Raw Input only enqueues bounded semantic reports. No global mapping or hook.
//! SendInput is focus-sensitive: a final identity/foreground check narrows but
//! cannot eliminate a foreground race. Website behavior requires hardware QA.

use crate::ds4::{Ds4Button, Ds4Dpad, Ds4Report};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MIN_ACTION_MS: u64 = 33;
const REPEAT_MS: u64 = 160;
const STALE_PACKET_MS: u64 = 200;

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
    device: String,
    report: Ds4Report,
    at_ms: u64,
    queued_at: Instant,
}

struct ReportQueue {
    epoch: u64,
    sender: SyncSender<Packet>,
    last_sample_ms: Option<u64>,
    last_buttons: Option<u16>,
    last_dpad: Ds4Dpad,
}

#[derive(Default)]
pub struct StreamingControl {
    config_gate: Mutex<()>,
    epoch: AtomicU64,
    controller_epoch: AtomicU64,
    reset_pending: AtomicBool,
    enabled: AtomicBool,
    dropped: AtomicU64,
    state: Mutex<RuntimeState>,
    sender: Mutex<Option<ReportQueue>>,
    worker_stop: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Default)]
struct RuntimeState {
    pointer_mode: bool,
    active_service: Option<String>,
    last_result: Option<String>,
    accepted: u64,
    rejected: u64,
    engine: InteractionEngine,
    last_remote_at: Option<Instant>,
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
}

#[derive(Default)]
struct InteractionEngine {
    device: Option<String>,
    target: Option<u64>,
    primed: bool,
    last_buttons: u16,
    last_direction: Option<Action>,
    last_direction_at: Option<u64>,
    last_action_at: Option<u64>,
    last_report_at: Option<u64>,
    pending_action: Option<Action>,
}

fn home_constituent(report: &Ds4Report) -> bool {
    [
        Ds4Button::Ps,
        Ds4Button::Options,
        Ds4Button::Share,
        Ds4Button::L3,
        Ds4Button::R3,
        Ds4Button::L1,
        Ds4Button::R1,
    ]
    .into_iter()
    .any(|button| report.buttons.is_pressed(button))
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
        pointer: bool,
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
        if home_constituent(report) {
            self.primed = false;
            self.pending_action = None;
            self.last_buttons = report.buttons.bits();
            return Vec::new();
        }
        if !self.primed {
            self.primed = neutral(report);
            self.last_buttons = report.buttons.bits();
            return Vec::new();
        }
        let previous = self.last_buttons;
        self.last_buttons = report.buttons.bits();
        let rising = |button: Ds4Button| {
            report.buttons.is_pressed(button) && previous & (1 << button as u16) == 0
        };
        let pressed_action = if rising(Ds4Button::Triangle) {
            Some(Action::TogglePointer)
        } else if rising(Ds4Button::Cross) {
            Some(if pointer {
                Action::Click
            } else {
                Action::Select
            })
        } else if rising(Ds4Button::Circle) {
            Some(Action::Back)
        } else if rising(Ds4Button::Square) {
            Some(Action::NextFocus)
        } else if rising(Ds4Button::Touchpad) {
            Some(Action::PreviousFocus)
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
        let direction = if report.dpad.up {
            Some(Action::Up)
        } else if report.dpad.down {
            Some(Action::Down)
        } else if report.dpad.left {
            Some(Action::Left)
        } else if report.dpad.right {
            Some(Action::Right)
        } else {
            None
        };
        if let Some(direction) = direction {
            if self.last_direction != Some(direction)
                || self
                    .last_direction_at
                    .map_or(true, |last| at_ms.saturating_sub(last) >= REPEAT_MS)
            {
                actions.push(direction);
                self.last_direction_at = Some(at_ms);
            }
        }
        self.last_direction = direction;
        if pointer {
            let axis = |value: f32| {
                if value.is_finite() && value.abs() >= 0.25 {
                    (value.clamp(-1.0, 1.0) * 20.0) as i32
                } else {
                    0
                }
            };
            let (x, y) = (axis(report.right_x), axis(report.right_y));
            if x != 0 || y != 0 {
                actions.push(Action::Move(x, y));
            }
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

impl StreamingControl {
    fn status(&self) -> StreamingControlStatus {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        StreamingControlStatus {
            windows: cfg!(target_os = "windows"),
            enabled: self.enabled.load(Ordering::Acquire),
            pointer_mode: state.pointer_mode,
            active_service: state.active_service.clone(),
            last_result: state.last_result.clone(),
            accepted_actions: state.accepted,
            rejected_actions: state.rejected,
            dropped_reports: self.dropped.load(Ordering::Relaxed),
        }
    }
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

#[tauri::command]
pub fn configure_streaming_control(
    app: AppHandle,
    enabled: bool,
    pointer_mode: bool,
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
    stop_internal(&app);
    {
        let mut state = control
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.pointer_mode = pointer_mode;
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
        let (sender, receiver) = mpsc::sync_channel::<Packet>(8);
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
                while !thread_stop.load(Ordering::Acquire) {
                    let packet = match receiver.recv_timeout(Duration::from_millis(50)) {
                        Ok(packet) => packet,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    if thread_stop.load(Ordering::Acquire) {
                        break;
                    }
                    if packet.queued_at.elapsed() > Duration::from_millis(STALE_PACKET_MS) {
                        continue;
                    }
                    dispatch_packet(&worker_app, packet);
                }
            })
            .is_err()
        {
            stop_internal(&app);
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
}

/// Called by PadHub. No OS calls, waiting, unbounded queue or raw bytes.
pub(crate) fn route_controller_report(
    app: &AppHandle,
    device: &str,
    report: &Ds4Report,
    at_ms: u64,
) {
    let control = app.state::<StreamingControl>();
    if !control.enabled.load(Ordering::Acquire) {
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
            if queue
                .sender
                .try_send(Packet {
                    epoch: queue.epoch,
                    controller_epoch: control.controller_epoch.load(Ordering::Acquire),
                    device: device.to_string(),
                    report: *report,
                    at_ms,
                    queued_at: Instant::now(),
                })
                .is_err()
            {
                control.dropped.fetch_add(1, Ordering::Relaxed);
                // A lost release invalidates the whole controller generation.
                // Never continue a held action from an incomplete report stream.
                control.controller_epoch.fetch_add(1, Ordering::AcqRel);
                control.reset_pending.store(true, Ordering::Release);
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
        control.reset_pending.store(true, Ordering::Release);
    };
}

fn dispatch_packet(app: &AppHandle, packet: Packet) {
    let control = app.state::<StreamingControl>();
    if !generation_active(&control, packet.epoch, packet.controller_epoch) {
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
    if !generation_active(&control, packet.epoch, packet.controller_epoch) {
        return;
    }
    if control.reset_pending.swap(false, Ordering::AcqRel) {
        state.engine = InteractionEngine::default();
    }
    let Some(target) = target else {
        crate::pointer_indicator::update(0, false);
        state.active_service = None;
        state.engine = InteractionEngine::default();
        return;
    };
    state.active_service = Some(target.service_id.to_string());
    let pointer = state.pointer_mode;
    let actions = state.engine.update(
        &packet.device,
        &packet.report,
        target.hwnd,
        pointer,
        packet.at_ms,
    );
    for action in actions {
        if !generation_active(&control, packet.epoch, packet.controller_epoch) {
            break;
        }
        if action == Action::TogglePointer {
            state.pointer_mode = !state.pointer_mode;
            state.engine.primed = false;
            state.last_result = Some(
                if state.pointer_mode {
                    "Tryb wskaźnika: prawy analog, X wybiera; trójkąt wyłącza."
                } else {
                    "Tryb klawiatury: D-pad, X wybiera; trójkąt włącza wskaźnik."
                }
                .into(),
            );
            break;
        }
        match send_owned_action(app, &target, action, packet.epoch, packet.controller_epoch) {
            Ok(()) => {
                state.accepted = state.accepted.saturating_add(1);
                state.last_result =
                    Some("Windows przyjął sterowanie; zachowanie strony wymaga walidacji.".into());
            }
            Err(error) => {
                state.rejected = state.rejected.saturating_add(1);
                state.last_result = Some(error);
                state.engine.primed = false;
                break;
            }
        }
    }
    crate::pointer_indicator::update(target.hwnd, state.pointer_mode);
}

fn send_owned_action(
    app: &AppHandle,
    target: &crate::edge_cinema::StreamingWindowTarget,
    action: Action,
    epoch: u64,
    controller_epoch: u64,
) -> Result<(), String> {
    let control = app.state::<StreamingControl>();
    if !generation_active(&control, epoch, controller_epoch) {
        return Err("Sterowanie zostało anulowane.".into());
    }
    let home = crate::pad_hub::get_native_controller_status(app.state::<crate::pad_hub::PadHub>());
    if !home.running || !home.home_enabled {
        return Err("Sterowanie wstrzymane: natywny Home jest niedostępny.".into());
    }
    if !crate::edge_cinema::streaming_target_is_current(app, target) {
        return Err("Wstrzymano sterowanie: zmienił się fokus lub właściciel sesji.".into());
    }
    #[cfg(target_os = "windows")]
    {
        native::send(target, action, &control, epoch, controller_epoch)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = action;
        Err("Sterowanie wymaga Windows.".into())
    }
}

fn generation_active(control: &StreamingControl, epoch: u64, controller_epoch: u64) -> bool {
    control.enabled.load(Ordering::Acquire)
        && control.epoch.load(Ordering::Acquire) == epoch
        && control.controller_epoch.load(Ordering::Acquire) == controller_epoch
}

/// Raw Input removal/arrival uses this bounded hook, never waits on the input
/// worker. Old queued packets are invalid immediately; same-path reconnects
/// must observe neutral before another controller action is permitted.
pub(crate) fn invalidate_controller_streaming(app: &AppHandle) {
    let control = app.state::<StreamingControl>();
    control.controller_epoch.fetch_add(1, Ordering::AcqRel);
    control.reset_pending.store(true, Ordering::Release);
}

/// Called only after RemoteAccess has authenticated/authorized its command.
/// Returns false when VELORA should handle normal local navigation itself.
/// No script, remote-provided HWND, arbitrary key, process, or pointer is accepted.
pub(crate) fn route_remote_navigation(app: &AppHandle, command: &str) -> Result<bool, String> {
    let action = match command {
        "up" => Action::Up,
        "down" => Action::Down,
        "left" => Action::Left,
        "right" => Action::Right,
        "select" => Action::Select,
        "back" => Action::Back,
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
    if !generation_active(&control, epoch, controller_epoch) {
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
    match send_owned_action(app, &target, action, epoch, controller_epoch) {
        Ok(()) => {
            state.accepted = state.accepted.saturating_add(1);
            state.last_result = Some("Windows przyjął polecenie sparowanego pilota.".into());
            Ok(true)
        }
        Err(error) => {
            state.rejected = state.rejected.saturating_add(1);
            state.last_result = Some(error.clone());
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
mod native {
    use super::{generation_active, Action, StreamingControl};
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
        Ok((cursor, first, last))
    }
    pub(super) fn send(
        target: &StreamingWindowTarget,
        action: Action,
        control: &StreamingControl,
        epoch: u64,
        controller_epoch: u64,
    ) -> Result<(), String> {
        // Do not combine generated taps with an actual keyboard shortcut/drag.
        if [0x10, 0x11, 0x12, 0x5b, 0x5c, 0x01, 0x02]
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(*key) } < 0)
        {
            return Err(
                "Sterowanie wstrzymane podczas klawisza modyfikującego lub przeciągania.".into(),
            );
        }
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
                let (cursor, first, last) = pointer_inside(target)?;
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
                    vec![mouse(2, 0, 0, 0), mouse(4, 0, 0, 0)]
                } else if let Action::Scroll(amount) = action {
                    vec![mouse(0x800, 0, 0, amount as u32)]
                } else {
                    unreachable!()
                }
            }
            Action::Move(dx, dy) => {
                let (cursor, first, last) = pointer_inside(target)?;
                let x = cursor.x.saturating_add(dx).clamp(first.x, last.x);
                let y = cursor.y.saturating_add(dy).clamp(first.y, last.y);
                let (left, top, width, height) = unsafe {
                    (
                        GetSystemMetrics(76),
                        GetSystemMetrics(77),
                        GetSystemMetrics(78),
                        GetSystemMetrics(79),
                    )
                };
                if width <= 1 || height <= 1 {
                    return Err("Brak geometrii pulpitu.".into());
                }
                let normalized_x = ((i64::from(x) - i64::from(left)) * 65535 / i64::from(width - 1))
                    .clamp(0, 65535) as i32;
                let normalized_y = ((i64::from(y) - i64::from(top)) * 65535 / i64::from(height - 1))
                    .clamp(0, 65535) as i32;
                vec![mouse(0xc001, normalized_x, normalized_y, 0)]
            }
            Action::TogglePointer => return Ok(()),
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
        if !generation_active(control, epoch, controller_epoch) {
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
            return Ok(());
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
    #[test]
    fn held_cross_never_crosses_focus_or_reconnect() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        input.buttons.set(Ds4Button::Cross, true);
        assert!(engine.update("pad", &input, 1, false, 0).is_empty());
        input.buttons.set(Ds4Button::Cross, false);
        engine.update("pad", &input, 1, false, 10);
        input.buttons.set(Ds4Button::Cross, true);
        assert_eq!(
            engine.update("pad", &input, 1, false, 50),
            vec![Action::Select]
        );
        assert!(engine.update("pad", &input, 2, false, 100).is_empty());
        assert!(engine.update("pad", &input, 2, false, 500).is_empty());
    }
    #[test]
    fn home_constituents_suppress_controls_until_neutral() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, false, 0);
        input.buttons.set(Ds4Button::Options, true);
        input.buttons.set(Ds4Button::Cross, true);
        assert!(engine.update("pad", &input, 1, false, 50).is_empty());
        input.buttons.set(Ds4Button::Options, false);
        assert!(engine.update("pad", &input, 1, false, 100).is_empty());
        input.buttons.set(Ds4Button::Cross, false);
        engine.update("pad", &input, 1, false, 150);
        input.buttons.set(Ds4Button::Cross, true);
        assert_eq!(
            engine.update("pad", &input, 1, false, 200),
            vec![Action::Select]
        );
    }
    #[test]
    fn pointer_is_opt_in_and_deadzone_rejects_noise() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, false, 0);
        input.right_x = 0.2;
        assert!(engine.update("pad", &input, 1, true, 50).is_empty());
        input.right_x = 1.0;
        assert!(engine.update("pad", &input, 1, false, 100).is_empty());
        assert_eq!(
            engine.update("pad", &input, 1, true, 150),
            vec![Action::Move(20, 0)]
        );
        assert!(engine.update("pad", &input, 1, true, 160).is_empty());
    }
    #[test]
    fn repeat_is_bounded_and_does_not_hold_os_keys() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, false, 0);
        input.dpad.down = true;
        assert_eq!(
            engine.update("pad", &input, 1, false, 50),
            vec![Action::Down]
        );
        assert!(engine.update("pad", &input, 1, false, 100).is_empty());
        assert_eq!(
            engine.update("pad", &input, 1, false, 210),
            vec![Action::Down]
        );
    }
    #[test]
    fn alternate_device_cannot_inherit_armed_input() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad-a", &input, 1, false, 0);
        input.buttons.set(Ds4Button::Circle, true);
        assert!(engine.update("pad-b", &input, 1, false, 50).is_empty());
    }

    #[test]
    fn a_short_tap_after_navigation_survives_frame_pacing_and_release() {
        let mut engine = InteractionEngine::default();
        let mut input = report();
        engine.update("pad", &input, 1, false, 0);
        input.dpad.down = true;
        assert_eq!(
            engine.update("pad", &input, 1, false, 50),
            vec![Action::Down]
        );
        input.dpad.down = false;
        input.buttons.set(Ds4Button::Cross, true);
        assert!(engine.update("pad", &input, 1, false, 60).is_empty());
        input.buttons.set(Ds4Button::Cross, false);
        assert_eq!(
            engine.update("pad", &input, 1, false, 90),
            vec![Action::Select]
        );
        assert!(engine.update("pad", &input, 1, false, 130).is_empty());
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
}
