use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
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

#[tauri::command]
pub fn get_app_manager_status() -> AppManagerSnapshot {
    #[cfg(target_os = "windows")]
    {
        let apps = APP_SPECS.iter().map(|spec| {
            let path = app_path(spec.id);
            let installed = path.is_some();
            let (running_instances, last_error) = if installed {
                match process_count(spec.process_name) {
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
        AppManagerSnapshot {
            windows: true,
            foreground_process: crate::control_service::foreground_process_name(),
            apps,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        AppManagerSnapshot {
            windows: false,
            foreground_process: None,
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

#[tauri::command]
pub fn launch_managed_app(app: AppHandle, id: String) -> Result<LaunchReceipt, String> {
    let spec = spec_for(&id).ok_or_else(|| "Aplikacja nie znajduje się na allowliście NEXUS.".to_string())?;

    #[cfg(target_os = "windows")]
    {
        let executable = app_path(spec.id)
            .ok_or_else(|| format!("Nie wykryto zainstalowanej aplikacji: {}.", spec.name))?;
        let count = process_count(spec.process_name)?;
        if count > 0 {
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
        let child = command.spawn().map_err(|_| format!("Windows nie uruchomił aplikacji {}.", spec.name))?;
        if spec.focus_restore_supported {
            watch_owned_process(app, id.clone(), child);
        }
        Ok(LaunchReceipt {
            id,
            already_running: false,
            focus_restore_supported: spec.focus_restore_supported,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, spec);
        Err("App Manager jest dostępny tylko w natywnej aplikacji Windows.".into())
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
    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
            paths.push(root.join("Playnite").join("Playnite.FullscreenApp.exe"));
            paths.push(root.join("Programs").join("Playnite").join("Playnite.FullscreenApp.exe"));
        }
    }
    first_existing(paths)
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

fn first_existing(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn process_count(image_name: &str) -> Result<usize, String> {
    let mut child = Command::new("tasklist")
        .args(["/FO", "CSV", "/NH", "/FI", &format!("IMAGENAME eq {image_name}")])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Nie można odczytać stanu procesów Windows.".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Przekroczono limit czasu diagnostyki procesów Windows.".into());
            }
            Err(_) => return Err("Nie udało się sprawdzić procesów Windows.".into()),
        }
    }
    let output = child.wait_with_output().map_err(|_| "Nie można odczytać stanu procesów Windows.".to_string())?;
    if !output.status.success() {
        return Err("Windows zwrócił błąd przy sprawdzaniu procesów.".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_tasklist_count(&text, image_name))
}

fn parse_tasklist_count(output: &str, image_name: &str) -> usize {
    output.lines().filter(|line| {
        line.split(',').next().map(|field| field.trim().trim_matches('"'))
            .is_some_and(|name| name.eq_ignore_ascii_case(image_name))
    }).count()
}

#[cfg(target_os = "windows")]
fn watch_owned_process(app: AppHandle, id: String, mut child: Child) {
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(12 * 60 * 60);
        loop {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    let foreground = crate::control_service::foreground_process_name();
                    let returned_to_desktop = foreground.as_deref().is_some_and(|name| {
                        name.eq_ignore_ascii_case("explorer.exe")
                            || name.eq_ignore_ascii_case("nexus-aurea.exe")
                    });
                    if returned_to_desktop {
                        let _ = app.emit("managed-app-exited", id);
                    }
                    break;
                }
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(300)),
                Ok(None) | Err(_) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_tasklist_count, spec_for};

    #[test]
    fn app_registry_rejects_unlisted_ids() {
        assert!(spec_for("appleMusic").is_some());
        assert!(spec_for("C:\\Users\\someone\\app.exe").is_none());
        assert!(spec_for("arbitraryCommand").is_none());
    }

    #[test]
    fn process_diagnostics_parse_only_the_allowlisted_image_name() {
        let output = "\"chrome.exe\",\"123\",\"Console\",\"1\",\"1000 K\"\r\n\"chrome.exe\",\"124\",\"Console\",\"1\",\"1200 K\"\r\nINFO: No tasks are running which match the specified criteria.\r\n";
        assert_eq!(parse_tasklist_count(output, "chrome.exe"), 2);
        assert_eq!(parse_tasklist_count(output, "steam.exe"), 0);
    }
}
