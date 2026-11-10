use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformLauncherStatus {
    windows: bool,
    steam_available: bool,
    playnite_available: bool,
}

#[tauri::command]
pub fn get_platform_launcher_status() -> PlatformLauncherStatus {
    PlatformLauncherStatus {
        windows: cfg!(target_os = "windows"),
        steam_available: steam_path().is_some(),
        playnite_available: playnite_path().is_some(),
    }
}

#[tauri::command]
pub fn launch_platform(launcher: String) -> Result<(), String> {
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
        std::process::Command::new(path)
            .args(arguments)
            .spawn()
            .map(|_| ())
            .map_err(|_| "Windows nie uruchomił wybranej aplikacji.".to_string())
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

    #[test]
    fn launcher_detection_accepts_only_existing_files() {
        let root = std::env::temp_dir().join(format!(
            "nexus-aurea-launcher-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
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
}
