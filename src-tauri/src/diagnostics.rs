//! Read-only diagnostics snapshot and sanitized MSI export.
//!
//! The export is built from typed fields only. It never includes remote-access
//! pairing material, credentials, window titles, raw device paths or unchecked
//! free-form JSON. Every string is still scrubbed for user-profile paths and
//! control characters before hashing.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::control_service::ControlService;
use crate::display_audio::{self, DisplayAudioSnapshot};
use crate::launch_registry::{LaunchRegistry, LaunchRegistrySnapshot};
use crate::operation_registry::SessionOperation;
use crate::pad_hub::{NativeControllerStatus, PadHub};
use crate::session_orchestrator::{self, SessionOrchestrator, SessionSnapshot};
use crate::window_broker::{WindowBroker, WindowBrokerSnapshot};

pub(crate) const MAX_EXPORT_BYTES: usize = 256 * 1024;
const MAX_STRING_CHARS: usize = 240;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    pub build_sha: String,
    pub checkout_sha: String,
    pub branch: String,
    pub build_ref: String,
    pub dirty: String,
    pub event: String,
    pub pr_head_sha: Option<String>,
    pub pr_base_sha: Option<String>,
    pub target: String,
    pub profile: String,
    pub rustc_version: String,
    pub windows: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsError {
    pub source: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub generated_at_ms: u64,
    pub build: BuildInfo,
    pub session: SessionSnapshot,
    pub session_operations: Vec<SessionOperation>,
    pub persistence_error: Option<String>,
    pub launch_registry: LaunchRegistrySnapshot,
    pub window_broker: WindowBrokerSnapshot,
    pub control_service: crate::control_service::ControlServiceStatus,
    pub native_controller: NativeControllerStatus,
    pub display_audio: DisplayAudioSnapshot,
    pub remote: RemoteDiagnostics,
    pub errors: Vec<DiagnosticsError>,
    pub limitations: Vec<String>,
}

/// Deliberately excludes device names, origins, pairing credentials and certificate paths.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDiagnostics {
    pub enabled: bool,
    pub secure_origin_available: bool,
    pub paired_device_count: usize,
    pub recovery_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExport {
    pub generated_at_ms: u64,
    pub sha256: String,
    pub report_json: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub(crate) fn build_info() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_sha: option_env!("VELORA_BUILD_SHA")
            .filter(|value| !value.is_empty() && *value != "unknown")
            .unwrap_or("unknown")
            .to_string(),
        checkout_sha: option_env!("VELORA_CHECKOUT_SHA")
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string(),
        branch: option_env!("VELORA_BUILD_BRANCH")
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string(),
        build_ref: option_env!("VELORA_BUILD_REF")
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string(),
        dirty: option_env!("VELORA_BUILD_DIRTY")
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string(),
        event: option_env!("VELORA_BUILD_EVENT")
            .filter(|value| !value.is_empty())
            .unwrap_or("local")
            .to_string(),
        pr_head_sha: option_env!("VELORA_PR_HEAD_SHA")
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        pr_base_sha: option_env!("VELORA_PR_BASE_SHA")
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        target: option_env!("VELORA_BUILD_TARGET")
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string(),
        profile: option_env!("VELORA_BUILD_PROFILE")
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string(),
        rustc_version: option_env!("VELORA_RUSTC_VERSION")
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string(),
        windows: cfg!(target_os = "windows"),
    }
}

fn limitations() -> Vec<String> {
    vec![
        "Diagnostyka jest tylko do odczytu: VELORA nie zmienia rozdzielczości, HDR, domyślnego urządzenia audio ani ustawień Windows.".into(),
        "Brak weryfikacji sprzętowej na MSI, Panasonicu i fizycznym DualSense; te testy pozostają bramką akceptacyjną.".into(),
        "Windows może odmówić SetForegroundWindow; wynik odmowy jest raportowany, nie maskowany.".into(),
        "Steam Input lub inny program może ukryć raporty Raw Input pada; VELORA nie przechwytuje ani nie blokuje wejścia gry.".into(),
        "Raport nie zawiera tokenów parowania, kluczy, danych logowania, tytułów obcych okien ani prywatnych ścieżek użytkownika.".into(),
        "Gra uruchomiona poza drzewem procesów Steam może nie zostać skojarzona; raport pokaże brak okna lub timeout.".into(),
    ]
}

fn collect_errors(snapshot: &DiagnosticsSnapshot) -> Vec<DiagnosticsError> {
    let mut errors = Vec::new();
    if let Some(error) = snapshot.persistence_error.as_ref() {
        errors.push(DiagnosticsError {
            source: "sessionPersistence".into(),
            message: error.clone(),
        });
    }
    if let Some(error) = snapshot.launch_registry.last_error.as_ref() {
        errors.push(DiagnosticsError {
            source: "launchRegistry".into(),
            message: error.clone(),
        });
    }
    if let Some(error) = snapshot.window_broker.last_error.as_ref() {
        errors.push(DiagnosticsError {
            source: "windowBroker".into(),
            message: error.clone(),
        });
    }
    if let Some(error) = snapshot.control_service.last_error.as_ref() {
        errors.push(DiagnosticsError {
            source: "controlService".into(),
            message: error.clone(),
        });
    }
    if let Some(error) = snapshot.native_controller.last_error.as_ref() {
        errors.push(DiagnosticsError {
            source: "nativeController".into(),
            message: error.clone(),
        });
    }
    if let Some(error) = snapshot.control_service.gamepad_home_last_error.as_ref() {
        errors.push(DiagnosticsError {
            source: "gamepadHome".into(),
            message: error.clone(),
        });
    }
    if let Some(error) = snapshot.display_audio.display_error.as_ref() {
        errors.push(DiagnosticsError {
            source: "display".into(),
            message: error.clone(),
        });
    }
    if let Some(error) = snapshot.display_audio.audio_error.as_ref() {
        errors.push(DiagnosticsError {
            source: "audio".into(),
            message: error.clone(),
        });
    }
    for session in &snapshot.launch_registry.sessions {
        if let Some(error) = session.error.as_ref() {
            errors.push(DiagnosticsError {
                source: format!("launch:{}", session.id),
                message: error.clone(),
            });
        }
    }
    errors
}

pub(crate) fn capture(app: &AppHandle) -> DiagnosticsSnapshot {
    let session = session_orchestrator::current_snapshot(app);
    let orchestrator = app.state::<SessionOrchestrator>();
    let session_operations = orchestrator.operation_snapshot();
    let persistence_error = orchestrator.persistence_error();
    let launch_registry = app.state::<LaunchRegistry>().snapshot();
    let window_broker = app.state::<WindowBroker>().refresh();
    let control_service = app.state::<ControlService>().status();
    let native_controller = app.state::<PadHub>().status();
    let display_audio = display_audio::snapshot();
    let remote_status = app
        .state::<crate::remote_access::RemoteAccess>()
        .status_cached();
    let remote = RemoteDiagnostics {
        enabled: remote_status.enabled,
        secure_origin_available: remote_status.secure_origin_available,
        paired_device_count: remote_status.paired_device_count,
        recovery_required: remote_status.recovery_required,
    };
    let mut snapshot = DiagnosticsSnapshot {
        generated_at_ms: now_ms(),
        build: build_info(),
        session,
        session_operations,
        persistence_error,
        launch_registry,
        window_broker,
        control_service,
        native_controller,
        display_audio,
        remote,
        errors: Vec::new(),
        limitations: limitations(),
    };
    snapshot.errors = collect_errors(&snapshot);
    sanitize_snapshot(&mut snapshot);
    snapshot
}

/// Redacts user-profile paths and control characters from one bounded string.
/// The report is typed, so this is defense in depth rather than the only gate.
/// A line that contains a private-path marker is redacted as a whole: splitting
/// on whitespace could leak the second half of a user name containing spaces.
/// Returns true when one bounded diagnostic line carries material that must not
/// appear in an exported report: credentials, one-time pairing/bootstrap codes,
/// device/session identifiers, network addresses or local account identifiers.
/// This is defense in depth on top of the typed report; it is not a universal
/// secret detector.
fn is_sensitive_detail(line: &str, lower: &str) -> bool {
    const MARKERS: &[&str] = &[
        "token=",
        "secret=",
        "password=",
        "authorization",
        "bearer ",
        "https://",
        "http://",
        "\"token\"",
        "\"secret\"",
        "\"password\"",
        // S2.6 short-lived pairing/bootstrap material and remote identity.
        "pair=",
        "pairing",
        "bootstrap",
        "otp=",
        "pin=",
        "qr=",
        "qrcode",
        "one-time code",
        "kod jednorazowy",
        "deviceid",
        "device_id",
        "hmac",
        "signature",
        "nonce",
        "credential",
        "private key",
        "-----begin",
        "cert=",
        "ca_key",
    ];
    if MARKERS.iter().any(|marker| lower.contains(marker)) {
        return true;
    }
    if line
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .any(|part| part.parse::<std::net::Ipv4Addr>().is_ok())
        || line.split_whitespace().any(|part| {
            part.trim_matches(['[', ']', ',', ';'])
                .parse::<std::net::Ipv6Addr>()
                .is_ok()
        })
    {
        return true;
    }
    // MAC-48 address (AA:BB:CC:DD:EE:FF) and Windows SIDs identify hardware or accounts.
    if line.split_whitespace().any(|part| {
        let groups: Vec<&str> = part
            .trim_matches(['[', ']', ',', ';', '(', ')'])
            .split(':')
            .collect();
        groups.len() == 6
            && groups
                .iter()
                .all(|g| g.len() == 2 && g.bytes().all(|b| b.is_ascii_hexdigit()))
    }) {
        return true;
    }
    if lower.contains("s-1-5-") || lower.contains("s-1-12-") {
        return true;
    }
    // An email-like token can leak an account name even without a URL.
    line.split_whitespace()
        .any(|part| part.contains('@') && part.contains('.'))
}

pub(crate) fn sanitize_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len().min(MAX_STRING_CHARS * 2));
    for line in input.lines().take(4) {
        if !output.is_empty() {
            output.push(' ');
        }
        let lower = line.to_ascii_lowercase();
        let private_path = lower.contains(":\\users\\")
            || lower.contains(":/users/")
            || lower.contains("/users/")
            || lower.contains("/home/")
            || lower.contains("\\appdata\\")
            || lower.contains("/appdata/")
            || lower.contains("/private/var/folders/")
            || lower.contains("documents and settings");
        if private_path {
            output.push_str("<redacted-path>");
        } else if is_sensitive_detail(line, &lower) {
            output.push_str("<redacted-detail>");
        } else {
            output.extend(
                line.chars()
                    .filter(|character| !character.is_control())
                    .take(MAX_STRING_CHARS),
            );
        }
        if output.chars().count() >= MAX_STRING_CHARS * 2 {
            break;
        }
    }
    if output.chars().count() > MAX_STRING_CHARS * 2 {
        output = output.chars().take(MAX_STRING_CHARS * 2).collect();
        output.push('…');
    }
    output
}

fn sanitize_optional(value: &mut Option<String>) {
    if let Some(text) = value.as_mut() {
        *text = sanitize_text(text);
    }
}

fn sanitize_foreground(foreground: &mut crate::window_broker::ForegroundWindow) {
    sanitize_optional(&mut foreground.process_name);
    sanitize_optional(&mut foreground.class_name);
}

fn sanitize_snapshot(snapshot: &mut DiagnosticsSnapshot) {
    snapshot.build.version = sanitize_text(&snapshot.build.version);
    snapshot.build.build_sha = sanitize_text(&snapshot.build.build_sha);
    snapshot.build.checkout_sha = sanitize_text(&snapshot.build.checkout_sha);
    snapshot.build.branch = sanitize_text(&snapshot.build.branch);
    snapshot.build.build_ref = sanitize_text(&snapshot.build.build_ref);
    snapshot.build.dirty = sanitize_text(&snapshot.build.dirty);
    snapshot.build.event = sanitize_text(&snapshot.build.event);
    sanitize_optional(&mut snapshot.build.pr_head_sha);
    sanitize_optional(&mut snapshot.build.pr_base_sha);
    snapshot.build.target = sanitize_text(&snapshot.build.target);
    snapshot.build.profile = sanitize_text(&snapshot.build.profile);
    snapshot.build.rustc_version = sanitize_text(&snapshot.build.rustc_version);
    sanitize_optional(&mut snapshot.persistence_error);
    if let Some(recovery) = snapshot.session.recovery.as_mut() {
        recovery.message = sanitize_text(&recovery.message);
    }
    if let Some(context) = snapshot.session.context.as_mut() {
        sanitize_optional(&mut context.launch_id);
        sanitize_optional(&mut context.app_id);
    }
    for operation in &mut snapshot.session_operations {
        operation.id = sanitize_text(&operation.id);
    }
    sanitize_optional(&mut snapshot.launch_registry.last_error);
    for session in &mut snapshot.launch_registry.sessions {
        session.display_name = sanitize_text(&session.display_name);
        sanitize_optional(&mut session.error);
        sanitize_optional(&mut session.attention);
        sanitize_optional(&mut session.app_id);
        if let Some(restore) = session.restore.as_mut() {
            sanitize_restore(restore);
        }
    }
    sanitize_optional(&mut snapshot.window_broker.last_error);
    sanitize_foreground(&mut snapshot.window_broker.foreground);
    for window in &mut snapshot.window_broker.tracked_windows {
        sanitize_optional(&mut window.process_name);
        sanitize_optional(&mut window.class_name);
    }
    sanitize_optional(&mut snapshot.control_service.foreground_process);
    sanitize_optional(&mut snapshot.control_service.last_error);
    sanitize_optional(&mut snapshot.control_service.gamepad_home_last_error);
    sanitize_optional(&mut snapshot.control_service.gamepad_home_warning);
    snapshot.control_service.fallback_hotkey =
        sanitize_text(&snapshot.control_service.fallback_hotkey);
    sanitize_optional(&mut snapshot.native_controller.last_error);
    for pad in &mut snapshot.native_controller.pads {
        if pad.device.len() != 16 || !pad.device.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            pad.device = "invalid-id".into();
        }
    }
    snapshot.display_audio.display_signature =
        sanitize_text(&snapshot.display_audio.display_signature);
    sanitize_optional(&mut snapshot.display_audio.display_error);
    sanitize_optional(&mut snapshot.display_audio.audio_error);
    for display in &mut snapshot.display_audio.displays {
        display.name = sanitize_text(&display.name);
        sanitize_optional(&mut display.hdr_error);
        sanitize_optional(&mut display.diagnostics.adapter_name);
        sanitize_optional(&mut display.diagnostics.dpi_provenance);
        sanitize_optional(&mut display.diagnostics.connection_type);
        display.diagnostics.identity_source = sanitize_text(&display.diagnostics.identity_source);
    }
    for endpoint in &mut snapshot.display_audio.audio {
        endpoint.name = sanitize_text(&endpoint.name);
    }
    for note in &mut snapshot.display_audio.policy.notes {
        *note = sanitize_text(note);
    }
    for limitation in &mut snapshot.display_audio.limitations {
        *limitation = sanitize_text(limitation);
    }
    for error in &mut snapshot.errors {
        error.source = sanitize_text(&error.source);
        error.message = sanitize_text(&error.message);
    }
    for limitation in &mut snapshot.limitations {
        *limitation = sanitize_text(limitation);
    }
}

fn sanitize_restore(restore: &mut crate::window_broker::RestoreResult) {
    restore.message = sanitize_text(&restore.message);
    sanitize_foreground(&mut restore.foreground_before);
    sanitize_foreground(&mut restore.foreground_after);
}

#[tauri::command]
pub async fn get_diagnostics_snapshot(app: AppHandle) -> Result<DiagnosticsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(capture(&app)))
        .await
        .map_err(|_| "Wątek diagnostyki VELORA został przerwany.".to_string())?
}

#[tauri::command]
pub async fn export_diagnostics_report(app: AppHandle) -> Result<DiagnosticsExport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = capture(&app);
        let report_json = serde_json::to_string_pretty(&snapshot)
            .map_err(|_| "Nie można zserializować raportu diagnostycznego.".to_string())?;
        if report_json.len() > MAX_EXPORT_BYTES {
            return Err("Raport diagnostyczny przekroczył bezpieczny rozmiar.".into());
        }
        let digest = Sha256::digest(report_json.as_bytes());
        Ok(DiagnosticsExport {
            generated_at_ms: snapshot.generated_at_ms,
            sha256: digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            report_json,
        })
    })
    .await
    .map_err(|_| "Wątek eksportu diagnostyki VELORA został przerwany.".to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn export_redacts_credentials_urls_and_network_addresses() {
        for text in [
            "token=private",
            "password=private",
            "Authorization: Bearer private",
            "https://private.example/watch/123",
            "LAN 192.168.1.42:8765",
            "[fe80::1234]",
            "{\"secret\":\"private\"}",
        ] {
            assert_eq!(super::sanitize_text(text), "<redacted-detail>");
        }
        let json = serde_json::to_string(&super::RemoteDiagnostics {
            enabled: true,
            secure_origin_available: true,
            paired_device_count: 2,
            recovery_required: false,
        })
        .unwrap();
        for forbidden in ["token", "origin\"", "path", "name", "192.168"] {
            assert!(!json.contains(forbidden));
        }
    }
    #[test]
    fn pairing_bootstrap_and_device_material_never_reaches_an_export() {
        for text in [
            "https://192.168.0.10:47862/#pair=123456&exp=1731000000",
            "pair=123456",
            "#pair=123456",
            "one-time code 123456",
            "kod jednorazowy 123456",
            "bootstrap token for device",
            "deviceId=0123456789abcdef",
            "hmac signature abcd nonce ef01",
            "adapter 00:1A:2B:3C:4D:5E",
            "owner S-1-5-21-1234-5678",
            "contact milos@example.com",
        ] {
            assert_eq!(
                super::sanitize_text(text),
                "<redacted-detail>",
                "unredacted diagnostic material: {text}"
            );
        }
    }

    #[test]
    fn sanitized_export_stays_bounded_even_with_many_sensitive_lines() {
        let input = "token=abc\n".repeat(MAX_STRING_CHARS);
        let sanitized = super::sanitize_text(&input);
        assert!(sanitized.chars().count() <= MAX_STRING_CHARS * 2 + 1);
        assert!(!sanitized.contains("abc"));
    }

    use super::{
        sanitize_text, BuildInfo, DiagnosticsError, DiagnosticsSnapshot, MAX_STRING_CHARS,
    };
    use crate::control_service::ControlServiceStatus;
    use crate::display_audio::{
        AudioEndpointInfo, DisplayAudioPolicy, DisplayAudioSnapshot, DisplayInfo,
    };
    use crate::launch_registry::{LaunchRegistrySnapshot, LaunchSession};
    use crate::pad_hub::NativeControllerStatus;
    use crate::session_orchestrator::SessionSnapshot;
    use crate::window_broker::{ForegroundWindow, WindowBrokerSnapshot};

    fn minimal_snapshot() -> DiagnosticsSnapshot {
        DiagnosticsSnapshot {
            generated_at_ms: 1,
            build: BuildInfo {
                version: "0.9.2".into(),
                build_sha: "abc123".into(),
                checkout_sha: "abc123".into(),
                branch: "test".into(),
                build_ref: "refs/heads/test".into(),
                dirty: "false".into(),
                event: "test".into(),
                pr_head_sha: None,
                pr_base_sha: None,
                target: "windows-x86_64".into(),
                profile: "release".into(),
                rustc_version: "rustc test".into(),
                windows: true,
            },
            session: SessionSnapshot {
                current: crate::session_orchestrator::SessionId::VeloraHome,
                previous: None,
                revision: 0,
                transitioned_at_ms: 0,
                context: None,
                allowed_targets: vec![crate::session_orchestrator::SessionId::Game],
                recovery: None,
            },
            session_operations: Vec::new(),
            persistence_error: None,
            launch_registry: LaunchRegistrySnapshot {
                windows: true,
                sessions: Vec::new(),
                last_error: None,
                active_sessions: 0,
                poll_interval_ms: 600,
            },
            window_broker: WindowBrokerSnapshot {
                windows: true,
                own_window: Some(1),
                own_window_valid: true,
                foreground: ForegroundWindow::default(),
                tracked_processes: Vec::new(),
                tracked_windows: Vec::new(),
                last_error: None,
                poll_interval_ms: 750,
                last_handoff: None,
            },
            control_service: ControlServiceStatus {
                windows: true,
                running: false,
                game_mode: false,
                controller_count: 0,
                playstation_controller_count: 0,
                foreground_process: None,
                return_hotkey_registered: false,
                fallback_hotkey: "Ctrl+Alt+N".into(),
                gamepad_home_running: false,
                gamepad_home_device_count: 0,
                gamepad_home_last_combo_at_ms: None,
                gamepad_home_last_error: None,
                gamepad_home_warning: None,
                gamepad_home_devices: Vec::new(),
                gamepad_home_duplicate_reports: 0,
                gamepad_home_reconnects: 0,
                gamepad_home_last_report_at_ms: None,
                gamepad_home_last_chord: None,
                last_error: None,
            },
            native_controller: NativeControllerStatus::default(),
            remote: super::RemoteDiagnostics::default(),
            display_audio: DisplayAudioSnapshot {
                windows: true,
                supported: true,
                displays: vec![DisplayInfo {
                    id: "abc".into(),
                    name: "Panasonic".into(),
                    width: 3840,
                    height: 2160,
                    refresh_hz: 60,
                    bits_per_pixel: 32,
                    primary: true,
                    hdr: Some(false),
                    hdr_error: None,
                    diagnostics: Default::default(),
                }],
                audio: vec![AudioEndpointInfo {
                    id: "def".into(),
                    name: "TV".into(),
                    state: "active".into(),
                    default_device: true,
                    volume_percent: Some(20),
                    muted: Some(false),
                }],
                display_error: None,
                audio_error: None,
                policy: DisplayAudioPolicy {
                    read_only: true,
                    automatic_mode_changes: false,
                    notes: vec!["read only".into()],
                },
                limitations: vec!["test".into()],
                display_signature: "sig".into(),
                captured_at_ms: 2,
            },
            errors: vec![DiagnosticsError {
                source: "test".into(),
                message: "test".into(),
            }],
            limitations: vec!["test".into()],
        }
    }

    #[test]
    fn report_contract_never_contains_secret_material_or_raw_window_titles() {
        let snapshot = minimal_snapshot();
        let json = serde_json::to_string(&snapshot)
            .unwrap()
            .to_ascii_lowercase();
        for forbidden in [
            "pairingcode",
            "authorization",
            "password",
            "privatekey",
            "windowtitle",
            "token",
        ] {
            assert!(!json.contains(forbidden), "report leaked {forbidden}");
        }
        assert!(json.contains("\"readonly\":true"));
        assert!(json.contains("\"automaticmodechanges\":false"));
    }

    #[test]
    fn native_controller_diagnostics_keep_only_hashed_ids_and_numeric_trace() {
        let mut snapshot = minimal_snapshot();
        snapshot.native_controller.pads.push(crate::ds4::PadInfo {
            device: r"\\?\HID#VID_054C&PID_09CC#sensitive-instance".into(),
            revision: crate::ds4::Ds4Revision::V2,
            transport: crate::ds4::Ds4Transport::Bluetooth,
        });
        snapshot.native_controller.last_error =
            Some(r"Failed to open C:\Users\private\controller.log".into());
        crate::diagnostics::sanitize_snapshot(&mut snapshot);
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("invalid-id"));
        assert!(json.contains("<redacted-path>"));
        assert!(!json.contains("sensitive-instance"));
        assert!(!json.contains("controller.log"));
        assert!(json.contains("\"homeEnabled\":false"));
        assert!(json.contains("\"lastHomeButtons\":null"));
    }

    #[test]
    fn user_profile_paths_are_redacted_and_control_characters_removed() {
        let text = "Nie można otworzyć C:\\Users\\mil\\AppData\\Roaming\\VELORA\\x.json\noraz /home/mil/.config/velora";
        let sanitized = sanitize_text(text);
        assert!(!sanitized.contains("C:\\Users\\mil"));
        assert!(!sanitized.contains("/home/mil"));
        assert!(!sanitized.contains('\n'));
        assert!(sanitized.contains("<redacted-path>"));
    }

    #[test]
    fn a_user_name_with_spaces_cannot_leak_a_path_fragment() {
        let sanitized = sanitize_text(
            "Nie można otworzyć C:\\Users\\Jan Kowalski\\AppData\\Roaming\\VELORA\\state.json",
        );
        assert_eq!(sanitized, "<redacted-path>");
        assert!(!sanitized.contains("Kowalski"));
    }

    #[test]
    fn long_strings_are_bounded() {
        let sanitized = sanitize_text(&"a".repeat(MAX_STRING_CHARS * 5));
        assert!(sanitized.chars().count() <= MAX_STRING_CHARS * 2 + 1);
    }

    #[test]
    fn launch_session_errors_are_collected_without_window_titles() {
        let mut snapshot = minimal_snapshot();
        snapshot.launch_registry.sessions.push(LaunchSession {
            id: "game-1".into(),
            kind: crate::launch_registry::LaunchKind::Game,
            display_name: "Cyberpunk 2077".into(),
            app_id: Some("1091500".into()),
            phase: crate::launch_registry::LaunchPhase::Failed,
            process_ids: Vec::new(),
            foreground: false,
            window_id: None,
            started_at_ms: 1,
            updated_at_ms: 2,
            last_activation_at_ms: None,
            error: Some("C:\\Users\\mil\\game.log".into()),
            restore: None,
            session_revision: Some(1),
            pid_reuse_detected: false,
            attention: None,
        });
        crate::diagnostics::sanitize_snapshot(&mut snapshot);
        snapshot.errors = crate::diagnostics::collect_errors(&snapshot);
        assert!(snapshot
            .errors
            .iter()
            .any(|error| error.source == "launch:game-1"));
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("C:\\\\Users\\\\mil"));
    }
}
