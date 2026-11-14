//! Sony DualShock 4 (PS4) input report parsing and per-device state tracking.
//!
//! Everything here is pure: no Win32, no Tauri, no clocks. The Windows runtime
//! feeds it raw HID input reports plus a device path and a timestamp; the frontend
//! only ever sees the semantic [`Ds4Snapshot`], never raw packets or device paths.
//!
//! Report layouts (documented in the public Linux `hid-playstation` driver and the
//! PS Dev Wiki). They are NOT verified on physical hardware in this repo:
//!
//! | Transport | Report id | Length | Offset of the 9-byte "common" block |
//! |-----------|-----------|--------|-------------------------------------|
//! | USB       | 0x01      | 64     | 1                                   |
//! | Bluetooth, basic (default until the host reads feature 0x05/0x02) | 0x01 | 10 | 1 |
//! | Bluetooth, full   | 0x11      | 78     | 3 (CRC-32 over 0xA1 + bytes 0..74)  |
//!
//! Common block: `lx ly rx ry | hat+face | shoulder+share/options+stick clicks |
//! ps/touchpad/counter | l2 | r2`.
//!
//! This module never writes to the controller and never asks it to change report
//! mode. A pad that stays in the basic Bluetooth mode is fully supported.

use serde::Serialize;
use std::collections::HashMap;

pub(crate) const SONY_VID: u16 = 0x054c;
pub(crate) const PID_DS4_V1: u16 = 0x05c4;
pub(crate) const PID_DS4_V2: u16 = 0x09cc;
/// Sony DUALSHOCK 4 USB Wireless Adapter. The pad talks to the dongle over radio,
/// the dongle talks to Windows over USB with the USB report layout.
pub(crate) const PID_DS4_USB_ADAPTER: u16 = 0x0ba0;

pub(crate) const USB_REPORT_LEN: usize = 64;
pub(crate) const BT_BASIC_REPORT_LEN: usize = 10;
pub(crate) const BT_FULL_REPORT_LEN: usize = 78;

/// Largest number of devices tracked at once. Extra devices are ignored, never
/// evicting an active pad.
pub(crate) const MAX_TRACKED_PADS: usize = 4;
/// A pad that has sent nothing for this long is treated as gone. Windows does not
/// always emit a removal notification when a Bluetooth pad goes out of range.
pub(crate) const PAD_STALE_MS: u64 = 3_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ds4Revision {
    /// CUH-ZCT1 (original, pid 05C4).
    V1,
    /// CUH-ZCT2 (second revision, pid 09CC).
    V2,
    /// Sony USB Wireless Adapter (pid 0BA0).
    UsbAdapter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ds4Transport {
    Usb,
    Bluetooth,
}

/// Reads the hex digits that follow `marker` (`vid_`, `vid&`, `pid_`, `pid&`).
/// USB paths look like `VID_054C&PID_09CC`; Bluetooth HID paths look like
/// `{00001124-...}_VID&0002054C_PID&05C4`, where the vendor field carries a
/// 4-digit vendor-id-source prefix. Only the low 16 bits are the id.
fn hex_id_after(lower: &str, markers: [&str; 2]) -> Option<u16> {
    markers.iter().find_map(|marker| {
        let start = lower.find(marker)? + marker.len();
        let digits: String = lower[start..]
            .chars()
            .take_while(char::is_ascii_hexdigit)
            .collect();
        match digits.len() {
            4 | 8 => u16::from_str_radix(&digits[digits.len() - 4..], 16).ok(),
            _ => None,
        }
    })
}

/// Identifies a DualShock 4 from the Windows device interface path. A path that
/// carries another pid, or no pid, is `None`: nothing is guessed from the vendor
/// id alone.
pub(crate) fn ds4_revision_from_path(path: &str) -> Option<Ds4Revision> {
    let lower = path.to_ascii_lowercase();
    ds4_revision_from_ids(
        hex_id_after(&lower, ["vid_", "vid&"])?,
        hex_id_after(&lower, ["pid_", "pid&"])?,
    )
}

/// Identifies a DualShock 4 from the vendor and product id. Windows reports these
/// directly through `RIDI_DEVICEINFO`, which is the primary source; the path parser
/// above is only the fallback when that query fails.
pub(crate) fn ds4_revision_from_ids(vendor: u16, product: u16) -> Option<Ds4Revision> {
    if vendor != SONY_VID {
        return None;
    }
    match product {
        PID_DS4_V1 => Some(Ds4Revision::V1),
        PID_DS4_V2 => Some(Ds4Revision::V2),
        PID_DS4_USB_ADAPTER => Some(Ds4Revision::UsbAdapter),
        _ => None,
    }
}

/// True when the device interface path says the link is Bluetooth. Used only as a
/// cross-check on the report shape, which can be ambiguous when Raw Input pads a
/// short Bluetooth report up to a larger size.
pub(crate) fn path_is_bluetooth(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    crate::gamepad_home::BLUETOOTH_PATH_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
        || lower.contains("vid&0002")
}

/// What the report itself says about the link. The report id and length are the
/// ground truth; the device path is only a cross-check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReportKind {
    Usb,
    BluetoothBasic,
    BluetoothFull,
}

impl ReportKind {
    pub(crate) fn transport(self) -> Ds4Transport {
        match self {
            Self::Usb => Ds4Transport::Usb,
            Self::BluetoothBasic | Self::BluetoothFull => Ds4Transport::Bluetooth,
        }
    }
}

/// Semantic buttons. Order is the bit order of [`Ds4Buttons::bits`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ds4Button {
    Cross,
    Circle,
    Square,
    Triangle,
    L1,
    R1,
    L2,
    R2,
    L3,
    R3,
    Share,
    Options,
    Ps,
    Touchpad,
}

impl Ds4Button {
    pub(crate) const ALL: [Ds4Button; 14] = [
        Ds4Button::Cross,
        Ds4Button::Circle,
        Ds4Button::Square,
        Ds4Button::Triangle,
        Ds4Button::L1,
        Ds4Button::R1,
        Ds4Button::L2,
        Ds4Button::R2,
        Ds4Button::L3,
        Ds4Button::R3,
        Ds4Button::Share,
        Ds4Button::Options,
        Ds4Button::Ps,
        Ds4Button::Touchpad,
    ];

    fn bit(self) -> u16 {
        1 << (self as u16)
    }
}

/// Pressed buttons as a bit set, plus a derived D-pad.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Ds4Buttons {
    bits: u16,
}

impl Ds4Buttons {
    pub(crate) fn set(&mut self, button: Ds4Button, pressed: bool) {
        if pressed {
            self.bits |= button.bit();
        } else {
            self.bits &= !button.bit();
        }
    }

    pub fn is_pressed(&self, button: Ds4Button) -> bool {
        self.bits & button.bit() != 0
    }

    pub fn bits(&self) -> u16 {
        self.bits
    }

    pub fn pressed_names(&self) -> Vec<Ds4Button> {
        Ds4Button::ALL
            .into_iter()
            .filter(|button| self.is_pressed(*button))
            .collect()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Ds4Dpad {
    pub up: bool,
    pub down: bool,
    pub left: bool,
    pub right: bool,
}

/// Decodes the 4-bit hat nibble. 0 is north, clockwise to 7 (north-west); 8 and
/// every other value is neutral. A corrupt nibble never produces a direction.
pub(crate) fn decode_hat(nibble: u8) -> Ds4Dpad {
    match nibble {
        0 => Ds4Dpad { up: true, ..Ds4Dpad::default() },
        1 => Ds4Dpad { up: true, right: true, ..Ds4Dpad::default() },
        2 => Ds4Dpad { right: true, ..Ds4Dpad::default() },
        3 => Ds4Dpad { down: true, right: true, ..Ds4Dpad::default() },
        4 => Ds4Dpad { down: true, ..Ds4Dpad::default() },
        5 => Ds4Dpad { down: true, left: true, ..Ds4Dpad::default() },
        6 => Ds4Dpad { left: true, ..Ds4Dpad::default() },
        7 => Ds4Dpad { up: true, left: true, ..Ds4Dpad::default() },
        _ => Ds4Dpad::default(),
    }
}

/// One decoded input report. Sticks are -1.0..=1.0 with +Y pointing DOWN, which
/// matches the browser Gamepad API and the frontend engine. No dead zone is
/// applied here: dead zone and hysteresis belong to the navigation engine.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Ds4Report {
    pub dpad: Ds4Dpad,
    pub left_x: f32,
    pub left_y: f32,
    pub right_x: f32,
    pub right_y: f32,
    pub l2: f32,
    pub r2: f32,
    pub buttons: Ds4Buttons,
    #[serde(skip)]
    pub(crate) kind: ReportKind,
}

fn stick(value: u8) -> f32 {
    ((f32::from(value) - 128.0) / 127.0).clamp(-1.0, 1.0)
}

fn trigger(value: u8) -> f32 {
    f32::from(value) / 255.0
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

/// The Bluetooth full report carries a CRC-32 (little endian) in its last four
/// bytes, computed over the 0xA1 HID transaction header plus everything before it.
fn bt_full_crc_ok(report: &[u8]) -> bool {
    if report.len() != BT_FULL_REPORT_LEN {
        return false;
    }
    let end = report.len() - 4;
    let expected = u32::from_le_bytes([report[end], report[end + 1], report[end + 2], report[end + 3]]);
    let crc = !crc32_update(crc32_update(0xffff_ffff, &[0xa1]), &report[..end]);
    crc == expected
}

/// Parses one raw HID input report. Anything that is not exactly a known layout,
/// has a bad CRC, or is truncated returns `None`; unknown reports are dropped, not
/// guessed at.
pub fn parse_report(report: &[u8]) -> Option<Ds4Report> {
    // Raw Input hands over the report of the collection; whether Bluetooth reports
    // arrive padded to a larger declared size is unverified. Lengths are therefore
    // minimums, and the 0x11 CRC always sits at the protocol offset (74..78), not at
    // the end of the buffer.
    let (kind, offset) = match (report.first().copied()?, report.len()) {
        (0x01, length) if length >= USB_REPORT_LEN => (ReportKind::Usb, 1),
        (0x01, length) if length >= BT_BASIC_REPORT_LEN => (ReportKind::BluetoothBasic, 1),
        (0x11, length) if length >= BT_FULL_REPORT_LEN => {
            if !bt_full_crc_ok(&report[..BT_FULL_REPORT_LEN]) {
                return None;
            }
            (ReportKind::BluetoothFull, 3)
        }
        _ => return None,
    };
    let common = report.get(offset..offset + 9)?;
    let face = common[4];
    let shoulder = common[5];
    let special = common[6];

    let mut buttons = Ds4Buttons::default();
    buttons.set(Ds4Button::Square, face & 0x10 != 0);
    buttons.set(Ds4Button::Cross, face & 0x20 != 0);
    buttons.set(Ds4Button::Circle, face & 0x40 != 0);
    buttons.set(Ds4Button::Triangle, face & 0x80 != 0);
    buttons.set(Ds4Button::L1, shoulder & 0x01 != 0);
    buttons.set(Ds4Button::R1, shoulder & 0x02 != 0);
    buttons.set(Ds4Button::L2, shoulder & 0x04 != 0);
    buttons.set(Ds4Button::R2, shoulder & 0x08 != 0);
    buttons.set(Ds4Button::Share, shoulder & 0x10 != 0);
    buttons.set(Ds4Button::Options, shoulder & 0x20 != 0);
    buttons.set(Ds4Button::L3, shoulder & 0x40 != 0);
    buttons.set(Ds4Button::R3, shoulder & 0x80 != 0);
    buttons.set(Ds4Button::Ps, special & 0x01 != 0);
    buttons.set(Ds4Button::Touchpad, special & 0x02 != 0);

    Some(Ds4Report {
        dpad: decode_hat(face & 0x0f),
        left_x: stick(common[0]),
        left_y: stick(common[1]),
        right_x: stick(common[2]),
        right_y: stick(common[3]),
        l2: trigger(common[7]),
        r2: trigger(common[8]),
        buttons,
        kind,
    })
}

/// What the frontend receives. Contains no device path, no serial, no raw bytes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ds4Snapshot {
    /// Opaque per-session label (see `gamepad_home::device_label`), stable while the
    /// pad stays connected. Not a hardware identifier.
    pub device: String,
    pub revision: Ds4Revision,
    pub transport: Ds4Transport,
    pub dpad: Ds4Dpad,
    pub left_x: f32,
    pub left_y: f32,
    pub buttons: Vec<Ds4Button>,
}

/// Result of feeding one report to the tracker.
#[derive(Debug, Default)]
pub(crate) struct Ingest {
    pub events: Vec<PadEvent>,
    /// Pressed buttons of this report, for the PS + Options chord.
    pub buttons: Option<Ds4Buttons>,
    /// Opaque device label the report belongs to.
    pub label: Option<String>,
}

/// A tracked pad as the status command reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadInfo {
    pub device: String,
    pub revision: Ds4Revision,
    pub transport: Ds4Transport,
}

pub(crate) fn is_neutral(snapshot: &Ds4Snapshot) -> bool {
    snapshot.buttons.is_empty()
        && !snapshot.dpad.up
        && !snapshot.dpad.down
        && !snapshot.dpad.left
        && !snapshot.dpad.right
        && snapshot.left_x.abs() < 0.35
        && snapshot.left_y.abs() < 0.35
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PadEvent {
    /// First valid report from a pad that was not tracked.
    Connected { label: String, revision: Ds4Revision, transport: Ds4Transport },
    /// The semantic state changed. Never emitted for an identical report.
    State(Ds4Snapshot),
    /// The pad was removed or went stale. The frontend must treat all inputs as released.
    Disconnected { label: String },
}

struct TrackedPad {
    revision: Ds4Revision,
    transport: Ds4Transport,
    last: Option<Ds4Snapshot>,
    last_seen_ms: u64,
}

/// Per-device bookkeeping: connect on first valid report, emit only on semantic
/// change, drop on removal or silence. Pure and clock-free.
#[derive(Default)]
pub(crate) struct Ds4Tracker {
    pads: HashMap<String, TrackedPad>,
    ignored_reports: u64,
}

fn snapshot_of(label: &str, revision: Ds4Revision, report: &Ds4Report) -> Ds4Snapshot {
    // Sticks are quantised so sensor noise of one count does not emit events.
    let quantise = |value: f32| (value * 32.0).round() / 32.0;
    Ds4Snapshot {
        device: label.to_string(),
        revision,
        transport: report.kind.transport(),
        dpad: report.dpad,
        left_x: quantise(report.left_x),
        left_y: quantise(report.left_y),
        buttons: report.buttons.pressed_names(),
    }
}

impl Ds4Tracker {
    pub(crate) fn pad_count(&self) -> usize {
        self.pads.len()
    }

    pub(crate) fn ignored_reports(&self) -> u64 {
        self.ignored_reports
    }

    /// Feeds one raw report from a device already identified as `revision`. `path`
    /// is the Windows device interface path of the sender; it is hashed for the label
    /// and checked for a Bluetooth hint, and is never stored or returned.
    pub(crate) fn on_report(
        &mut self,
        path: &str,
        revision: Ds4Revision,
        report: &[u8],
        at_ms: u64,
    ) -> Ingest {
        let mut out = Ingest::default();
        let Some(parsed) = parse_report(report) else {
            self.ignored_reports = self.ignored_reports.saturating_add(1);
            return out;
        };
        let label = crate::gamepad_home::device_label(path);
        // A short Bluetooth report padded by Raw Input would look like USB; the path knows better.
        let transport = if path_is_bluetooth(path) {
            Ds4Transport::Bluetooth
        } else {
            parsed.kind.transport()
        };
        if !self.pads.contains_key(&label) {
            if self.pads.len() >= MAX_TRACKED_PADS {
                self.ignored_reports = self.ignored_reports.saturating_add(1);
                return out;
            }
            self.pads.insert(
                label.clone(),
                TrackedPad { revision, transport, last: None, last_seen_ms: at_ms },
            );
            out.events.push(PadEvent::Connected { label: label.clone(), revision, transport });
        }
        let mut snapshot = snapshot_of(&label, revision, &parsed);
        snapshot.transport = transport;
        if let Some(pad) = self.pads.get_mut(&label) {
            pad.last_seen_ms = at_ms;
            pad.transport = transport;
            if pad.last.as_ref() != Some(&snapshot) {
                pad.last = Some(snapshot.clone());
                out.events.push(PadEvent::State(snapshot));
            }
        }
        out.label = Some(label);
        out.buttons = Some(parsed.buttons);
        out
    }

    /// Latest snapshot of every tracked pad, for resynchronising the frontend (window
    /// focus regained) and for the periodic heartbeat while an input is held.
    pub(crate) fn snapshots(&self) -> Vec<Ds4Snapshot> {
        self.pads.values().filter_map(|pad| pad.last.clone()).collect()
    }

    /// Connected pads without any state, for the status command.
    pub(crate) fn pads(&self) -> Vec<PadInfo> {
        self.pads
            .iter()
            .map(|(label, pad)| PadInfo {
                device: label.clone(),
                revision: pad.revision,
                transport: pad.transport,
            })
            .collect()
    }

    /// Removes the pad that owns `path`, if tracked.
    pub(crate) fn on_removed(&mut self, path: &str) -> Option<PadEvent> {
        let label = crate::gamepad_home::device_label(path);
        self.pads.remove(&label).map(|_| PadEvent::Disconnected { label })
    }

    /// Drops pads that have been silent for [`PAD_STALE_MS`].
    pub(crate) fn prune(&mut self, at_ms: u64) -> Vec<PadEvent> {
        let stale: Vec<String> = self
            .pads
            .iter()
            .filter(|(_, pad)| at_ms.saturating_sub(pad.last_seen_ms) >= PAD_STALE_MS)
            .map(|(label, _)| label.clone())
            .collect();
        stale
            .into_iter()
            .map(|label| {
                self.pads.remove(&label);
                PadEvent::Disconnected { label }
            })
            .collect()
    }

    pub(crate) fn clear(&mut self) -> Vec<PadEvent> {
        self.pads
            .drain()
            .map(|(label, _)| PadEvent::Disconnected { label })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USB_PATH: &str = r"\\?\HID#VID_054C&PID_09CC#7&2a3b4c5d&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";
    const BT_PATH: &str =
        r"\\?\HID#{00001124-0000-1000-8000-00805f9b34fb}_VID&0002054C_PID&05C4#8&1&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";

    /// Builds a USB report with neutral sticks and no buttons.
    fn usb_report() -> Vec<u8> {
        let mut report = vec![0u8; USB_REPORT_LEN];
        report[0] = 0x01;
        report[1..5].copy_from_slice(&[128, 128, 128, 128]);
        report[5] = 0x08; // hat neutral
        report
    }

    fn basic_bt_report() -> Vec<u8> {
        let mut report = vec![0u8; BT_BASIC_REPORT_LEN];
        report[0] = 0x01;
        report[1..5].copy_from_slice(&[128, 128, 128, 128]);
        report[5] = 0x08;
        report
    }

    fn full_bt_report() -> Vec<u8> {
        let mut report = vec![0u8; BT_FULL_REPORT_LEN];
        report[0] = 0x11;
        report[1] = 0xc0;
        report[3..7].copy_from_slice(&[128, 128, 128, 128]);
        report[7] = 0x08;
        seal(&mut report);
        report
    }

    fn seal(report: &mut [u8]) {
        let end = report.len() - 4;
        let crc = !crc32_update(crc32_update(0xffff_ffff, &[0xa1]), &report[..end]);
        report[end..].copy_from_slice(&crc.to_le_bytes());
    }

    #[test]
    fn identifies_revisions_from_the_path_only() {
        assert_eq!(ds4_revision_from_path(USB_PATH), Some(Ds4Revision::V2));
        assert_eq!(ds4_revision_from_path(BT_PATH), Some(Ds4Revision::V1), "bluetooth path form");
        assert_eq!(
            ds4_revision_from_path(r"\\?\HID#VID_054C&PID_05C4#x"),
            Some(Ds4Revision::V1)
        );
        assert_eq!(
            ds4_revision_from_path(r"\\?\HID#VID_054C&PID_0BA0#x"),
            Some(Ds4Revision::UsbAdapter)
        );
        // A DualSense or another Sony pad is not a DualShock 4.
        assert_eq!(ds4_revision_from_path(r"\\?\HID#VID_054C&PID_0CE6#x"), None);
        // The vendor id alone proves nothing.
        assert_eq!(ds4_revision_from_path(r"\\?\HID#VID_054C#x"), None);
        assert_eq!(ds4_revision_from_path(r"\\?\HID#VID_045E&PID_09CC#x"), None);
    }

    #[test]
    fn decodes_every_hat_value_and_rejects_garbage() {
        assert_eq!(decode_hat(0), Ds4Dpad { up: true, ..Default::default() });
        assert_eq!(decode_hat(1), Ds4Dpad { up: true, right: true, ..Default::default() });
        assert_eq!(decode_hat(2), Ds4Dpad { right: true, ..Default::default() });
        assert_eq!(decode_hat(3), Ds4Dpad { down: true, right: true, ..Default::default() });
        assert_eq!(decode_hat(4), Ds4Dpad { down: true, ..Default::default() });
        assert_eq!(decode_hat(5), Ds4Dpad { down: true, left: true, ..Default::default() });
        assert_eq!(decode_hat(6), Ds4Dpad { left: true, ..Default::default() });
        assert_eq!(decode_hat(7), Ds4Dpad { up: true, left: true, ..Default::default() });
        for neutral in [8u8, 9, 12, 15] {
            assert_eq!(decode_hat(neutral), Ds4Dpad::default());
        }
    }

    #[test]
    fn maps_every_button_semantically_on_usb() {
        let cases: [(usize, u8, Ds4Button); 14] = [
            (5, 0x10, Ds4Button::Square),
            (5, 0x20, Ds4Button::Cross),
            (5, 0x40, Ds4Button::Circle),
            (5, 0x80, Ds4Button::Triangle),
            (6, 0x01, Ds4Button::L1),
            (6, 0x02, Ds4Button::R1),
            (6, 0x04, Ds4Button::L2),
            (6, 0x08, Ds4Button::R2),
            (6, 0x10, Ds4Button::Share),
            (6, 0x20, Ds4Button::Options),
            (6, 0x40, Ds4Button::L3),
            (6, 0x80, Ds4Button::R3),
            (7, 0x01, Ds4Button::Ps),
            (7, 0x02, Ds4Button::Touchpad),
        ];
        for (index, mask, expected) in cases {
            let mut report = usb_report();
            report[index] |= mask;
            let parsed = parse_report(&report).expect("usb report");
            assert_eq!(parsed.buttons.pressed_names(), vec![expected], "byte {index} mask {mask:#x}");
        }
    }

    #[test]
    fn usb_basic_bt_and_full_bt_agree_on_the_same_input() {
        let mut usb = usb_report();
        usb[1] = 0; // left stick hard left
        usb[2] = 255; // left stick hard down
        usb[5] = 0x20 | 0x02; // Cross + hat east
        usb[6] = 0x20; // Options
        usb[7] = 0x01; // PS
        let mut basic = basic_bt_report();
        basic[1..8].copy_from_slice(&usb[1..8]);
        let mut full = full_bt_report();
        full[3..10].copy_from_slice(&usb[1..8]);
        seal(&mut full);

        let a = parse_report(&usb).unwrap();
        let b = parse_report(&basic).unwrap();
        let c = parse_report(&full).unwrap();
        for other in [&b, &c] {
            assert_eq!(a.dpad, other.dpad);
            assert_eq!(a.buttons, other.buttons);
            assert_eq!(a.left_x, other.left_x);
            assert_eq!(a.left_y, other.left_y);
        }
        assert_eq!(a.kind, ReportKind::Usb);
        assert_eq!(b.kind, ReportKind::BluetoothBasic);
        assert_eq!(c.kind, ReportKind::BluetoothFull);
        assert_eq!(a.kind.transport(), Ds4Transport::Usb);
        assert_eq!(c.kind.transport(), Ds4Transport::Bluetooth);
        assert!(a.dpad.right);
        assert!(a.buttons.is_pressed(Ds4Button::Cross));
        assert!(a.buttons.is_pressed(Ds4Button::Options));
        assert!(a.buttons.is_pressed(Ds4Button::Ps));
        assert_eq!(a.left_x, -1.0);
        assert_eq!(a.left_y, 1.0);
    }

    #[test]
    fn stick_and_trigger_ranges_are_normalised() {
        let mut report = usb_report();
        report[1..5].copy_from_slice(&[0, 255, 128, 64]);
        report[8] = 255;
        report[9] = 51;
        let parsed = parse_report(&report).unwrap();
        assert_eq!(parsed.left_x, -1.0); // 0 clamps from -1.008
        assert_eq!(parsed.left_y, 1.0);
        assert_eq!(parsed.right_x, 0.0);
        assert!((parsed.right_y + 0.504).abs() < 0.01);
        assert_eq!(parsed.l2, 1.0);
        assert!((parsed.r2 - 0.2).abs() < 0.001);
    }

    #[test]
    fn rejects_malformed_unknown_and_corrupt_reports() {
        assert!(parse_report(&[]).is_none());
        assert!(parse_report(&[0x01]).is_none());
        let mut short = usb_report();
        short.truncate(BT_BASIC_REPORT_LEN - 1);
        assert!(parse_report(&short).is_none(), "shorter than any known report");
        let mut unknown = usb_report();
        unknown[0] = 0x05;
        assert!(parse_report(&unknown).is_none(), "output/feature report id");
        let mut bt = full_bt_report();
        bt[10] ^= 0x20; // flip Cross after sealing
        assert!(parse_report(&bt).is_none(), "bad crc must not synthesise input");
        let mut wrong_len = full_bt_report();
        wrong_len.truncate(77);
        assert!(parse_report(&wrong_len).is_none(), "0x11 shorter than its CRC");
        // Every possible one-byte report id with a 64-byte body is handled without panicking.
        for id in 0..=255u8 {
            let mut report = vec![0xffu8; USB_REPORT_LEN];
            report[0] = id;
            let _ = parse_report(&report);
        }
    }

    /// Mirrors what the runtime does: identify by ids/path first, then feed the tracker.
    fn feed(tracker: &mut Ds4Tracker, path: &str, report: &[u8], at_ms: u64) -> Vec<PadEvent> {
        match ds4_revision_from_path(path) {
            Some(revision) => tracker.on_report(path, revision, report, at_ms).events,
            None => Vec::new(),
        }
    }

    #[test]
    fn padded_reports_parse_and_the_crc_stays_at_the_protocol_offset() {
        // Raw Input may hand over a Bluetooth report padded to a larger declared size.
        let mut padded_full = full_bt_report();
        padded_full[7] |= 0x20; // Cross (common block starts at 3, face byte at 7)
        seal(&mut padded_full);
        padded_full.resize(547, 0);
        let parsed = parse_report(&padded_full).expect("padded 0x11 with valid crc");
        assert!(parsed.buttons.is_pressed(Ds4Button::Cross));
        padded_full[10] ^= 0x40; // corrupt a covered byte
        assert!(parse_report(&padded_full).is_none(), "crc is still enforced when padded");
        let mut padded_usb = usb_report();
        padded_usb.resize(78, 0);
        assert_eq!(parse_report(&padded_usb).unwrap().kind, ReportKind::Usb);
        let mut padded_basic = basic_bt_report();
        padded_basic.resize(40, 0);
        assert_eq!(parse_report(&padded_basic).unwrap().kind, ReportKind::BluetoothBasic);
    }

    #[test]
    fn identifies_by_vendor_and_product_ids() {
        assert_eq!(ds4_revision_from_ids(0x054c, 0x05c4), Some(Ds4Revision::V1));
        assert_eq!(ds4_revision_from_ids(0x054c, 0x09cc), Some(Ds4Revision::V2));
        assert_eq!(ds4_revision_from_ids(0x054c, 0x0ba0), Some(Ds4Revision::UsbAdapter));
        assert_eq!(ds4_revision_from_ids(0x054c, 0x0ce6), None, "DualSense");
        assert_eq!(ds4_revision_from_ids(0x045e, 0x09cc), None, "wrong vendor");
    }

    #[test]
    fn a_padded_bluetooth_report_is_still_labelled_bluetooth_from_the_path() {
        let mut tracker = Ds4Tracker::default();
        let mut padded = basic_bt_report();
        padded.resize(78, 0); // looks like a USB-shaped report
        let out = tracker.on_report(BT_PATH, Ds4Revision::V1, &padded, 0);
        let Some(PadEvent::Connected { transport, .. }) = out.events.first() else { panic!("connect") };
        assert_eq!(*transport, Ds4Transport::Bluetooth);
        assert!(path_is_bluetooth(BT_PATH));
        assert!(!path_is_bluetooth(USB_PATH));
    }

    #[test]
    fn ingest_exposes_buttons_for_the_chord_and_snapshots_for_resync() {
        let mut tracker = Ds4Tracker::default();
        let mut report = usb_report();
        report[6] |= 0x20; // Options
        report[7] |= 0x01; // PS
        let out = tracker.on_report(USB_PATH, Ds4Revision::V2, &report, 0);
        let buttons = out.buttons.expect("buttons");
        assert!(buttons.is_pressed(Ds4Button::Ps) && buttons.is_pressed(Ds4Button::Options));
        assert!(out.label.is_some());
        let snapshots = tracker.snapshots();
        assert_eq!(snapshots.len(), 1);
        assert!(!is_neutral(&snapshots[0]));
        assert_eq!(tracker.pads().len(), 1);
    }

    #[test]
    fn tracker_connects_once_and_emits_only_on_change() {
        let mut tracker = Ds4Tracker::default();
        let first = feed(&mut tracker, USB_PATH, &usb_report(), 10);
        assert!(matches!(first.as_slice(), [PadEvent::Connected { revision: Ds4Revision::V2, transport: Ds4Transport::Usb, .. }, PadEvent::State(_)]));
        assert_eq!(tracker.pad_count(), 1);
        // Identical report: nothing.
        assert!(feed(&mut tracker, USB_PATH, &usb_report(), 14).is_empty());
        // One count of stick noise quantises away.
        let mut noisy = usb_report();
        noisy[1] = 129;
        assert!(feed(&mut tracker, USB_PATH, &noisy, 18).is_empty());
        // A real press emits.
        let mut cross = usb_report();
        cross[5] |= 0x20;
        let events = feed(&mut tracker, USB_PATH, &cross, 22);
        let [PadEvent::State(snapshot)] = events.as_slice() else { panic!("expected one state") };
        assert_eq!(snapshot.buttons, vec![Ds4Button::Cross]);
        // Release emits too.
        assert_eq!(feed(&mut tracker, USB_PATH, &usb_report(), 30).len(), 1);
    }

    #[test]
    fn tracker_ignores_other_devices_and_bad_reports() {
        let mut tracker = Ds4Tracker::default();
        assert!(feed(&mut tracker, r"\\?\HID#VID_046D&PID_C21D#x", &usb_report(), 1).is_empty());
        assert_eq!(tracker.pad_count(), 0);
        assert_eq!(tracker.ignored_reports(), 0, "foreign devices are not counted as bad reports");
        assert!(feed(&mut tracker, USB_PATH, &[0x01, 0x02], 2).is_empty());
        assert_eq!(tracker.ignored_reports(), 1);
        assert_eq!(tracker.pad_count(), 0, "a corrupt report never connects a pad");
    }

    #[test]
    fn tracker_disconnect_reconnect_and_stale_pruning() {
        let mut tracker = Ds4Tracker::default();
        feed(&mut tracker, USB_PATH, &usb_report(), 0);
        let removed = tracker.on_removed(USB_PATH);
        assert!(matches!(removed, Some(PadEvent::Disconnected { .. })));
        assert_eq!(tracker.pad_count(), 0);
        assert!(tracker.on_removed(USB_PATH).is_none(), "second removal is a no-op");
        // Reconnect is a fresh Connected event with a fresh State.
        let again = feed(&mut tracker, USB_PATH, &usb_report(), 100);
        assert!(matches!(again.first(), Some(PadEvent::Connected { .. })));
        assert!(matches!(again.get(1), Some(PadEvent::State(_))));
        // Silent pads are pruned, active ones are kept.
        assert!(tracker.prune(100 + PAD_STALE_MS - 1).is_empty());
        let pruned = tracker.prune(100 + PAD_STALE_MS);
        assert!(matches!(pruned.as_slice(), [PadEvent::Disconnected { .. }]));
        assert_eq!(tracker.pad_count(), 0);
    }

    #[test]
    fn tracker_caps_the_number_of_pads_without_evicting_active_ones() {
        let mut tracker = Ds4Tracker::default();
        for index in 0..MAX_TRACKED_PADS {
            let path = format!(r"\\?\HID#VID_054C&PID_09CC#unit{index}");
            assert!(!feed(&mut tracker, &path, &usb_report(), 0).is_empty());
        }
        assert!(feed(&mut tracker, r"\\?\HID#VID_054C&PID_09CC#overflow", &usb_report(), 1).is_empty());
        assert_eq!(tracker.pad_count(), MAX_TRACKED_PADS);
        assert_eq!(tracker.clear().len(), MAX_TRACKED_PADS);
    }

    #[test]
    fn snapshot_never_contains_the_device_path() {
        let mut tracker = Ds4Tracker::default();
        let events = feed(&mut tracker, USB_PATH, &usb_report(), 0);
        let json = events
            .iter()
            .filter_map(|event| match event {
                PadEvent::State(snapshot) => serde_json::to_string(snapshot).ok(),
                _ => None,
            })
            .next()
            .expect("state");
        assert!(!json.to_ascii_lowercase().contains("hid#"));
        assert!(!json.to_ascii_lowercase().contains("vid_054c"));
        assert!(!json.contains("7&2a3b4c5d"));
    }
}
