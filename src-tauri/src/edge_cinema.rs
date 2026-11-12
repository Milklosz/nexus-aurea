use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

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

// ---------------------------------------------------------------------------
// MODUŁ B — Edge Cinema Lifecycle 2.0 (ADAPTER + typowane zdarzenia).
// To NIE jest WindowBroker: żaden proces nie jest zabijany, żadne okno nie jest
// wyszukiwane (brak HWND / EnumWindows / wątku watchera). Stan sesji to dane
// w pamięci + typowane zdarzenia przeznaczone dla PRZYSZŁEGO brokera/obserwatora
// pierwszoplanowego (dziedzina DeepSeek). VELORA sama nie odpytuje okien.
// ---------------------------------------------------------------------------

/// Typowany rekord sesji Edge Cinema. `state` jest jednym z
/// idle|launching|active|closing|exited|error (mirrors kontrakt SessionStatus).
/// Wyłącznie bezpieczne dane diagnostyczne: brak uchwytów HWND, a `last_error`
/// jest zawsze sanitized (bez surowych ścieżek / stosu wywołań).
#[derive(Clone, Debug, Serialize)]
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

/// Czysty stan w pamięci (Send + Sync) — wyłącznie dane, bez wątków.
/// LEAD dodaje `.manage(edge_cinema::EdgeCinemaSessions::default())` w `lib.rs`.
#[derive(Default)]
pub struct EdgeCinemaSessions {
    pub current: Mutex<Option<EdgeCinemaSession>>,
}

/// Ładunek zdarzenia `velora://cinema-session-changed`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CinemaSessionEvent {
    pub session: EdgeCinemaSession,
}

/// Ładunek zdarzenia `velora://cinema-exited`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CinemaExitedEvent {
    pub session_id: String,
    pub reason: String,
}

/// Ładunek zdarzenia `velora://cinema-close-requested`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CinemaCloseRequestedEvent {
    pub session_id: String,
    pub confirmed: bool,
}

/// Czysty helper: liczba sekund od epoki UNIX (bez zewnętrznych crate'ów).
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Czysty, unit-testowalny znacznik czasu (epoch seconds jako String).
pub fn now_timestamp() -> String {
    now_seconds().to_string()
}

/// Deterministyczny identyfikator sesji (bez losowości, bez ścieżek systemowych).
pub fn make_session_id(pid: u32, seconds: u64) -> String {
    format!("edge-cinema-{pid}-{seconds}")
}

/// Czysty helper: AKTYWNA = faza uruchamiania lub aktywna.
pub fn session_is_active(session: &EdgeCinemaSession) -> bool {
    session.state == "launching" || session.state == "active"
}

/// Czysty helper: ZAMKNIĘTA = jawne wyjście lub błąd.
pub fn session_is_closed(session: &EdgeCinemaSession) -> bool {
    session.state == "exited" || session.state == "error"
}

/// Czysty helper: duplikat odrzucamy wyłącznie, gdy bieżąca sesja jest aktywna.
pub fn should_reject_duplicate(current: Option<&EdgeCinemaSession>) -> bool {
    matches!(current, Some(session) if session_is_active(session))
}

/// Bezpieczna diagnoza błędu: usuwa znaki sterujące i ogranicza długość.
/// NIGDY nie przepuszcza surowego stosu wywołań.
fn sanitize_error(message: &str) -> String {
    let cleaned: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cleaned.trim().chars().take(240).collect()
}

/// Pusty (idle) rekord sesji — punkt wyjścia i bezpieczny default odczytu.
/// Pomimo nazwy jest to stan bezczynności, zgodny z `IDLE_CINEMA_SESSION`.
pub fn active_session() -> EdgeCinemaSession {
    EdgeCinemaSession {
        session_id: None,
        state: "idle".to_string(),
        app_id: "edge-cinema".to_string(),
        pid: None,
        window_title: None,
        profile_dir: None,
        url: None,
        launched_at: None,
        last_error: None,
        managed_by_velora: true,
    }
}

/// Buduje NOWY rekord aktywnej, zarządzanej sesji po udanym `spawn`.
pub fn begin_session(pid: u32, url: String, profile_dir: String) -> EdgeCinemaSession {
    EdgeCinemaSession {
        session_id: Some(make_session_id(pid, now_seconds())),
        state: "active".to_string(),
        app_id: "edge-cinema".to_string(),
        pid: Some(pid),
        window_title: Some(profile_directory_name().to_string()),
        profile_dir: Some(profile_dir),
        url: Some(url),
        launched_at: Some(now_timestamp()),
        last_error: None,
        managed_by_velora: true,
    }
}

/// Niemutowalne przejście: zwraca NOWY rekord w stanie `exited`.
pub fn mark_exited(session: &EdgeCinemaSession) -> EdgeCinemaSession {
    let mut next = session.clone();
    next.state = "exited".to_string();
    next.last_error = None;
    next
}

/// Niemutowalne przejście: zwraca NOWY rekord w stanie `error` z sanitized diagnozą.
pub fn mark_error(session: &EdgeCinemaSession, message: &str) -> EdgeCinemaSession {
    let mut next = session.clone();
    next.state = "error".to_string();
    next.last_error = Some(sanitize_error(message));
    next
}

/// Niemutowalne przejście: zwraca NOWY rekord w stanie `closing`.
pub fn mark_closing(session: &EdgeCinemaSession) -> EdgeCinemaSession {
    let mut next = session.clone();
    next.state = "closing".to_string();
    next
}

/// Czyste, polskie komunikaty (bez wycieków technicznych).
pub fn duplicate_launch_error() -> &'static str {
    "Okno Edge Cinema jest już uruchomione. VELORA nie uruchamia duplikatu."
}

pub fn unmanaged_close_error() -> &'static str {
    "Tej sesji Edge Cinema nie uruchomiła VELORA — nie można jej zamknąć z poziomu aplikacji."
}

pub fn unconfirmed_close_error() -> &'static str {
    "Zamknięcie okna Edge Cinema wymaga potwierdzenia."
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
pub fn launch_edge_cinema(
    url: String,
    sessions: State<'_, EdgeCinemaSessions>,
    app: AppHandle,
) -> Result<EdgeCinemaReceipt, String> {
    // (1) Odrzucenie duplikatu JAKO PIERWSZY KROK: blok z blokadą jest
    //     zwalniany PRZED jakimkolwiek `spawn` (brak przetrzymywania mutexa).
    //     Działa na obu platformach; na macOS i tak zwracamy NON_WINDOWS_ERROR.
    {
        let current = sessions
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if should_reject_duplicate(current.as_ref()) {
            return Err(duplicate_launch_error().to_string());
        }
    }

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
        // Zapisujemy pid PRZED odłączeniem; nie czekamy, nie zabijamy procesu.
        let pid = child.id();
        drop(child);

        // (2) Stan sesji + typowane zdarzenie (ADAPTER, NIE WindowBroker).
        let session = begin_session(pid, canonical.to_string(), profile_dir_string.clone());
        {
            let mut current = sessions
                .current
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *current = Some(session.clone());
        }
        let _ = app.emit(
            "velora://cinema-session-changed",
            CinemaSessionEvent { session },
        );

        // Ten sam, niezmieniony EdgeCinemaReceipt (backward compat).
        Ok(EdgeCinemaReceipt {
            launched: true,
            mode: "app-fullscreen".to_string(),
            profile_dir: profile_dir_string,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Na macOS nie uruchamiamy Edge; parametry są jedynie konsumowane,
        // aby sygnatura komendy pozostała identyczna na obu platformach.
        let _ = (sessions, app, url);
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

/// Diagnostyka sesji (read-only). Zwraca klon bieżącej sesji lub rekord idle.
#[tauri::command]
pub fn get_edge_cinema_session(
    sessions: State<'_, EdgeCinemaSessions>,
) -> EdgeCinemaSession {
    let current = sessions
        .current
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    current.clone().unwrap_or_else(active_session)
}

/// Prośba o zamknięcie: WYMAGA potwierdzenia, waliduje zgodność `session_id`
/// z bieżącą sesją ORAZ `managed_by_velora == true`. NIE zabija żadnego procesu
/// — emituje wyłącznie typowane zdarzenie dla PRZYSZŁEGO WindowBroker (DeepSeek).
#[tauri::command]
pub fn request_edge_cinema_close(
    session_id: String,
    confirm: bool,
    sessions: State<'_, EdgeCinemaSessions>,
    app: AppHandle,
) -> Result<EdgeCinemaSession, String> {
    if !confirm {
        return Err(unconfirmed_close_error().to_string());
    }

    let next = {
        let current = sessions
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let session = current
            .as_ref()
            .ok_or_else(|| unmanaged_close_error().to_string())?;
        if !session.managed_by_velora
            || session.session_id.as_deref() != Some(session_id.as_str())
        {
            return Err(unmanaged_close_error().to_string());
        }
        mark_closing(session)
    };

    {
        let mut current = sessions
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = Some(next.clone());
    }
    let _ = app.emit(
        "velora://cinema-close-requested",
        CinemaCloseRequestedEvent {
            session_id,
            confirmed: true,
        },
    );
    Ok(next)
}

/// Bezpieczny ADAPTER wykrycia zamknięcia: wołany w przyszłości przez brokera /
/// obserwatora pierwszoplanowego. VELORA sama NIE odpytuje okien, NIE zabija
/// procesów — jedynie aktualizuje stan i emituje `velora://cinema-exited`.
#[tauri::command]
pub fn report_edge_cinema_exit(
    session_id: String,
    sessions: State<'_, EdgeCinemaSessions>,
    app: AppHandle,
) -> Result<EdgeCinemaSession, String> {
    let next = {
        let current = sessions
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let session = current
            .as_ref()
            .ok_or_else(|| unmanaged_close_error().to_string())?;
        if session.session_id.as_deref() != Some(session_id.as_str()) {
            return Err(unmanaged_close_error().to_string());
        }
        mark_exited(session)
    };

    {
        let mut current = sessions
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = Some(next.clone());
    }
    let _ = app.emit(
        "velora://cinema-exited",
        CinemaExitedEvent {
            session_id,
            reason: "closed".to_string(),
        },
    );
    Ok(next)
}

/// Recovery po restarcie VELORA: czyści stan do idle (wyłącznie pamięć).
#[tauri::command]
pub fn reset_edge_cinema_session(
    sessions: State<'_, EdgeCinemaSessions>,
) -> EdgeCinemaSession {
    let idle = active_session();
    let mut current = sessions
        .current
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *current = Some(idle.clone());
    idle
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

// ---------------------------------------------------------------------------
// MODUŁ B — czyste testy helperów cyklu życia. ŻADEN test nie uruchamia procesów
// ani nie wywołuje API Windows. 7 testów powyżej pozostaje BEZ ZMIAN.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    fn session_with_state(state: &str) -> EdgeCinemaSession {
        EdgeCinemaSession {
            session_id: Some("edge-cinema-1-1".to_string()),
            state: state.to_string(),
            app_id: "edge-cinema".to_string(),
            pid: Some(1),
            window_title: Some("VELORA-EdgeCinema".to_string()),
            profile_dir: Some("C:/profile".to_string()),
            url: Some("https://www.netflix.com/pl/".to_string()),
            launched_at: Some("1".to_string()),
            last_error: None,
            managed_by_velora: true,
        }
    }

    #[test]
    fn should_reject_duplicate_only_for_active_states() {
        assert!(!should_reject_duplicate(None));
        assert!(!should_reject_duplicate(Some(&session_with_state("idle"))));
        assert!(should_reject_duplicate(Some(&session_with_state("launching"))));
        assert!(should_reject_duplicate(Some(&session_with_state("active"))));
        assert!(!should_reject_duplicate(Some(&session_with_state("closing"))));
        assert!(!should_reject_duplicate(Some(&session_with_state("exited"))));
        assert!(!should_reject_duplicate(Some(&session_with_state("error"))));
    }

    #[test]
    fn active_and_closed_session_predicates() {
        assert!(session_is_active(&session_with_state("launching")));
        assert!(session_is_active(&session_with_state("active")));
        assert!(!session_is_active(&session_with_state("idle")));
        assert!(!session_is_active(&session_with_state("closing")));
        assert!(session_is_closed(&session_with_state("exited")));
        assert!(session_is_closed(&session_with_state("error")));
        assert!(!session_is_closed(&session_with_state("active")));
        assert!(!session_is_closed(&session_with_state("idle")));
    }

    #[test]
    fn begin_session_carries_launch_diagnostics() {
        let s = begin_session(
            4242,
            "https://www.youtube.com/".to_string(),
            "C:/VELORA/VELORA-EdgeCinema".to_string(),
        );
        assert_eq!(s.state, "active");
        assert_eq!(s.app_id, "edge-cinema");
        assert_eq!(s.pid, Some(4242));
        assert_eq!(s.url.as_deref(), Some("https://www.youtube.com/"));
        assert_eq!(s.profile_dir.as_deref(), Some("C:/VELORA/VELORA-EdgeCinema"));
        assert_eq!(s.window_title.as_deref(), Some("VELORA-EdgeCinema"));
        assert!(s.session_id.is_some());
        assert!(s.launched_at.is_some());
        assert!(s.last_error.is_none());
        assert!(s.managed_by_velora);
    }

    #[test]
    fn transitions_return_new_immutable_values() {
        let base = session_with_state("active");

        let closing = mark_closing(&base);
        assert_eq!(closing.state, "closing");
        assert_eq!(base.state, "active"); // oryginał pozostaje niezmieniony

        let exited = mark_exited(&base);
        assert_eq!(exited.state, "exited");
        assert!(exited.last_error.is_none());
        assert_eq!(base.state, "active");

        let error = mark_error(&base, "surowy błąd\nC:\\ sekret 0xDEAD");
        assert_eq!(error.state, "error");
        assert_eq!(base.state, "active");
        let diag = error.last_error.expect("last_error powinien być ustawiony");
        assert!(!diag.is_empty());
        assert!(!diag.contains('\n')); // znaki sterujące usunięte
        assert!(diag.chars().count() <= 240); // długość ograniczona
    }

    #[test]
    fn make_session_id_is_deterministic() {
        assert_eq!(make_session_id(42, 100), make_session_id(42, 100));
        assert_ne!(make_session_id(42, 100), make_session_id(43, 100));
        assert_ne!(make_session_id(42, 100), make_session_id(42, 101));
        assert!(make_session_id(42, 100).starts_with("edge-cinema-"));
        assert!(!now_timestamp().is_empty());
    }

    #[test]
    fn lifecycle_error_messages_are_clean_polish_and_leak_free() {
        let messages = [
            duplicate_launch_error(),
            unconfirmed_close_error(),
            unmanaged_close_error(),
        ];
        for message in messages {
            assert!(!message.is_empty());
            assert!(!message.contains("C:\\"));
            assert!(!message.contains("os error"));
            assert!(!message.contains("0x"));
            assert!(!message.chars().any(char::is_control));
        }
        assert!(duplicate_launch_error().contains("duplikatu"));
        assert!(unconfirmed_close_error().contains("potwierdzenia"));
    }

    #[test]
    fn active_session_is_the_idle_record() {
        let s = active_session();
        assert_eq!(s.state, "idle");
        assert!(s.session_id.is_none());
        assert!(s.pid.is_none());
        assert!(s.last_error.is_none());
        assert!(s.managed_by_velora);
    }

    #[test]
    fn launch_arguments_still_have_six_flags_and_one_user_data_dir() {
        let args = edge_cinema_arguments("https://www.netflix.com/pl/", "C:/profile");
        assert_eq!(args.len(), 6);
        assert_eq!(
            args.iter()
                .filter(|arg| arg.starts_with("--user-data-dir="))
                .count(),
            1
        );
    }
}
