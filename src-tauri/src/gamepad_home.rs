use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::collections::HashSet;
#[cfg(target_os = "windows")]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "windows")]
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use crate::session_orchestrator::{self, TransitionCause};

pub(crate) const GAMEPAD_HOME_EVENT: &str = "velora-gamepad-home";
pub(crate) const WM_INPUT_MESSAGE: u32 = 0x00ff;
pub(crate) const WM_INPUT_DEVICE_CHANGE_MESSAGE: u32 = 0x00fe;
pub(crate) const CHORD_WINDOW_MS: u64 = 250;
pub(crate) const COMBO_COOLDOWN_MS: u64 = 750;
pub(crate) const DEVICE_STALE_MS: u64 = 5_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DualSenseButtons {
    pub ps: bool,
    pub options: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamepadHomeStatus {
    pub windows: bool,
    pub running: bool,
    pub device_count: usize,
    pub last_combo_at_ms: Option<u64>,
    pub last_error: Option<String>,
    pub fallback: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamepadHomeEvent {
    pub at_ms: u64,
    pub status: GamepadHomeStatus,
    pub restore: Option<crate::session_orchestrator::ReturnHomeResult>,
}

pub(crate) fn is_dualsense_device_path(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    path.contains("vid_054c") && (path.contains("pid_0ce6") || path.contains("pid_0df2"))
}

fn crc32_update(mut crc: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    crc
}

/// Sony Bluetooth input reports are CRC-protected. A corrupted report must not
/// be allowed to synthesise a PS + Options chord.
fn crc32_matches(report: &[u8]) -> bool {
    if report.len() < 5 {
        return false;
    }
    let data_end = report.len() - 4;
    let expected = u32::from_le_bytes([
        report[data_end],
        report[data_end + 1],
        report[data_end + 2],
        report[data_end + 3],
    ]);
    let mut crc = crc32_update(0xffff_ffff, &[0xa1]);
    crc = !crc32_update(crc, &report[..data_end]);
    crc == expected
}

/// Parses only the two button bytes needed for the Home chord. USB reports,
/// Bluetooth full reports (0x31), and the DualSense Bluetooth minimal 0x01
/// report are supported. Unknown report IDs and malformed lengths are ignored.
pub(crate) fn parse_dualsense_report(report: &[u8]) -> Option<DualSenseButtons> {
    let (options_byte, ps_byte) = match (report.first().copied()?, report.len()) {
        (0x01, 64) => (9, 10),
        (0x01, 10) => (6, 7),
        (0x31, 78) => {
            if !crc32_matches(report) {
                return None;
            }
            (10, 11)
        }
        _ => return None,
    };
    Some(DualSenseButtons {
        options: report.get(options_byte).is_some_and(|byte| byte & 0x20 != 0),
        ps: report.get(ps_byte).is_some_and(|byte| byte & 0x01 != 0),
    })
}

#[derive(Clone, Debug, Default)]
struct DeviceChord {
    ps: bool,
    options: bool,
    ps_pressed_at_ms: Option<u64>,
    options_pressed_at_ms: Option<u64>,
    latched: bool,
    last_seen_ms: u64,
}

#[derive(Default)]
pub(crate) struct ComboTracker {
    devices: HashMap<String, DeviceChord>,
    last_trigger_ms: Option<u64>,
}

impl ComboTracker {
    /// Returns true exactly once per PS + Options press. Both buttons must be
    /// pressed within `CHORD_WINDOW_MS`, either may be first, and both must be
    /// released before another chord can trigger.
    pub(crate) fn observe(&mut self, device: &str, buttons: DualSenseButtons, at_ms: u64) -> bool {
        let state = self.devices.entry(device.to_string()).or_default();
        if at_ms.saturating_sub(state.last_seen_ms) > DEVICE_STALE_MS {
            *state = DeviceChord::default();
        }
        state.last_seen_ms = at_ms;

        let ps_rising = buttons.ps && !state.ps;
        let options_rising = buttons.options && !state.options;
        state.ps = buttons.ps;
        state.options = buttons.options;
        if ps_rising {
            state.ps_pressed_at_ms = Some(at_ms);
        } else if !buttons.ps {
            state.ps_pressed_at_ms = None;
        }
        if options_rising {
            state.options_pressed_at_ms = Some(at_ms);
        } else if !buttons.options {
            state.options_pressed_at_ms = None;
        }
        if !buttons.ps && !buttons.options {
            state.latched = false;
        }
        if state.latched || !(ps_rising || options_rising) || !(buttons.ps && buttons.options) {
            return false;
        }
        let (Some(ps_at), Some(options_at)) = (state.ps_pressed_at_ms, state.options_pressed_at_ms)
        else {
            return false;
        };
        if ps_at.abs_diff(options_at) > CHORD_WINDOW_MS {
            return false;
        }
        if self
            .last_trigger_ms
            .is_some_and(|last| at_ms.saturating_sub(last) < COMBO_COOLDOWN_MS)
        {
            state.latched = true;
            return false;
        }
        state.latched = true;
        self.last_trigger_ms = Some(at_ms);
        true
    }

    pub(crate) fn remove_device(&mut self, device: &str) {
        self.devices.remove(device);
    }

    pub(crate) fn prune(&mut self, at_ms: u64) -> usize {
        self.devices.retain(|_, state| {
            at_ms.saturating_sub(state.last_seen_ms) <= DEVICE_STALE_MS
        });
        self.devices.len()
    }

    #[cfg(test)]
    pub(crate) fn device_count(&self) -> usize {
        self.devices.len()
    }
}

#[cfg(target_os = "windows")]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
pub(crate) struct GamepadHomeRuntime {
    window: native::Hwnd,
    tracker: ComboTracker,
    devices: HashSet<usize>,
    device_paths: HashMap<usize, Option<String>>,
    device_seen_ms: HashMap<usize, u64>,
    last_combo_at_ms: Option<u64>,
    last_error: Option<String>,
}

#[cfg(target_os = "windows")]
impl GamepadHomeRuntime {
    pub(crate) fn start() -> Result<Self, String> {
        let window = native::create_message_window()?;
        if let Err(error) = native::register_raw_input(window) {
            native::destroy_message_window(window);
            return Err(error);
        }
        Ok(Self {
            window,
            tracker: ComboTracker::default(),
            devices: HashSet::new(),
            device_paths: HashMap::new(),
            device_seen_ms: HashMap::new(),
            last_combo_at_ms: None,
            last_error: None,
        })
    }

    pub(crate) fn handle_message(
        &mut self,
        app: &AppHandle,
        message: u32,
        w_param: usize,
        l_param: isize,
    ) -> bool {
        if message == native::WM_INPUT {
            let triggered = self.handle_raw_input(app, l_param);
            native::def_window_proc(self.window, message, w_param, l_param);
            return triggered;
        }
        if message == native::WM_INPUT_DEVICE_CHANGE {
            let device = l_param as usize;
            if w_param == native::GIDC_REMOVAL {
                let key = self.device_key(device);
                self.devices.remove(&device);
                self.device_paths.remove(&device);
                self.device_seen_ms.remove(&device);
                if let Some(key) = key {
                    self.tracker.remove_device(&key);
                }
            }
            return false;
        }
        false
    }

    fn handle_raw_input(&mut self, app: &AppHandle, l_param: isize) -> bool {
        let Some(reports) = native::read_raw_input(l_param) else {
            return false;
        };
        let mut triggered = false;
        let at_ms = now_ms();
        for report in reports {
            let Some(device) = report.device else {
                continue;
            };
            let cached = self.device_paths.get(&device).cloned().flatten();
            let path = match cached {
                Some(path) => Some(path),
                None => {
                    // A transient device-info failure must not poison the cache
                    // until physical reconnect.
                    let path = native::device_path(device);
                    self.device_paths.insert(device, path.clone());
                    path
                }
            };
            let Some(path) = path else {
                continue;
            };
            if !is_dualsense_device_path(&path) {
                continue;
            }
            let Some(buttons) = parse_dualsense_report(&report.data) else {
                continue;
            };
            self.devices.insert(device);
            self.device_seen_ms.insert(device, at_ms);
            if self.tracker.observe(&path, buttons, at_ms) {
                self.last_combo_at_ms = Some(at_ms);
                triggered = true;
                let result = session_orchestrator::return_home(app, TransitionCause::GamepadHome);
                self.last_error = result.as_ref().err().map(|error| error.message.clone());
                let event = GamepadHomeEvent {
                    at_ms,
                    status: self.status(true),
                    restore: result.ok(),
                };
                let _ = app.emit(GAMEPAD_HOME_EVENT, event);
            }
        }
        triggered
    }

    fn device_key(&self, device: usize) -> Option<String> {
        self.device_paths.get(&device).cloned().flatten()
    }

    pub(crate) fn status(&self, running: bool) -> GamepadHomeStatus {
        GamepadHomeStatus {
            windows: true,
            running,
            device_count: self.devices.len(),
            last_combo_at_ms: self.last_combo_at_ms,
            last_error: self.last_error.clone(),
            fallback: Some(
                "Gdy DualSense nie jest widoczny lub Windows odmówi fokusu, użyj Ctrl+Alt+N."
                    .into(),
            ),
        }
    }

    pub(crate) fn refresh_devices(&mut self) {
        let at_ms = now_ms();
        self.tracker.prune(at_ms);
        self.devices.retain(|device| {
            self.device_paths.get(device).is_some_and(Option::is_some)
                && self
                    .device_seen_ms
                    .get(device)
                    .is_some_and(|seen| at_ms.saturating_sub(*seen) <= DEVICE_STALE_MS)
        });
    }
}

#[cfg(target_os = "windows")]
impl Drop for GamepadHomeRuntime {
    fn drop(&mut self) {
        native::unregister_raw_input();
        native::destroy_message_window(self.window);
    }
}

#[cfg(target_os = "windows")]
mod native {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr;

    pub(super) type Hwnd = *mut c_void;
    type Handle = *mut c_void;
    type HrawInput = *mut c_void;

    pub(super) const WM_INPUT: u32 = 0x00ff;
    pub(super) const WM_INPUT_DEVICE_CHANGE: u32 = 0x00fe;
    pub(super) const GIDC_REMOVAL: usize = 1;

    const HTYPE_HID: u32 = 2;
    const RID_INPUT: u32 = 0x1000_0003;
    const RIDI_DEVICENAME: u32 = 0x2000_0007;
    const RIDEV_INPUTSINK: u32 = 0x0000_0100;
    const RIDEV_DEVNOTIFY: u32 = 0x0000_2000;
    const RIDEV_REMOVE: u32 = 0x0000_0001;
    const HWND_MESSAGE: isize = -3;
    const ERROR_CLASS_ALREADY_EXISTS: u32 = 1410;

    #[repr(C)]
    struct WndClassEx {
        size: u32,
        style: u32,
        wnd_proc: Option<unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize>,
        class_extra: i32,
        window_extra: i32,
        instance: Handle,
        icon: Handle,
        cursor: Handle,
        background: Handle,
        menu_name: *const u16,
        class_name: *const u16,
        small_icon: Handle,
    }

    #[repr(C)]
    struct RawInputDevice {
        usage_page: u16,
        usage: u16,
        flags: u32,
        target: Hwnd,
    }

    #[repr(C)]
    struct RawInputHeader {
        input_type: u32,
        size: u32,
        device: Handle,
        w_param: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RawInputHidHeader {
        size_hid: u32,
        count: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassExW(class: *const WndClassEx) -> u16;
        fn UnregisterClassW(name: *const u16, instance: Handle) -> i32;
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: Handle,
            instance: Handle,
            parameter: *mut c_void,
        ) -> Hwnd;
        fn DestroyWindow(window: Hwnd) -> i32;
        fn DefWindowProcW(window: Hwnd, message: u32, w_param: usize, l_param: isize) -> isize;
        fn GetRawInputData(
            input: HrawInput,
            command: u32,
            data: *mut c_void,
            size: *mut u32,
            header_size: u32,
        ) -> u32;
        fn GetRawInputDeviceInfoW(
            device: Handle,
            command: u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> u32;
        fn RegisterRawInputDevices(
            devices: *const RawInputDevice,
            count: u32,
            size: u32,
        ) -> i32;
        fn GetLastError() -> u32;
        fn SetLastError(error: u32);
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> Handle;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn class_name() -> Vec<u16> {
        wide("VeloraRawInputSink")
    }

    fn last_error_message(context: &str) -> String {
        let code = unsafe { GetLastError() };
        if code == 0 {
            context.to_string()
        } else {
            format!("{context} (kod Win32 {code}).")
        }
    }

    pub(super) fn create_message_window() -> Result<Hwnd, String> {
        let instance = unsafe { GetModuleHandleW(ptr::null()) };
        if instance.is_null() {
            return Err("Windows nie udostępnił modułu aplikacji.".into());
        }
        let name = class_name();
        let class = WndClassEx {
            size: size_of::<WndClassEx>() as u32,
            style: 0,
            wnd_proc: Some(DefWindowProcW),
            class_extra: 0,
            window_extra: 0,
            instance,
            icon: ptr::null_mut(),
            cursor: ptr::null_mut(),
            background: ptr::null_mut(),
            menu_name: ptr::null(),
            class_name: name.as_ptr(),
            small_icon: ptr::null_mut(),
        };
        unsafe { SetLastError(0) };
        let atom = unsafe { RegisterClassExW(&class) };
        if atom == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_CLASS_ALREADY_EXISTS {
                return Err(format!(
                    "Nie udało się zarejestrować okna odbioru pada (kod Win32 {code})."
                ));
            }
        }
        let window = unsafe {
            CreateWindowExW(
                0,
                name.as_ptr(),
                name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE as Hwnd,
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            )
        };
        if window.is_null() {
            let error = last_error_message("Nie udało się utworzyć okna odbioru pada");
            unsafe { UnregisterClassW(name.as_ptr(), instance) };
            return Err(error);
        }
        Ok(window)
    }

    pub(super) fn destroy_message_window(window: Hwnd) {
        if !window.is_null() {
            unsafe { DestroyWindow(window) };
        }
    }

    pub(super) fn def_window_proc(window: Hwnd, message: u32, w_param: usize, l_param: isize) {
        unsafe { DefWindowProcW(window, message, w_param, l_param) };
    }

    pub(super) fn register_raw_input(window: Hwnd) -> Result<(), String> {
        let devices = [
            RawInputDevice {
                usage_page: 0x01,
                usage: 0x05,
                flags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
                target: window,
            },
            RawInputDevice {
                usage_page: 0x01,
                usage: 0x04,
                flags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
                target: window,
            },
        ];
        let registered = unsafe {
            RegisterRawInputDevices(
                devices.as_ptr(),
                devices.len() as u32,
                size_of::<RawInputDevice>() as u32,
            )
        };
        if registered == 0 {
            return Err(last_error_message(
                "Windows nie udostępnił globalnego odczytu pada",
            ));
        }
        Ok(())
    }

    pub(super) fn unregister_raw_input() {
        let devices = [
            RawInputDevice {
                usage_page: 0x01,
                usage: 0x05,
                flags: RIDEV_REMOVE,
                target: ptr::null_mut(),
            },
            RawInputDevice {
                usage_page: 0x01,
                usage: 0x04,
                flags: RIDEV_REMOVE,
                target: ptr::null_mut(),
            },
        ];
        unsafe {
            RegisterRawInputDevices(
                devices.as_ptr(),
                devices.len() as u32,
                size_of::<RawInputDevice>() as u32,
            );
        }
    }

    pub(super) struct RawReport {
        pub device: Option<usize>,
        pub data: Vec<u8>,
    }

    pub(super) fn read_raw_input(input: isize) -> Option<Vec<RawReport>> {
        let mut size = 0u32;
        let result = unsafe {
            GetRawInputData(
                input as HrawInput,
                RID_INPUT,
                ptr::null_mut(),
                &mut size,
                size_of::<RawInputHeader>() as u32,
            )
        };
        if size == 0 || size > 4 * 1024 * 1024 || result == u32::MAX {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let copied = unsafe {
            GetRawInputData(
                input as HrawInput,
                RID_INPUT,
                buffer.as_mut_ptr().cast(),
                &mut size,
                size_of::<RawInputHeader>() as u32,
            )
        };
        if copied == u32::MAX || copied < size_of::<RawInputHeader>() as u32 {
            return None;
        }
        let header = unsafe { ptr::read_unaligned(buffer.as_ptr().cast::<RawInputHeader>()) };
        if header.input_type != HTYPE_HID {
            return None;
        }
        let hid_offset = size_of::<RawInputHeader>();
        if (copied as usize) < hid_offset + size_of::<RawInputHidHeader>()
            || buffer.len() < hid_offset + size_of::<RawInputHidHeader>()
        {
            return None;
        }
        let hid = unsafe {
            ptr::read_unaligned(buffer.as_ptr().add(hid_offset).cast::<RawInputHidHeader>())
        };
        if hid.size_hid == 0 || hid.count == 0 || hid.count > 256 {
            return None;
        }
        let data_offset = hid_offset + size_of::<RawInputHidHeader>();
        let total = (hid.size_hid as usize).checked_mul(hid.count as usize)?;
        if data_offset.checked_add(total)? > buffer.len() {
            return None;
        }
        let device = if header.device.is_null() {
            None
        } else {
            Some(header.device as usize)
        };
        let mut reports = Vec::with_capacity(hid.count as usize);
        for index in 0..hid.count as usize {
            let start = data_offset + index * hid.size_hid as usize;
            reports.push(RawReport {
                device,
                data: buffer[start..start + hid.size_hid as usize].to_vec(),
            });
        }
        Some(reports)
    }

    pub(super) fn device_path(device: usize) -> Option<String> {
        let mut size = 0u32;
        let first = unsafe {
            GetRawInputDeviceInfoW(
                device as Handle,
                RIDI_DEVICENAME,
                ptr::null_mut(),
                &mut size,
            )
        };
        if first == u32::MAX || size == 0 || size > 4096 {
            return None;
        }
        let mut name = vec![0u16; size as usize];
        let copied = unsafe {
            GetRawInputDeviceInfoW(
                device as Handle,
                RIDI_DEVICENAME,
                name.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if copied == u32::MAX || copied == 0 {
            return None;
        }
        let value = String::from_utf16_lossy(&name[..copied as usize])
            .trim_end_matches('\0')
            .to_string();
        (!value.is_empty()).then_some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_dualsense_device_path, parse_dualsense_report, ComboTracker, DualSenseButtons,
        CHORD_WINDOW_MS, COMBO_COOLDOWN_MS, DEVICE_STALE_MS,
    };

    const USB_REPORT_LEN: usize = 64;
    const BT_FULL_REPORT_LEN: usize = 78;
    const BT_MINIMAL_REPORT_LEN: usize = 10;

    fn usb_report(ps: bool, options: bool) -> Vec<u8> {
        let mut report = vec![0u8; USB_REPORT_LEN];
        report[0] = 0x01;
        report[9] = if options { 0x20 } else { 0 };
        report[10] = if ps { 0x01 } else { 0 };
        report
    }

    fn bt_full_report(ps: bool, options: bool) -> Vec<u8> {
        let mut report = vec![0u8; BT_FULL_REPORT_LEN];
        report[0] = 0x31;
        report[10] = if options { 0x20 } else { 0 };
        report[11] = if ps { 0x01 } else { 0 };
        let mut crc = super::crc32_update(0xffff_ffff, &[0xa1]);
        crc = !super::crc32_update(crc, &report[..BT_FULL_REPORT_LEN - 4]);
        report[BT_FULL_REPORT_LEN - 4..].copy_from_slice(&crc.to_le_bytes());
        report
    }

    fn bt_minimal_report(ps: bool, options: bool) -> Vec<u8> {
        let mut report = vec![0u8; BT_MINIMAL_REPORT_LEN];
        report[0] = 0x01;
        report[6] = if options { 0x20 } else { 0 };
        report[7] = if ps { 0x01 } else { 0 };
        report
    }

    #[test]
    fn identifies_only_sony_dualsense_and_edge_interfaces() {
        assert!(is_dualsense_device_path(
            r"\\?\HID#VID_054C&PID_0CE6#8&2a4d5e6f&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}"
        ));
        assert!(is_dualsense_device_path(
            r"\\?\hid#vid_054c&pid_0df2#..."
        ));
        assert!(!is_dualsense_device_path(
            r"\\?\HID#VID_054C&PID_05C4#..."
        ));
        assert!(!is_dualsense_device_path(
            r"\\?\HID#VID_045E&PID_0B13#..."
        ));
    }

    #[test]
    fn parses_usb_ps_and_options_bits() {
        assert_eq!(
            parse_dualsense_report(&usb_report(true, true)),
            Some(DualSenseButtons { ps: true, options: true })
        );
        assert_eq!(
            parse_dualsense_report(&usb_report(false, true)),
            Some(DualSenseButtons { ps: false, options: true })
        );
        assert_eq!(
            parse_dualsense_report(&usb_report(true, false)),
            Some(DualSenseButtons { ps: true, options: false })
        );
    }

    #[test]
    fn parses_bluetooth_full_report_with_valid_crc() {
        assert_eq!(
            parse_dualsense_report(&bt_full_report(true, true)),
            Some(DualSenseButtons { ps: true, options: true })
        );
        let mut corrupted = bt_full_report(true, true);
        corrupted[11] = 0;
        assert_eq!(parse_dualsense_report(&corrupted), None);
    }

    #[test]
    fn bluetooth_crc_matches_the_hid_playstation_seed() {
        // Vector computed independently with zlib.crc32(data, zlib.crc32([0xA1])).
        let report = bt_full_report(true, true);
        assert_eq!(&report[74..], &[0x3a, 0xd5, 0x81, 0xab]);
    }

    #[test]
    fn parses_bluetooth_minimal_report() {
        assert_eq!(
            parse_dualsense_report(&bt_minimal_report(true, true)),
            Some(DualSenseButtons { ps: true, options: true })
        );
    }

    #[test]
    fn ignores_short_unknown_and_malformed_reports() {
        assert_eq!(parse_dualsense_report(&[]), None);
        assert_eq!(parse_dualsense_report(&[0x01]), None);
        assert_eq!(parse_dualsense_report(&[0x02; 64]), None);
        assert_eq!(parse_dualsense_report(&[0x31; 64]), None);
        assert_eq!(parse_dualsense_report(&[0x01; 63]), None);
        let mut report = usb_report(false, false);
        report.truncate(11);
        assert_eq!(parse_dualsense_report(&report), None);
    }

    #[test]
    fn chord_triggers_once_and_requires_release_before_repeat() {
        let mut tracker = ComboTracker::default();
        assert!(!tracker.observe("pad", DualSenseButtons { ps: false, options: false }, 0));
        assert!(tracker.observe("pad", DualSenseButtons { ps: true, options: true }, 100));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons { ps: true, options: true },
            120
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons { ps: false, options: false },
            200
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons { ps: true, options: true },
            300
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons { ps: true, options: true },
            320
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons { ps: false, options: false },
            400
        ));
        assert!(tracker.observe("pad", DualSenseButtons { ps: true, options: true }, 2_000));
    }

    #[test]
    fn chord_rejects_a_button_held_before_the_window() {
        let mut tracker = ComboTracker::default();
        assert!(!tracker.observe("pad", DualSenseButtons { ps: true, options: false }, 0));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons { ps: true, options: true },
            CHORD_WINDOW_MS + 1
        ));
    }

    #[test]
    fn either_button_may_be_pressed_first_within_the_window() {
        let mut tracker = ComboTracker::default();
        assert!(!tracker.observe("pad", DualSenseButtons { ps: false, options: true }, 0));
        assert!(tracker.observe(
            "pad",
            DualSenseButtons { ps: true, options: true },
            CHORD_WINDOW_MS
        ));
        assert!(!tracker.observe("pad", DualSenseButtons { ps: false, options: false }, 500));
        assert!(tracker.observe("pad", DualSenseButtons { ps: true, options: true }, 1_000));
    }

    #[test]
    fn cooldown_and_stale_device_reset_prevent_repeat_triggers() {
        let mut tracker = ComboTracker::default();
        assert!(tracker.observe("pad", DualSenseButtons { ps: true, options: true }, 0));
        assert!(!tracker.observe("pad", DualSenseButtons { ps: false, options: false }, 100));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons { ps: true, options: true },
            COMBO_COOLDOWN_MS - 1
        ));
        assert_eq!(tracker.device_count(), 1);
        assert_eq!(tracker.prune(1_000 + DEVICE_STALE_MS), 0);
        assert_eq!(tracker.device_count(), 0);
        assert!(tracker.observe("pad", DualSenseButtons { ps: true, options: true }, 10_000));
    }

    #[test]
    fn disconnect_and_reconnect_resets_the_chord_state() {
        let mut tracker = ComboTracker::default();
        assert!(!tracker.observe("pad", DualSenseButtons { ps: true, options: false }, 0));
        tracker.remove_device("pad");
        assert_eq!(tracker.device_count(), 0);
        assert!(tracker.observe("pad", DualSenseButtons { ps: true, options: true }, 1_000));
    }

    #[test]
    fn independent_devices_share_the_global_cooldown() {
        let mut tracker = ComboTracker::default();
        assert!(tracker.observe("pad-a", DualSenseButtons { ps: true, options: true }, 0));
        assert!(!tracker.observe("pad-b", DualSenseButtons { ps: true, options: true }, 10));
        assert!(!tracker.observe("pad-b", DualSenseButtons { ps: false, options: false }, 100));
        assert!(tracker.observe("pad-b", DualSenseButtons { ps: true, options: true }, 1_000));
    }
}
