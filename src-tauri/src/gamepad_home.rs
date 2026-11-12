use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
pub(crate) const DUPLICATE_REPORT_WINDOW_MS: u64 = 8;
pub(crate) const MAX_TRACKED_DEVICES: usize = 8;

/// How Windows exposes the device interface. A path that does not say
/// `usb` or Bluetooth is reported as unknown instead of being guessed from
/// the Sony VID/PID pair.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DualSenseConnection {
    Usb,
    Bluetooth,
    #[default]
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DualSenseModel {
    DualSense,
    DualSenseEdge,
    #[default]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChordOutcome {
    Triggered,
    Armed,
    Cooldown,
    Latched,
    Released,
    RejectedWindow,
    Ignored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordDiagnostic {
    pub outcome: ChordOutcome,
    pub at_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DualSenseButtons {
    pub ps: bool,
    pub options: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamepadDeviceInfo {
    /// Stable 16-hex FNV-1a label. The raw Windows device path is never
    /// serialized.
    pub id: String,
    pub model: DualSenseModel,
    pub connection: DualSenseConnection,
    pub connected_at_ms: u64,
    pub last_report_at_ms: Option<u64>,
    pub report_count: u64,
    pub last_chord_at_ms: Option<u64>,
    /// Windows arrival notifications observed after this device was seen.
    /// This is not proof of a physical cable/radio reconnect.
    pub reconnect_count: u32,
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
    #[serde(default)]
    pub devices: Vec<GamepadDeviceInfo>,
    #[serde(default)]
    pub last_report_at_ms: Option<u64>,
    #[serde(default)]
    pub duplicate_reports: u64,
    /// Observed arrival notifications, not verified physical reconnects.
    #[serde(default)]
    pub reconnects: u64,
    /// Most recent non-neutral chord transition. `ignored` reports do not
    /// overwrite this value.
    #[serde(default)]
    pub last_chord: Option<ChordDiagnostic>,
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

/// Windows exposes Bluetooth HID interfaces through BTHENUM/BTHLEDEVICE
/// paths. Some paths only carry the HID-over-GATT service UUID instead.
const BLUETOOTH_PATH_MARKERS: [&str; 5] = [
    "bthenum",
    "bthled",
    "bluetooth",
    "00001124-0000-1000-8000-00805f9b34fb",
    "00001812-0000-1000-8000-00805f9b34fb",
];

fn path_pid(path: &str) -> Option<u16> {
    let lower = path.to_ascii_lowercase();
    let start = lower.find("pid_")?.checked_add(4)?;
    let end = start.checked_add(4)?;
    let digits = lower.get(start..end)?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit())
        || lower
            .as_bytes()
            .get(end)
            .is_some_and(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    u16::from_str_radix(digits, 16).ok()
}

pub(crate) fn dualsense_connection(path: &str) -> DualSenseConnection {
    let lower = path.to_ascii_lowercase();
    if BLUETOOTH_PATH_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return DualSenseConnection::Bluetooth;
    }
    if lower.contains("usb") {
        return DualSenseConnection::Usb;
    }
    DualSenseConnection::Unknown
}

pub(crate) fn dualsense_model(path: &str) -> DualSenseModel {
    match path_pid(path) {
        Some(0x0df2) => DualSenseModel::DualSenseEdge,
        Some(0x0ce6) => DualSenseModel::DualSense,
        _ => DualSenseModel::Unknown,
    }
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The public diagnostics surface must not leak the raw device interface
/// path. Windows paths are case-insensitive, so the label hashes a normalized
/// (lowercase, extension-prefix-free) path with FNV-1a 64.
pub(crate) fn device_label(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches('\0').to_ascii_lowercase();
    let normalized = trimmed.strip_prefix(r"\\?\").unwrap_or(&trimmed);
    format!("{:016x}", fnv1a_64(normalized.as_bytes()))
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
        options: report
            .get(options_byte)
            .is_some_and(|byte| byte & 0x20 != 0),
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
    #[cfg(test)]
    pub(crate) fn observe(&mut self, device: &str, buttons: DualSenseButtons, at_ms: u64) -> bool {
        self.observe_diagnostic(device, buttons, at_ms).0
    }

    /// Same trigger semantics as `observe`, with the reason attached so the
    /// Control Service can explain why a chord did or did not fire.
    pub(crate) fn observe_diagnostic(
        &mut self,
        device: &str,
        buttons: DualSenseButtons,
        at_ms: u64,
    ) -> (bool, ChordOutcome) {
        if !self.devices.contains_key(device) && self.devices.len() >= MAX_TRACKED_DEVICES {
            let oldest = self
                .devices
                .iter()
                .min_by_key(|(_, state)| state.last_seen_ms)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                self.devices.remove(&oldest);
            }
        }
        let state = self.devices.entry(device.to_string()).or_default();
        if at_ms.saturating_sub(state.last_seen_ms) > DEVICE_STALE_MS {
            *state = DeviceChord::default();
        }
        state.last_seen_ms = at_ms;

        let was_pressed = state.ps || state.options;
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
            return (
                false,
                if was_pressed {
                    ChordOutcome::Released
                } else {
                    ChordOutcome::Ignored
                },
            );
        }
        if state.latched {
            return (false, ChordOutcome::Latched);
        }
        if !(ps_rising || options_rising) {
            return (
                false,
                if buttons.ps ^ buttons.options {
                    ChordOutcome::Armed
                } else {
                    ChordOutcome::Ignored
                },
            );
        }
        if !(buttons.ps && buttons.options) {
            return (false, ChordOutcome::Armed);
        }
        let (Some(ps_at), Some(options_at)) = (state.ps_pressed_at_ms, state.options_pressed_at_ms)
        else {
            return (false, ChordOutcome::Ignored);
        };
        if ps_at.abs_diff(options_at) > CHORD_WINDOW_MS {
            return (false, ChordOutcome::RejectedWindow);
        }
        if self
            .last_trigger_ms
            .is_some_and(|last| at_ms.saturating_sub(last) < COMBO_COOLDOWN_MS)
        {
            state.latched = true;
            return (false, ChordOutcome::Cooldown);
        }
        state.latched = true;
        self.last_trigger_ms = Some(at_ms);
        (true, ChordOutcome::Triggered)
    }

    pub(crate) fn remove_device(&mut self, device: &str) {
        self.devices.remove(device);
    }

    pub(crate) fn prune(&mut self, at_ms: u64) -> usize {
        self.devices
            .retain(|_, state| at_ms.saturating_sub(state.last_seen_ms) <= DEVICE_STALE_MS);
        self.devices.len()
    }

    #[cfg(test)]
    pub(crate) fn device_count(&self) -> usize {
        self.devices.len()
    }
}

const MAX_DEVICE_HISTORY: usize = 16;
/// Suppresses duplicate arrival notifications from Windows without preventing
/// a real unplug/replug (which produces a removal and is tracked through the
/// removal history) from incrementing the counter.
const RECONNECT_ARRIVAL_DEDUP_MS: u64 = 1_000;

#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReportRecord {
    Accepted(String),
    Duplicate,
}

#[derive(Clone, Debug, Default)]
struct DeviceHistory {
    reconnect_count: u32,
    last_seen_ms: u64,
}

#[derive(Clone, Debug)]
struct DeviceRecord {
    id: Option<String>,
    model: DualSenseModel,
    connection: DualSenseConnection,
    connected_at_ms: u64,
    last_report_at_ms: Option<u64>,
    report_count: u64,
    last_chord_at_ms: Option<u64>,
    reconnect_count: u32,
    last_arrival_ms: Option<u64>,
    last_activity_ms: u64,
    last_report_bytes: Option<Vec<u8>>,
}

impl DeviceRecord {
    fn new(at_ms: u64) -> Self {
        Self {
            id: None,
            model: DualSenseModel::Unknown,
            connection: DualSenseConnection::Unknown,
            connected_at_ms: at_ms,
            last_report_at_ms: None,
            report_count: 0,
            last_chord_at_ms: None,
            reconnect_count: 0,
            last_arrival_ms: None,
            last_activity_ms: at_ms,
            last_report_bytes: None,
        }
    }
}

/// Pure device/connection bookkeeping used by the Windows runtime. Keeping it
/// free of Win32 calls allows reconnect, pruning and report de-duplication to
/// be tested on macOS.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
#[derive(Default)]
pub(crate) struct DeviceBookkeeping {
    devices: HashMap<usize, DeviceRecord>,
    history: HashMap<String, DeviceHistory>,
    duplicate_reports: u64,
    reconnects: u64,
    last_report_at_ms: Option<u64>,
    last_arrival_ms: Option<u64>,
}

#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
impl DeviceBookkeeping {
    fn remember(&mut self, id: &str, reconnect_count: u32, at_ms: u64) {
        if !self.history.contains_key(id) && self.history.len() >= MAX_DEVICE_HISTORY {
            let oldest = self
                .history
                .iter()
                .min_by_key(|(_, entry)| entry.last_seen_ms)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                self.history.remove(&oldest);
            }
        }
        let entry = self.history.entry(id.to_string()).or_default();
        entry.reconnect_count = entry.reconnect_count.max(reconnect_count);
        entry.last_seen_ms = at_ms;
    }

    fn drop_record(&mut self, record: DeviceRecord, at_ms: u64) {
        if let Some(id) = record.id {
            self.remember(&id, record.reconnect_count, at_ms);
        }
    }

    fn prune_stale(&mut self, at_ms: u64) -> usize {
        let stale: Vec<usize> = self
            .devices
            .iter()
            .filter(|(_, record)| at_ms.saturating_sub(record.last_activity_ms) > DEVICE_STALE_MS)
            .map(|(device, _)| *device)
            .collect();
        for device in stale {
            if let Some(record) = self.devices.remove(&device) {
                self.drop_record(record, at_ms);
            }
        }
        self.devices.len()
    }

    fn reserve_slot(&mut self, at_ms: u64) {
        if self.devices.len() < MAX_TRACKED_DEVICES {
            return;
        }
        self.prune_stale(at_ms);
        while self.devices.len() >= MAX_TRACKED_DEVICES {
            let oldest = self
                .devices
                .iter()
                .min_by_key(|(_, record)| record.last_activity_ms)
                .map(|(device, _)| *device);
            let Some(oldest) = oldest else {
                break;
            };
            if let Some(record) = self.devices.remove(&oldest) {
                self.drop_record(record, at_ms);
            }
        }
    }

    /// Windows reported a device arrival. The cached path and report sample
    /// are discarded so the next report resolves identity again.
    pub(crate) fn arrival(&mut self, device: usize, at_ms: u64) -> Option<String> {
        self.last_arrival_ms = Some(at_ms);
        if !self.devices.contains_key(&device) {
            self.reserve_slot(at_ms);
            let mut record = DeviceRecord::new(at_ms);
            record.last_arrival_ms = Some(at_ms);
            self.devices.insert(device, record);
            return None;
        }
        let (id, reconnected) = {
            let record = self.devices.get_mut(&device).expect("device was inserted");
            let duplicate_arrival = record.last_arrival_ms.is_some_and(|previous| {
                at_ms.saturating_sub(previous) < RECONNECT_ARRIVAL_DEDUP_MS
            });
            let established = record.report_count > 0;
            let id = record.id.clone();
            record.last_report_bytes = None;
            record.last_activity_ms = at_ms;
            record.last_arrival_ms = Some(at_ms);
            let reconnected = established && !duplicate_arrival;
            if reconnected {
                record.reconnect_count = record.reconnect_count.saturating_add(1);
                record.connected_at_ms = at_ms;
            }
            (id, reconnected)
        };
        if reconnected {
            self.reconnects = self.reconnects.saturating_add(1);
        }
        id
    }

    /// Removes a device and preserves its reconnect count for the next
    /// arrival. Removal is idempotent.
    pub(crate) fn remove(&mut self, device: usize, at_ms: u64) -> Option<String> {
        let record = self.devices.remove(&device)?;
        let id = record.id.clone();
        if let Some(id) = &id {
            self.remember(id, record.reconnect_count, at_ms);
        }
        id
    }

    pub(crate) fn note_report(
        &mut self,
        device: usize,
        path: &str,
        report: &[u8],
        at_ms: u64,
    ) -> ReportRecord {
        if !self.devices.contains_key(&device) {
            self.reserve_slot(at_ms);
            self.devices.insert(device, DeviceRecord::new(at_ms));
        }

        let id = device_label(path);
        let needs_resolution = self
            .devices
            .get(&device)
            .map_or(true, |record| record.id.as_deref() != Some(id.as_str()));
        if needs_resolution {
            let previous_id = self
                .devices
                .get(&device)
                .and_then(|record| record.id.clone());
            let had_identity = previous_id.is_some();
            if let Some(previous_id) = previous_id.as_deref() {
                let previous_count = self
                    .devices
                    .get(&device)
                    .map_or(0, |record| record.reconnect_count);
                self.remember(previous_id, previous_count, at_ms);
            }
            let history = self.history.remove(&id);
            let reconnected = {
                let record = self.devices.get_mut(&device).expect("device was inserted");
                record.id = Some(id);
                record.model = dualsense_model(path);
                record.connection = dualsense_connection(path);
                if had_identity {
                    // A new identity on a reused handle starts a new
                    // connection. A pending arrival already supplied the
                    // connection timestamp.
                    record.connected_at_ms = at_ms;
                }
                record.last_report_at_ms = None;
                record.last_report_bytes = None;
                record.last_chord_at_ms = None;
                match history {
                    Some(history) => {
                        record.reconnect_count = history.reconnect_count.saturating_add(1);
                        true
                    }
                    None => {
                        record.reconnect_count = 0;
                        false
                    }
                }
            };
            if reconnected {
                self.reconnects = self.reconnects.saturating_add(1);
            }
        }

        let (duplicate, id) = {
            let record = self.devices.get_mut(&device).expect("device was inserted");
            let duplicate = record.last_report_bytes.as_deref() == Some(report)
                && record.last_report_at_ms.is_some_and(|previous| {
                    at_ms.saturating_sub(previous) < DUPLICATE_REPORT_WINDOW_MS
                });
            if duplicate {
                record.last_activity_ms = at_ms;
            } else {
                // Reuse the bounded sample buffer instead of allocating for
                // every 250 Hz report.
                match record.last_report_bytes.as_mut() {
                    Some(buffer) => {
                        buffer.clear();
                        buffer.extend_from_slice(report);
                    }
                    None => record.last_report_bytes = Some(report.to_vec()),
                }
                record.last_report_at_ms = Some(at_ms);
                record.report_count = record.report_count.saturating_add(1);
                record.last_activity_ms = at_ms;
            }
            (duplicate, record.id.clone().expect("identity was resolved"))
        };

        if duplicate {
            self.duplicate_reports = self.duplicate_reports.saturating_add(1);
            return ReportRecord::Duplicate;
        }
        self.last_report_at_ms = Some(
            self.last_report_at_ms
                .map_or(at_ms, |previous| previous.max(at_ms)),
        );
        ReportRecord::Accepted(id)
    }

    pub(crate) fn note_chord(&mut self, device: usize, at_ms: u64) {
        if let Some(record) = self.devices.get_mut(&device) {
            record.last_chord_at_ms = Some(at_ms);
        }
    }

    pub(crate) fn prune(&mut self, at_ms: u64) -> usize {
        self.prune_stale(at_ms)
    }

    #[cfg(test)]
    pub(crate) fn device_count(&self) -> usize {
        self.devices
            .values()
            .filter(|record| record.id.is_some())
            .count()
    }

    pub(crate) fn devices(&self) -> Vec<GamepadDeviceInfo> {
        let mut devices: Vec<GamepadDeviceInfo> = self
            .devices
            .values()
            .filter_map(|record| {
                Some(GamepadDeviceInfo {
                    id: record.id.clone()?,
                    model: record.model,
                    connection: record.connection,
                    connected_at_ms: record.connected_at_ms,
                    last_report_at_ms: record.last_report_at_ms,
                    report_count: record.report_count,
                    last_chord_at_ms: record.last_chord_at_ms,
                    reconnect_count: record.reconnect_count,
                })
            })
            .collect();
        devices.sort_by(|left, right| left.id.cmp(&right.id));
        devices
    }

    pub(crate) fn last_report_at_ms(&self) -> Option<u64> {
        self.last_report_at_ms
    }

    pub(crate) fn duplicate_reports(&self) -> u64 {
        self.duplicate_reports
    }

    pub(crate) fn reconnects(&self) -> u64 {
        self.reconnects
    }

    #[cfg(test)]
    pub(crate) fn last_arrival_ms(&self) -> Option<u64> {
        self.last_arrival_ms
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
const MAX_PATH_CACHE: usize = 32;

#[cfg(target_os = "windows")]
pub(crate) struct GamepadHomeRuntime {
    window: native::Hwnd,
    tracker: ComboTracker,
    bookkeeping: DeviceBookkeeping,
    device_paths: HashMap<usize, Option<String>>,
    last_combo_at_ms: Option<u64>,
    last_chord: Option<ChordDiagnostic>,
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
            bookkeeping: DeviceBookkeeping::default(),
            device_paths: HashMap::new(),
            last_combo_at_ms: None,
            last_chord: None,
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
            let at_ms = now_ms();
            if w_param == native::GIDC_ARRIVAL {
                // The next report must resolve the path again. Any chord
                // state from the previous connection is stale.
                self.device_paths.remove(&device);
                if let Some(id) = self.bookkeeping.arrival(device, at_ms) {
                    self.tracker.remove_device(&id);
                }
            } else if w_param == native::GIDC_REMOVAL {
                self.device_paths.remove(&device);
                if let Some(id) = self.bookkeeping.remove(device, at_ms) {
                    self.tracker.remove_device(&id);
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
            let Some(path) = self.resolve_device_path(device) else {
                continue;
            };
            if !is_dualsense_device_path(&path) {
                continue;
            }
            let Some(buttons) = parse_dualsense_report(&report.data) else {
                continue;
            };
            let ReportRecord::Accepted(id) =
                self.bookkeeping
                    .note_report(device, &path, &report.data, at_ms)
            else {
                continue;
            };
            let (triggered_now, outcome) = self.tracker.observe_diagnostic(&id, buttons, at_ms);
            if outcome != ChordOutcome::Ignored {
                self.last_chord = Some(ChordDiagnostic { outcome, at_ms });
            }
            if triggered_now {
                self.last_combo_at_ms = Some(at_ms);
                self.bookkeeping.note_chord(device, at_ms);
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

    fn resolve_device_path(&mut self, device: usize) -> Option<String> {
        match self.device_paths.get(&device) {
            Some(Some(path)) => return Some(path.clone()),
            Some(None) => {
                // A transient device-info failure must not poison the cache
                // until physical reconnect.
            }
            None => {}
        }
        let path = native::device_path(device);
        if self.device_paths.len() >= MAX_PATH_CACHE {
            self.device_paths.clear();
        }
        self.device_paths.insert(device, path.clone());
        path
    }

    pub(crate) fn status(&self, running: bool) -> GamepadHomeStatus {
        let devices = self.bookkeeping.devices();
        GamepadHomeStatus {
            windows: true,
            running,
            device_count: devices.len(),
            last_combo_at_ms: self.last_combo_at_ms,
            last_error: self.last_error.clone(),
            fallback: Some(
                "Gdy DualSense nie jest widoczny lub Windows odmówi fokusu, użyj skonfigurowanego skrótu powrotu."
                    .into(),
            ),
            devices,
            last_report_at_ms: self.bookkeeping.last_report_at_ms(),
            duplicate_reports: self.bookkeeping.duplicate_reports(),
            reconnects: self.bookkeeping.reconnects(),
            last_chord: self.last_chord,
        }
    }

    pub(crate) fn refresh_devices(&mut self) {
        let at_ms = now_ms();
        self.bookkeeping.prune(at_ms);
        self.tracker.prune(at_ms);
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
    pub(super) const GIDC_ARRIVAL: usize = 1;
    pub(super) const GIDC_REMOVAL: usize = 2;

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
        fn RegisterRawInputDevices(devices: *const RawInputDevice, count: u32, size: u32) -> i32;
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
        device_label, dualsense_connection, dualsense_model, fnv1a_64, is_dualsense_device_path,
        parse_dualsense_report, ChordDiagnostic, ChordOutcome, ComboTracker, DeviceBookkeeping,
        DualSenseButtons, DualSenseConnection, DualSenseModel, GamepadHomeStatus, ReportRecord,
        CHORD_WINDOW_MS, COMBO_COOLDOWN_MS, DEVICE_STALE_MS, DUPLICATE_REPORT_WINDOW_MS,
        MAX_TRACKED_DEVICES,
    };

    const USB_PATH: &str =
        r"\\?\USB#VID_054C&PID_0CE6#7&1a2b3c4d&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";
    const USB_EDGE_PATH: &str =
        r"\\?\USB#VID_054C&PID_0DF2#8&5e6f7a8b&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";
    const BLUETOOTH_PATH: &str = r"\\?\BTHENUM#{00001124-0000-1000-8000-00805f9b34fb}_VID&0002054c_PID&0ce6#9&3c4d5e6f&0&0001";
    const HID_PATH: &str =
        r"\\?\HID#VID_054C&PID_0CE6#a&7b8c9d0e&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";

    fn buttons(ps: bool, options: bool) -> DualSenseButtons {
        DualSenseButtons { ps, options }
    }

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
        assert!(is_dualsense_device_path(r"\\?\hid#vid_054c&pid_0df2#..."));
        assert!(!is_dualsense_device_path(r"\\?\HID#VID_054C&PID_05C4#..."));
        assert!(!is_dualsense_device_path(r"\\?\HID#VID_045E&PID_0B13#..."));
    }

    #[test]
    fn parses_usb_ps_and_options_bits() {
        assert_eq!(
            parse_dualsense_report(&usb_report(true, true)),
            Some(DualSenseButtons {
                ps: true,
                options: true
            })
        );
        assert_eq!(
            parse_dualsense_report(&usb_report(false, true)),
            Some(DualSenseButtons {
                ps: false,
                options: true
            })
        );
        assert_eq!(
            parse_dualsense_report(&usb_report(true, false)),
            Some(DualSenseButtons {
                ps: true,
                options: false
            })
        );
    }

    #[test]
    fn parses_bluetooth_full_report_with_valid_crc() {
        assert_eq!(
            parse_dualsense_report(&bt_full_report(true, true)),
            Some(DualSenseButtons {
                ps: true,
                options: true
            })
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
            Some(DualSenseButtons {
                ps: true,
                options: true
            })
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
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: false,
                options: false
            },
            0
        ));
        assert!(tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            100
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            120
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: false,
                options: false
            },
            200
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            300
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            320
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: false,
                options: false
            },
            400
        ));
        assert!(tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            2_000
        ));
    }

    #[test]
    fn chord_rejects_a_button_held_before_the_window() {
        let mut tracker = ComboTracker::default();
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: false
            },
            0
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            CHORD_WINDOW_MS + 1
        ));
    }

    #[test]
    fn either_button_may_be_pressed_first_within_the_window() {
        let mut tracker = ComboTracker::default();
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: false,
                options: true
            },
            0
        ));
        assert!(tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            CHORD_WINDOW_MS
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: false,
                options: false
            },
            500
        ));
        assert!(tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            1_000
        ));
    }

    #[test]
    fn cooldown_and_stale_device_reset_prevent_repeat_triggers() {
        let mut tracker = ComboTracker::default();
        assert!(tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            0
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: false,
                options: false
            },
            100
        ));
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            COMBO_COOLDOWN_MS - 1
        ));
        assert_eq!(tracker.device_count(), 1);
        assert_eq!(tracker.prune(1_000 + DEVICE_STALE_MS), 0);
        assert_eq!(tracker.device_count(), 0);
        assert!(tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            10_000
        ));
    }

    #[test]
    fn disconnect_and_reconnect_resets_the_chord_state() {
        let mut tracker = ComboTracker::default();
        assert!(!tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: false
            },
            0
        ));
        tracker.remove_device("pad");
        assert_eq!(tracker.device_count(), 0);
        assert!(tracker.observe(
            "pad",
            DualSenseButtons {
                ps: true,
                options: true
            },
            1_000
        ));
    }

    #[test]
    fn independent_devices_share_the_global_cooldown() {
        let mut tracker = ComboTracker::default();
        assert!(tracker.observe(
            "pad-a",
            DualSenseButtons {
                ps: true,
                options: true
            },
            0
        ));
        assert!(!tracker.observe(
            "pad-b",
            DualSenseButtons {
                ps: true,
                options: true
            },
            10
        ));
        assert!(!tracker.observe(
            "pad-b",
            DualSenseButtons {
                ps: false,
                options: false
            },
            100
        ));
        assert!(tracker.observe(
            "pad-b",
            DualSenseButtons {
                ps: true,
                options: true
            },
            1_000
        ));
    }

    #[test]
    fn identifies_dualsense_model_from_pid_only() {
        assert_eq!(dualsense_model(USB_PATH), DualSenseModel::DualSense);
        assert_eq!(
            dualsense_model(USB_EDGE_PATH),
            DualSenseModel::DualSenseEdge
        );
        assert_eq!(
            dualsense_model(r"\\?\HID#VID_054C&PID_05C4#..."),
            DualSenseModel::Unknown
        );
        assert_eq!(
            dualsense_model(r"\\?\HID#VID_054C#no-pid"),
            DualSenseModel::Unknown
        );
        assert_eq!(
            dualsense_model(r"\\?\HID#VID_054C&PID_0CE65#..."),
            DualSenseModel::Unknown
        );
        assert_eq!(
            dualsense_model(&USB_EDGE_PATH.to_ascii_lowercase()),
            DualSenseModel::DualSenseEdge
        );
    }

    #[test]
    fn connection_mode_requires_an_explicit_path_marker() {
        assert_eq!(dualsense_connection(USB_PATH), DualSenseConnection::Usb);
        assert_eq!(
            dualsense_connection(&USB_PATH.to_ascii_lowercase()),
            DualSenseConnection::Usb
        );
        assert_eq!(
            dualsense_connection(BLUETOOTH_PATH),
            DualSenseConnection::Bluetooth
        );
        assert_eq!(
            dualsense_connection(r"\\?\BTHLEDEVICE#BluetoothLE#..."),
            DualSenseConnection::Bluetooth
        );
        assert_eq!(
            dualsense_connection("{00001124-0000-1000-8000-00805f9b34fb}"),
            DualSenseConnection::Bluetooth
        );
        // Sony VID/PID alone is not enough to claim a physical transport.
        assert_eq!(dualsense_connection(HID_PATH), DualSenseConnection::Unknown);
        assert_eq!(dualsense_connection(""), DualSenseConnection::Unknown);
    }

    #[test]
    fn stable_device_labels_are_hashed_case_insensitive_and_path_free() {
        let label = device_label(USB_PATH);
        assert_eq!(label, device_label(USB_PATH));
        assert_eq!(label, device_label(&USB_PATH.to_ascii_uppercase()));
        assert_ne!(label, device_label(HID_PATH));
        assert_eq!(label.len(), 16);
        assert!(label.chars().all(|character| character.is_ascii_hexdigit()));
        assert!(!label.contains(r"\\?\"));
        assert_eq!(
            device_label(r"\\?\USB#ABC"),
            device_label("usb#abc"),
            "normalization must ignore the Win32 extension prefix and case"
        );
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn diagnostic_enums_serialize_with_the_camel_case_contract() {
        assert_eq!(
            serde_json::to_value(DualSenseConnection::Usb).unwrap(),
            "usb"
        );
        assert_eq!(
            serde_json::to_value(DualSenseConnection::Bluetooth).unwrap(),
            "bluetooth"
        );
        assert_eq!(
            serde_json::to_value(DualSenseConnection::Unknown).unwrap(),
            "unknown"
        );
        assert_eq!(
            serde_json::to_value(DualSenseModel::DualSenseEdge).unwrap(),
            "dualSenseEdge"
        );
        assert_eq!(
            serde_json::to_value(ChordOutcome::RejectedWindow).unwrap(),
            "rejectedWindow"
        );
    }

    #[test]
    fn bookkeeping_tracks_connection_model_and_sorted_device_labels() {
        let mut bookkeeping = DeviceBookkeeping::default();
        assert_eq!(bookkeeping.arrival(11, 500), None);
        assert_eq!(
            bookkeeping.note_report(11, USB_PATH, &usb_report(false, false), 510),
            ReportRecord::Accepted(device_label(USB_PATH))
        );
        bookkeeping.arrival(12, 520);
        assert_eq!(
            bookkeeping.note_report(12, BLUETOOTH_PATH, &bt_minimal_report(false, false), 530),
            ReportRecord::Accepted(device_label(BLUETOOTH_PATH))
        );
        bookkeeping.note_chord(11, 540);

        let devices = bookkeeping.devices();
        assert_eq!(devices.len(), 2);
        let ids: Vec<String> = devices.iter().map(|device| device.id.clone()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);

        let usb = devices
            .iter()
            .find(|device| device.id == device_label(USB_PATH))
            .expect("USB device is tracked");
        assert_eq!(usb.model, DualSenseModel::DualSense);
        assert_eq!(usb.connection, DualSenseConnection::Usb);
        assert_eq!(usb.connected_at_ms, 500);
        assert_eq!(usb.last_report_at_ms, Some(510));
        assert_eq!(usb.report_count, 1);
        assert_eq!(usb.last_chord_at_ms, Some(540));
        assert_eq!(usb.reconnect_count, 0);
        assert_eq!(bookkeeping.device_count(), 2);
        assert_eq!(bookkeeping.last_report_at_ms(), Some(530));
        assert_eq!(bookkeeping.duplicate_reports(), 0);
        assert_eq!(bookkeeping.reconnects(), 0);
        assert_eq!(bookkeeping.last_arrival_ms(), Some(520));
    }

    #[test]
    fn removal_is_idempotent() {
        let mut bookkeeping = DeviceBookkeeping::default();
        let label = device_label(USB_PATH);
        bookkeeping.arrival(1, 0);
        bookkeeping.note_report(1, USB_PATH, &usb_report(false, false), 10);
        assert_eq!(bookkeeping.remove(1, 20), Some(label));
        assert_eq!(bookkeeping.remove(1, 21), None);
        assert_eq!(bookkeeping.device_count(), 0);
    }

    #[test]
    fn reconnect_counter_increments_on_arrival_and_removal_history() {
        let mut bookkeeping = DeviceBookkeeping::default();
        bookkeeping.arrival(1, 0);
        bookkeeping.note_report(1, USB_PATH, &usb_report(false, false), 10);
        assert_eq!(bookkeeping.reconnects(), 0);

        assert_eq!(bookkeeping.remove(1, 100), Some(device_label(USB_PATH)));
        bookkeeping.arrival(1, 1_000);
        bookkeeping.note_report(1, USB_PATH, &usb_report(false, false), 1_010);
        assert_eq!(bookkeeping.devices()[0].reconnect_count, 1);
        assert_eq!(bookkeeping.reconnects(), 1);

        // An arrival for a still-active device is treated as a re-arrival, but
        // duplicate Windows notifications within one second are ignored.
        bookkeeping.arrival(1, 2_000);
        bookkeeping.note_report(1, USB_PATH, &usb_report(false, false), 2_010);
        assert_eq!(bookkeeping.devices()[0].reconnect_count, 2);
        assert_eq!(bookkeeping.reconnects(), 2);

        bookkeeping.arrival(1, 2_500);
        bookkeeping.note_report(1, USB_PATH, &usb_report(false, false), 2_510);
        assert_eq!(bookkeeping.devices()[0].reconnect_count, 2);
        assert_eq!(bookkeeping.reconnects(), 2);
    }

    #[test]
    fn stale_devices_are_pruned_and_a_later_report_counts_as_reconnect() {
        let mut bookkeeping = DeviceBookkeeping::default();
        bookkeeping.arrival(3, 0);
        bookkeeping.note_report(3, USB_PATH, &usb_report(false, false), 10);
        assert_eq!(bookkeeping.prune(10 + DEVICE_STALE_MS + 1), 0);
        assert_eq!(bookkeeping.device_count(), 0);

        bookkeeping.note_report(3, USB_PATH, &usb_report(false, false), 20_000);
        assert_eq!(bookkeeping.devices()[0].reconnect_count, 1);
        assert_eq!(bookkeeping.reconnects(), 1);
    }

    #[test]
    fn duplicate_reports_are_counted_and_skipped_within_the_window() {
        let mut bookkeeping = DeviceBookkeeping::default();
        let report = usb_report(false, false);
        let label = device_label(USB_PATH);
        assert_eq!(
            bookkeeping.note_report(4, USB_PATH, &report, 1_000),
            ReportRecord::Accepted(label.clone())
        );
        assert_eq!(
            bookkeeping.note_report(4, USB_PATH, &report, 1_000 + DUPLICATE_REPORT_WINDOW_MS - 1),
            ReportRecord::Duplicate
        );
        assert_eq!(bookkeeping.duplicate_reports(), 1);

        // The same bytes exactly at the window boundary are a new report.
        assert_eq!(
            bookkeeping.note_report(4, USB_PATH, &report, 1_000 + DUPLICATE_REPORT_WINDOW_MS),
            ReportRecord::Accepted(label.clone())
        );
        assert_eq!(
            bookkeeping.note_report(4, USB_PATH, &usb_report(true, false), 1_020),
            ReportRecord::Accepted(label)
        );

        let device = &bookkeeping.devices()[0];
        assert_eq!(device.report_count, 3);
        assert_eq!(device.last_report_at_ms, Some(1_020));
        assert_eq!(bookkeeping.last_report_at_ms(), Some(1_020));
        assert_eq!(bookkeeping.duplicate_reports(), 1);
    }

    #[test]
    fn tracked_devices_stay_bounded() {
        let mut bookkeeping = DeviceBookkeeping::default();
        for device in 0..MAX_TRACKED_DEVICES + 4 {
            let path = format!(r"\\?\USB#VID_054C&PID_0CE6#device{device}");
            let at_ms = device as u64 * 10;
            bookkeeping.arrival(device, at_ms);
            bookkeeping.note_report(device, &path, &usb_report(false, false), at_ms + 1);
        }
        assert_eq!(bookkeeping.devices().len(), MAX_TRACKED_DEVICES);
        assert_eq!(bookkeeping.device_count(), MAX_TRACKED_DEVICES);
    }

    #[test]
    fn chord_tracker_stays_bounded() {
        let mut tracker = ComboTracker::default();
        for device in 0..MAX_TRACKED_DEVICES + 4 {
            tracker.observe(
                &format!("pad-{device}"),
                buttons(false, false),
                device as u64,
            );
        }
        assert_eq!(tracker.device_count(), MAX_TRACKED_DEVICES);
    }

    #[test]
    fn chord_diagnostics_cover_every_outcome() {
        let mut tracker = ComboTracker::default();
        let none = buttons(false, false);

        assert_eq!(
            tracker.observe_diagnostic("pad", none, 0),
            (false, ChordOutcome::Ignored)
        );
        assert_eq!(
            tracker.observe_diagnostic("pad", buttons(true, false), 10),
            (false, ChordOutcome::Armed)
        );
        assert_eq!(
            tracker.observe_diagnostic("pad", buttons(true, true), 100),
            (true, ChordOutcome::Triggered)
        );
        assert_eq!(
            tracker.observe_diagnostic("pad", buttons(true, true), 110),
            (false, ChordOutcome::Latched)
        );
        assert_eq!(
            tracker.observe_diagnostic("pad", buttons(false, true), 120),
            (false, ChordOutcome::Latched)
        );
        assert_eq!(
            tracker.observe_diagnostic("pad", none, 130),
            (false, ChordOutcome::Released)
        );
        assert_eq!(
            tracker.observe_diagnostic("pad", none, 140),
            (false, ChordOutcome::Ignored)
        );

        // A chord inside the global cooldown is rejected and latched.
        assert_eq!(
            tracker.observe_diagnostic("pad-b", buttons(true, true), 200),
            (false, ChordOutcome::Cooldown)
        );
        assert_eq!(
            tracker.observe_diagnostic("pad-b", none, 210),
            (false, ChordOutcome::Released)
        );

        // Both buttons held, but the second arrived outside the 250 ms window.
        assert_eq!(
            tracker.observe_diagnostic("pad-b", buttons(true, false), 300),
            (false, ChordOutcome::Armed)
        );
        assert_eq!(
            tracker.observe_diagnostic("pad-b", buttons(true, true), 300 + CHORD_WINDOW_MS + 1),
            (false, ChordOutcome::RejectedWindow)
        );
    }

    #[test]
    fn repeated_identical_chord_reports_never_trigger_twice() {
        let mut tracker = ComboTracker::default();
        let both = buttons(true, true);
        assert!(tracker.observe("pad", both, 100));
        for tick in 1..=20 {
            assert!(!tracker.observe("pad", both, 100 + tick * 10));
        }
        assert_eq!(
            tracker.observe_diagnostic("pad", both, 400),
            (false, ChordOutcome::Latched)
        );
        assert!(!tracker.observe("pad", buttons(false, false), 410));
        assert!(tracker.observe("pad", both, 2_000));
    }

    #[test]
    fn legacy_status_payloads_default_the_diagnostics_fields() {
        let status: GamepadHomeStatus = serde_json::from_str(
            r#"{"windows":true,"running":true,"deviceCount":0,"lastComboAtMs":null,"lastError":null,"fallback":null}"#,
        )
        .unwrap();
        assert!(status.devices.is_empty());
        assert_eq!(status.last_report_at_ms, None);
        assert_eq!(status.duplicate_reports, 0);
        assert_eq!(status.reconnects, 0);
        assert_eq!(status.last_chord, None);
    }

    #[test]
    fn status_serializes_only_hashed_ids_and_camel_case_enums() {
        let mut bookkeeping = DeviceBookkeeping::default();
        bookkeeping.arrival(21, 1_000);
        bookkeeping.note_report(21, USB_EDGE_PATH, &usb_report(true, true), 1_010);
        bookkeeping.note_chord(21, 1_010);
        let status = GamepadHomeStatus {
            windows: true,
            running: true,
            device_count: bookkeeping.device_count(),
            last_combo_at_ms: Some(1_010),
            last_error: None,
            fallback: None,
            devices: bookkeeping.devices(),
            last_report_at_ms: bookkeeping.last_report_at_ms(),
            duplicate_reports: bookkeeping.duplicate_reports(),
            reconnects: bookkeeping.reconnects(),
            last_chord: Some(ChordDiagnostic {
                outcome: ChordOutcome::Triggered,
                at_ms: 1_010,
            }),
        };

        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["devices"][0]["id"], device_label(USB_EDGE_PATH));
        assert_eq!(json["devices"][0]["model"], "dualSenseEdge");
        assert_eq!(json["devices"][0]["connection"], "usb");
        assert_eq!(json["devices"][0]["reportCount"], 1_u64);
        assert_eq!(json["devices"][0]["lastChordAtMs"], 1_010_u64);
        assert_eq!(json["lastChord"]["outcome"], "triggered");
        assert_eq!(json["lastChord"]["atMs"], 1_010_u64);
        assert_eq!(json["duplicateReports"], 0_u64);
        assert_eq!(json["reconnects"], 0_u64);

        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains(r"\\?\"));
        assert!(!serialized.contains("VID_054C"));
        assert!(!serialized.contains("PID_0DF2"));
    }
}
