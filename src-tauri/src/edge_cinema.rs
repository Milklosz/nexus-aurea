//! Edge Cinema — the only adapter between Microsoft Edge and VELORA's native
//! sessions. It does not own a state machine: every phase comes from
//! `LaunchRegistry`, and windows come from `WindowBroker`. The adapter keeps a
//! small, non-secret marker in the dedicated Edge profile so a duplicate launch
//! after a VELORA restart can be adopted instead of opening a second window.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::launch_registry::{self, LaunchKind, LaunchPhase, LaunchSession, LaunchWatch};
#[cfg(target_os = "windows")]
use crate::window_broker;
use crate::session_orchestrator::SessionId;

#[cfg(target_os = "windows")]
use std::collections::HashSet;
#[cfg(target_os = "windows")]
use std::fs;
#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::Command;

/// Stabilna nazwa dedykowanego, trwałego profilu Edge Cinema. Ta sama wartość
/// jest zdefiniowana po stronie TypeScript jako `EDGE_CINEMA_PROFILE_NAME`.
pub const EDGE_CINEMA_PROFILE_NAME: &str = "VELORA-EdgeCinema";
const EDGE_APP_ID: &str = "edge-cinema";
const SESSION_MARKER_FILE: &str = ".velora-edge-session.json";
const SESSION_MARKER_VERSION: u32 = 1;
const MAX_MARKER_BYTES: u64 = 4096;
const MAX_LAUNCH_ID_LEN: usize = 128;

/// Serializes the duplicate check and spawn/adoption. Without it, two quick
/// service clicks could both pass the registry check before the first register.
static EDGE_LAUNCH_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Dokładna allowlista pięciu oficjalnych adresów HTTPS z
/// `src/data/streamingServices.ts`. Żaden inny ciąg nie zostaje przepuszczony —
/// zapobiega to wstrzykiwaniu argumentów do wywołania `msedge.exe`.
const ALLOWED_STREAMING_URLS: &[&str] = &[
    "https://www.netflix.com/pl/",
    "https://www.disneyplus.com/pl-pl",
    "https://www.hbomax.com/pl/pl",
    "https://www.primevideo.com/-/pl_PL/?tr=pl",
    "https://www.youtube.com/",
];

#[cfg(target_os = "windows")]
const UNTRUSTED_URL_ERROR: &str = "Adres usługi nie znajduje się na liście zaufanych stron.";
#[cfg(not(target_os = "windows"))]
const NON_WINDOWS_ERROR: &str = "Edge Cinema jest dostępne tylko w natywnej aplikacji Windows.";
#[cfg(target_os = "windows")]
const EDGE_NOT_FOUND_ERROR: &str =
    "Nie wykryto przeglądarki Microsoft Edge. Zainstaluj Edge, aby uruchomić Edge Cinema.";
#[cfg(target_os = "windows")]
const PROFILE_DIR_ERROR: &str = "Nie udało się przygotować katalogu profilu Edge Cinema.";
#[cfg(target_os = "windows")]
const SPAWN_ERROR: &str = "Windows nie uruchomił okna Edge Cinema.";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeCinemaStatus {
    pub windows: bool,
    pub edge_detected: bool,
    pub profile_dir: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeCinemaReceipt {
    pub launched: bool,
    pub mode: String,
    pub profile_dir: String,
    pub launch_id: Option<String>,
    pub adopted: bool,
}

/// Read-only projection of a LaunchRegistry session. `state` is one of
/// idle|launching|active|closing|exited|error and never drives session logic.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeCinemaSession {
    pub session_id: Option<String>,
    pub state: String,
    pub app_id: String,
    pub pid: Option<u32>,
    pub window_title: Option<String>,
    pub profile_dir: Option<String>,
    pub url: Option<String>,
    pub launched_at: Option<String>,
    pub last_error: Option<String>,
    pub managed_by_velora: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CinemaSessionEvent {
    pub session: EdgeCinemaSession,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CinemaExitedEvent {
    pub session_id: String,
    pub reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CinemaCloseRequestedEvent {
    pub session_id: String,
    pub confirmed: bool,
}

/// Non-secret marker written next to the dedicated Edge profile. It contains no
/// URLs outside the allowlist, tokens, cookies or credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EdgeSessionMarker {
    version: u32,
    launch_id: String,
    process_id: u32,
    process_created_at_100ns: u64,
    url: String,
}

fn sanitize_error(message: &str) -> String {
    let cleaned: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cleaned.trim().chars().take(240).collect()
}

fn phase_state(phase: LaunchPhase) -> &'static str {
    match phase {
        LaunchPhase::Requested
        | LaunchPhase::ProcessStarted
        | LaunchPhase::WindowAppeared => "launching",
        LaunchPhase::SessionActive => "active",
        LaunchPhase::ExitPending => "closing",
        LaunchPhase::Ended | LaunchPhase::Cancelled => "exited",
        LaunchPhase::Failed => "error",
    }
}

fn session_from_launch(
    launch: &LaunchSession,
    marker_url: Option<String>,
    profile_dir: Option<String>,
) -> EdgeCinemaSession {
    EdgeCinemaSession {
        session_id: Some(launch.id.clone()),
        state: phase_state(launch.phase).to_string(),
        app_id: EDGE_APP_ID.to_string(),
        pid: launch.process_ids.first().copied(),
        // VELORA deliberately reads no window titles. The field stays `None`
        // instead of fabricating a value the native layer does not know.
        window_title: None,
        profile_dir,
        url: marker_url.filter(|url| is_allowed_streaming_url(url)),
        launched_at: Some(launch.started_at_ms.to_string()),
        last_error: launch.error.as_deref().map(sanitize_error),
        managed_by_velora: true,
    }
}

fn idle_session() -> EdgeCinemaSession {
    EdgeCinemaSession {
        session_id: None,
        state: "idle".to_string(),
        app_id: EDGE_APP_ID.to_string(),
        pid: None,
        window_title: None,
        profile_dir: None,
        url: None,
        launched_at: None,
        last_error: None,
        managed_by_velora: true,
    }
}

pub fn is_allowed_streaming_url(url: &str) -> bool {
    ALLOWED_STREAMING_URLS.contains(&url)
}

pub fn profile_directory_name() -> &'static str {
    EDGE_CINEMA_PROFILE_NAME
}

/// Fixed, closed set of launch flags. `url` is one opaque `--app=...` value and
/// is never split into additional arguments. In production this helper is only
/// called with a matched constant from the allowlist.
pub fn edge_cinema_arguments(url: &str, profile_dir: &str) -> Vec<String> {
    vec![
        format!("--app={url}"),
        "--start-fullscreen".to_string(),
        format!("--user-data-dir={profile_dir}"),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        format!("--window-name={}", profile_directory_name()),
    ]
}

fn edge_cinema_notes() -> Vec<String> {
    vec![
        "Dedykowany, trwały profil Microsoft Edge (VELORA-EdgeCinema) zachowuje logowania do serwisów między uruchomieniami.".to_string(),
        "Błędy uruchomienia (brak Edge, katalog profilu, uruchomienie okna) są komunikowane czytelnie po polsku.".to_string(),
        "VELORA nie gwarantuje i nie zmienia obsługi DRM / Widevine / PlayReady, jakości 4K, HDR, HDCP, możliwości GPU, poziomu subskrypcji ani dostępności usługi — zależą one od sprzętu, sterowników i dostawcy.".to_string(),
    ]
}

fn validate_marker(marker: &EdgeSessionMarker) -> bool {
    marker.version == SESSION_MARKER_VERSION
        && marker.process_id != 0
        && marker.process_created_at_100ns != 0
        && !marker.launch_id.is_empty()
        && marker.launch_id.len() <= MAX_LAUNCH_ID_LEN
        && !marker
            .launch_id
            .chars()
            .any(|character| character.is_control())
        && is_allowed_streaming_url(&marker.url)
}

fn marker_matches_identity(
    marker: &EdgeSessionMarker,
    identity: Option<crate::process_table::ProcessIdentity>,
) -> bool {
    identity.is_some_and(|identity| {
        identity.process_id == marker.process_id
            && identity.created_at_100ns == marker.process_created_at_100ns
    })
}

/// Adoption is service-specific. A live Netflix window must not silently
/// satisfy a Disney+ request: the user expects the selected service.
fn adoption_is_compatible(marker: &EdgeSessionMarker, requested_url: &str) -> bool {
    validate_marker(marker) && marker.url == requested_url
}

/// The IPC surface exposes the stable profile label, never the full
/// `%LOCALAPPDATA%` path. The native layer still uses the real directory.
fn public_profile_label() -> String {
    profile_directory_name().to_string()
}

fn edge_watch(root_process_id: Option<u32>) -> LaunchWatch {
    LaunchWatch::new(
        LaunchKind::Cinema,
        "Edge Cinema",
        Some(EDGE_APP_ID.to_string()),
        Vec::new(),
        root_process_id,
        true,
        true,
        Vec::new(),
        true,
        Some(SessionId::Cinema),
    )
    .detect_window_close()
    .include_root_window()
    .with_start_timeout_ms(20_000)
}

#[cfg(target_os = "windows")]
fn edge_profile_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    Some(local.join("VELORA").join(profile_directory_name()))
}

#[cfg(target_os = "windows")]
fn marker_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(SESSION_MARKER_FILE)
}

#[cfg(target_os = "windows")]
fn read_marker(profile_dir: &Path) -> Option<EdgeSessionMarker> {
    let path = marker_path(profile_dir);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    if metadata.len() == 0 || metadata.len() > MAX_MARKER_BYTES {
        return None;
    }
    let contents = fs::read_to_string(&path).ok()?;
    let marker: EdgeSessionMarker = serde_json::from_str(&contents).ok()?;
    validate_marker(&marker).then_some(marker)
}

#[cfg(target_os = "windows")]
fn write_marker(profile_dir: &Path, marker: &EdgeSessionMarker) -> Result<(), String> {
    if !validate_marker(marker) {
        return Err("Nieprawidłowe dane znacznika sesji Edge Cinema.".into());
    }
    let path = marker_path(profile_dir);
    if fs::symlink_metadata(&path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Znacznik sesji Edge Cinema nie może być dowiązaniem symbolicznym.".into());
    }
    let serialized = serde_json::to_vec(marker)
        .map_err(|_| "Nie można zapisać znacznika sesji Edge Cinema.".to_string())?;
    if serialized.len() as u64 > MAX_MARKER_BYTES {
        return Err("Znacznik sesji Edge Cinema przekroczył bezpieczny rozmiar.".into());
    }
    fs::write(path, serialized)
        .map_err(|_| "Nie można zapisać znacznika sesji Edge Cinema.".to_string())
}

#[cfg(target_os = "windows")]
fn remove_marker(profile_dir: &Path) {
    let _ = fs::remove_file(marker_path(profile_dir));
}

#[cfg(target_os = "windows")]
fn marker_is_live(app: &AppHandle, marker: &EdgeSessionMarker) -> bool {
    if !validate_marker(marker) {
        return false;
    }
    let Some(identity) = crate::process_table::identity(marker.process_id) else {
        return false;
    };
    if !marker_matches_identity(marker, Some(identity)) {
        return false;
    }
    let Ok(table) = crate::process_table::snapshot(true) else {
        return false;
    };
    if !table
        .image_name(marker.process_id)
        .is_some_and(|name| name.eq_ignore_ascii_case("msedge.exe"))
    {
        return false;
    }
    let processes = HashSet::from([marker.process_id]);
    !crate::window_broker::windows_for_processes(app, &processes).is_empty()
}

#[cfg(target_os = "windows")]
fn current_marker(app: &AppHandle) -> Option<EdgeSessionMarker> {
    let profile_dir = edge_profile_dir()?;
    read_marker(&profile_dir)
}

#[cfg(target_os = "windows")]
fn store_marker(
    app: &AppHandle,
    launch_id: &str,
    process_id: u32,
    url: &str,
) -> Result<(), String> {
    let Some(profile_dir) = edge_profile_dir() else {
        return Err(PROFILE_DIR_ERROR.into());
    };
    let Some(identity) = crate::process_table::identity(process_id) else {
        return Err("Nie można ustalić tożsamości procesu Edge Cinema.".into());
    };
    let marker = EdgeSessionMarker {
        version: SESSION_MARKER_VERSION,
        launch_id: launch_id.to_string(),
        process_id,
        process_created_at_100ns: identity.created_at_100ns,
        url: url.to_string(),
    };
    write_marker(&profile_dir, &marker)
}

#[cfg(target_os = "windows")]
fn edge_executable() -> Option<PathBuf> {
    let mut paths = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            let prefix = if key == "LOCALAPPDATA" {
                root.join("Programs")
            } else {
                root
            };
            paths.push(
                prefix
                    .join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
            );
        }
    }
    paths.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn active_edge_window(app: &AppHandle, launch: &LaunchSession) -> Option<u64> {
    if let Some(window) = launch.window_id {
        return Some(window);
    }
    let processes = launch.process_ids.iter().copied().collect::<HashSet<_>>();
    crate::window_broker::windows_for_processes(app, &processes)
        .into_iter()
        .find(|window| window.is_main)
        .map(|window| window.hwnd)
}

fn emit_session(app: &AppHandle, session: EdgeCinemaSession) {
    let _ = app.emit(
        "velora://cinema-session-changed",
        CinemaSessionEvent { session },
    );
}

fn current_session(app: &AppHandle) -> EdgeCinemaSession {
    #[cfg(target_os = "windows")]
    {
        let marker = current_marker(app);
        let profile = Some(public_profile_label());
        if let Some(launch) = launch_registry::active_launch_for_app(app, EDGE_APP_ID) {
            let url = marker
                .as_ref()
                .filter(|marker| marker.launch_id == launch.id)
                .map(|marker| marker.url.clone());
            return session_from_launch(&launch, url, profile);
        }
        if let Some(launch) = launch_registry::latest_launch_for_app(app, EDGE_APP_ID) {
            let url = marker
                .as_ref()
                .filter(|marker| marker.launch_id == launch.id)
                .map(|marker| marker.url.clone());
            return session_from_launch(&launch, url, profile);
        }
        idle_session()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        idle_session()
    }
}

#[tauri::command]
pub fn launch_edge_cinema(app: AppHandle, url: String) -> Result<EdgeCinemaReceipt, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, url);
        Err(NON_WINDOWS_ERROR.to_string())
    }

    #[cfg(target_os = "windows")]
    {
        let _launch_gate = EDGE_LAUNCH_GATE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let canonical = ALLOWED_STREAMING_URLS
            .iter()
            .find(|allowed| **allowed == url)
            .copied()
            .ok_or_else(|| UNTRUSTED_URL_ERROR.to_string())?;

        // The authoritative duplicate guard is LaunchRegistry, never a second
        // adapter-local "current session" value.
        if launch_registry::active_launch_for_app(&app, EDGE_APP_ID).is_some() {
            return Err(
                "Okno Edge Cinema jest już uruchomione. VELORA nie uruchamia duplikatu."
                    .to_string(),
            );
        }

        let executable = edge_executable().ok_or_else(|| EDGE_NOT_FOUND_ERROR.to_string())?;
        let profile_dir = edge_profile_dir().ok_or_else(|| PROFILE_DIR_ERROR.to_string())?;
        fs::create_dir_all(&profile_dir).map_err(|_| PROFILE_DIR_ERROR.to_string())?;
        let profile_dir_string = profile_dir.to_string_lossy().into_owned();

        // Recovery/adoption: if VELORA restarted while its dedicated Edge
        // profile window stayed open, attach the existing process instead of
        // creating a duplicate. The marker is validated against the process
        // creation timestamp and the msedge.exe image name, so a recycled PID
        // is never adopted.
        if let Some(marker) = read_marker(&profile_dir) {
            if marker_is_live(&app, &marker) {
                if !adoption_is_compatible(&marker, canonical) {
                    return Err(
                        "W oknie Edge Cinema otwarta jest inna usługa. Zamknij je i wybierz nową usługę."
                            .to_string(),
                    );
                }
                // VELORA is foreground because the user clicked this tile. Let
                // the adopted Edge window come forward instead of staying behind
                // the fullscreen launcher.
                window_broker::grant_foreground_handoff(&[marker.process_id]);
                let watch = edge_watch(Some(marker.process_id));
                let launch = launch_registry::track_launch(&app, watch)?;
                let _ = store_marker(&app, &launch.id, marker.process_id, &marker.url);
                let session = session_from_launch(
                    &launch,
                    Some(marker.url),
                    Some(public_profile_label()),
                );
                emit_session(&app, session);
                return Ok(EdgeCinemaReceipt {
                    launched: true,
                    mode: "app-fullscreen".to_string(),
                    profile_dir: public_profile_label(),
                    launch_id: Some(launch.id),
                    adopted: true,
                });
            }
            remove_marker(&profile_dir);
        }

        let mut watch = edge_watch(None);
        // Capture the baseline before spawning, while no Edge Cinema process is
        // known. The registry then observes the entire new process subtree.
        launch_registry::capture_baseline(&app, &mut watch)?;
        let arguments = edge_cinema_arguments(canonical, &profile_dir_string);
        let child = Command::new(executable)
            .args(&arguments)
            .spawn()
            .map_err(|_| SPAWN_ERROR.to_string())?;
        let child_id = child.id();
        drop(child);
        // Identity of the spawned process, taken right away. It is the only proof
        // of ownership if the launch cannot be tracked and has to be rolled back.
        let spawned_identity = crate::process_table::identity(child_id);
        watch.root_process_id = Some(child_id);
        // Explicit AllowSetForegroundWindow hand-off while VELORA still holds
        // the foreground, so the browser window it creates is allowed to come
        // forward. A no-op if VELORA is not foreground (reported, not forced).
        window_broker::grant_foreground_handoff(&[child_id]);

        let launch = match launch_registry::track_launch(&app, watch) {
            Ok(launch) => launch,
            Err(error) => {
                rollback_failed_spawn(&app, spawned_identity);
                return Err(error);
            }
        };
        // A marker failure must not fail an otherwise successful launch.
        let _ = store_marker(&app, &launch.id, child_id, canonical);
        let session = session_from_launch(
            &launch,
            Some(canonical.to_string()),
            Some(public_profile_label()),
        );
        emit_session(&app, session);

        Ok(EdgeCinemaReceipt {
            launched: true,
            mode: "app-fullscreen".to_string(),
            profile_dir: public_profile_label(),
            launch_id: Some(launch.id),
            adopted: false,
        })
    }
}

#[tauri::command]
pub fn get_edge_cinema_status() -> EdgeCinemaStatus {
    #[cfg(target_os = "windows")]
    {
        EdgeCinemaStatus {
            windows: true,
            edge_detected: edge_executable().is_some(),
            profile_dir: edge_profile_dir().map(|_| public_profile_label()),
            notes: edge_cinema_notes(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut notes = edge_cinema_notes();
        notes.push(NON_WINDOWS_ERROR.to_string());
        EdgeCinemaStatus {
            windows: false,
            edge_detected: false,
            profile_dir: None,
            notes,
        }
    }
}

#[tauri::command]
pub fn get_edge_cinema_session(app: AppHandle) -> EdgeCinemaSession {
    current_session(&app)
}

/// Confirmed close request for the window VELORA launched. It posts WM_CLOSE to
/// that single tracked HWND; it never kills a process and refuses foreign or
/// already-ended sessions. Repeated requests are idempotent for terminal ones.
#[tauri::command]
pub fn request_edge_cinema_close(
    app: AppHandle,
    session_id: String,
    confirm: bool,
) -> Result<EdgeCinemaSession, String> {
    if !confirm {
        return Err("Zamknięcie okna Edge Cinema wymaga potwierdzenia.".to_string());
    }
    let Some(launch) = launch_registry::active_launch_for_app(&app, EDGE_APP_ID) else {
        if let Some(terminal) = launch_registry::launch_by_id(&app, &session_id) {
            if !terminal.phase.is_active() {
                return Ok(current_session(&app));
            }
        }
        return Err("Tej sesji Edge Cinema nie można bezpiecznie zamknąć.".to_string());
    };
    if launch.id != session_id {
        return Err(
            "Tej sesji Edge Cinema nie uruchomiła VELORA — nie można jej zamknąć z poziomu aplikacji."
                .to_string(),
        );
    }

    #[cfg(target_os = "windows")]
    {
        for process_id in &launch.process_ids {
            crate::window_broker::track_process(&app, *process_id);
        }
        let window = active_edge_window(&app, &launch)
            .ok_or_else(|| "Nie można ustalić okna Edge Cinema.".to_string())?;
        crate::window_broker::close_tracked_window(&app, window)?;
        let _ = app.emit(
            "velora://cinema-close-requested",
            CinemaCloseRequestedEvent {
                session_id: session_id.clone(),
                confirmed: true,
            },
        );
        let mut session = current_session(&app);
        session.state = "closing".to_string();
        Ok(session)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (launch, session_id);
        Err(NON_WINDOWS_ERROR.to_string())
    }
}

/// Compatibility endpoint for the typed frontend adapter. The native watcher
/// owns exit detection; this command never lets an older caller force a newer
/// session to `exited`.
#[tauri::command]
pub fn report_edge_cinema_exit(
    app: AppHandle,
    session_id: String,
) -> Result<EdgeCinemaSession, String> {
    let Some(launch) = launch_registry::launch_by_id(&app, &session_id) else {
        return Err("Nie znaleziono sesji Edge Cinema o podanym identyfikatorze.".to_string());
    };
    if launch.phase.is_active() {
        // A stale adapter must not close an active native session.
        return Ok(current_session(&app));
    }
    // Never publish an exit for a superseded terminal launch while a newer
    // Edge Cinema session is active or latest.
    if let Some(active) = launch_registry::active_launch_for_app(&app, EDGE_APP_ID) {
        if active.id != session_id {
            return Ok(current_session(&app));
        }
    }
    if launch_registry::latest_launch_for_app(&app, EDGE_APP_ID)
        .is_some_and(|latest| latest.id != session_id)
    {
        return Ok(current_session(&app));
    }
    let session = current_session(&app);
    let _ = app.emit(
        "velora://cinema-exited",
        CinemaExitedEvent {
            session_id,
            reason: "closed".to_string(),
        },
    );
    Ok(session)
}

/// Recovery view. Active sessions are never terminated by a reset; terminal
/// state and stale markers are cleaned up.
#[tauri::command]
pub fn reset_edge_cinema_session(app: AppHandle) -> EdgeCinemaSession {
    #[cfg(target_os = "windows")]
    {
        if launch_registry::active_launch_for_app(&app, EDGE_APP_ID).is_none() {
            if let Some(profile_dir) = edge_profile_dir() {
                if let Some(marker) = read_marker(&profile_dir) {
                    if !marker_is_live(&app, &marker) {
                        remove_marker(&profile_dir);
                    }
                }
            }
        }
    }
    current_session(&app)
}

/// Periodic housekeeping called by the session monitor. It refreshes the
/// marker to the process that actually owns the window (Edge may fork) and
/// removes a marker whose process is gone or whose window disappeared.
pub(crate) fn reconcile_edge_marker(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let Some(profile_dir) = edge_profile_dir() else {
            return;
        };
        let Some(active) = launch_registry::active_launch_for_app(app, EDGE_APP_ID) else {
            if let Some(marker) = read_marker(&profile_dir) {
                if !marker_is_live(app, &marker) {
                    remove_marker(&profile_dir);
                }
            }
            return;
        };
        let processes = active.process_ids.iter().copied().collect::<HashSet<_>>();
        let windows = crate::window_broker::windows_for_processes(app, &processes);
        let window_process = windows
            .iter()
            .find(|window| Some(window.hwnd) == active.window_id)
            .or_else(|| windows.iter().find(|window| window.is_main))
            .or_else(|| windows.first())
            .map(|window| window.process_id);
        let Some(process_id) = window_process.or_else(|| active.process_ids.first().copied()) else {
            return;
        };
        let existing = current_marker(app);
        if existing
            .as_ref()
            .is_some_and(|marker| marker.launch_id == active.id && marker.process_id == process_id)
        {
            return;
        }
        let url = match existing
            .filter(|marker| marker.launch_id == active.id)
            .map(|marker| marker.url)
        {
            Some(url) => url,
            // Without a marker URL, do not invent a service. The launch stays
            // valid; only the read-only URL projection remains unknown.
            None => return,
        };
        let _ = store_marker(app, &active.id, process_id, &url);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// What a failed Edge launch may do with the process it spawned. Decided from
/// plain data, so the ownership rule can be tested on any platform.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SpawnRollback {
    /// Same PID, same creation time and image msedge.exe: the process is ours.
    /// Only the windows of that process may be asked to close (WM_CLOSE).
    CloseOwnWindows { process_id: u32 },
    /// The spawned process has already exited, for example it handed off to an
    /// Edge that was already running. Nothing of ours is left to close.
    NothingLeft,
    /// Identity cannot be proven. Nothing is touched and the state is reported.
    Refuse,
}

/// `spawned` is captured right after the spawn, `current` is read at rollback
/// time. Only an exact (PID, creation time) match plus the msedge.exe image
/// counts as ours, so a recycled PID or another browser is never closed.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn spawn_rollback(
    spawned: Option<(u32, u64)>,
    current: Option<(u32, u64)>,
    image: Option<&str>,
) -> SpawnRollback {
    let Some(spawned) = spawned else {
        return SpawnRollback::Refuse;
    };
    let Some(current) = current else {
        return SpawnRollback::NothingLeft;
    };
    let is_edge = image.is_some_and(|name| name.eq_ignore_ascii_case("msedge.exe"));
    if spawned == current && is_edge {
        SpawnRollback::CloseOwnWindows { process_id: spawned.0 }
    } else {
        SpawnRollback::Refuse
    }
}

/// Runs only after `track_launch` failed for a process VELORA spawned. Closes
/// that process's windows gracefully (WM_CLOSE through the window broker). It
/// never terminates a process and never touches windows of other processes.
#[cfg(target_os = "windows")]
fn rollback_failed_spawn(app: &AppHandle, spawned: Option<crate::process_table::ProcessIdentity>) {
    let current = spawned.and_then(|identity| crate::process_table::identity(identity.process_id));
    let image = spawned.and_then(|identity| {
        crate::process_table::snapshot(true)
            .ok()
            .and_then(|table| table.image_name(identity.process_id).map(str::to_owned))
    });
    let decision = spawn_rollback(
        spawned.map(|identity| (identity.process_id, identity.created_at_100ns)),
        current.map(|identity| (identity.process_id, identity.created_at_100ns)),
        image.as_deref(),
    );
    if let SpawnRollback::CloseOwnWindows { process_id } = decision {
        window_broker::track_process(app, process_id);
        let processes = HashSet::from([process_id]);
        for window in window_broker::windows_for_processes(app, &processes) {
            let _ = window_broker::close_tracked_window(app, window.hwnd);
        }
    }
}

#[cfg(test)]
mod rollback_tests {
    use super::{spawn_rollback, SpawnRollback};

    #[test]
    fn rollback_closes_only_a_proven_msedge_process() {
        assert_eq!(
            spawn_rollback(Some((4242, 99)), Some((4242, 99)), Some("msedge.exe")),
            SpawnRollback::CloseOwnWindows { process_id: 4242 },
        );
        // Image names are compared case-insensitively, as Windows reports them.
        assert_eq!(
            spawn_rollback(Some((4242, 99)), Some((4242, 99)), Some("MSEDGE.EXE")),
            SpawnRollback::CloseOwnWindows { process_id: 4242 },
        );
    }

    #[test]
    fn rollback_refuses_a_recycled_pid() {
        // Same PID, different creation time: a different process now owns the number.
        assert_eq!(
            spawn_rollback(Some((4242, 99)), Some((4242, 100)), Some("msedge.exe")),
            SpawnRollback::Refuse,
        );
    }

    #[test]
    fn rollback_refuses_another_browser_or_unknown_image() {
        assert_eq!(
            spawn_rollback(Some((4242, 99)), Some((4242, 99)), Some("chrome.exe")),
            SpawnRollback::Refuse,
        );
        assert_eq!(
            spawn_rollback(Some((4242, 99)), Some((4242, 99)), None),
            SpawnRollback::Refuse,
        );
    }

    #[test]
    fn rollback_without_a_spawn_identity_touches_nothing() {
        assert_eq!(
            spawn_rollback(None, Some((4242, 99)), Some("msedge.exe")),
            SpawnRollback::Refuse,
        );
    }

    #[test]
    fn rollback_after_a_handoff_exit_leaves_nothing_to_close() {
        assert_eq!(
            spawn_rollback(Some((4242, 99)), None, None),
            SpawnRollback::NothingLeft,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        adoption_is_compatible, edge_cinema_arguments, edge_cinema_notes, edge_watch,
        is_allowed_streaming_url, marker_matches_identity, phase_state, profile_directory_name,
        public_profile_label, session_from_launch, validate_marker, EdgeCinemaReceipt,
        EdgeCinemaSession, EdgeCinemaStatus, EdgeSessionMarker, ALLOWED_STREAMING_URLS,
        EDGE_CINEMA_PROFILE_NAME, SESSION_MARKER_VERSION,
    };
    use crate::launch_registry::{LaunchKind, LaunchPhase, LaunchSession};
    use crate::process_table::ProcessIdentity;

    #[test]
    fn allowlist_accepts_exactly_the_five_official_urls() {
        assert_eq!(ALLOWED_STREAMING_URLS.len(), 5);
        for url in ALLOWED_STREAMING_URLS {
            assert!(is_allowed_streaming_url(url), "powinien być dozwolony: {url}");
        }
    }

    #[test]
    fn allowlist_rejects_near_misses_and_argument_injection() {
        let rejected = [
            "http://www.netflix.com/pl/",
            "https://www.netflix.com/pl/login",
            "https://netflix.com/pl/",
            "https://www.netflix.com.evil.example/pl/",
            "https://www.disneyplus.com/pl-pl ",
            "https://www.youtube.com/ --kiosk",
            "https://www.primevideo.com/-/pl_PL/?tr=pl&extra=1",
            "https://www.example.com/",
            "",
        ];
        for url in rejected {
            assert!(
                !is_allowed_streaming_url(url),
                "powinien zostać odrzucony: {url:?}"
            );
        }
    }

    #[test]
    fn edge_cinema_arguments_match_the_fixed_app_fullscreen_flags() {
        let url = "https://www.hbomax.com/pl/pl";
        let profile = r"C:\Users\tester\AppData\Local\VELORA\VELORA-EdgeCinema";
        assert_eq!(
            edge_cinema_arguments(url, profile),
            vec![
                format!("--app={url}"),
                "--start-fullscreen".to_string(),
                format!("--user-data-dir={profile}"),
                "--no-first-run".to_string(),
                "--no-default-browser-check".to_string(),
                "--window-name=VELORA-EdgeCinema".to_string(),
            ]
        );
    }

    #[test]
    fn edge_cinema_arguments_never_emit_forbidden_or_injected_args() {
        let malicious = "https://www.netflix.com/pl/ --kiosk --incognito --disable-gpu --no-sandbox --disable-features=X --user-data-dir=C:\\evil";
        let profile = r"C:\Users\tester\AppData\Local\VELORA\VELORA-EdgeCinema";
        let args = edge_cinema_arguments(malicious, profile);
        assert_eq!(args.len(), 6);
        assert!(args.iter().any(|arg| arg == &format!("--app={malicious}")));
        for arg in &args {
            for flag in [
                "--kiosk",
                "--incognito",
                "--disable-gpu",
                "--disable-drm",
                "--no-sandbox",
            ] {
                assert!(
                    !arg.starts_with(flag),
                    "zabroniona flaga jako osobny argument: {arg}"
                );
            }
            assert!(!arg.starts_with("--disable-features="));
        }
        let user_data_dirs = args
            .iter()
            .filter(|arg| arg.starts_with("--user-data-dir="))
            .collect::<Vec<_>>();
        assert_eq!(user_data_dirs.len(), 1);
        assert_eq!(user_data_dirs[0], &format!("--user-data-dir={profile}"));
    }

    #[test]
    fn profile_directory_name_is_the_stable_velora_profile() {
        assert_eq!(profile_directory_name(), "VELORA-EdgeCinema");
        assert_eq!(profile_directory_name(), EDGE_CINEMA_PROFILE_NAME);
    }

    #[test]
    fn status_and_receipt_have_the_expected_shape() {
        let status = EdgeCinemaStatus {
            windows: false,
            edge_detected: false,
            profile_dir: None,
            notes: edge_cinema_notes(),
        };
        assert!(!status.windows);
        assert!(!status.edge_detected);
        assert!(status.profile_dir.is_none());
        assert!(!status.notes.is_empty());
        let receipt = EdgeCinemaReceipt {
            launched: true,
            mode: "app-fullscreen".to_string(),
            profile_dir: profile_directory_name().to_string(),
            launch_id: Some("cinema-1".into()),
            adopted: false,
        };
        assert!(receipt.launched);
        assert_eq!(receipt.mode, "app-fullscreen");
        assert_eq!(receipt.profile_dir, "VELORA-EdgeCinema");
    }

    #[test]
    fn notes_document_drm_and_login_persistence() {
        let notes = edge_cinema_notes().join(" ");
        assert!(notes.contains("DRM"));
        assert!(notes.contains("4K"));
        assert!(notes.contains("HDR"));
        assert!(notes.to_lowercase().contains("logowania"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn missing_edge_is_reported_without_inventing_native_state() {
        let status = super::get_edge_cinema_status();
        assert!(!status.windows);
        assert!(!status.edge_detected);
        assert!(status.profile_dir.is_none());
        assert!(status.notes.iter().any(|note| note.contains("tylko w natywnej")));
    }

    fn marker() -> EdgeSessionMarker {
        EdgeSessionMarker {
            version: SESSION_MARKER_VERSION,
            launch_id: "cinema-1".into(),
            process_id: 4242,
            process_created_at_100ns: 77,
            url: "https://www.netflix.com/pl/".into(),
        }
    }

    #[test]
    fn marker_accepts_only_the_closed_safe_shape() {
        assert!(validate_marker(&marker()));
        let mut wrong_version = marker();
        wrong_version.version = SESSION_MARKER_VERSION + 1;
        assert!(!validate_marker(&wrong_version));
        let mut zero_pid = marker();
        zero_pid.process_id = 0;
        assert!(!validate_marker(&zero_pid));
        let mut unknown_url = marker();
        unknown_url.url = "https://example.com/".into();
        assert!(!validate_marker(&unknown_url));
        let mut empty_launch = marker();
        empty_launch.launch_id.clear();
        assert!(!validate_marker(&empty_launch));
        let mut control = marker();
        control.launch_id = "cinema\n2".into();
        assert!(!validate_marker(&control));
    }

    #[test]
    fn marker_identity_requires_pid_and_creation_time() {
        let marker = marker();
        let identity = ProcessIdentity {
            process_id: 4242,
            created_at_100ns: 77,
        };
        assert!(marker_matches_identity(&marker, Some(identity)));
        assert!(!marker_matches_identity(
            &marker,
            Some(ProcessIdentity {
                process_id: 4242,
                created_at_100ns: 78
            })
        ));
        assert!(!marker_matches_identity(
            &marker,
            Some(ProcessIdentity {
                process_id: 4243,
                created_at_100ns: 77
            })
        ));
        assert!(!marker_matches_identity(&marker, None));
    }

    #[test]
    fn adoption_is_limited_to_the_requested_service() {
        let netflix = marker();
        assert!(adoption_is_compatible(
            &netflix,
            "https://www.netflix.com/pl/"
        ));
        assert!(!adoption_is_compatible(
            &netflix,
            "https://www.disneyplus.com/pl-pl"
        ));
        assert!(!adoption_is_compatible(
            &netflix,
            "https://www.youtube.com/"
        ));
        let mut invalid = marker();
        invalid.url = "https://evil.example/".into();
        assert!(!adoption_is_compatible(&invalid, "https://evil.example/"));
    }

    #[test]
    fn public_profile_projection_never_exposes_the_user_path() {
        let label = public_profile_label();
        assert_eq!(label, EDGE_CINEMA_PROFILE_NAME);
        assert!(!label.contains(':'));
        assert!(!label.contains('\\'));
        assert!(!label.contains('/'));
        assert!(!label.to_ascii_lowercase().contains("appdata"));
        assert!(!label.to_ascii_lowercase().contains("users"));
    }

    #[test]
    fn launch_phase_projection_never_invents_active_state() {
        assert_eq!(phase_state(LaunchPhase::Requested), "launching");
        assert_eq!(phase_state(LaunchPhase::ProcessStarted), "launching");
        assert_eq!(phase_state(LaunchPhase::WindowAppeared), "launching");
        assert_eq!(phase_state(LaunchPhase::SessionActive), "active");
        assert_eq!(phase_state(LaunchPhase::ExitPending), "closing");
        assert_eq!(phase_state(LaunchPhase::Ended), "exited");
        assert_eq!(phase_state(LaunchPhase::Cancelled), "exited");
        assert_eq!(phase_state(LaunchPhase::Failed), "error");
    }

    fn launch(phase: LaunchPhase) -> LaunchSession {
        LaunchSession {
            id: "cinema-9".into(),
            kind: LaunchKind::Cinema,
            display_name: "Edge Cinema".into(),
            app_id: Some("edge-cinema".into()),
            phase,
            process_ids: vec![900],
            foreground: false,
            window_id: Some(55),
            started_at_ms: 1000,
            updated_at_ms: 1100,
            error: None,
            restore: None,
            session_revision: Some(3),
            pid_reuse_detected: false,
            attention: None,
        }
    }

    #[test]
    fn session_projection_uses_registry_state_and_no_fake_window_title() {
        let session = session_from_launch(
            &launch(LaunchPhase::SessionActive),
            Some("https://www.youtube.com/".into()),
            Some("C:/profile".into()),
        );
        assert_eq!(session.session_id.as_deref(), Some("cinema-9"));
        assert_eq!(session.state, "active");
        assert_eq!(session.pid, Some(900));
        assert!(session.window_title.is_none());
        assert_eq!(session.url.as_deref(), Some("https://www.youtube.com/"));
        assert!(session.managed_by_velora);
    }

    #[test]
    fn session_projection_rejects_a_url_outside_the_allowlist() {
        let session = session_from_launch(
            &launch(LaunchPhase::Ended),
            Some("https://evil.example/".into()),
            None,
        );
        assert!(session.url.is_none());
        assert_eq!(session.state, "exited");
    }

    #[test]
    fn edge_watch_owns_cinema_and_detects_window_close() {
        let watch = edge_watch(Some(4242));
        assert_eq!(watch.kind, LaunchKind::Cinema);
        assert_eq!(watch.session_target, Some(crate::session_orchestrator::SessionId::Cinema));
        assert!(watch.end_on_window_gone);
        assert!(watch.ignore_baseline_windows);
        assert!(watch.descendants_only);
        assert!(watch.root_counts_as_running);
        assert!(watch.include_root_window);
        assert_eq!(watch.start_timeout_ms, 20_000);
    }

    #[test]
    fn idle_projection_is_explicit() {
        let idle = super::idle_session();
        assert_eq!(idle.state, "idle");
        assert!(idle.session_id.is_none());
        assert!(idle.pid.is_none());
        assert!(idle.last_error.is_none());
    }

    #[test]
    fn session_type_is_serializable_in_camel_case() {
        let session: EdgeCinemaSession = session_from_launch(
            &launch(LaunchPhase::WindowAppeared),
            Some("https://www.hbomax.com/pl/pl".into()),
            None,
        );
        let value = serde_json::to_value(session).unwrap();
        assert_eq!(value["state"], "launching");
        assert_eq!(value["sessionId"], "cinema-9");
        assert_eq!(value["managedByVelora"], true);
    }
}
