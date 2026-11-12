use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const DISPLAY_CHANGED_EVENT: &str = "velora-display-changed";

const MAX_DISPLAYS: usize = 16;

#[cfg(target_os = "windows")]
const MAX_AUDIO_ENDPOINTS: usize = 32;
#[cfg(target_os = "windows")]
const MAX_LABEL_CHARS: usize = 96;
#[cfg(target_os = "windows")]
const MONITOR_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "windows")]
static DISPLAY_MONITOR_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(target_os = "windows")]
static DISPLAY_MONITOR_STOP: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub bits_per_pixel: u32,
    pub primary: bool,
    pub hdr: Option<bool>,
    pub hdr_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEndpointInfo {
    pub id: String,
    pub name: String,
    pub state: String,
    pub default_device: bool,
    pub volume_percent: Option<u8>,
    pub muted: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayAudioPolicy {
    pub read_only: bool,
    pub automatic_mode_changes: bool,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayAudioSnapshot {
    pub windows: bool,
    pub supported: bool,
    pub displays: Vec<DisplayInfo>,
    pub audio: Vec<AudioEndpointInfo>,
    pub display_error: Option<String>,
    pub audio_error: Option<String>,
    pub policy: DisplayAudioPolicy,
    pub limitations: Vec<String>,
    pub display_signature: String,
    pub captured_at_ms: u64,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayChangedEvent {
    pub previous_signature: String,
    pub display_signature: String,
    pub displays: Vec<DisplayInfo>,
    pub at_ms: u64,
}

#[tauri::command]
pub async fn get_display_audio_status() -> DisplayAudioSnapshot {
    tauri::async_runtime::spawn_blocking(snapshot)
        .await
        .unwrap_or_else(|_| {
            unavailable_snapshot("Wątek diagnostyki wyświetlaczy i audio został przerwany.")
        })
}

pub(crate) fn snapshot() -> DisplayAudioSnapshot {
    let policy = read_only_policy();
    let limitations = limitations();
    let captured_at_ms = now_ms();

    #[cfg(target_os = "windows")]
    {
        let (displays, display_error, signature) = display_state();
        let (audio, audio_error) = windows_native::read_audio();
        DisplayAudioSnapshot {
            windows: true,
            supported: true,
            displays,
            audio,
            display_error,
            audio_error,
            policy,
            limitations,
            display_signature: signature,
            captured_at_ms,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let (displays, display_error, signature) = display_state();
        DisplayAudioSnapshot {
            windows: false,
            supported: false,
            displays,
            audio: Vec::new(),
            display_error,
            audio_error: None,
            policy,
            limitations,
            display_signature: signature,
            captured_at_ms,
        }
    }
}

fn display_state() -> (Vec<DisplayInfo>, Option<String>, String) {
    #[cfg(target_os = "windows")]
    {
        let (displays, error) = windows_native::read_displays();
        let signature = display_signature(&displays);
        (displays, error, signature)
    }

    #[cfg(not(target_os = "windows"))]
    {
        (Vec::new(), None, display_signature(&[]))
    }
}

pub(crate) fn display_signature(displays: &[DisplayInfo]) -> String {
    let mut ordered: Vec<&DisplayInfo> = displays.iter().collect();
    ordered.sort_by(|left, right| left.id.cmp(&right.id));
    ordered.truncate(MAX_DISPLAYS);

    let mut normalized = String::with_capacity(ordered.len() * 48);
    for display in ordered {
        use std::fmt::Write as _;
        let hdr = match display.hdr {
            Some(true) => "1",
            Some(false) => "0",
            None => "-",
        };
        let _ = write!(
            &mut normalized,
            "{}:{}x{}@{}/{}/{};",
            display.id,
            display.width,
            display.height,
            display.refresh_hz,
            display.bits_per_pixel,
            if display.primary { "1" } else { "0" }
        );
        let _ = write!(&mut normalized, "{hdr};");
    }
    short_hash(&normalized)
}

pub(crate) fn start_monitor(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::Ordering;
        use tauri::Emitter;

        if DISPLAY_MONITOR_STARTED.swap(true, Ordering::AcqRel) {
            return;
        }
        DISPLAY_MONITOR_STOP.store(false, Ordering::Release);

        let spawned = std::thread::Builder::new()
            .name("velora-display-monitor".into())
            .spawn(move || {
                let mut previous_signature: Option<String> = None;
                loop {
                    if DISPLAY_MONITOR_STOP.load(Ordering::Acquire) {
                        break;
                    }
                    let (displays, display_error, signature) = display_state();
                    let readable = !(displays.is_empty() && display_error.is_some());
                    if readable {
                        match previous_signature.clone() {
                            Some(previous) if previous != signature => {
                                let event = DisplayChangedEvent {
                                    previous_signature: previous,
                                    display_signature: signature.clone(),
                                    displays,
                                    at_ms: now_ms(),
                                };
                                let _ = app.emit(DISPLAY_CHANGED_EVENT, event);
                                previous_signature = Some(signature);
                            }
                            None => previous_signature = Some(signature),
                            _ => {}
                        }
                    }
                    std::thread::sleep(MONITOR_INTERVAL);
                }
            });

        if spawned.is_err() {
            DISPLAY_MONITOR_STARTED.store(false, Ordering::Release);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

pub(crate) fn stop_monitor() {
    #[cfg(target_os = "windows")]
    DISPLAY_MONITOR_STOP.store(true, std::sync::atomic::Ordering::Release);
}

fn unavailable_snapshot(message: &str) -> DisplayAudioSnapshot {
    DisplayAudioSnapshot {
        windows: cfg!(target_os = "windows"),
        supported: false,
        displays: Vec::new(),
        audio: Vec::new(),
        display_error: Some(message.to_string()),
        audio_error: Some(message.to_string()),
        policy: read_only_policy(),
        limitations: limitations(),
        display_signature: String::new(),
        captured_at_ms: now_ms(),
    }
}

fn read_only_policy() -> DisplayAudioPolicy {
    DisplayAudioPolicy {
        read_only: true,
        automatic_mode_changes: false,
        notes: vec![
            "Ten build tylko odczytuje stan wyświetlaczy i audio.".to_string(),
            "VELORA nie zmienia rozdzielczości, HDR, głośności ani domyślnych urządzeń."
                .to_string(),
            "Automatyczne przełączanie trybów obrazu i dźwięku jest wyłączone.".to_string(),
            "Tryb 4K 60 Hz dla Panasonic nie jest zakładany; raport pokazuje rzeczywisty tryb zgłoszony przez Windows.".to_string(),
        ],
    }
}

fn limitations() -> Vec<String> {
    let mut items = vec![
        "Moduł jest fundamentem diagnostycznym; nie zawiera jeszcze silnika scen.".to_string(),
        "HDR jest raportowany tylko wtedy, gdy Windows udostępni stan zaawansowanego koloru; w przeciwnym razie hdr ma wartość null, a hdrError opisuje przyczynę. Wartość hdr odzwierciedla stan zaawansowanego koloru Windows, a nie certyfikację HDR monitora.".to_string(),
        "Odświeżanie i głębia kolorów opisują bieżący tryb systemowy, a nie maksymalne możliwości monitora; wartość 0 oznacza, że Windows nie zwrócił danych.".to_string(),
        "Identyfikatory monitorów i punktów końcowych audio są nieodwracalnymi skrótami; surowe ścieżki urządzeń nie opuszczają backendu.".to_string(),
        "Identyfikator monitora jest oparty na ścieżce urządzenia Windows; jeśli system jej nie zwróci, identyfikator może zmienić się po ponownym uruchomieniu.".to_string(),
        "Lista audio obejmuje urządzenia renderujące w każdym stanie; głośność i wyciszenie są odczytywane tylko dla aktywnych punktów końcowych.".to_string(),
        "Zmiana HDMI jest wnioskowana z sygnatury aktywnych monitorów i trybu; moduł nie odczytuje nazwy portu HDMI ani nie negocjuje trybu.".to_string(),
    ];

    if cfg!(target_os = "windows") {
        items.push(
            "Automatyczna zmiana trybu obrazu nie jest zaimplementowana w tym buildzie."
                .to_string(),
        );
    } else {
        items.push(
            "Diagnostyka wyświetlaczy i audio jest dostępna wyłącznie w natywnej aplikacji Windows."
                .to_string(),
        );
    }

    items
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn short_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(target_os = "windows")]
fn normalize_identifier(raw: &str) -> String {
    let trimmed =
        raw.trim_matches(|character: char| character == '\0' || character.is_whitespace());
    let mut normalized = String::with_capacity(trimmed.len().min(1024));
    for character in trimmed.chars().take(1024) {
        normalized.extend(character.to_lowercase());
    }
    normalized
}

#[cfg(target_os = "windows")]
fn hash_identifier(namespace: &str, raw: &str, fallback: &str) -> String {
    let normalized = normalize_identifier(raw);
    let value = if normalized.is_empty() {
        fallback
    } else {
        normalized.as_str()
    };
    short_hash(&format!("{namespace}:{value}"))
}

#[cfg(target_os = "windows")]
fn sanitize_label(raw: &str) -> String {
    let mut sanitized = String::with_capacity(raw.len().min(MAX_LABEL_CHARS * 4));
    let mut pending_space = false;
    let mut written = 0usize;

    for character in raw.chars() {
        if written >= MAX_LABEL_CHARS {
            break;
        }
        if character == '\0'
            || character.is_control()
            || matches!(
                character,
                '\u{200b}'..='\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
        {
            continue;
        }
        if character.is_whitespace() {
            if !sanitized.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space && !sanitized.is_empty() {
            sanitized.push(' ');
            written += 1;
        }
        pending_space = false;
        sanitized.push(character);
        written += 1;
    }

    sanitized.trim().to_string()
}

#[cfg(target_os = "windows")]
mod windows_native {
    use super::{
        hash_identifier, normalize_identifier, sanitize_label, AudioEndpointInfo, DisplayInfo,
        MAX_AUDIO_ENDPOINTS, MAX_DISPLAYS,
    };
    use ::windows::core::{BOOL, PCWSTR, PWSTR};
    use ::windows::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
        DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
        DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
        DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
        DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
    };
    use ::windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use ::windows::Win32::Foundation::{
        ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, LPARAM, RECT, RPC_E_CHANGED_MODE,
    };
    use ::windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW, DEVMODEW,
        ENUM_CURRENT_SETTINGS, HDC, HMONITOR, MONITORINFOEXW,
    };
    use ::windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use ::windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE,
        DEVICE_STATEMASK_ALL, DEVICE_STATE_ACTIVE, DEVICE_STATE_DISABLED, DEVICE_STATE_NOTPRESENT,
        DEVICE_STATE_UNPLUGGED,
    };
    use ::windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToString, PROPVARIANT,
    };
    use ::windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED, STGM_READ,
    };

    const MAX_DIMENSION: u32 = 65_535;
    const MAX_REFRESH_HZ: u32 = 1_000;
    const MAX_CONFIG_PATHS: usize = 64;
    const MAX_CONFIG_MODES: usize = 256;
    const MAX_ENDPOINT_ID_CHARS: usize = 1_024;
    const MONITORINFOF_PRIMARY: u32 = 1;

    struct MonitorEnumContext {
        monitors: Vec<RawMonitor>,
        truncated: bool,
    }

    struct RawMonitor {
        device_name: [u16; 32],
        width: u32,
        height: u32,
        primary: bool,
    }

    struct DisplayConfigEntry {
        source_key: String,
        device_key: String,
        friendly_name: Option<String>,
        hdr: Option<bool>,
        hdr_error: Option<String>,
    }

    struct ActivePaths {
        paths: Vec<DISPLAYCONFIG_PATH_INFO>,
    }

    pub(super) fn read_displays() -> (Vec<DisplayInfo>, Option<String>) {
        let config_entries = read_display_config_entries();
        let mut context = MonitorEnumContext {
            monitors: Vec::new(),
            truncated: false,
        };

        let enumerated = unsafe {
            EnumDisplayMonitors(
                None,
                None,
                Some(enum_monitor),
                LPARAM(&mut context as *mut MonitorEnumContext as isize),
            )
        };

        if context.monitors.is_empty() {
            return if enumerated.as_bool() {
                (Vec::new(), None)
            } else {
                (
                    Vec::new(),
                    Some("EnumDisplayMonitors nie zwrócił żadnego monitora.".to_string()),
                )
            };
        }

        let mut displays = Vec::with_capacity(context.monitors.len().min(MAX_DISPLAYS));
        for (index, monitor) in context.monitors.into_iter().enumerate() {
            let gdi_name = wide_z_to_string(&monitor.device_name);
            let normalized_name = normalize_identifier(&gdi_name);
            let entry = config_entries
                .iter()
                .find(|candidate| candidate.source_key == normalized_name);

            let mut width = monitor.width;
            let mut height = monitor.height;
            let mut refresh_hz = 0u32;
            let mut bits_per_pixel = 0u32;

            let mut devmode = DEVMODEW {
                dmSize: core::mem::size_of::<DEVMODEW>() as u16,
                ..Default::default()
            };
            let mode_ok = unsafe {
                EnumDisplaySettingsW(
                    PCWSTR::from_raw(monitor.device_name.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &mut devmode,
                )
            };
            if mode_ok.as_bool() {
                if devmode.dmPelsWidth > 0 && devmode.dmPelsWidth <= MAX_DIMENSION {
                    width = devmode.dmPelsWidth;
                }
                if devmode.dmPelsHeight > 0 && devmode.dmPelsHeight <= MAX_DIMENSION {
                    height = devmode.dmPelsHeight;
                }
                if devmode.dmDisplayFrequency > 0 && devmode.dmDisplayFrequency <= MAX_REFRESH_HZ {
                    refresh_hz = devmode.dmDisplayFrequency;
                }
                if devmode.dmBitsPerPel > 0 && devmode.dmBitsPerPel <= 64 {
                    bits_per_pixel = devmode.dmBitsPerPel;
                }
            }

            let fallback_name = fallback_display_name(&gdi_name);
            let (name, id_source, hdr, hdr_error) = match entry {
                Some(entry) => {
                    let name = entry
                        .friendly_name
                        .as_deref()
                        .map(sanitize_label)
                        .filter(|value| !value.is_empty())
                        .unwrap_or(fallback_name);
                    (
                        name,
                        entry.device_key.clone(),
                        entry.hdr,
                        entry.hdr_error.clone(),
                    )
                }
                None => (
                    fallback_name,
                    format!("gdi:{normalized_name}"),
                    None,
                    Some(
                        "Windows nie udostępnił danych DisplayConfig dla tego monitora."
                            .to_string(),
                    ),
                ),
            };

            let clean_name = sanitize_label(&name);
            displays.push(DisplayInfo {
                id: hash_identifier("display", &id_source, &format!("display-index:{index}")),
                name: if clean_name.is_empty() {
                    format!("Monitor {}", index + 1)
                } else {
                    clean_name
                },
                width,
                height,
                refresh_hz,
                bits_per_pixel,
                primary: monitor.primary,
                hdr,
                hdr_error,
            });
        }

        displays.sort_by(|left, right| left.id.cmp(&right.id));
        displays.dedup_by(|left, right| left.id == right.id);
        displays.sort_by(|left, right| {
            right
                .primary
                .cmp(&left.primary)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut error = if context.truncated {
            Some(format!(
                "Windows zgłosił więcej niż {MAX_DISPLAYS} monitorów; lista została ograniczona."
            ))
        } else {
            None
        };

        if displays.is_empty() && error.is_none() {
            error = Some("Nie udało się odczytać żadnego monitora.".to_string());
        }

        (displays, error)
    }

    unsafe extern "system" fn enum_monitor(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let context = unsafe { &mut *(data.0 as *mut MonitorEnumContext) };
        if context.monitors.len() >= MAX_DISPLAYS {
            context.truncated = true;
            return false.into();
        }

        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = core::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(hmonitor, &mut info.monitorInfo) }.as_bool() {
            context.monitors.push(RawMonitor {
                device_name: info.szDevice,
                width: dimension(
                    info.monitorInfo.rcMonitor.right,
                    info.monitorInfo.rcMonitor.left,
                ),
                height: dimension(
                    info.monitorInfo.rcMonitor.bottom,
                    info.monitorInfo.rcMonitor.top,
                ),
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        true.into()
    }

    fn dimension(high: i32, low: i32) -> u32 {
        let value = i64::from(high) - i64::from(low);
        if value <= 0 {
            0
        } else {
            value.min(i64::from(MAX_DIMENSION)) as u32
        }
    }

    fn fallback_display_name(gdi_name: &str) -> String {
        let digits: String = gdi_name
            .chars()
            .filter(|character| character.is_ascii_digit())
            .take(4)
            .collect();
        if digits.is_empty() {
            "Monitor".to_string()
        } else {
            format!("Monitor {digits}")
        }
    }

    fn read_display_config_entries() -> Vec<DisplayConfigEntry> {
        let active = match query_active_paths() {
            Ok(active) => active,
            Err(_) => return Vec::new(),
        };

        let mut entries = Vec::with_capacity(active.paths.len().min(MAX_CONFIG_PATHS));
        for path in active.paths {
            if !path.targetInfo.targetAvailable.as_bool() {
                continue;
            }
            let source_key = match source_gdi_name(&path) {
                Some(name) if !name.trim().is_empty() => normalize_identifier(&name),
                _ => continue,
            };
            let (friendly_name, device_key) = target_identity(&path);
            let (hdr, hdr_error) = advanced_color_state(&path);
            entries.push(DisplayConfigEntry {
                source_key,
                device_key,
                friendly_name,
                hdr,
                hdr_error,
            });
        }
        entries
    }

    fn query_active_paths() -> Result<ActivePaths, String> {
        for _ in 0..3 {
            let mut path_count = 0u32;
            let mut mode_count = 0u32;
            let status = unsafe {
                GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
            };
            if status != ERROR_SUCCESS {
                return Err(format!(
                    "GetDisplayConfigBufferSizes zwrócił kod {}.",
                    status.0
                ));
            }
            if path_count == 0 {
                return Ok(ActivePaths { paths: Vec::new() });
            }
            if path_count as usize > MAX_CONFIG_PATHS || mode_count as usize > MAX_CONFIG_MODES {
                return Err(format!(
                    "DisplayConfig zgłosił {path_count} ścieżek i {mode_count} trybów, co przekracza bezpieczny limit."
                ));
            }

            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
            let status = unsafe {
                QueryDisplayConfig(
                    QDC_ONLY_ACTIVE_PATHS,
                    &mut path_count,
                    paths.as_mut_ptr(),
                    &mut mode_count,
                    modes.as_mut_ptr(),
                    None,
                )
            };
            if status == ERROR_SUCCESS {
                paths.truncate(path_count as usize);
                return Ok(ActivePaths { paths });
            }
            if status != ERROR_INSUFFICIENT_BUFFER {
                return Err(format!("QueryDisplayConfig zwrócił kod {}.", status.0));
            }
        }
        Err("QueryDisplayConfig nie ustabilizował listy aktywnych ścieżek.".to_string())
    }

    fn source_gdi_name(path: &DISPLAYCONFIG_PATH_INFO) -> Option<String> {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
        source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        source.header.size = core::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
        source.header.adapterId = path.sourceInfo.adapterId;
        source.header.id = path.sourceInfo.id;
        let status = unsafe { DisplayConfigGetDeviceInfo(&mut source.header as *mut _) };
        if status != 0 {
            return None;
        }
        Some(wide_z_to_string(&source.viewGdiDeviceName))
    }

    fn target_identity(path: &DISPLAYCONFIG_PATH_INFO) -> (Option<String>, String) {
        let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
        target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
        target.header.size = core::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
        target.header.adapterId = path.targetInfo.adapterId;
        target.header.id = path.targetInfo.id;

        let status = unsafe { DisplayConfigGetDeviceInfo(&mut target.header as *mut _) };
        if status != 0 {
            return (
                None,
                format!(
                    "displayconfig:{}:{}:{}",
                    path.targetInfo.adapterId.HighPart,
                    path.targetInfo.adapterId.LowPart,
                    path.targetInfo.id
                ),
            );
        }

        let name = wide_z_to_string(&target.monitorFriendlyDeviceName);
        let path_text = wide_z_to_string(&target.monitorDevicePath);
        let device_key = if path_text.trim().is_empty() {
            format!(
                "displayconfig:{}:{}:{}",
                path.targetInfo.adapterId.HighPart,
                path.targetInfo.adapterId.LowPart,
                path.targetInfo.id
            )
        } else {
            path_text
        };
        (
            if name.trim().is_empty() {
                None
            } else {
                Some(name)
            },
            device_key,
        )
    }

    fn advanced_color_state(path: &DISPLAYCONFIG_PATH_INFO) -> (Option<bool>, Option<String>) {
        let mut color = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO::default();
        color.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
        color.header.size = core::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32;
        color.header.adapterId = path.targetInfo.adapterId;
        color.header.id = path.targetInfo.id;

        let status = unsafe { DisplayConfigGetDeviceInfo(&mut color.header as *mut _) };
        if status != 0 {
            return (
                None,
                Some(format!(
                    "Windows nie udostępnił informacji o HDR (kod {status})."
                )),
            );
        }

        let flags = unsafe { color.Anonymous.value };
        let supported = flags & 0b1 != 0;
        let enabled = flags & 0b10 != 0;
        if supported {
            (Some(enabled), None)
        } else {
            (Some(false), None)
        }
    }

    pub(super) fn read_audio() -> (Vec<AudioEndpointInfo>, Option<String>) {
        match read_audio_result() {
            Ok(result) => result,
            Err(error) => (Vec::new(), Some(error)),
        }
    }

    fn read_audio_result() -> Result<(Vec<AudioEndpointInfo>, Option<String>), String> {
        let _apartment = ComApartment::initialize()?;

        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(
                |error| format!("Core Audio: nie można utworzyć MMDeviceEnumerator ({error})."),
            )?;

        let default_id = match unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) } {
            Ok(device) => read_endpoint_id(&device).map(|id| normalize_identifier(&id)),
            Err(_) => None,
        };

        let collection =
            unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE(DEVICE_STATEMASK_ALL)) }
                .map_err(|error| {
                format!("Core Audio: nie można wyliczyć urządzeń renderujących ({error}).")
            })?;

        let total = unsafe { collection.GetCount() }
            .map_err(|error| format!("Core Audio: brak liczby urządzeń ({error})."))?
            as usize;
        let count = total.min(MAX_AUDIO_ENDPOINTS);

        let mut endpoints = Vec::with_capacity(count);
        let mut skipped = 0usize;
        for index in 0..count {
            let device = match unsafe { collection.Item(index as u32) } {
                Ok(device) => device,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let raw_id = match read_endpoint_id(&device) {
                Some(id) => id,
                None => {
                    skipped += 1;
                    continue;
                }
            };
            let normalized_id = normalize_identifier(&raw_id);
            if normalized_id.is_empty() {
                skipped += 1;
                continue;
            }

            let state = unsafe { device.GetState() }.unwrap_or(DEVICE_STATE(0));
            let (volume_percent, muted) = if state.0 & DEVICE_STATE_ACTIVE.0 != 0 {
                read_endpoint_volume(&device).unwrap_or((None, None))
            } else {
                (None, None)
            };

            let friendly = read_friendly_name(&device).unwrap_or_default();
            let clean_name = sanitize_label(&friendly);
            let name = if clean_name.is_empty() {
                format!("Wyjście audio {}", index + 1)
            } else {
                clean_name
            };

            endpoints.push(AudioEndpointInfo {
                id: hash_identifier("audio", &raw_id, &format!("audio-index:{index}")),
                name,
                state: state_label(state).to_string(),
                default_device: default_id.as_deref() == Some(normalized_id.as_str()),
                volume_percent,
                muted,
            });
        }

        endpoints.sort_by(|left, right| left.id.cmp(&right.id));
        endpoints.dedup_by(|left, right| left.id == right.id);
        endpoints.sort_by(|left, right| {
            right
                .default_device
                .cmp(&left.default_device)
                .then_with(|| left.state.cmp(&right.state))
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut warnings = Vec::new();
        if total > count {
            warnings.push(format!(
                "Windows zgłosił {total} punktów końcowych audio; pokazano pierwsze {count}."
            ));
        }
        if skipped > 0 {
            warnings.push(format!(
                "Nie udało się odczytać {skipped} punktów końcowych audio."
            ));
        }
        if default_id.is_none() && total > 0 {
            warnings.push("Nie udało się ustalić domyślnego urządzenia audio.".to_string());
        }

        Ok((
            endpoints,
            if warnings.is_empty() {
                None
            } else {
                Some(warnings.join(" "))
            },
        ))
    }

    fn read_endpoint_id(device: &IMMDevice) -> Option<String> {
        let pointer = unsafe { device.GetId() }.ok()?;
        if pointer.is_null() {
            return None;
        }
        let value = unsafe { read_bounded_pwstr(pointer, MAX_ENDPOINT_ID_CHARS) };
        unsafe {
            CoTaskMemFree(Some(pointer.0 as *const core::ffi::c_void));
        }
        Some(value)
    }

    unsafe fn read_bounded_pwstr(pointer: PWSTR, max_chars: usize) -> String {
        if pointer.is_null() {
            return String::new();
        }
        let mut length = 0usize;
        while length < max_chars {
            let unit = unsafe { *pointer.0.add(length) };
            if unit == 0 {
                break;
            }
            length += 1;
        }
        let slice = unsafe { core::slice::from_raw_parts(pointer.0, length) };
        String::from_utf16_lossy(slice)
    }

    fn read_friendly_name(device: &IMMDevice) -> Option<String> {
        let store = unsafe { device.OpenPropertyStore(STGM_READ) }.ok()?;
        let mut property: PROPVARIANT =
            unsafe { store.GetValue(&PKEY_Device_FriendlyName) }.ok()?;
        let mut buffer = [0u16; 256];
        let conversion = unsafe { PropVariantToString(&property, &mut buffer) };
        let _ = unsafe { PropVariantClear(&mut property) };
        conversion.ok()?;
        if buffer[0] == 0 {
            return None;
        }
        Some(wide_z_to_string(&buffer))
    }

    fn read_endpoint_volume(device: &IMMDevice) -> Option<(Option<u8>, Option<bool>)> {
        let endpoint: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None) }.ok()?;
        let volume = unsafe { endpoint.GetMasterVolumeLevelScalar() }
            .ok()
            .and_then(volume_percent);
        let muted = unsafe { endpoint.GetMute() }
            .ok()
            .map(|value| value.as_bool());
        Some((volume, muted))
    }

    fn volume_percent(scalar: f32) -> Option<u8> {
        if !scalar.is_finite() {
            return None;
        }
        Some((scalar.clamp(0.0, 1.0) * 100.0).round() as u8)
    }

    fn state_label(state: DEVICE_STATE) -> &'static str {
        if state.0 & DEVICE_STATE_ACTIVE.0 != 0 {
            "active"
        } else if state.0 & DEVICE_STATE_DISABLED.0 != 0 {
            "disabled"
        } else if state.0 & DEVICE_STATE_NOTPRESENT.0 != 0 {
            "notPresent"
        } else if state.0 & DEVICE_STATE_UNPLUGGED.0 != 0 {
            "unplugged"
        } else {
            "unknown"
        }
    }

    struct ComApartment {
        uninitialize: bool,
    }

    impl ComApartment {
        fn initialize() -> Result<Self, String> {
            let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if result.is_ok() {
                Ok(Self { uninitialize: true })
            } else if result == RPC_E_CHANGED_MODE {
                Ok(Self {
                    uninitialize: false,
                })
            } else {
                Err(format!("COM nie zainicjalizował się ({result:?})."))
            }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.uninitialize {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn wide_z_to_string(buffer: &[u16]) -> String {
        let length = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..length])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(id: &str, width: u32, height: u32, refresh_hz: u32, primary: bool) -> DisplayInfo {
        DisplayInfo {
            id: id.to_string(),
            name: format!("Monitor {id}"),
            width,
            height,
            refresh_hz,
            bits_per_pixel: 32,
            primary,
            hdr: Some(false),
            hdr_error: None,
        }
    }

    #[test]
    fn stable_hash_is_deterministic_and_hides_input() {
        assert_eq!(short_hash("hello"), "a430d84680aabd0b");
        assert_eq!(short_hash("hello"), short_hash("hello"));

        let monitor_path =
            r"\\?\DISPLAY#DELA123#5&1a2b3c4d&0&UID4352#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";
        let monitor_hash = short_hash(monitor_path);
        assert_eq!(monitor_hash.len(), 16);
        assert!(monitor_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
        assert!(!monitor_hash.contains("DISPLAY"));
        assert!(!monitor_hash.contains(monitor_path));

        let endpoint = "{0.0.0.00000000}.{8f7f4c1e-6d7a-4f3b-9c2e-1a5b6c7d8e9f}";
        let endpoint_hash = short_hash(endpoint);
        assert_ne!(endpoint_hash, endpoint);
        assert_eq!(endpoint_hash.len(), 16);
    }

    #[test]
    fn signature_is_stable_and_order_independent() {
        let first = display("alpha", 1920, 1080, 60, true);
        let second = display("beta", 2560, 1440, 144, false);

        let signature = display_signature(&[first.clone(), second.clone()]);
        assert_eq!(signature, display_signature(&[second, first]));
        assert_eq!(signature.len(), 16);
        assert!(signature
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
    }

    #[test]
    fn signature_detects_monitor_loss_and_mode_change() {
        let left = display("alpha", 1920, 1080, 60, true);
        let right = display("beta", 2560, 1440, 144, false);

        let both = display_signature(&[left.clone(), right.clone()]);
        let lost = display_signature(&[left.clone()]);
        let lower_refresh = DisplayInfo {
            refresh_hz: 60,
            ..right.clone()
        };
        let changed = display_signature(&[left.clone(), lower_refresh]);

        assert_ne!(both, lost);
        assert_ne!(both, changed);
        assert_ne!(lost, changed);
        assert_eq!(both, display_signature(&[left, right]));
    }

    #[test]
    fn signature_tracks_primary_and_hdr_state() {
        let base = display("alpha", 1920, 1080, 60, true);
        let not_primary = DisplayInfo {
            primary: false,
            ..base.clone()
        };
        let hdr_enabled = DisplayInfo {
            hdr: Some(true),
            ..base.clone()
        };
        let hdr_unknown = DisplayInfo {
            hdr: None,
            hdr_error: Some("Windows nie udostępnił informacji o HDR (kod 50).".to_string()),
            ..base.clone()
        };

        let signature = display_signature(&[base]);
        assert_ne!(signature, display_signature(&[not_primary]));
        assert_ne!(signature, display_signature(&[hdr_enabled]));
        assert_ne!(signature, display_signature(&[hdr_unknown]));
    }

    #[test]
    fn snapshot_serializes_read_only_policy() {
        let value = serde_json::to_value(snapshot()).expect("snapshot powinien się serializować");
        assert_eq!(value["policy"]["readOnly"], true);
        assert_eq!(value["policy"]["automaticModeChanges"], false);
        assert_eq!(value["policy"]["notes"].as_array().map(Vec::len), Some(4));
    }

    #[test]
    fn hdr_none_stays_null_and_explains_why() {
        let unknown = DisplayInfo {
            id: short_hash("display:unknown"),
            name: "Monitor".to_string(),
            width: 3840,
            height: 2160,
            refresh_hz: 60,
            bits_per_pixel: 32,
            primary: true,
            hdr: None,
            hdr_error: Some("Windows nie udostępnił informacji o HDR (kod 50).".to_string()),
        };

        let value = serde_json::to_value(&unknown).expect("DisplayInfo powinien się serializować");
        assert!(value["hdr"].is_null());
        assert!(!value["hdr"].is_boolean());
        assert_eq!(
            value["hdrError"],
            "Windows nie udostępnił informacji o HDR (kod 50)."
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_snapshot_is_an_honest_stub() {
        let snapshot = snapshot();
        assert!(!snapshot.windows);
        assert!(!snapshot.supported);
        assert!(snapshot.displays.is_empty());
        assert!(snapshot.audio.is_empty());
        assert!(snapshot.display_error.is_none());
        assert!(snapshot.audio_error.is_none());
        assert!(snapshot.policy.read_only);
        assert!(!snapshot.policy.automatic_mode_changes);
        assert!(snapshot
            .limitations
            .iter()
            .any(|line| line.contains("Windows")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn labels_do_not_keep_control_characters() {
        assert_eq!(sanitize_label("Monitor\u{0}\n 1\u{202e}"), "Monitor 1");
    }
}
