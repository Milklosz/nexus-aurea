//! Biblioteka Steam — adapter TYLKO DO ODCZYTU (VELORA 3.0, workstream S3.2).
//!
//! Moduł odkrywa instalację Steam (rejestr HKCU\Software\Valve\Steam `SteamPath`
//! oraz typowe domyślne lokalizacje), czyta `steamapps/libraryfolders.vdf`
//! i manifesty `steamapps/appmanifest_*.acf` (zwykły tekst VDF) i zwraca
//! wyłącznie `{appid, name, library}` zainstalowanych gier.
//!
//! GRANICA BEZPIECZEŃSTWA: moduł NIGDY nie rusza DRM, zapisów gier,
//! anti-cheata ani plików gier — czyta tylko VDF Steam. Uruchomienie gry
//! otwiera wyłącznie oficjalny URI `steam://run/<appid>`; obserwacja procesu
//! jest tylko do odczytu (launch_registry + process_table), proces gry
//! NIGDY nie jest zabijany.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

/// Prefix, pod którym gry Steam trafiają do `AppManagerSnapshot.games`.
pub const STEAM_GAME_ID_PREFIX: &str = "steam:";

/// Pojedyncza gra z odczytanych manifestów Steam (tylko do odczytu).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SteamGameEntry {
    pub appid: String,
    pub name: String,
    /// Katalog główny biblioteki, w której znaleziono manifest.
    pub library: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamLibrarySnapshot {
    pub windows: bool,
    /// `registry` | `default-paths` | `unavailable`
    pub source: String,
    pub available: bool,
    pub reason: Option<String>,
    pub games: Vec<SteamGameEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamGameLaunchReceipt {
    pub appid: String,
    pub launched: bool,
}

/// Read-only stan procesu gry (launch_registry + process_table, bez zabijania).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProcessState {
    pub windows: bool,
    pub id: String,
    pub tracked: bool,
    pub running: bool,
    pub phase: Option<String>,
    pub crashed: bool,
    pub pid_reuse_detected: bool,
    pub error: Option<String>,
    pub attention: Option<String>,
    pub process_ids: Vec<u32>,
}

/// Kanoniczny identyfikator gry Steam w bibliotece VELORA (`steam:<appid>`).
pub fn steam_game_id(appid: &str) -> Option<String> {
    is_valid_appid(appid).then(|| format!("{STEAM_GAME_ID_PREFIX}{appid}"))
}

/// Zwraca appid dla `steam:<appid>` oraz dla legacycznego numerycznego id.
pub fn appid_from_game_id(id: &str) -> Option<&str> {
    if let Some(rest) = id.strip_prefix(STEAM_GAME_ID_PREFIX) {
        return is_valid_appid(rest).then_some(rest);
    }
    is_valid_appid(id).then_some(id)
}

pub fn is_valid_appid(appid: &str) -> bool {
    !appid.is_empty()
        && appid.len() <= 10
        && appid.bytes().all(|byte| byte.is_ascii_digit())
        && appid.parse::<u32>().map_or(false, |value| value > 0)
}

/* ------------------------------------------------------------------------- *
 * Parsowanie zwykłego tekstu VDF (libraryfolders.vdf / appmanifest_*.acf).
 * ------------------------------------------------------------------------- */

fn parse_vdf_quoted(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<String> {
    while chars
        .peek()
        .is_some_and(|character| character.is_whitespace())
    {
        chars.next();
    }
    if chars.next()? != '"' {
        return None;
    }
    let mut value = String::new();
    while let Some(character) = chars.next() {
        if character == '\\' {
            match chars.peek().copied() {
                Some(next) if next == '\\' || next == '"' => {
                    chars.next();
                    value.push(next);
                }
                _ => value.push('\\'),
            }
        } else if character == '"' {
            return Some(value);
        } else {
            value.push(character);
        }
    }
    None
}

fn parse_vdf_pair(line: &str) -> Option<(String, String)> {
    let mut chars = line.trim().chars().peekable();
    let key = parse_vdf_quoted(&mut chars)?;
    let value = parse_vdf_quoted(&mut chars)?;
    Some((key, value))
}

/// Ścieżki bibliotek z `libraryfolders.vdf`: obsługuje zarówno stary format
/// (`"0"  "D:\\SteamLibrary"`), jak i nowy (`"1" { "path" "D:\\..." }`).
pub fn parse_libraryfolders(contents: &str) -> Vec<PathBuf> {
    let mut libraries = Vec::new();
    for line in contents.lines() {
        let Some((key, value)) = parse_vdf_pair(line) else {
            continue;
        };
        let is_entry = key == "path" || key.parse::<usize>().is_ok();
        if !is_entry || value.trim().is_empty() {
            continue;
        }
        let path = PathBuf::from(value);
        if !libraries.contains(&path) {
            libraries.push(path);
        }
    }
    libraries
}

struct AppManifest {
    appid: String,
    name: String,
    install_dir: String,
}

/// Parsuje pojedynczy `appmanifest_*.acf`. Odrzuca appid spoza zakresu,
/// pustą nazwę i `installdir` z komponentami innymi niż zwykłe segmenty
/// (ochrona przed traversalem — manifest jest tylko czytany, nigdy pisany).
pub fn parse_appmanifest(contents: &str) -> Option<AppManifest> {
    let mut appid = None;
    let mut name = None;
    let mut install_dir = None;
    for line in contents.lines() {
        if let Some((key, value)) = parse_vdf_pair(line) {
            match key.as_str() {
                "appid" => appid = Some(value),
                "name" => name = Some(value),
                "installdir" => install_dir = Some(value),
                _ => {}
            }
        }
    }
    let appid = appid?;
    let name = name?.trim().to_string();
    let install_dir = install_dir?;
    if !is_valid_appid(&appid)
        || name.is_empty()
        || install_dir.trim().is_empty()
        || Path::new(&install_dir)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(AppManifest {
        appid,
        name,
        install_dir,
    })
}

/* ------------------------------------------------------------------------- *
 * Odkrywanie instalacji Steam — tylko do odczytu.
 * ------------------------------------------------------------------------- */

/// Typowe domyślne lokalizacje (fallback, gdy rejestr nie odpowiada).
fn default_steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // Jawny, najczęstszy domyślny katalog — także gdy zmienne środowiskowe
    // są niedostępne.
    roots.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    roots.push(PathBuf::from(r"C:\Program Files\Steam"));
    for key in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            roots.push(root.join("Steam"));
            if key == "LOCALAPPDATA" {
                roots.push(root.join("Programs").join("Steam"));
            }
        }
    }
    roots
}

/// HKCU\Software\Valve\Steam `SteamPath` — odczyt rejestru tylko do odczytu.
#[cfg(target_os = "windows")]
fn registry_steam_path() -> Option<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
        REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let subkey = wide("Software\\Valve\\Steam");
    let mut handle = HKEY::default();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            None,
            KEY_READ,
            &mut handle,
        )
    };
    if status.0 != ERROR_SUCCESS.0 {
        return None;
    }
    let value_name = wide("SteamPath");
    let mut value_type = REG_VALUE_TYPE(0);
    let mut size = 0u32;
    let status = unsafe {
        RegQueryValueExW(
            handle,
            PCWSTR(value_name.as_ptr()),
            None,
            Some(&mut value_type),
            None,
            Some(&mut size),
        )
    };
    if status.0 != ERROR_SUCCESS.0 || size == 0 || size % 2 != 0 {
        unsafe { RegCloseKey(handle) };
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    let status = unsafe {
        RegQueryValueExW(
            handle,
            PCWSTR(value_name.as_ptr()),
            None,
            Some(&mut value_type),
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    unsafe { RegCloseKey(handle) };
    if status.0 != ERROR_SUCCESS.0 {
        return None;
    }
    if value_type != REG_SZ && value_type != REG_EXPAND_SZ {
        return None;
    }
    let units: Vec<u16> = buffer[..(size as usize).min(buffer.len())]
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let text = String::from_utf16_lossy(&units);
    let text = text.trim_matches('\0').trim();
    if text.is_empty() {
        return None;
    }
    Some(PathBuf::from(text))
}

#[cfg(not(target_os = "windows"))]
fn registry_steam_path() -> Option<PathBuf> {
    None
}

/// Zwraca `(katalog główny Steam, źródło)` — rejestr albo typowe lokalizacje.
pub fn discover_steam_root() -> Option<(PathBuf, &'static str)> {
    if let Some(path) = registry_steam_path() {
        if path.join("steam.exe").is_file() {
            return Some((path, "registry"));
        }
    }
    default_steam_roots()
        .into_iter()
        .find(|root| root.join("steam.exe").is_file())
        .map(|root| (root, "default-paths"))
}

/* ------------------------------------------------------------------------- *
 * Skanowanie bibliotek (tylko appmanifest/libraryfolders VDF).
 * ------------------------------------------------------------------------- */

/// Skanuje bibliotekę Steam: `libraryfolders.vdf` + `appmanifest_*.acf`.
/// Gra jest uwzględniana tylko, gdy katalog instalacji istnieje lokalnie.
pub fn scan_library(root: &Path) -> Result<Vec<SteamGameEntry>, String> {
    let steamapps = root.join("steamapps");
    if !steamapps.is_dir() {
        return Err("Nie znaleziono katalogu steamapps Steam.".into());
    }
    let mut libraries = vec![root.to_path_buf()];
    if let Ok(contents) = std::fs::read_to_string(steamapps.join("libraryfolders.vdf")) {
        for library in parse_libraryfolders(&contents) {
            if library.is_dir() && !libraries.contains(&library) {
                libraries.push(library);
            }
        }
    }

    let mut scanned = 0usize;
    let mut games: Vec<SteamGameEntry> = Vec::new();
    for library in libraries {
        let apps_dir = library.join("steamapps");
        let entries = match std::fs::read_dir(&apps_dir) {
            Ok(entries) => {
                scanned += 1;
                entries
            }
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_lowercase();
            if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let Some(manifest) = parse_appmanifest(&contents) else {
                continue;
            };
            if !apps_dir.join("common").join(&manifest.install_dir).is_dir() {
                continue;
            }
            if games.iter().any(|game| game.appid == manifest.appid) {
                continue;
            }
            games.push(SteamGameEntry {
                appid: manifest.appid,
                name: manifest.name,
                library: library.to_string_lossy().to_string(),
            });
        }
    }
    if scanned == 0 {
        return Err("Nie można odczytać katalogów bibliotek Steam.".into());
    }
    games.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(games)
}

const LIBRARY_CACHE_MS: u64 = 60_000;

#[cfg(target_os = "windows")]
fn cached_snapshot() -> SteamLibrarySnapshot {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    static CACHE: OnceLock<Mutex<Option<(Instant, SteamLibrarySnapshot)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((captured_at, snapshot)) = guard.as_ref() {
        if captured_at.elapsed() <= Duration::from_millis(LIBRARY_CACHE_MS) {
            return snapshot.clone();
        }
    }
    let snapshot = library_snapshot();
    *guard = Some((Instant::now(), snapshot.clone()));
    snapshot
}

#[cfg(not(target_os = "windows"))]
fn cached_snapshot() -> SteamLibrarySnapshot {
    library_snapshot()
}

/// Snapshot biblioteki: Windows odkrywa Steam, pozostałe platformy dostają
/// jawny, pusty wynik (bez wymyślonych gier).
pub fn library_snapshot() -> SteamLibrarySnapshot {
    #[cfg(target_os = "windows")]
    {
        match discover_steam_root() {
            Some((root, source)) => match scan_library(&root) {
                Ok(games) => SteamLibrarySnapshot {
                    windows: true,
                    source: source.to_string(),
                    available: true,
                    reason: None,
                    games,
                },
                Err(reason) => SteamLibrarySnapshot {
                    windows: true,
                    source: source.to_string(),
                    available: false,
                    reason: Some(reason),
                    games: Vec::new(),
                },
            },
            None => SteamLibrarySnapshot {
                windows: true,
                source: "unavailable".to_string(),
                available: false,
                reason: Some(
                    "Nie wykryto instalacji Steam (rejestr HKCU\\Software\\Valve\\Steam ani typowe lokalizacje)."
                        .to_string(),
                ),
                games: Vec::new(),
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        SteamLibrarySnapshot {
            windows: false,
            source: "unavailable".to_string(),
            available: false,
            reason: Some(
                "Biblioteka Steam jest dostępna tylko w natywnej aplikacji Windows.".to_string(),
            ),
            games: Vec::new(),
        }
    }
}

/// Odczyt dla `AppManagerSnapshot.games` — tylko gry faktycznie odczytane
/// z manifestów (błąd, gdy biblioteka jest niedostępna).
pub fn cached_library_games() -> Result<Vec<SteamGameEntry>, String> {
    let snapshot = cached_snapshot();
    if snapshot.available {
        Ok(snapshot.games)
    } else {
        Err(snapshot
            .reason
            .unwrap_or_else(|| "Biblioteka Steam jest niedostępna.".to_string()))
    }
}

/* ------------------------------------------------------------------------- *
 * Komendy Tauri.
 * ------------------------------------------------------------------------- */

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| "Operacja Steam została przerwana.".to_string())?
}

/// Read-only snapshot biblioteki Steam: `{windows, source, available, reason, games}`.
#[tauri::command]
pub async fn get_steam_library() -> Result<SteamLibrarySnapshot, String> {
    run_blocking(|| Ok(cached_snapshot())).await
}

/// Uruchamia grę Steam przez oficjalny URI `steam://run/<appid>` (otwierany
/// przez istniejący shell-open path). Zwraca tylko potwierdzenie `{launched}`.
/// Proces gry jest dalej obserwowany przez launch_registry — nigdy zabijany.
#[tauri::command]
pub async fn launch_steam_game(
    app: AppHandle,
    appid: String,
) -> Result<SteamGameLaunchReceipt, String> {
    run_blocking(move || launch_steam_game_blocking(app, appid)).await
}

fn launch_steam_game_blocking(
    app: AppHandle,
    appid: String,
) -> Result<SteamGameLaunchReceipt, String> {
    if !is_valid_appid(&appid) {
        return Err("Nieprawidłowy identyfikator gry Steam.".into());
    }

    #[cfg(target_os = "windows")]
    {
        use crate::launch_registry::{self, LaunchKind, LaunchWatch};
        use crate::session_orchestrator::SessionId;
        use std::time::{Duration, Instant};

        let games = cached_library_games()?;
        let game = games
            .iter()
            .find(|entry| entry.appid == appid)
            .ok_or_else(|| {
                format!(
                    "Gra Steam o ID {appid} nie znajduje się w dostępnej, zainstalowanej bibliotece."
                )
            })?;

        let steam_pid_before = launch_registry::find_process_id("steam.exe");
        let mut watch = LaunchWatch::new(
            LaunchKind::Game,
            game.name.clone(),
            steam_game_id(&appid),
            Vec::new(),
            steam_pid_before,
            true,
            false,
            vec![
                "steamwebhelper.exe".into(),
                "gameoverlayui.exe".into(),
                "steamservice.exe".into(),
                "steamerrorreporter.exe".into(),
            ],
            false,
            Some(SessionId::Game),
        );
        // Baseline PRZED otwarciem URI: gdy Steam już działa, jego istniejące
        // procesy potomne nie mogą stać się "nową" grą.
        launch_registry::capture_baseline(&app, &mut watch)?;
        open_steam_run_uri(&appid)?;
        if watch.root_process_id.is_none() {
            // Steam nie był uruchomiony — URI samo go startuje; poczekaj
            // chwilę na pojawienie się klienta, aby móc obserwować grę.
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline {
                if let Some(pid) = launch_registry::find_process_id("steam.exe") {
                    watch.root_process_id = Some(pid);
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        if watch.root_process_id.is_none() {
            return Err(
                "Nie udało się potwierdzić uruchomienia klienta Steam; gra nie została wystartowana."
                    .to_string(),
            );
        }
        launch_registry::track_launch(&app, watch)
            .map_err(|error| format!("{} uruchomiono, ale VELORA nie może śledzić jej sesji: {error}", game.name))?;
        Ok(SteamGameLaunchReceipt {
            appid,
            launched: true,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, appid);
        Err("Uruchamianie gier Steam jest dostępne tylko w natywnej aplikacji Windows.".into())
    }
}

/// Otwiera `steam://run/<appid>` przez ShellExecuteW — istniejący path
/// otwierania URI (jak `playnite://`), bez zabijania czegokolwiek.
#[cfg(target_os = "windows")]
fn open_steam_run_uri(appid: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let uri = format!("steam://run/{appid}");
    let running = crate::launch_registry::find_process_id("steam.exe");
    crate::window_broker::grant_foreground_handoff(&[
        running.unwrap_or(crate::window_broker::ASFW_ANY),
    ]);
    let operation = HSTRING::from("open");
    let file = HSTRING::from(uri.as_str());
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute zwraca wartość > 32 przy sukcesie (udokumentowany próg).
    if result.0 as isize <= 32 {
        return Err(
            "Windows nie przekazał uruchomienia gry do Steam. Sprawdź, czy Steam obsługuje steam://run/."
                .to_string(),
        );
    }
    Ok(())
}

/// Read-only stan procesu gry: launch_registry (start/exit/crash) +
/// process_table. Nigdy nie kończy procesu.
#[tauri::command]
pub async fn get_game_process_state(
    app: AppHandle,
    id: String,
) -> Result<GameProcessState, String> {
    run_blocking(move || Ok(game_process_state(&app, &id))).await
}

fn game_process_state(app: &AppHandle, id: &str) -> GameProcessState {
    let launches = crate::launch_registry::launches_matching_game(app, id);
    let latest = launches
        .iter()
        .max_by_key(|session| session.started_at_ms)
        .cloned();
    let Some(session) = latest else {
        return GameProcessState {
            windows: cfg!(target_os = "windows"),
            id: id.to_string(),
            tracked: false,
            running: false,
            phase: None,
            crashed: false,
            pid_reuse_detected: false,
            error: None,
            attention: None,
            process_ids: Vec::new(),
        };
    };
    #[cfg(target_os = "windows")]
    let running = match crate::process_table::snapshot(false) {
        Ok(table) => session
            .process_ids
            .iter()
            .any(|process_id| table.contains(*process_id)),
        Err(_) => false,
    };
    #[cfg(not(target_os = "windows"))]
    let running = false;
    let phase = session.phase.as_str().to_string();
    let crashed = session.pid_reuse_detected || session.phase == crate::launch_registry::LaunchPhase::Failed;
    GameProcessState {
        windows: cfg!(target_os = "windows"),
        id: id.to_string(),
        tracked: true,
        running,
        phase: Some(phase),
        crashed,
        pid_reuse_detected: session.pid_reuse_detected,
        error: session.error.clone(),
        attention: session.attention.clone(),
        process_ids: session.process_ids.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        appid_from_game_id, cached_snapshot, discover_steam_root, is_valid_appid, parse_appmanifest,
        parse_libraryfolders, parse_vdf_pair, scan_library, steam_game_id,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    /// Root of the committed, synthetic VDF fixtures (S3.8): nothing in there
    /// comes from a real machine and the files are read, never written.
    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/steam-library");

    fn fixture(name: &str) -> String {
        fs::read_to_string(format!("{FIXTURES}/{name}")).expect("synthetic fixture must be readable")
    }

    /// VDF-escapes an absolute temp path for use inside an `{{ROOT}}`/`{{LIB2}}`
    /// placeholder in a fixture libraryfolder file.
    fn vdf_escaped(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "\\\\")
    }

    fn write_manifest(library: &Path, appid: &str, manifest_file: &str) {
        let steamapps = library.join("steamapps");
        fs::write(
            steamapps.join(format!("appmanifest_{appid}.acf")),
            fixture(manifest_file),
        )
        .expect("fixture manifest write");
    }

    fn write_libraryfolders(root: &Path, second_library: &Path, fixture_file: &str) {
        let contents = fixture(fixture_file)
            .replace("{{ROOT}}", &vdf_escaped(root))
            .replace("{{LIB2}}", &vdf_escaped(second_library));
        fs::write(root.join("steamapps").join("libraryfolders.vdf"), contents)
            .expect("fixture libraryfolders write");
    }

    fn create_installed_dir(library: &Path, install_dir: &str) {
        fs::create_dir_all(library.join("steamapps").join("common").join(install_dir))
            .expect("fixture install dir");
    }

    /// Assembles the committed fixture files into a fresh, throwaway synthetic
    /// Steam library (root + second library + installed common directories) and
    /// returns the root to hand to `scan_library`. Deterministic: temp names are
    /// process-scoped counters, no random data, and the tree is removed on drop.
    struct FixtureLibrary(PathBuf);

    impl Drop for FixtureLibrary {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn assemble_fixture_library(fixture_file: &str) -> (PathBuf, PathBuf) {
        let root = temp_root();
        let second = root.join("second-library");
        fs::create_dir_all(root.join("steamapps")).expect("root steamapps");
        fs::create_dir_all(second.join("steamapps")).expect("second steamapps");
        write_libraryfolders(&root, &second, fixture_file);
        // Root library: TF2 (valid), the duplicate appid 440 copy in the second
        // library must lose, all malformed manifests must be skipped, and the
        // not-installed manifest (no common/ dir) must be skipped.
        create_installed_dir(&root, "Team Fortress 2");
        write_manifest(&root, "440", "appmanifest-440-valid.acf");
        write_manifest(&root, "999", "appmanifest-999-not-installed.acf");
        write_manifest(&root, "80", "appmanifest-80-traversal-installdir.acf");
        write_manifest(&root, "0", "appmanifest-0-zero-appid.acf");
        write_manifest(&root, "70", "appmanifest-70-missing-installdir.acf");
        write_manifest(&root, "300", "appmanifest-300-blank-name.acf");
        write_manifest(&root, "8x", "appmanifest-8x-bad-appid.acf");
        // Root also carries the CRLF + padded-name manifest with its install dir.
        create_installed_dir(&root, "WindowsCarrierReturnGame");
        write_manifest(&root, "500", "appmanifest-500-crlf.acf");
        // Second library: Half-Life 2 plus the duplicate appid 440 manifest.
        create_installed_dir(&second, "Half-Life 2");
        write_manifest(&second, "220", "appmanifest-220-valid.acf");
        create_installed_dir(&second, "Team Fortress 2");
        write_manifest(&second, "440", "appmanifest-440-duplicate.acf");
        (root, second)
    }

    #[test]
    fn fixture_scan_covers_multiple_libraries_missing_library_duplicates_and_malformed_manifests() {
        for fixture_file in ["libraryfolders-modern.vdf", "libraryfolders-legacy.vdf"] {
            let (root, second) = assemble_fixture_library(fixture_file);
            let games = scan_library(&root).expect("synthetic library scan must succeed");
            // Exactly the three installed, well-formed games; every malformed
            // manifest and the not-installed manifest are skipped.
            let appids: Vec<&str> = games.iter().map(|game| game.appid.as_str()).collect();
            assert_eq!(appids, ["220", "440", "500"], "fixture file {fixture_file}");
            let hl2 = games.iter().find(|game| game.appid == "220").expect("Half-Life 2");
            assert_eq!(hl2.name, "Half-Life 2");
            assert_eq!(PathBuf::from(&hl2.library), second);
            let tf2 = games.iter().find(|game| game.appid == "440").expect("TF2");
            // Duplicate appid in the second library never replaces the first entry.
            assert_eq!(PathBuf::from(&tf2.library), root);
            let crlf = games.iter().find(|game| game.appid == "500").expect("CRLF game");
            // Metadata normalization: padded names are trimmed before display.
            assert_eq!(crlf.name, "Windows Carrier Return Game");
            assert!(games.iter().all(|game| game.appid != "999"), "not-installed game is skipped");
            assert!(games.iter().all(|game| game.appid != "80"), "traversal installdir is rejected");
            assert!(games.iter().all(|game| game.appid != "0"), "zero appid is rejected");
            assert!(games.iter().all(|game| game.appid != "70"), "missing installdir is rejected");
            assert!(games.iter().all(|game| game.appid != "300"), "blank name is rejected");
            assert!(games.iter().all(|game| game.appid != "8x"), "malformed appid is rejected");
            // Sort stays case-insensitive by display name.
            for pair in games.windows(2) {
                assert!(pair[0].name.to_lowercase() <= pair[1].name.to_lowercase());
            }
        }
    }

    #[test]
    fn fixture_scan_reports_a_missing_library_instead_of_guessing() {
        // Missing root entirely — never an empty, guessed library.
        assert!(scan_library(&temp_root()).is_err());
        let root = temp_root();
        fs::create_dir_all(root.join("steamapps")).expect("steamapps only");
        // A valid but empty library (no libraryfolders, no manifests) is an
        // honest, empty result — not an error, not an invented game.
        let games = scan_library(&root).expect("empty library is valid");
        assert!(games.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn temp_roots_are_unique_without_randomness() {
        let first = temp_root();
        let second = temp_root();
        assert_ne!(first, second);
    }

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "nexus-aurea-steam-library-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn vdf_pairs_preserve_escaped_windows_paths() {
        assert_eq!(
            parse_vdf_pair(r#""path" "E:\\Games\\Steam""#),
            Some(("path".into(), r"E:\Games\Steam".into()))
        );
        assert_eq!(
            parse_vdf_pair(r#""1" "D:\SteamLibrary""#),
            Some(("1".into(), r"D:\SteamLibrary".into()))
        );
        assert_eq!(parse_vdf_pair("not a pair"), None);
    }

    #[test]
    fn libraryfolders_parser_handles_legacy_and_modern_formats() {
        let legacy = r#"
            "LibraryFolders"
            {
                "0"  "C:\Program Files (x86)\Steam"
                "1"  "D:\\SteamLibrary"
            }
        "#;
        let libraries = parse_libraryfolders(legacy);
        assert_eq!(
            libraries,
            vec![
                PathBuf::from(r"C:\Program Files (x86)\Steam"),
                PathBuf::from(r"D:\SteamLibrary")
            ]
        );

        let modern = r#"
            "LibraryFolders"
            {
                "0"
                {
                    "path"  "C:\\Program Files (x86)\\Steam"
                    "label" ""
                }
                "1"
                {
                    "path"  "E:\\Games\\Steam"
                    "label" "Games"
                    "contentid" "123"
                }
            }
        "#;
        let libraries = parse_libraryfolders(modern);
        assert_eq!(
            libraries,
            vec![
                PathBuf::from(r"C:\Program Files (x86)\Steam"),
                PathBuf::from(r"E:\Games\Steam")
            ]
        );
        // Duplikaty są usuwane.
        let duplicated = parse_libraryfolders(
            "\"0\" \"D:\\\\Lib\"\n\"path\" \"D:\\\\Lib\"\n",
        );
        assert_eq!(duplicated, vec![PathBuf::from(r"D:\Lib")]);
    }

    #[test]
    fn appmanifest_parser_reads_metadata_and_rejects_traversal_and_bad_ids() {
        let manifest = r#"
            "AppState"
            {
                "appid"  "440"
                "name"  "Team Fortress 2"
                "installdir"  "Team Fortress 2"
            }
        "#;
        let parsed = parse_appmanifest(manifest).expect("valid appmanifest");
        assert_eq!(parsed.appid, "440");
        assert_eq!(parsed.name, "Team Fortress 2");
        assert_eq!(parsed.install_dir, "Team Fortress 2");

        let traversal = r#""appid" "440" "name" "TF2" "installdir" "../escape""#;
        assert!(parse_appmanifest(traversal).is_none());
        let bad_id = r#""appid" "44x" "name" "TF2" "installdir" "tf2""#;
        assert!(parse_appmanifest(bad_id).is_none());
        let zero_id = r#""appid" "0" "name" "TF2" "installdir" "tf2""#;
        assert!(parse_appmanifest(zero_id).is_none());
        let missing_name = r#""appid" "440" "installdir" "tf2""#;
        assert!(parse_appmanifest(missing_name).is_none());
    }

    #[test]
    fn fixture_manifest_variants_parse_exactly_like_assembled_libraries() {
        // Valid, CRLF-terminated manifest with a padded display name.
        let crlf = parse_appmanifest(&fixture("appmanifest-500-crlf.acf")).expect("CRLF manifest");
        assert_eq!(crlf.appid, "500");
        assert_eq!(crlf.name, "Windows Carrier Return Game");
        assert_eq!(crlf.install_dir, "WindowsCarrierReturnGame");

        // Every malformed fixture is rejected by the same production parser
        // used by `scan_library` — no fallback, no guessing. The Windows-style
        // `..\escape` traversal fixture is only parseable on hosts where `\` is
        // not a path separator; on Windows (the production target) the
        // component guard rejects it, and on every host the scan-level
        // install-dir existence check denies it (covered by the scan test).
        for malformed in [
            "appmanifest-0-zero-appid.acf",
            "appmanifest-70-missing-installdir.acf",
            "appmanifest-300-blank-name.acf",
            "appmanifest-8x-bad-appid.acf",
        ] {
            assert!(
                parse_appmanifest(&fixture(malformed)).is_none(),
                "fixture {malformed} must be rejected"
            );
        }
        if cfg!(windows) {
            assert!(
                parse_appmanifest(&fixture("appmanifest-80-traversal-installdir.acf")).is_none(),
                "backslash traversal must be rejected on Windows"
            );
        }
    }

    #[test]
    fn scan_library_reads_only_manifests_of_installed_games() {
        let root = temp_root();
        let library = root.join("extlib");
        fs::create_dir_all(root.join("steamapps").join("common").join("Team Fortress 2")).unwrap();
        fs::create_dir_all(library.join("steamapps").join("common").join("Half-Life 2")).unwrap();
        fs::write(
            root.join("steamapps").join("libraryfolders.vdf"),
            "\"LibraryFolders\"\n{\n\"0\" \"PLACEHOLDER\"\n\"1\"\n{\n\"path\" \"EXTLIB\"\n}\n}\n"
                .replace("PLACEHOLDER", &root.to_string_lossy().replace('\\', "\\\\"))
                .replace("EXTLIB", &library.to_string_lossy().replace('\\', "\\\\")),
        )
        .unwrap();
        fs::write(
            root.join("steamapps").join("appmanifest_440.acf"),
            "\"AppState\"\n{\n\"appid\" \"440\"\n\"name\" \"Team Fortress 2\"\n\"installdir\" \"Team Fortress 2\"\n}\n",
        )
        .unwrap();
        // Ta gra NIE jest zainstalowana (brak katalogu common) — pomijana.
        fs::write(
            root.join("steamapps").join("appmanifest_999.acf"),
            "\"AppState\"\n{\n\"appid\" \"999\"\n\"name\" \"Not Installed\"\n\"installdir\" \"not installed\"\n}\n",
        )
        .unwrap();
        fs::write(
            library.join("steamapps").join("appmanifest_220.acf"),
            "\"AppState\"\n{\n\"appid\" \"220\"\n\"name\" \"Half-Life 2\"\n\"installdir\" \"Half-Life 2\"\n}\n",
        )
        .unwrap();
        // Duplikat appid 440 w drugiej bibliotece — ignorowany.
        fs::create_dir_all(library.join("steamapps").join("common").join("Team Fortress 2")).unwrap();
        fs::write(
            library.join("steamapps").join("appmanifest_440.acf"),
            "\"AppState\"\n{\n\"appid\" \"440\"\n\"name\" \"Team Fortress 2\"\n\"installdir\" \"Team Fortress 2\"\n}\n",
        )
        .unwrap();

        let games = scan_library(&root).expect("scan must succeed");
        assert_eq!(games.len(), 2);
        assert!(games.iter().any(|game| game.appid == "440" && game.name == "Team Fortress 2"));
        assert!(
            games
                .iter()
                .any(|game| game.appid == "220" && game.name == "Half-Life 2" && game.library == library.to_string_lossy())
        );
        // Posortowane po nazwie (bez rozróżniania wielkości liter).
        assert!(games[0].name.to_lowercase() <= games[1].name.to_lowercase());

        let missing = scan_library(&root.join("missing"));
        assert!(missing.is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn appids_are_positive_numeric_and_bounded() {
        assert!(is_valid_appid("440"));
        assert!(is_valid_appid("4294967295"));
        assert!(!is_valid_appid("0"));
        assert!(!is_valid_appid("44x"));
        assert!(!is_valid_appid("4294967296"));
        assert!(!is_valid_appid(""));
        assert!(!is_valid_appid("steam://run/440"));
    }

    #[test]
    fn game_id_helpers_round_trip() {
        assert_eq!(steam_game_id("440").as_deref(), Some("steam:440"));
        assert_eq!(steam_game_id("bad"), None);
        assert_eq!(appid_from_game_id("steam:440"), Some("440"));
        assert_eq!(appid_from_game_id("440"), Some("440"));
        assert_eq!(appid_from_game_id("steam:bad"), None);
        assert_eq!(appid_from_game_id("playnite:guid"), None);
    }

    #[test]
    fn default_roots_include_common_steam_locations() {
        let roots = super::default_steam_roots();
        assert!(roots.contains(&PathBuf::from(r"C:\Program Files (x86)\Steam")));
        assert!(roots.contains(&PathBuf::from(r"C:\Program Files\Steam")));
    }

    #[test]
    fn snapshot_is_honest_on_every_platform() {
        let snapshot = cached_snapshot();
        assert_eq!(snapshot.windows, cfg!(target_os = "windows"));
        let discovered = discover_steam_root();
        if !snapshot.windows {
            assert!(!snapshot.available);
            assert!(snapshot.games.is_empty());
            assert!(snapshot.reason.is_some());
            assert_eq!(snapshot.source, "unavailable");
            assert!(discovered.is_none());
        }
        if !snapshot.available {
            assert!(snapshot.games.is_empty());
            assert!(snapshot.reason.is_some());
        }
        // Źródło jest zawsze jawne i znane.
        assert!(["registry", "default-paths", "unavailable"].contains(&snapshot.source.as_str()));
        if snapshot.available {
            assert!(discovered.is_some());
        }
    }

    #[test]
    fn module_never_touches_game_files_or_saves() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/steam_library.rs");
        let full = fs::read_to_string(path).expect("steam_library.rs must be readable");
        // Sprawdzamy część produkcyjną (przed modułem testowym): tylko odczyt
        // dozwolonych plików VDF — bez zapisu, kasowania ani zabijania procesów.
        let source = full
            .split("#[cfg(test)]")
            .next()
            .unwrap_or(full.as_str())
            .to_lowercase();
        for forbidden in [
            "fs::write",
            "fs::remove",
            "remove_dir",
            "create_dir",
            "kill",
            "terminateprocess",
        ] {
            assert!(
                !source.contains(forbidden),
                "steam_library.rs production code must not contain {forbidden}"
            );
        }
        // Czytamy wyłącznie dozwolone pliki VDF.
        assert!(source.contains("libraryfolders.vdf"));
        assert!(source.contains("appmanifest_"));
    }
}
