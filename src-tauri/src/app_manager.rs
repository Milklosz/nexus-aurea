use serde::Serialize;
#[cfg(target_os = "windows")]
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "windows")]
use std::thread;
#[cfg(any(target_os = "windows", test))]
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::time::Instant;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAppStatus {
    pub id: String,
    pub name: String,
    pub process_name: String,
    pub installed: bool,
    pub running_instances: usize,
    pub focus_restore_supported: bool,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppManagerSnapshot {
    pub windows: bool,
    pub foreground_process: Option<String>,
    pub apps: Vec<ManagedAppStatus>,
    pub games: Vec<ManagedGame>,
    pub games_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GamingDiagnostics {
    pub windows: bool,
    pub playnite_detected: bool,
    pub gog_galaxy_detected: bool,
    pub gog_galaxy_running_instances: Option<usize>,
    pub gog_galaxy_process_error: Option<String>,
    pub cyberpunk_install_detected: bool,
    pub disk_space: Vec<DiskSpaceStatus>,
    pub disk_space_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpaceStatus {
    pub drive: String,
    pub available_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedGame {
    pub id: String,
    pub name: String,
    pub launcher: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedGameLaunchReceipt {
    pub id: String,
    pub launched: bool,
}

struct ParsedSteamManifest {
    game: ManagedGame,
    install_dir: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReceipt {
    pub id: String,
    pub already_running: bool,
    pub focus_restore_supported: bool,
}

#[derive(Clone, Copy)]
struct AppSpec {
    id: &'static str,
    name: &'static str,
    process_name: &'static str,
    focus_restore_supported: bool,
}

const APP_SPECS: &[AppSpec] = &[
    AppSpec { id: "steamBigPicture", name: "Steam Big Picture", process_name: "steam.exe", focus_restore_supported: false },
    AppSpec { id: "appleMusic", name: "Apple Music", process_name: "AppleMusic.exe", focus_restore_supported: false },
    AppSpec { id: "playniteFullscreen", name: "Playnite Fullscreen", process_name: "Playnite.FullscreenApp.exe", focus_restore_supported: true },
    AppSpec { id: "chrome", name: "Google Chrome", process_name: "chrome.exe", focus_restore_supported: false },
    AppSpec { id: "edge", name: "Microsoft Edge", process_name: "msedge.exe", focus_restore_supported: false },
    AppSpec { id: "firefox", name: "Mozilla Firefox", process_name: "firefox.exe", focus_restore_supported: false },
];

fn spec_for(id: &str) -> Option<&'static AppSpec> {
    APP_SPECS.iter().find(|spec| spec.id == id)
}

fn should_dispatch_when_running(id: &str) -> bool {
    // Both launchers have documented single-instance handoffs for changing modes.
    matches!(id, "steamBigPicture" | "playniteFullscreen")
}

#[tauri::command]
pub fn get_app_manager_status() -> AppManagerSnapshot {
    #[cfg(target_os = "windows")]
    {
        let apps = APP_SPECS.iter().map(|spec| {
            let path = app_path(spec.id);
            let installed = path.is_some();
            let (running_instances, last_error) = if installed {
                match app_process_count(spec.id, spec.process_name) {
                    Ok(count) => (count, None),
                    Err(error) => (0, Some(error)),
                }
            } else {
                (0, None)
            };
            ManagedAppStatus {
                id: spec.id.into(),
                name: spec.name.into(),
                process_name: spec.process_name.into(),
                installed,
                running_instances,
                focus_restore_supported: spec.focus_restore_supported,
                last_error,
            }
        }).collect();
        let (games, games_error) = if app_path("steamBigPicture").is_some() {
            match steam_games() {
                Ok(games) => (games, None),
                Err(error) => (Vec::new(), Some(error)),
            }
        } else {
            (Vec::new(), None)
        };
        AppManagerSnapshot {
            windows: true,
            foreground_process: crate::control_service::foreground_process_name(),
            apps,
            games,
            games_error,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        AppManagerSnapshot {
            windows: false,
            foreground_process: None,
            games: Vec::new(),
            games_error: None,
            apps: APP_SPECS.iter().map(|spec| ManagedAppStatus {
                id: spec.id.into(),
                name: spec.name.into(),
                process_name: spec.process_name.into(),
                installed: false,
                running_instances: 0,
                focus_restore_supported: false,
                last_error: None,
            }).collect(),
        }
    }
}

/// Runs only when requested from Gaming Hub. Checks known install locations and
/// fixed volumes; it does not crawl user files, inspect accounts, or launch apps.
#[tauri::command]
pub fn get_gaming_diagnostics() -> GamingDiagnostics {
    #[cfg(target_os = "windows")]
    {
        let drives = fixed_drive_roots();
        let (disk_space, disk_space_error) = match drives {
            Ok(roots) => {
                let results = roots.iter().map(|root| disk_space_status(root)).collect();
                (results, None)
            }
            Err(error) => (Vec::new(), Some(error)),
        };
        let gog_galaxy_detected = first_existing(gog_galaxy_paths()).is_some();
        let cyberpunk_install_detected = first_existing(cyberpunk_paths()).is_some();
        let (gog_galaxy_running_instances, gog_galaxy_process_error) = match process_count("GalaxyClient.exe") {
            Ok(count) => (Some(count), None),
            Err(error) => (None, Some(error)),
        };
        GamingDiagnostics {
            windows: true,
            playnite_detected: playnite_path().is_some(),
            gog_galaxy_detected,
            gog_galaxy_running_instances,
            gog_galaxy_process_error,
            cyberpunk_install_detected,
            disk_space,
            disk_space_error,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        GamingDiagnostics {
            windows: false,
            playnite_detected: false,
            gog_galaxy_detected: false,
            gog_galaxy_running_instances: None,
            gog_galaxy_process_error: None,
            cyberpunk_install_detected: false,
            disk_space: Vec::new(),
            disk_space_error: Some("Diagnostyka jest dostępna w natywnej aplikacji Windows.".into()),
        }
    }
}

#[tauri::command]
pub fn launch_managed_app(app: AppHandle, id: String) -> Result<LaunchReceipt, String> {
    let spec = spec_for(&id).ok_or_else(|| "Aplikacja nie znajduje się na allowliście VELORA.".to_string())?;

    #[cfg(target_os = "windows")]
    {
        let executable = app_path(spec.id)
            .ok_or_else(|| format!("Nie wykryto zainstalowanej aplikacji: {}.", spec.name))?;
        let count = app_process_count(spec.id, spec.process_name)?;
        let already_running = count > 0;
        if already_running && !should_dispatch_when_running(spec.id) {
            return Ok(LaunchReceipt {
                id,
                already_running: true,
                focus_restore_supported: false,
            });
        }

        let mut command = Command::new(executable);
        match spec.id {
            "steamBigPicture" => { command.arg("steam://open/bigpicture"); }
            "playniteFullscreen" => { command.arg("--startfullscreen"); }
            _ => {}
        }
        let child = command.spawn().map_err(|error| format!("Windows nie uruchomił aplikacji {}: {error}", spec.name))?;
        if spec.id == "playniteFullscreen" {
            drop(child);
            watch_playnite_lifecycle(app, already_running);
        }
        Ok(LaunchReceipt {
            id,
            already_running,
            focus_restore_supported: spec.focus_restore_supported,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, spec);
        Err("App Manager jest dostępny tylko w natywnej aplikacji Windows.".into())
    }
}

#[tauri::command]
pub fn launch_managed_game(id: String) -> Result<ManagedGameLaunchReceipt, String> {
    if !is_valid_steam_app_id(&id) {
        return Err("Nieprawidłowy identyfikator gry Steam.".into());
    }

    #[cfg(target_os = "windows")]
    {
        let game = steam_games()?.into_iter().find(|game| game.id == id)
            .ok_or_else(|| format!("Gra Steam o ID {} nie znajduje się w dostępnej, zainstalowanej bibliotece.", id))?;
        let executable = steam_path()
            .ok_or_else(|| "Nie wykryto pliku wykonywalnego Steam.".to_string())?;
        let child = Command::new(executable)
            .args(["-applaunch", game.id.as_str()])
            .spawn()
            .map_err(|error| format!("Steam nie uruchomił gry {}: {error}", game.name))?;
        drop(child);
        Ok(ManagedGameLaunchReceipt { id: game.id, launched: true })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = id;
        Err("Gaming Hub wymaga natywnego App Managera Windows.".into())
    }
}

#[cfg(target_os = "windows")]
fn app_path(id: &str) -> Option<PathBuf> {
    match id {
        "steamBigPicture" => steam_path(),
        "appleMusic" => std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("Microsoft").join("WindowsApps").join("AppleMusic.exe"))
            .filter(|path| path.is_file()),
        "playniteFullscreen" => playnite_path(),
        "chrome" => browser_paths("Google", "Chrome", "Application", "chrome.exe"),
        "edge" => browser_paths("Microsoft", "Edge", "Application", "msedge.exe"),
        "firefox" => firefox_path(),
        _ => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn app_path(_id: &str) -> Option<PathBuf> { None }

#[cfg(target_os = "windows")]
fn steam_path() -> Option<PathBuf> {
    let mut paths = Vec::new();
    for key in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            paths.push(root.join("Steam").join("steam.exe"));
            if key == "LOCALAPPDATA" {
                paths.push(root.join("Programs").join("Steam").join("steam.exe"));
            }
        }
    }
    first_existing(paths)
}

#[cfg(target_os = "windows")]
fn playnite_path() -> Option<PathBuf> {
    let mut paths = Vec::new();
    for root in standard_install_roots() {
        paths.push(root.join("Playnite").join("Playnite.FullscreenApp.exe"));
        paths.push(root.join("Programs").join("Playnite").join("Playnite.FullscreenApp.exe"));
    }
    first_existing(paths)
}

#[cfg(target_os = "windows")]
fn standard_install_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            if !roots.contains(&root) { roots.push(root); }
        }
    }
    if let Ok(drives) = fixed_drive_roots() {
        for drive in drives {
            for root in [
                drive.clone(),
                drive.join("Program Files"),
                drive.join("Program Files (x86)"),
            ] {
                if !roots.contains(&root) { roots.push(root); }
            }
        }
    }
    roots
}

#[cfg(target_os = "windows")]
fn gog_galaxy_paths() -> Vec<PathBuf> {
    standard_install_roots().into_iter()
        .map(|root| root.join("GOG Galaxy").join("GalaxyClient.exe"))
        .collect()
}

#[cfg(target_os = "windows")]
fn cyberpunk_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for root in standard_install_roots() {
        paths.push(root.join("GOG Games").join("Cyberpunk 2077").join("bin").join("x64").join("Cyberpunk2077.exe"));
        paths.push(root.join("GOG Galaxy").join("Games").join("Cyberpunk 2077").join("bin").join("x64").join("Cyberpunk2077.exe"));
    }
    paths
}

#[cfg(target_os = "windows")]
fn fixed_drive_roots() -> Result<Vec<PathBuf>, String> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    use windows::core::PCWSTR;

    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err("Windows nie zwrócił listy dostępnych dysków.".into());
    }
    let mut roots = Vec::new();
    for index in 0..26 {
        if mask & (1 << index) == 0 { continue; }
        let letter = char::from(b'A' + index as u8);
        let root = format!("{letter}:\\");
        let wide = root.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
        // DRIVE_FIXED = 3. Network and removable volumes are excluded to avoid
        // triggering remote lookups or waiting for disconnected media.
        if unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } == 3 {
            roots.push(PathBuf::from(root));
        }
    }
    Ok(roots)
}

#[cfg(target_os = "windows")]
fn disk_space_status(root: &Path) -> DiskSpaceStatus {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::core::PCWSTR;

    let drive = root.to_string_lossy().trim_end_matches('\\').to_string();
    let wide = root.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut available = 0u64;
    let mut total = 0u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut available),
            Some(&mut total),
            None,
        )
    };
    match result {
        Ok(()) => DiskSpaceStatus { drive, available_bytes: Some(available), total_bytes: Some(total), error: None },
        Err(_) => DiskSpaceStatus { drive, available_bytes: None, total_bytes: None, error: Some("Nie udało się odczytać wolnego miejsca.".into()) },
    }
}

#[cfg(target_os = "windows")]
fn browser_paths(vendor: &str, product: &str, channel: &str, executable: &str) -> Option<PathBuf> {
    let mut paths = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            let prefix = if key == "LOCALAPPDATA" { root.join("Programs") } else { root };
            paths.push(prefix.join(vendor).join(product).join(channel).join(executable));
        }
    }
    first_existing(paths)
}

#[cfg(target_os = "windows")]
fn firefox_path() -> Option<PathBuf> {
    let mut paths = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            paths.push(root.join("Mozilla Firefox").join("firefox.exe"));
        }
    }
    first_existing(paths)
}

fn is_valid_steam_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 10
        && id.bytes().all(|byte| byte.is_ascii_digit())
        && id.parse::<u32>().map_or(false, |value| value > 0)
}

fn parse_vdf_quoted(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<String> {
    while chars.peek().is_some_and(|character| character.is_whitespace()) {
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

fn parse_steam_manifest(contents: &str) -> Option<ParsedSteamManifest> {
    let mut id = None;
    let mut name = None;
    let mut install_dir = None;
    for line in contents.lines() {
        if let Some((key, value)) = parse_vdf_pair(line) {
            match key.as_str() {
                "appid" => id = Some(value),
                "name" => name = Some(value),
                "installdir" => install_dir = Some(value),
                _ => {}
            }
        }
    }
    let id = id?;
    let name = name?.trim().to_string();
    let install_dir = install_dir?;
    if !is_valid_steam_app_id(&id) || name.is_empty() || install_dir.trim().is_empty()
        || Path::new(&install_dir).components().any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(ParsedSteamManifest {
        game: ManagedGame { id, name, launcher: "Steam".into() },
        install_dir,
    })
}

#[cfg(target_os = "windows")]
fn steam_games() -> Result<Vec<ManagedGame>, String> {
    let executable = steam_path().ok_or_else(|| "Nie wykryto Steam.".to_string())?;
    let root = executable.parent().ok_or_else(|| "Nie można ustalić katalogu Steam.".to_string())?;
    let mut libraries = vec![root.to_path_buf()];
    if let Ok(contents) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for line in contents.lines() {
            if let Some((key, value)) = parse_vdf_pair(line) {
                if key == "path" || key.parse::<usize>().is_ok() {
                    let library = PathBuf::from(value);
                    if library.is_dir() && !libraries.contains(&library) {
                        libraries.push(library);
                    }
                }
            }
        }
    }

    let mut scanned = 0usize;
    let mut games: Vec<ManagedGame> = Vec::new();
    for library in libraries {
        let steamapps = library.join("steamapps");
        let entries = match fs::read_dir(&steamapps) {
            Ok(entries) => { scanned += 1; entries }
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_lowercase();
            if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                continue;
            }
            let Ok(contents) = fs::read_to_string(entry.path()) else { continue; };
            let Some(parsed) = parse_steam_manifest(&contents) else { continue; };
            if !steamapps.join("common").join(&parsed.install_dir).is_dir() {
                continue;
            }
            if !games.iter().any(|game| game.id == parsed.game.id) {
                games.push(parsed.game);
            }
        }
    }
    if scanned == 0 {
        return Err("Nie można odczytać katalogów bibliotek Steam.".into());
    }
    games.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(games)
}

fn first_existing(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn process_count(image_name: &str) -> Result<usize, String> {
    use windows::core::HRESULT;
    use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|_| "Nie można odczytać stanu procesów Windows.".to_string())?;
    let no_more_files = HRESULT::from_win32(ERROR_NO_MORE_FILES.0);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let first = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut count = 0;

    let result = match first {
        Ok(()) => loop {
            if process_entry_matches(&entry.szExeFile, image_name) {
                count += 1;
            }
            match unsafe { Process32NextW(snapshot, &mut entry) } {
                Ok(()) => {}
                Err(error) if error.code() == no_more_files => break Ok(count),
                Err(_) => break Err("Nie udało się odczytać stanu procesów Windows.".into()),
            }
        },
        Err(error) if error.code() == no_more_files => Ok(0),
        Err(_) => Err("Nie udało się odczytać stanu procesów Windows.".into()),
    };
    let close_result = unsafe { CloseHandle(snapshot) };
    if result.is_ok() && close_result.is_err() {
        return Err("Nie udało się zamknąć migawki procesów Windows.".into());
    }
    result
}

fn process_entry_matches(executable_name: &[u16], image_name: &str) -> bool {
    let length = executable_name.iter().position(|character| *character == 0).unwrap_or(executable_name.len());
    String::from_utf16_lossy(&executable_name[..length]).eq_ignore_ascii_case(image_name)
}

#[cfg(any(target_os = "windows", test))]
fn should_restore_after_playnite(
    seen_running: bool,
    absent_for: Duration,
) -> bool {
    seen_running && absent_for >= Duration::from_secs(2)
}

#[cfg(target_os = "windows")]
fn app_process_count(id: &str, process_name: &str) -> Result<usize, String> {
    if id == "playniteFullscreen" {
        return Ok(process_count("Playnite.FullscreenApp.exe")?
            + process_count("Playnite.DesktopApp.exe")?);
    }
    process_count(process_name)
}

#[cfg(not(target_os = "windows"))]
fn app_process_count(_id: &str, _process_name: &str) -> Result<usize, String> {
    Ok(0)
}

#[cfg(target_os = "windows")]
static PLAYNITE_WATCHER_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
fn watch_playnite_lifecycle(app: AppHandle, already_running: bool) {
    if PLAYNITE_WATCHER_ACTIVE.swap(true, Ordering::AcqRel) { return; }
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(12 * 60 * 60);
        let mut seen_running = already_running;
        let mut absent_since = None;
        loop {
            match app_process_count("playniteFullscreen", "Playnite.FullscreenApp.exe") {
                Ok(count) if count > 0 => {
                    seen_running = true;
                    absent_since = None;
                }
                Ok(0) if seen_running => {
                    let absent_since = absent_since.get_or_insert_with(Instant::now);
                    if absent_since.elapsed() < Duration::from_secs(2) {
                        thread::sleep(Duration::from_millis(300));
                        continue;
                    }
                    if should_restore_after_playnite(seen_running, absent_since.elapsed()) {
                        let _ = app.emit("managed-app-exited", "playniteFullscreen");
                    }
                    break;
                }
                Ok(_) | Err(_) => absent_since = None,
            }
            if Instant::now() >= deadline { break; }
            thread::sleep(Duration::from_millis(300));
        }
        PLAYNITE_WATCHER_ACTIVE.store(false, Ordering::Release);
    });
}

#[cfg(test)]
mod tests {
    use super::{is_valid_steam_app_id, parse_steam_manifest, parse_vdf_pair, process_entry_matches, should_dispatch_when_running, should_restore_after_playnite, spec_for};
    use std::time::Duration;

    #[test]
    fn app_registry_rejects_unlisted_ids() {
        assert!(spec_for("appleMusic").is_some());
        assert!(spec_for("C:\\Users\\someone\\app.exe").is_none());
        assert!(spec_for("arbitraryCommand").is_none());
    }

    #[test]
    fn steam_dispatches_big_picture_to_its_single_existing_client() {
        assert!(should_dispatch_when_running("steamBigPicture"));
        assert!(!should_dispatch_when_running("appleMusic"));
        assert!(should_dispatch_when_running("playniteFullscreen"));
    }

    #[test]
    fn playnite_return_waits_for_process_exit_and_only_restores_to_velora_or_desktop() {
        assert!(!should_restore_after_playnite(false, Duration::from_secs(3)));
        assert!(!should_restore_after_playnite(true, Duration::from_millis(500)));
        assert!(should_restore_after_playnite(true, Duration::from_secs(3)));
    }

    #[test]
    fn steam_app_ids_are_positive_numeric_and_bounded() {
        assert!(is_valid_steam_app_id("440"));
        assert!(!is_valid_steam_app_id("0"));
        assert!(!is_valid_steam_app_id("44x"));
        assert!(!is_valid_steam_app_id("4294967296"));
        assert!(!is_valid_steam_app_id("12345678901"));
    }

    #[test]
    fn steam_library_parser_preserves_legacy_and_escaped_windows_paths() {
        assert_eq!(
            parse_vdf_pair(r#""1" "D:\SteamLibrary""#),
            Some(("1".into(), r"D:\SteamLibrary".into()))
        );
        assert_eq!(
            parse_vdf_pair(r#""path" "E:\\Games\\Steam""#),
            Some(("path".into(), r"E:\Games\Steam".into()))
        );
    }

    #[test]
    fn steam_manifest_parser_reads_game_metadata_and_rejects_traversal() {
        let manifest = r#"
            "AppState"
            {
                "appid" "440"
                "name" "Team Fortress 2"
                "installdir" "Team Fortress 2"
            }
        "#;
        let parsed = parse_steam_manifest(manifest).expect("valid appmanifest");
        assert_eq!(parsed.game.id, "440");
        assert_eq!(parsed.game.name, "Team Fortress 2");
        assert_eq!(parsed.game.launcher, "Steam");
        let traversal = r#""appid" "440"
            "name" "TF2"
            "installdir" "../escape""#;
        assert!(parse_steam_manifest(traversal).is_none());
    }

    #[test]
    fn process_diagnostics_match_names_case_insensitively() {
        let name = "ChRoMe.ExE".encode_utf16().chain([0]).collect::<Vec<_>>();
        assert!(process_entry_matches(&name, "chrome.exe"));
        assert!(!process_entry_matches(&name, "steam.exe"));
    }
}
