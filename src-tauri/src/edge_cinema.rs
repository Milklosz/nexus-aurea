use serde::Serialize;

#[cfg(target_os = "windows")]
use std::fs;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::Command;

/// Stabilna nazwa dedykowanego, trwałego profilu Edge Cinema. Ta sama wartość
/// jest zdefiniowana po stronie TypeScript jako `EDGE_CINEMA_PROFILE_NAME`.
pub const EDGE_CINEMA_PROFILE_NAME: &str = "VELORA-EdgeCinema";

/// Obrona warstwowa (defense in depth) po stronie serwera: DOKŁADNA allowlista
/// pięciu oficjalnych adresów HTTPS z `src/data/streamingServices.ts`.
/// Żaden inny ciąg nie zostaje przepuszczony — zapobiega to wstrzykiwaniu
/// argumentów do wywołania `msedge.exe`.
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
}

/// Czysty helper: czy adres jest dokładnie jednym z pięciu zaufanych adresów.
pub fn is_allowed_streaming_url(url: &str) -> bool {
    ALLOWED_STREAMING_URLS.contains(&url)
}

/// Czysty helper: stabilna nazwa katalogu profilu VELORA.
pub fn profile_directory_name() -> &'static str {
    EDGE_CINEMA_PROFILE_NAME
}

/// Czysty helper: buduje stały, zamknięty zestaw flag uruchomieniowych.
/// `url` jest traktowany jako pojedyncza, nieprzezroczysta wartość `--app=...`
/// (nie jest dzielony na osobne argumenty), co uniemożliwia wstrzyknięcie
/// dodatkowych flag. W produkcji helper jest wywoływany WYŁĄCZNIE z dopasowaną
/// stałą z allowlisty — nigdy z surowym wejściem od frontendu.
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

/// Notatki o zachowaniu i ograniczeniach (również dla statusu wyłączonego).
fn edge_cinema_notes() -> Vec<String> {
    vec![
        "Dedykowany, trwały profil Microsoft Edge (VELORA-EdgeCinema) zachowuje logowania do serwisów między uruchomieniami.".to_string(),
        "Błędy uruchomienia (brak Edge, katalog profilu, uruchomienie okna) są komunikowane czytelnie po polsku.".to_string(),
        "VELORA nie gwarantuje i nie zmienia obsługi DRM / Widevine / PlayReady, jakości 4K, HDR, HDCP, możliwości GPU, poziomu subskrypcji ani dostępności usługi — zależą one od sprzętu, sterowników i dostawcy.".to_string(),
    ]
}

#[tauri::command]
pub fn launch_edge_cinema(url: String) -> Result<EdgeCinemaReceipt, String> {
    #[cfg(target_os = "windows")]
    {
        // Używamy WYŁĄCZNIE dopasowanej stałej z allowlisty — nigdy surowego
        // wejścia `url`. Gwarantuje to brak interpolacji niezaufanych danych.
        let canonical = match ALLOWED_STREAMING_URLS.iter().find(|&&allowed| allowed == url) {
            Some(&allowed) => allowed,
            None => return Err(UNTRUSTED_URL_ERROR.to_string()),
        };

        let executable = edge_executable().ok_or_else(|| EDGE_NOT_FOUND_ERROR.to_string())?;
        let profile_dir = edge_profile_dir().ok_or_else(|| PROFILE_DIR_ERROR.to_string())?;
        fs::create_dir_all(&profile_dir).map_err(|_| PROFILE_DIR_ERROR.to_string())?;
        let profile_dir_string = profile_dir.to_string_lossy().into_owned();

        let arguments = edge_cinema_arguments(canonical, &profile_dir_string);
        let child = Command::new(executable)
            .args(&arguments)
            .spawn()
            .map_err(|_| SPAWN_ERROR.to_string())?;
        // Odłączamy proces: nie czekamy na niego ani go nie zabijamy.
        drop(child);

        Ok(EdgeCinemaReceipt {
            launched: true,
            mode: "app-fullscreen".to_string(),
            profile_dir: profile_dir_string,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        Err(NON_WINDOWS_ERROR.to_string())
    }
}

#[tauri::command]
pub fn get_edge_cinema_status() -> EdgeCinemaStatus {
    #[cfg(target_os = "windows")]
    {
        EdgeCinemaStatus {
            windows: true,
            edge_detected: edge_executable().is_some(),
            profile_dir: edge_profile_dir().map(|path| path.to_string_lossy().into_owned()),
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

/// Lokalizacja `msedge.exe` — wzorzec `browser_paths` z `app_manager.rs`,
/// wyłącznie odczytowe sprawdzenia `Path::is_file()`.
#[cfg(target_os = "windows")]
fn edge_executable() -> Option<PathBuf> {
    let mut paths = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            let prefix = if key == "LOCALAPPDATA" { root.join("Programs") } else { root };
            paths.push(prefix.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
        }
    }
    paths.into_iter().find(|path| path.is_file())
}

/// Własny folder danych aplikacji VELORA (nie ustawienie systemowe):
/// `<LOCALAPPDATA>/VELORA/VELORA-EdgeCinema`.
#[cfg(target_os = "windows")]
fn edge_profile_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    Some(local.join("VELORA").join(profile_directory_name()))
}

#[cfg(test)]
mod tests {
    use super::{
        edge_cinema_arguments, edge_cinema_notes, is_allowed_streaming_url, profile_directory_name,
        EdgeCinemaReceipt, EdgeCinemaStatus, ALLOWED_STREAMING_URLS, EDGE_CINEMA_PROFILE_NAME,
    };

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
            assert!(!is_allowed_streaming_url(url), "powinien zostać odrzucony: {url:?}");
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

        // URL pozostaje jedną, nieprzezroczystą wartością; nic nie dokłada argumentów.
        assert_eq!(args.len(), 6);
        assert!(args.iter().any(|arg| arg == &format!("--app={malicious}")));

        let forbidden = [
            "--kiosk",
            "--incognito",
            "--disable-gpu",
            "--disable-drm",
            "--no-sandbox",
        ];
        for arg in &args {
            for flag in forbidden {
                assert!(!arg.starts_with(flag), "zabroniona flaga jako osobny argument: {arg}");
            }
            assert!(
                !arg.starts_with("--disable-features="),
                "flaga wyłączająca funkcje jako osobny argument: {arg}"
            );
        }

        // Jedyny --user-data-dir wskazuje na profil VELORA, nigdzie indziej.
        let user_data_dirs: Vec<&String> = args
            .iter()
            .filter(|arg| arg.starts_with("--user-data-dir="))
            .collect();
        assert_eq!(user_data_dirs.len(), 1);
        assert_eq!(user_data_dirs[0], &format!("--user-data-dir={profile}"));
        assert!(user_data_dirs[0].contains("VELORA-EdgeCinema"));
    }

    #[test]
    fn profile_directory_name_is_the_stable_velora_profile() {
        assert_eq!(profile_directory_name(), "VELORA-EdgeCinema");
        assert_eq!(profile_directory_name(), EDGE_CINEMA_PROFILE_NAME);
    }

    #[test]
    fn disabled_status_and_receipt_have_the_expected_shape() {
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
}
