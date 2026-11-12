//! Biblioteka gier Playnite — granica adaptera TYLKO DO ODCZYTU (VELORA 1.0).
//!
//! W tym buildzie nie ma bezpiecznego, udokumentowanego API metadanych Playnite.
//! Moduł NIE otwiera bazy danych Playnite, NIE czyta plików biblioteki,
//! NIE zgaduje ich układu, NIE wykonuje logowania do GOG / Epic / EA / Ubisoft
//! i NIE zapisuje czegokolwiek w danych Playnite. Jedyną dozwoloną czynnością
//! na Windows jest sprawdzenie `Path::is_file()` na pliku wykonywalnym Playnite.

use serde::Serialize;
use tauri::AppHandle;

use crate::launch_registry::{self, LaunchKind, LaunchWatch};
use crate::session_orchestrator::SessionId;

#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

/// One Playnite handoff at a time: prevents two quick game clicks from starting
/// two Playnite instances or cancelling each other's launch session.
static PLAYNITE_LAUNCH_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Kształt pojedynczej gry. Zarezerwowany dla przyszłego, udokumentowanego API;
/// w VELORA 1.0 nie jest nigdy wypełniany (brak potwierdzonego źródła danych).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayniteGame {
    pub id: String,
    pub name: String,
    pub cover: Option<String>,
    pub source: String,
    pub last_played: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayniteLibrarySnapshot {
    pub source: String,
    pub available: bool,
    pub reason: Option<String>,
    pub games: Vec<PlayniteGame>,
    pub read_only: bool,
}

/// Snapshot używany zawsze, gdy brak bezpiecznego źródła metadanych.
pub fn unavailable_snapshot() -> PlayniteLibrarySnapshot {
    PlayniteLibrarySnapshot {
        source: "unavailable".to_string(),
        available: false,
        reason: Some(
            "Brak bezpiecznego, udokumentowanego API Playnite. VELORA nie odczytuje plików bazy danych Playnite ani nie zgaduje jej struktury."
                .to_string(),
        ),
        games: Vec::new(),
        read_only: true,
    }
}

/// Wykrycie samego pliku wykonywalnego Playnite — BEZ żadnych metadanych gier.
pub fn detected_snapshot() -> PlayniteLibrarySnapshot {
    PlayniteLibrarySnapshot {
        source: "playnite-detected".to_string(),
        available: false,
        reason: Some(
            "Wykryto instalację Playnite, ale brak bezpiecznego, udokumentowanego API metadanych. VELORA nie wyświetla listy gier bez potwierdzonego źródła."
                .to_string(),
        ),
        games: Vec::new(),
        read_only: true,
    }
}

/// W VELORA 1.0 żadne bezpieczne, udokumentowane API nie jest skonfigurowane.
pub const fn playnite_api_is_configured() -> bool {
    false
}

/// TYLKO DO ODCZYTU: `Path::is_file()` na znanych lokalizacjach pliku exe Playnite.
/// Wzorzec zgodny z `app_manager.rs::playnite_path`, ale bez uruchamiania procesów,
/// bez odczytu biblioteki i bez logowania do platform.
#[cfg(target_os = "windows")]
fn playnite_executable_detected() -> bool {
    for root in standard_install_roots() {
        for relative in [
            "Playnite/Playnite.FullscreenApp.exe",
            "Playnite/Playnite.DesktopApp.exe",
            "Programs/Playnite/Playnite.FullscreenApp.exe",
            "Programs/Playnite/Playnite.DesktopApp.exe",
        ] {
            let candidate = root.join(relative);
            if candidate.as_path().is_file() {
                return true;
            }
        }
    }
    false
}

/// macOS / Linux: brak natywnej detekcji, zawsze jawny brak danych.
#[cfg(not(target_os = "windows"))]
fn playnite_executable_detected() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn standard_install_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    roots
}

/// Granica adaptera: preferujemy zwalidowany, tylko-do-odczytu manifest
/// (gdy jest dostępny), w przeciwnym razie wracamy do bezpiecznego wykrycia
/// samego pliku wykonywalnego Playnite. Nigdy nie zgadujemy metadanych gier.
#[tauri::command]
pub fn get_playnite_library() -> PlayniteLibrarySnapshot {
    resolve_library_snapshot(crate::playnite_manifest::read_default_manifest().ok())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayniteLaunchReceipt {
    pub game_id: String,
    pub launched: bool,
    pub playnite_launch_id: Option<String>,
}

/// Starts one game through Playnite's official URI. VELORA first ensures that
/// Playnite Fullscreen is tracked by LaunchRegistry, then opens the validated
/// `playnite://playnite/start/<guid>` URI. It never reads or edits Playnite's
/// database and never copies launcher credentials.
#[tauri::command]
pub async fn launch_playnite_game(
    app: AppHandle,
    game_id: String,
) -> Result<PlayniteLaunchReceipt, String> {
    tauri::async_runtime::spawn_blocking(move || launch_playnite_game_blocking(app, game_id))
        .await
        .unwrap_or_else(|_| Err("Uruchomienie gry Playnite zostało przerwane.".to_string()))
}

fn launch_playnite_game_blocking(
    app: AppHandle,
    game_id: String,
) -> Result<PlayniteLaunchReceipt, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, game_id);
        Err("Uruchamianie gier Playnite jest dostępne tylko w natywnej aplikacji Windows.".into())
    }

    #[cfg(target_os = "windows")]
    {
        let _launch_gate = PLAYNITE_LAUNCH_GATE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let manifest = crate::playnite_manifest::read_default_manifest()
            .map_err(|error| error.user_message())?;
        let uri = crate::playnite_manifest::launch_uri_for_game(&manifest, &game_id)?;

        let already_running = playnite_process_id();
        if launch_registry::active_launch_for_app(&app, "playniteFullscreen").is_none() {
            if already_running.is_some() {
                attach_existing_playnite(&app, already_running.expect("checked above"))?;
            } else {
                crate::app_manager::launch_managed_app_blocking(
                    app.clone(),
                    "playniteFullscreen".to_string(),
                )?;
                if !wait_for_playnite(Duration::from_millis(8_000)) {
                    if let Some(launch) =
                        launch_registry::active_launch_for_app(&app, "playniteFullscreen")
                    {
                        let _ = launch_registry::cancel_launch(&app, &launch.id);
                    }
                    return Err(
                        "Playnite Fullscreen nie uruchomił się w bezpiecznym czasie.".to_string(),
                    );
                }
            }
        }

        let launch_id = launch_registry::active_launch_for_app(&app, "playniteFullscreen")
            .map(|launch| launch.id);
        if let Err(error) = open_playnite_uri(&uri) {
            // If VELORA started Playnite only for this request, return to Home
            // instead of leaving the user in an invisible, failed session.
            if already_running.is_none() {
                if let Some(launch_id) = launch_id.as_deref() {
                    let _ = launch_registry::cancel_launch(&app, launch_id);
                }
            }
            return Err(error);
        }

        Ok(PlayniteLaunchReceipt {
            game_id,
            launched: true,
            playnite_launch_id: launch_id,
        })
    }
}

#[cfg(target_os = "windows")]
fn playnite_process_id() -> Option<u32> {
    launch_registry::find_process_id("Playnite.FullscreenApp.exe")
        .or_else(|| launch_registry::find_process_id("Playnite.DesktopApp.exe"))
}

#[cfg(target_os = "windows")]
fn wait_for_playnite(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if playnite_process_id().is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Attaches a session to Playnite started outside VELORA. This is a user-driven
/// game launch, so the session is owned by VELORA, but the process is never
/// killed on exit.
#[cfg(target_os = "windows")]
fn attach_existing_playnite(app: &AppHandle, process_id: u32) -> Result<(), String> {
    let watch = LaunchWatch::new(
        LaunchKind::Playnite,
        "Playnite Fullscreen",
        Some("playniteFullscreen".to_string()),
        vec![
            "Playnite.FullscreenApp.exe".to_string(),
            "Playnite.DesktopApp.exe".to_string(),
        ],
        Some(process_id),
        false,
        true,
        Vec::new(),
        true,
        Some(SessionId::Playnite),
    );
    launch_registry::track_launch(app, watch).map(|_| ())
}

#[cfg(target_os = "windows")]
fn open_playnite_uri(uri: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation = HSTRING::from("open");
    let file = HSTRING::from(uri);
    let result = unsafe {
        ShellExecuteW(
            None,
            Some(PCWSTR(operation.as_ptr())),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute returns a value greater than 32 on success. It can return a
    // small error code even without setting GetLastError, so only the documented
    // threshold is used and no raw Windows message is surfaced.
    if result.0 as isize <= 32 {
        return Err(
            "Windows nie przekazał gry do Playnite. Sprawdź, czy Playnite obsługuje playnite://."
                .to_string(),
        );
    }
    Ok(())
}

/// Czysty wybór snapshotu: prawdziwy, zwalidowany manifest albo bezpieczny fallback.
pub fn resolve_library_snapshot(
    manifest: Option<crate::playnite_manifest::VeloraLibraryManifest>,
) -> PlayniteLibrarySnapshot {
    match manifest {
        Some(valid) => crate::playnite_manifest::snapshot_from_manifest(&valid),
        None => {
            if playnite_api_is_configured() {
                return unavailable_snapshot();
            }
            if playnite_executable_detected() {
                detected_snapshot()
            } else {
                unavailable_snapshot()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALLOWED_SOURCES: [&str; 3] = ["playnite-api", "playnite-detected", "unavailable"];

    #[test]
    fn unavailable_snapshot_is_read_only_and_empty() {
        let snapshot = unavailable_snapshot();
        assert_eq!(snapshot.source, "unavailable");
        assert!(!snapshot.available);
        assert!(snapshot.games.is_empty());
        assert!(snapshot.read_only);
        assert!(snapshot.reason.is_some());
        assert!(ALLOWED_SOURCES.contains(&snapshot.source.as_str()));
    }

    #[test]
    fn detected_snapshot_carries_no_metadata() {
        let snapshot = detected_snapshot();
        assert_eq!(snapshot.source, "playnite-detected");
        assert!(!snapshot.available);
        assert!(snapshot.games.is_empty());
        assert!(snapshot.read_only);
        assert!(ALLOWED_SOURCES.contains(&snapshot.source.as_str()));
    }

    #[test]
    fn safe_api_is_not_configured_in_this_build() {
        assert!(!playnite_api_is_configured());
    }

    #[test]
    fn command_never_invents_games() {
        // Deterministyczne: niezależne od ewentualnego manifestu na maszynie dev.
        let snapshot = resolve_library_snapshot(None);
        assert!(snapshot.games.is_empty());
        assert!(snapshot.read_only);
        assert!(!snapshot.available);
        assert!(ALLOWED_SOURCES.contains(&snapshot.source.as_str()));
    }

    #[test]
    fn manifest_snapshot_carries_real_games() {
        const FIXTURE: &str = r#"{
            "schemaVersion": 1,
            "kind": "velora.playnite.library-manifest",
            "generatedAt": "2026-11-12T00:00:00Z",
            "extension": { "id": "velora-library-exporter", "version": "1.0.0" },
            "source": "playnite-api",
            "readOnly": true,
            "games": [
                {
                    "id": "64f78cd1-0b00-4271-a9e1-89abc55f66cc",
                    "name": "Example Game",
                    "cover": null,
                    "source": "Steam",
                    "lastPlayed": null,
                    "favorite": false,
                    "installed": true,
                    "launch": {
                        "kind": "playnite-uri",
                        "uri": "playnite://playnite/start/64f78cd1-0b00-4271-a9e1-89abc55f66cc"
                    }
                }
            ]
        }"#;
        let manifest = crate::playnite_manifest::parse_manifest(FIXTURE.as_bytes())
            .expect("poprawny manifest testowy musi się sparsować");
        let snapshot = resolve_library_snapshot(Some(manifest));
        assert_eq!(snapshot.source, "playnite-api");
        assert!(snapshot.available);
        assert!(snapshot.read_only);
        assert!(snapshot.reason.is_none());
        assert_eq!(snapshot.games.len(), 1);
        assert_eq!(snapshot.games[0].id, "64f78cd1-0b00-4271-a9e1-89abc55f66cc");
        assert_eq!(snapshot.games[0].name, "Example Game");
        assert!(ALLOWED_SOURCES.contains(&snapshot.source.as_str()));
    }

    #[test]
    fn source_never_references_undocumented_library_files() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/playnite_library.rs");
        let source = std::fs::read_to_string(path)
            .expect("playnite_library.rs must be readable")
            .to_lowercase();
        // Tokeny zbudowane dynamicznie, aby sam test nie zawierał zakazanych literałów.
        let forbidden = [
            [".", "d", "b"].concat(),
            ["sql", "ite"].concat(),
            ["database", ".", "json"].concat(),
        ];
        for token in forbidden {
            assert!(
                !source.contains(token.as_str()),
                "playnite_library.rs must not reference an undocumented library token: {token}"
            );
        }
    }
}
