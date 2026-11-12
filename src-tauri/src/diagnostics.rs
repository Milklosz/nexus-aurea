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
use crate::session_orchestrator::{self, SessionOrchestrator, SessionSnapshot};
use crate::window_broker::{WindowBroker, WindowBrokerSnapshot};

pub(crate) const MAX_EXPORT_BYTES: usize = 256 * 1024;
const MAX_STRING_CHARS: usize = 240;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    pub build_sha: String,
    pub target: String,
    pub profile: String,
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
    pub display_audio: DisplayAudioSnapshot,
    pub errors: Vec<DiagnosticsError>,
    pub limitations: Vec<String>,
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
        target: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        profile: if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "release".to_string()
        },
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
    let display_audio = display_audio::snapshot();
    let mut snapshot = DiagnosticsSnapshot {
        generated_at_ms: now_ms(),
        build: build_info(),
        session,
        session_operations,
        persistence_error,
        launch_registry,
        window_broker,
        control_service,
        display_audio,
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
    snapshot.build.build_sha = sanitize_text(&snapshot.build.build_sha);
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
    snapshot.display_audio.display_signature =
        sanitize_text(&snapshot.display_audio.display_signature);
    sanitize_optional(&mut snapshot.display_audio.display_error);
    sanitize_optional(&mut snapshot.display_audio.audio_error);
    for display in &mut snapshot.display_audio.displays {
        display.name = sanitize_text(&display.name);
        sanitize_optional(&mut display.hdr_error);
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
    use super::{
        sanitize_text, BuildInfo, DiagnosticsError, DiagnosticsSnapshot, MAX_STRING_CHARS,
    };
    use crate::control_service::ControlServiceStatus;
    use crate::display_audio::{
        AudioEndpointInfo, DisplayAudioPolicy, DisplayAudioSnapshot, DisplayInfo,
    };
    use crate::launch_registry::{LaunchRegistrySnapshot, LaunchSession};
    use crate::session_orchestrator::SessionSnapshot;
    use crate::window_broker::{ForegroundWindow, WindowBrokerSnapshot};

    fn minimal_snapshot() -> DiagnosticsSnapshot {
        DiagnosticsSnapshot {
            generated_at_ms: 1,
            build: BuildInfo {
                version: "0.9.2".into(),
                build_sha: "abc123".into(),
                target: "windows-x86_64".into(),
                profile: "release".into(),
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
