//! Biblioteka gier Playnite — granica adaptera TYLKO DO ODCZYTU (VELORA 1.0).
//!
//! W tym buildzie nie ma bezpiecznego, udokumentowanego API metadanych Playnite.
//! Moduł NIE otwiera bazy danych Playnite, NIE czyta plików biblioteki,
//! NIE zgaduje ich układu, NIE wykonuje logowania do GOG / Epic / EA / Ubisoft
//! i NIE zapisuje czegokolwiek w danych Playnite. Jedyną dozwoloną czynnością
//! na Windows jest sprawdzenie `Path::is_file()` na pliku wykonywalnym Playnite.

use serde::Serialize;

#[cfg(target_os = "windows")]
use std::path::PathBuf;

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
