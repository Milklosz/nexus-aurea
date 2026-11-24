use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformLauncherStatus {
    windows: bool,
    steam_available: bool,
    playnite_available: bool,
}

impl PlatformLauncherStatus {
    /// Honest, all-unavailable fallback used only when the blocking task was
    /// interrupted — never a fabrication of detection results.
    fn unavailable() -> Self {
        Self {
            windows: cfg!(target_os = "windows"),
            steam_available: false,
            playnite_available: false,
        }
    }
}

/// Filesystem discovery and process spawning stay off Tauri's main thread,
/// matching the App Manager convention (`app_manager.rs::run_blocking_command`).
async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| "Operacja systemowa została przerwana.".to_string())?
}

#[tauri::command]
pub async fn get_platform_launcher_status() -> PlatformLauncherStatus {
    run_blocking(|| Ok(platform_launcher_status_snapshot()))
        .await
        .unwrap_or_else(|_| PlatformLauncherStatus::unavailable())
}

/// Pure filesystem lookups of the known install locations — no registry, no
/// processes, no writes.
fn platform_launcher_status_snapshot() -> PlatformLauncherStatus {
    PlatformLauncherStatus {
        windows: cfg!(target_os = "windows"),
        steam_available: steam_path().is_some(),
        playnite_available: playnite_path().is_some(),
    }
}

#[tauri::command]
pub async fn launch_platform(launcher: String) -> Result<(), String> {
    run_blocking(move || launch_platform_blocking(launcher)).await
}

fn launch_platform_blocking(launcher: String) -> Result<(), String> {
    let path = match launcher.as_str() {
        "steamBigPicture" => steam_path(),
        "playniteFullscreen" => playnite_path(),
        _ => return Err("Nieznany launcher.".into()),
    }
    .ok_or_else(|| "Nie wykryto instalacji w typowym folderze.".to_string())?;

    #[cfg(target_os = "windows")]
    {
        let arguments: &[&str] = if launcher == "steamBigPicture" {
            &["steam://open/bigpicture"]
        } else {
            &["--startfullscreen"]
        };
        let child = std::process::Command::new(path)
            .args(arguments)
            .spawn()
            .map_err(|_| "Windows nie uruchomił wybranej aplikacji.".to_string())?;
        // VELORA is foreground because the user chose this launcher; grant the
        // hand-off so the client window is not left behind the launcher.
        crate::window_broker::grant_foreground_handoff(&[child.id()]);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Launchery zewnętrzne są dostępne tylko w aplikacji Windows.".into())
    }
}

#[cfg(target_os = "windows")]
fn steam_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
            candidates.push(root.join("Steam").join("steam.exe"));
            if variable == "LOCALAPPDATA" {
                candidates.push(root.join("Programs").join("Steam").join("steam.exe"));
            }
        }
    }
    first_existing(candidates)
}

#[cfg(not(target_os = "windows"))]
fn steam_path() -> Option<PathBuf> {
    None
}

#[cfg(target_os = "windows")]
fn playnite_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        candidates.push(root.join("Playnite").join("Playnite.FullscreenApp.exe"));
        candidates.push(root.join("Programs").join("Playnite").join("Playnite.FullscreenApp.exe"));
        candidates.push(root.join("Playnite").join("Playnite.DesktopApp.exe"));
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
            candidates.push(root.join("Playnite").join("Playnite.FullscreenApp.exe"));
            candidates.push(root.join("Playnite").join("Playnite.DesktopApp.exe"));
        }
    }
    first_existing(candidates)
}

#[cfg(not(target_os = "windows"))]
fn playnite_path() -> Option<PathBuf> {
    None
}

fn first_existing(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::first_existing;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    fn temp_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "nexus-aurea-launcher-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn launcher_detection_accepts_only_existing_files() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let directory = root.join("not-an-executable.exe");
        let file = root.join("installed.exe");
        fs::create_dir(&directory).unwrap();
        fs::write(&file, b"fixture").unwrap();

        assert_eq!(
            first_existing(vec![directory, root.join("missing.exe"), file.clone()]),
            Some(file)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn launch_platform_rejects_unknown_launchers_before_any_lookup() {
        // Allowlist first: no arbitrary id may reach a path probe or a spawn,
        // on every platform and without touching the filesystem.
        for unknown in ["", "cmd.exe", "steamBigPicture ", "../steamBigPicture", "arbitrary"] {
            let error = super::launch_platform_blocking(unknown.to_string())
                .expect_err("unknown launcher must be rejected");
            assert_eq!(error, "Nieznany launcher.", "launcher {unknown:?}");
        }
    }

    #[test]
    fn detection_never_treats_a_directory_as_an_installed_launcher() {
        let root = temp_root();
        let steam_dir = root.join("Steam").join("steam.exe");
        fs::create_dir_all(&steam_dir).unwrap();
        // Even if the candidate path exists, a directory is not an executable.
        assert_eq!(first_existing(vec![steam_dir]), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn heavy_platform_commands_stay_off_the_main_thread() {
        let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/platform_launchers.rs"))
            .expect("platform_launchers.rs must be readable");
        assert!(source.contains("pub async fn get_platform_launcher_status"));
        assert!(source.contains("pub async fn launch_platform"));
        assert!(source.contains("tauri::async_runtime::spawn_blocking"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn off_windows_detection_is_honest_and_never_invents_installations() {
        assert!(super::steam_path().is_none());
        assert!(super::playnite_path().is_none());
        let status = super::platform_launcher_status_snapshot();
        assert!(!status.windows && !status.steam_available && !status.playnite_available);
    }
}
