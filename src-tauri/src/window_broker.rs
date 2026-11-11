use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const FOREGROUND_CHANGED_EVENT: &str = "velora-foreground-changed";
pub(crate) const TRACKING_ERROR_EVENT: &str = "velora-window-tracking-error";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundWindow {
    pub hwnd: Option<u64>,
    pub process_id: Option<u32>,
    pub process_name: Option<String>,
    pub class_name: Option<String>,
    pub window_present: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedWindow {
    pub hwnd: u64,
    pub process_id: u32,
    pub process_name: Option<String>,
    pub class_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBrokerSnapshot {
    pub windows: bool,
    pub own_window: Option<u64>,
    pub own_window_valid: bool,
    pub foreground: ForegroundWindow,
    pub tracked_processes: Vec<u32>,
    pub tracked_windows: Vec<TrackedWindow>,
    pub last_error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreReason {
    /// A direct user gesture (PS + Options, Ctrl+Alt+N, Home button).
    UserRequest,
    /// An automatic restore after a managed launch session ended.
    SessionEnded,
    /// An explicit diagnostic/command request without a user gesture.
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreOutcome {
    Restored,
    AlreadyFocused,
    BlockedUnsafeForeground,
    BlockedByWindows,
    WindowUnavailable,
    UnsupportedPlatform,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub attempted: bool,
    pub restored: bool,
    pub outcome: RestoreOutcome,
    pub reason: RestoreReason,
    pub own_window: Option<u64>,
    pub foreground_before: ForegroundWindow,
    pub foreground_after: ForegroundWindow,
    pub error_code: Option<u32>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RestoreDecision {
    Allow,
    AlreadyFocused,
    Blocked(RestoreOutcome),
}

fn shell_desktop_class(class_name: Option<&str>) -> bool {
    class_name.is_some_and(|class| {
        matches!(class, "Progman" | "WorkerW" | "SHELLDLL_DefView")
    })
}

fn is_velora_process(process: &str) -> bool {
    matches!(
        process.trim().to_ascii_lowercase().as_str(),
        "nexus-aurea.exe" | "velora.exe"
    )
}

fn is_playnite_process(process: &str) -> bool {
    matches!(
        process.trim().to_ascii_lowercase().as_str(),
        "playnite.fullscreenapp.exe" | "playnite.desktopapp.exe"
    )
}

/// Automatic focus recovery is deliberately conservative: VELORA may return
/// only when the user is on the Windows desktop, still in Playnite, still in
/// VELORA, or when no foreground window exists. Any other foreground app wins.
/// A direct user gesture authorises a best-effort foreground request, but it is
/// still verified and never retried in a loop.
pub(crate) fn evaluate_restore(
    reason: RestoreReason,
    own_window: Option<u64>,
    own_window_valid: bool,
    own_process_id: u32,
    foreground: &ForegroundWindow,
) -> RestoreDecision {
    let Some(own_window) = own_window.filter(|_| own_window_valid) else {
        return RestoreDecision::Blocked(RestoreOutcome::WindowUnavailable);
    };
    if foreground.hwnd == Some(own_window) {
        return RestoreDecision::AlreadyFocused;
    }
    if reason == RestoreReason::UserRequest {
        return RestoreDecision::Allow;
    }
    if foreground.process_id == Some(own_process_id) {
        return RestoreDecision::Allow;
    }
    if foreground.window_present && foreground.process_name.is_none() {
        // An active window whose process cannot be identified still owns focus.
        return RestoreDecision::Blocked(RestoreOutcome::BlockedUnsafeForeground);
    }
    let Some(process_name) = foreground.process_name.as_deref() else {
        return RestoreDecision::Allow;
    };
    if is_playnite_process(process_name) || is_velora_process(process_name) {
        return RestoreDecision::Allow;
    }
    if process_name.trim().eq_ignore_ascii_case("explorer.exe")
        && shell_desktop_class(foreground.class_name.as_deref())
    {
        return RestoreDecision::Allow;
    }
    RestoreDecision::Blocked(RestoreOutcome::BlockedUnsafeForeground)
}

fn blocked_result(
    reason: RestoreReason,
    own_window: Option<u64>,
    foreground_before: ForegroundWindow,
    outcome: RestoreOutcome,
    message: impl Into<String>,
) -> RestoreResult {
    RestoreResult {
        attempted: false,
        restored: false,
        outcome,
        reason,
        own_window,
        foreground_after: foreground_before.clone(),
        foreground_before,
        error_code: None,
        message: message.into(),
    }
}

fn windows_denied_result(
    reason: RestoreReason,
    own_window: Option<u64>,
    foreground_before: ForegroundWindow,
    foreground_after: ForegroundWindow,
    error_code: Option<u32>,
) -> RestoreResult {
    RestoreResult {
        attempted: true,
        restored: false,
        outcome: RestoreOutcome::BlockedByWindows,
        reason,
        own_window,
        foreground_before,
        foreground_after,
        message: match error_code {
            Some(code) => format!("Windows odrzucił aktywację VELORA (kod {code}). Użyj Alt+Tab."),
            None => "Windows nie przekazał fokusu VELORA. Użyj Alt+Tab.".into(),
        },
        error_code,
    }
}

#[cfg(target_os = "windows")]
fn window_is_valid(window: u64) -> bool {
    native::is_window_valid(window)
}

#[cfg(not(target_os = "windows"))]
fn window_is_valid(_window: u64) -> bool {
    false
}

#[derive(Default)]
struct BrokerState {
    own_window: Option<u64>,
    tracked_processes: HashSet<u32>,
    tracked_windows: HashMap<u64, TrackedWindow>,
    foreground: ForegroundWindow,
    last_error: Option<String>,
}

impl BrokerState {
    fn snapshot(&self, windows: bool) -> WindowBrokerSnapshot {
        let mut tracked_processes = self.tracked_processes.iter().copied().collect::<Vec<_>>();
        tracked_processes.sort_unstable();
        let mut tracked_windows = self.tracked_windows.values().cloned().collect::<Vec<_>>();
        tracked_windows.sort_by_key(|window| window.hwnd);
        WindowBrokerSnapshot {
            windows,
            own_window: self.own_window,
            own_window_valid: self.own_window.is_some_and(window_is_valid),
            foreground: self.foreground.clone(),
            tracked_processes,
            tracked_windows,
            last_error: self.last_error.clone(),
        }
    }
}

pub struct WindowBroker {
    state: Mutex<BrokerState>,
}

impl Default for WindowBroker {
    fn default() -> Self {
        Self {
            state: Mutex::new(BrokerState::default()),
        }
    }
}

impl WindowBroker {
    pub(crate) fn attach_main_window(&self, window: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.own_window = Some(window);
        state.tracked_processes.insert(std::process::id());
    }

    pub(crate) fn track_process(&self, process_id: u32) {
        if process_id == 0 {
            return;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.tracked_processes.insert(process_id);
    }

    pub(crate) fn release_process(&self, process_id: u32) {
        if process_id == 0 || process_id == std::process::id() {
            return;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.tracked_processes.remove(&process_id);
        state
            .tracked_windows
            .retain(|_, window| window.process_id != process_id);
    }

    fn refresh(&self) -> WindowBrokerSnapshot {
        #[cfg(target_os = "windows")]
        {
            let (tracked_processes, own_window) = {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                (
                    state.tracked_processes.iter().copied().collect::<HashSet<_>>(),
                    state.own_window,
                )
            };
            let native = native::snapshot(&tracked_processes, own_window);
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match native {
                Ok(snapshot) => {
                    state.foreground = snapshot.foreground;
                    state.tracked_windows = snapshot
                        .windows
                        .into_iter()
                        .map(|window| (window.hwnd, window))
                        .collect();
                    state.last_error = None;
                }
                Err(error) => {
                    state.last_error = Some(error);
                }
            }
            state.snapshot(true)
        }
        #[cfg(not(target_os = "windows"))]
        {
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .snapshot(false)
        }
    }

    pub(crate) fn foreground(&self) -> ForegroundWindow {
        self.refresh().foreground
    }

    pub(crate) fn windows_for_processes(&self, process_ids: &HashSet<u32>) -> Vec<TrackedWindow> {
        #[cfg(target_os = "windows")]
        {
            let own_window = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .own_window;
            native::snapshot(process_ids, own_window)
                .map(|snapshot| snapshot.windows)
                .unwrap_or_default()
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = process_ids;
            Vec::new()
        }
    }

    fn restore(&self, reason: RestoreReason) -> RestoreResult {
        #[cfg(not(target_os = "windows"))]
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            return blocked_result(
                reason,
                state.own_window,
                state.foreground.clone(),
                RestoreOutcome::UnsupportedPlatform,
                "Przywracanie okna jest dostępne tylko w natywnej aplikacji Windows.",
            );
        }

        #[cfg(target_os = "windows")]
        {
            let (own_window, own_process_id) = {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                (state.own_window, std::process::id())
            };
            let Some(own_window) = own_window else {
                return blocked_result(
                    reason,
                    None,
                    native::foreground().unwrap_or_default(),
                    RestoreOutcome::WindowUnavailable,
                    "VELORA nie ma jeszcze uchwytu okna głównego.",
                );
            };
            if !native::is_window_valid(own_window) {
                return blocked_result(
                    reason,
                    Some(own_window),
                    native::foreground().unwrap_or_default(),
                    RestoreOutcome::WindowUnavailable,
                    "Uchwyt okna VELORA wygasł. Uruchom ponownie aplikację.",
                );
            }
            if native::window_process_id(own_window) != Some(std::process::id()) {
                return blocked_result(
                    reason,
                    Some(own_window),
                    native::foreground().unwrap_or_default(),
                    RestoreOutcome::WindowUnavailable,
                    "Uchwyt okna należy do innego procesu. Uruchom ponownie VELORA.",
                );
            }

            // Re-check the policy immediately before the Win32 call. This does
            // not make foreground arbitration atomic, so the outcome is always
            // verified afterwards and reported truthfully.
            let foreground_before = native::foreground().unwrap_or_default();
            match evaluate_restore(
                reason,
                Some(own_window),
                true,
                own_process_id,
                &foreground_before,
            ) {
                RestoreDecision::AlreadyFocused => {
                    return RestoreResult {
                        attempted: false,
                        restored: true,
                        outcome: RestoreOutcome::AlreadyFocused,
                        reason,
                        own_window: Some(own_window),
                        foreground_before: foreground_before.clone(),
                        foreground_after: foreground_before,
                        error_code: None,
                        message: "VELORA ma już fokus.".into(),
                    };
                }
                RestoreDecision::Blocked(outcome) => {
                    return blocked_result(
                        reason,
                        Some(own_window),
                        foreground_before,
                        outcome,
                        "Aktywne okno innej aplikacji zachowało fokus. VELORA nie przejęła go automatycznie.",
                    );
                }
                RestoreDecision::Allow => {}
            }

            native::request_foreground(own_window, reason)
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForegroundChangedEvent {
    foreground: ForegroundWindow,
    at_ms: u64,
}

pub(crate) fn attach_main_window(app: &AppHandle, window: u64) {
    app.state::<WindowBroker>().attach_main_window(window);
}

pub(crate) fn track_process(app: &AppHandle, process_id: u32) {
    app.state::<WindowBroker>().track_process(process_id);
}

pub(crate) fn release_process(app: &AppHandle, process_id: u32) {
    app.state::<WindowBroker>().release_process(process_id);
}

pub(crate) fn windows_for_processes(
    app: &AppHandle,
    process_ids: &HashSet<u32>,
) -> Vec<TrackedWindow> {
    app.state::<WindowBroker>().windows_for_processes(process_ids)
}

pub(crate) fn foreground(app: &AppHandle) -> ForegroundWindow {
    app.state::<WindowBroker>().foreground()
}

pub(crate) fn restore_velora(app: &AppHandle, reason: RestoreReason) -> RestoreResult {
    app.state::<WindowBroker>().restore(reason)
}

pub(crate) fn start_foreground_monitor(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        std::thread::Builder::new()
            .name("velora-window-broker".into())
            .spawn(move || {
                let mut previous: Option<u64> = None;
                let mut reported_error: Option<String> = None;
                loop {
                    let broker = app.state::<WindowBroker>();
                    let snapshot = broker.refresh();
                    let current = snapshot.foreground.hwnd;
                    if current != previous {
                        previous = current;
                        let _ = app.emit(
                            FOREGROUND_CHANGED_EVENT,
                            ForegroundChangedEvent {
                                foreground: snapshot.foreground,
                                at_ms: now_ms(),
                            },
                        );
                    }
                    match snapshot.last_error {
                        Some(error) if reported_error.as_deref() != Some(error.as_str()) => {
                            reported_error = Some(error.clone());
                            let _ = app.emit(TRACKING_ERROR_EVENT, error);
                        }
                        None => reported_error = None,
                        _ => {}
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            })
            .ok();
    }
}

#[tauri::command]
pub async fn get_window_broker_status(app: AppHandle) -> WindowBrokerSnapshot {
    tauri::async_runtime::spawn_blocking(move || app.state::<WindowBroker>().refresh())
        .await
        .unwrap_or_else(|_| WindowBrokerSnapshot {
            windows: cfg!(target_os = "windows"),
            own_window: None,
            own_window_valid: false,
            foreground: ForegroundWindow::default(),
            tracked_processes: Vec::new(),
            tracked_windows: Vec::new(),
            last_error: Some("Odczyt stanu okien został przerwany.".into()),
        })
}

#[tauri::command]
pub async fn restore_velora_window(app: AppHandle) -> RestoreResult {
    tauri::async_runtime::spawn_blocking(move || {
        let result = restore_velora(&app, RestoreReason::Manual);
        let _ = app.emit("velora-restore-result", result.clone());
        result
    })
    .await
    .unwrap_or_else(|_| RestoreResult {
        attempted: false,
        restored: false,
        outcome: RestoreOutcome::BlockedByWindows,
        reason: RestoreReason::Manual,
        own_window: None,
        foreground_before: ForegroundWindow::default(),
        foreground_after: ForegroundWindow::default(),
        error_code: None,
        message: "Operacja przywracania okna została przerwana.".into(),
    })
}

#[cfg(target_os = "windows")]
mod native {
    use super::{
        windows_denied_result, ForegroundWindow, RestoreReason, RestoreResult, TrackedWindow,
    };
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::path::Path;

    type Handle = *mut c_void;
    type Hwnd = *mut c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    const SW_RESTORE: i32 = 9;
    const FLASHW_TRAY: u32 = 2;
    const FLASHW_TIMERNOFG: u32 = 12;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct FlashInfo {
        size: u32,
        window: Hwnd,
        flags: u32,
        count: u32,
        timeout: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(
            callback: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>,
            parameter: isize,
        ) -> i32;
        fn IsWindow(window: Hwnd) -> i32;
        fn IsWindowVisible(window: Hwnd) -> i32;
        fn IsIconic(window: Hwnd) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
        fn GetClassNameW(window: Hwnd, class_name: *mut u16, max_count: i32) -> i32;
        fn GetWindowLongW(window: Hwnd, index: i32) -> i32;
        fn GetWindowRect(window: Hwnd, rect: *mut Rect) -> i32;
        fn ShowWindowAsync(window: Hwnd, command: i32) -> i32;
        fn SetForegroundWindow(window: Hwnd) -> i32;
        fn FlashWindowEx(info: *mut FlashInfo) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
        fn SetLastError(error: u32);
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: u32,
            image_name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }

    pub(super) struct NativeSnapshot {
        pub foreground: ForegroundWindow,
        pub windows: Vec<TrackedWindow>,
    }

    struct EnumContext {
        process_ids: HashSet<u32>,
        process_names: HashMap<u32, Option<String>>,
        windows: Vec<TrackedWindow>,
    }

    fn window_id(window: Hwnd) -> u64 {
        window as usize as u64
    }

    fn hwnd(window: u64) -> Hwnd {
        window as usize as Hwnd
    }

    fn process_name(process_id: u32) -> Option<String> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            return None;
        }
        let mut path = vec![0u16; 32_768];
        let mut length = path.len() as u32;
        let succeeded = unsafe {
            QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) != 0
        };
        unsafe { CloseHandle(process) };
        if !succeeded {
            return None;
        }
        let path = String::from_utf16_lossy(&path[..length as usize]);
        Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }

    fn class_name(window: Hwnd) -> Option<String> {
        let mut value = [0u16; 256];
        let length = unsafe { GetClassNameW(window, value.as_mut_ptr(), value.len() as i32) };
        (length > 0).then(|| String::from_utf16_lossy(&value[..length as usize]))
    }

    unsafe extern "system" fn enum_window(window: Hwnd, parameter: isize) -> i32 {
        if unsafe { IsWindowVisible(window) } == 0 {
            return 1;
        }
        if unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as isize & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let mut process_id = 0u32;
        if unsafe { GetWindowThreadProcessId(window, &mut process_id) } == 0 || process_id == 0 {
            return 1;
        }
        let context = unsafe { &mut *(parameter as *mut EnumContext) };
        if !context.process_ids.contains(&process_id) {
            return 1;
        }
        let mut rect = Rect::default();
        if unsafe { GetWindowRect(window, &mut rect) } == 0
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return 1;
        }
        let name = context
            .process_names
            .entry(process_id)
            .or_insert_with(|| process_name(process_id))
            .clone();
        context.windows.push(TrackedWindow {
            hwnd: window_id(window),
            process_id,
            process_name: name,
            class_name: class_name(window),
        });
        1
    }

    pub(super) fn snapshot(
        process_ids: &HashSet<u32>,
        _own_window: Option<u64>,
    ) -> Result<NativeSnapshot, String> {
        let foreground = foreground()?;
        let mut context = EnumContext {
            process_ids: process_ids.clone(),
            process_names: HashMap::new(),
            windows: Vec::new(),
        };
        unsafe { SetLastError(0) };
        let succeeded = unsafe {
            EnumWindows(
                Some(enum_window),
                (&mut context as *mut EnumContext) as isize,
            )
        };
        if succeeded == 0 {
            // EnumWindows returns zero when the callback stops early as well;
            // only treat it as an error when Windows reports one explicitly.
            let code = unsafe { GetLastError() };
            if code != 0 {
                return Err(format!("Windows nie zwrócił listy okien (kod {code})."));
            }
        }
        Ok(NativeSnapshot {
            foreground,
            windows: context.windows,
        })
    }

    pub(super) fn foreground() -> Result<ForegroundWindow, String> {
        let window = unsafe { GetForegroundWindow() };
        if window.is_null() {
            return Ok(ForegroundWindow::default());
        }
        let mut process_id = 0u32;
        let thread_id = unsafe { GetWindowThreadProcessId(window, &mut process_id) };
        if thread_id == 0 || process_id == 0 {
            return Ok(ForegroundWindow {
                hwnd: Some(window_id(window)),
                window_present: true,
                ..ForegroundWindow::default()
            });
        }
        Ok(ForegroundWindow {
            hwnd: Some(window_id(window)),
            process_id: Some(process_id),
            process_name: process_name(process_id),
            class_name: class_name(window),
            window_present: true,
        })
    }

    pub(super) fn is_window_valid(window: u64) -> bool {
        !window.eq(&0) && unsafe { IsWindow(hwnd(window)) } != 0
    }

    pub(super) fn window_process_id(window: u64) -> Option<u32> {
        if window == 0 {
            return None;
        }
        let mut process_id = 0u32;
        if unsafe { GetWindowThreadProcessId(hwnd(window), &mut process_id) } == 0
            || process_id == 0
        {
            return None;
        }
        Some(process_id)
    }

    pub(super) fn request_foreground(own_window: u64, reason: RestoreReason) -> RestoreResult {
        let foreground_before = foreground().unwrap_or_default();
        let window = hwnd(own_window);
        if unsafe { IsIconic(window) } != 0 {
            unsafe { ShowWindowAsync(window, SW_RESTORE) };
        }
        unsafe { SetLastError(0) };
        unsafe { SetForegroundWindow(window) };
        let request_error = unsafe { GetLastError() };
        let mut foreground_after = foreground().unwrap_or_default();
        for _ in 0..5 {
            if foreground_after.hwnd == Some(own_window) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
            foreground_after = foreground().unwrap_or_default();
        }
        if foreground_after.hwnd == Some(own_window) {
            return RestoreResult {
                attempted: true,
                restored: true,
                outcome: super::RestoreOutcome::Restored,
                reason,
                own_window: Some(own_window),
                foreground_before,
                foreground_after,
                error_code: None,
                message: "VELORA odzyskała fokus.".into(),
            };
        }
        let mut flash = FlashInfo {
            size: std::mem::size_of::<FlashInfo>() as u32,
            window,
            flags: FLASHW_TRAY | FLASHW_TIMERNOFG,
            count: 0,
            timeout: 0,
        };
        unsafe { FlashWindowEx(&mut flash) };
        windows_denied_result(
            reason,
            Some(own_window),
            foreground_before,
            foreground_after,
            Some(request_error).filter(|code| *code != 0),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{
        evaluate_restore, ForegroundWindow, RestoreDecision, RestoreOutcome, RestoreReason,
        RestoreResult, WindowBroker,
    };

    const OWN_PID: u32 = 4242;
    const OWN_HWND: u64 = 100;

    fn foreground(process: Option<&str>, class: Option<&str>, present: bool) -> ForegroundWindow {
        ForegroundWindow {
            hwnd: present.then_some(900),
            process_id: process.map(|_| 900),
            process_name: process.map(str::to_string),
            class_name: class.map(str::to_string),
            window_present: present,
        }
    }

    #[test]
    fn automatic_restore_allows_only_shell_playnite_or_velora() {
        let cases = [
            (Some("explorer.exe"), Some("Progman"), true),
            (Some("explorer.exe"), Some("WorkerW"), true),
            (Some("explorer.exe"), Some("SHELLDLL_DefView"), true),
            (Some("Playnite.FullscreenApp.exe"), None, true),
            (Some("PLAYNITE.DESKTOPAPP.EXE"), None, true),
            (Some("nexus-aurea.exe"), None, true),
            (Some(" VELORA.EXE "), None, true),
        ];
        for (process, class, present) in cases {
            let decision = evaluate_restore(
                RestoreReason::SessionEnded,
                Some(OWN_HWND),
                true,
                OWN_PID,
                &foreground(process, class, present),
            );
            assert_eq!(decision, RestoreDecision::Allow, "{process:?} {class:?}");
        }
    }

    #[test]
    fn automatic_restore_never_takes_focus_from_unrelated_apps() {
        for (process, class) in [
            (Some("chrome.exe"), None),
            (Some("Code.exe"), None),
            (Some("steam.exe"), None),
            (Some("explorer.exe"), Some("CabinetWClass")),
            (Some("explorer.exe"), None),
            (None, None),
        ] {
            let decision = evaluate_restore(
                RestoreReason::SessionEnded,
                Some(OWN_HWND),
                true,
                OWN_PID,
                &foreground(process, class, true),
            );
            assert_eq!(
                decision,
                RestoreDecision::Blocked(RestoreOutcome::BlockedUnsafeForeground),
                "{process:?} {class:?}"
            );
        }
    }

    #[test]
    fn missing_desktop_foreground_is_safe_for_automatic_restore() {
        assert_eq!(
            evaluate_restore(
                RestoreReason::SessionEnded,
                Some(OWN_HWND),
                true,
                OWN_PID,
                &foreground(None, None, false),
            ),
            RestoreDecision::Allow
        );
    }

    #[test]
    fn user_gesture_can_request_focus_from_an_unrelated_app() {
        assert_eq!(
            evaluate_restore(
                RestoreReason::UserRequest,
                Some(OWN_HWND),
                true,
                OWN_PID,
                &foreground(Some("chrome.exe"), None, true),
            ),
            RestoreDecision::Allow
        );
    }

    #[test]
    fn stale_own_hwnd_is_never_used() {
        for reason in [
            RestoreReason::UserRequest,
            RestoreReason::SessionEnded,
            RestoreReason::Manual,
        ] {
            assert_eq!(
                evaluate_restore(
                    reason,
                    Some(OWN_HWND),
                    false,
                    OWN_PID,
                    &foreground(Some("chrome.exe"), None, true),
                ),
                RestoreDecision::Blocked(RestoreOutcome::WindowUnavailable)
            );
        }
    }

    #[test]
    fn already_focused_window_is_not_reassigned() {
        let mut current = foreground(Some("nexus-aurea.exe"), None, true);
        current.hwnd = Some(OWN_HWND);
        assert_eq!(
            evaluate_restore(
                RestoreReason::SessionEnded,
                Some(OWN_HWND),
                true,
                OWN_PID,
                &current,
            ),
            RestoreDecision::AlreadyFocused
        );
    }

    #[test]
    fn a_race_to_an_unrelated_window_is_caught_by_the_second_policy_check() {
        let before = foreground(None, None, false);
        assert_eq!(
            evaluate_restore(
                RestoreReason::SessionEnded,
                Some(OWN_HWND),
                true,
                OWN_PID,
                &before,
            ),
            RestoreDecision::Allow
        );
        let after = foreground(Some("Code.exe"), None, true);
        assert_eq!(
            evaluate_restore(
                RestoreReason::SessionEnded,
                Some(OWN_HWND),
                true,
                OWN_PID,
                &after,
            ),
            RestoreDecision::Blocked(RestoreOutcome::BlockedUnsafeForeground)
        );
    }

    #[test]
    fn broker_starts_without_claiming_a_native_window() {
        let snapshot = WindowBroker::default()
            .state
            .lock()
            .unwrap()
            .snapshot(false);
        assert_eq!(snapshot.own_window, None);
        assert!(!snapshot.own_window_valid);
        assert!(!snapshot.windows);
        assert!(snapshot.tracked_windows.is_empty());
    }

    #[test]
    fn restore_result_serializes_win32_failure_details() {
        let result = RestoreResult {
            attempted: true,
            restored: false,
            outcome: RestoreOutcome::BlockedByWindows,
            reason: RestoreReason::SessionEnded,
            own_window: Some(OWN_HWND),
            foreground_before: foreground(Some("chrome.exe"), None, true),
            foreground_after: foreground(Some("chrome.exe"), None, true),
            error_code: Some(5),
            message: "Windows odrzucił aktywację VELORA (kod 5). Użyj Alt+Tab.".into(),
        };
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["outcome"], "blockedByWindows");
        assert_eq!(value["reason"], "sessionEnded");
        assert_eq!(value["errorCode"], 5);
        assert_eq!(value["foregroundBefore"]["processName"], "chrome.exe");
    }
}
