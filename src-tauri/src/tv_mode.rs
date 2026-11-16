//! Window-only TV placement. Never changes Windows display topology, resolution or audio.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

static CONFIG_LOCK: Mutex<()> = Mutex::new(());
const CONFIG_FILE: &str = "tv-mode-v1.json";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TvPreference {
    version: u8,
    display_id: Option<String>,
    fullscreen: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TvDisplay {
    id: String,
    name: String,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    scale_factor: f64,
    primary: bool,
    current: bool,
    refresh_hz: Option<u32>,
    connection_type: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TvModeStatus {
    supported: bool,
    displays: Vec<TvDisplay>,
    selected_display_id: Option<String>,
    fullscreen: bool,
    selection_available: bool,
    error: Option<String>,
}

fn monitor_id(name: Option<&str>, x: i32, y: i32, width: u32, height: u32) -> String {
    let mut hash = Sha256::new();
    hash.update(name.unwrap_or("").as_bytes());
    for value in [x as i64, y as i64, width as i64, height as i64] {
        hash.update(value.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn id(monitor: &tauri::Monitor) -> String {
    monitor_id(
        monitor.name().map(String::as_str),
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
    )
}

fn preference(app: &AppHandle) -> Result<TvPreference, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Nie można odczytać ustawień ekranu.")?
        .join(CONFIG_FILE);
    match std::fs::read(&path) {
        Ok(bytes) if bytes.len() <= 2048 => {
            let value: TvPreference =
                serde_json::from_slice(&bytes).map_err(|_| "Ustawienia ekranu są uszkodzone.")?;
            if value.version != 1 || value.display_id.as_ref().is_some_and(|v| !valid_id(v)) {
                return Err("Nieobsługiwana wersja ustawień ekranu.".into());
            }
            Ok(value)
        }
        Ok(_) => Err("Ustawienia ekranu przekraczają dozwolony rozmiar.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TvPreference {
            version: 1,
            ..Default::default()
        }),
        Err(_) => Err("Nie można odczytać ustawień ekranu.".into()),
    }
}

fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn persist(app: &AppHandle, value: &TvPreference) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Nie można zapisać ustawień ekranu.")?;
    std::fs::create_dir_all(&dir).map_err(|_| "Nie można zapisać ustawień ekranu.")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "Nie można zapisać ustawień ekranu.")?;
    let pending = dir.join("tv-mode-v1.pending");
    std::fs::write(&pending, bytes).map_err(|_| "Nie można zapisać ustawień ekranu.")?;
    std::fs::rename(pending, dir.join(CONFIG_FILE))
        .map_err(|_| "Nie można zapisać ustawień ekranu.".to_string())
}

#[tauri::command]
pub fn get_tv_mode_status(app: AppHandle) -> Result<TvModeStatus, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Okno VELORA jest niedostępne.")?;
    let monitors = window
        .available_monitors()
        .map_err(|_| "Nie można odczytać ekranów.")?;
    let primary = window
        .primary_monitor()
        .map_err(|_| "Nie można odczytać ekranu głównego.")?
        .as_ref()
        .map(id);
    let current = window
        .current_monitor()
        .map_err(|_| "Nie można odczytać ekranu VELORA.")?
        .as_ref()
        .map(id);
    let config = preference(&app);
    let (selected_display_id, error) = match config {
        Ok(value) => (value.display_id, None),
        Err(message) => (None, Some(message)),
    };
    let names: Vec<_> = monitors
        .iter()
        .take(16)
        .map(|monitor| monitor.name().cloned().unwrap_or_default())
        .collect();
    let details = crate::display_audio::monitor_details(&names);
    let displays: Vec<_> = monitors
        .into_iter()
        .take(16)
        .zip(details)
        .map(|(monitor, details)| {
            let identity = id(&monitor);
            TvDisplay {
                primary: primary.as_ref() == Some(&identity),
                current: current.as_ref() == Some(&identity),
                id: identity,
                name: details.friendly_name.unwrap_or_else(|| {
                    monitor
                        .name()
                        .map(|name| name.chars().filter(|c| !c.is_control()).take(96).collect())
                        .unwrap_or_else(|| "Ekran".into())
                }),
                width: monitor.size().width,
                height: monitor.size().height,
                x: monitor.position().x,
                y: monitor.position().y,
                scale_factor: monitor.scale_factor(),
                refresh_hz: details.refresh_hz,
                connection_type: details.connection_type,
            }
        })
        .collect();
    Ok(TvModeStatus {
        supported: true,
        selection_available: selected_display_id
            .as_ref()
            .is_some_and(|selected| displays.iter().any(|display| &display.id == selected)),
        selected_display_id,
        fullscreen: window
            .is_fullscreen()
            .map_err(|_| "Nie można odczytać trybu okna.")?,
        displays,
        error,
    })
}

fn place(
    window: &tauri::WebviewWindow,
    monitor: &tauri::Monitor,
    fullscreen: bool,
) -> Result<(), String> {
    // Leave fullscreen before moving so Windows can reassign this window's monitor.
    window
        .set_fullscreen(false)
        .map_err(|_| "Nie można przywrócić trybu okienkowego.")?;
    window
        .set_decorations(true)
        .map_err(|_| "Nie można przywrócić ramki okna.")?;
    window
        .set_position(PhysicalPosition::new(
            monitor.position().x,
            monitor.position().y,
        ))
        .map_err(|_| "Nie można przenieść okna VELORA.")?;
    // Keep recovery inside the chosen physical desktop, including mixed DPI displays.
    window
        .set_size(PhysicalSize::new(
            monitor.size().width.min(1600),
            monitor.size().height.min(900),
        ))
        .map_err(|_| "Nie można zmienić rozmiaru okna VELORA.")?;
    if fullscreen {
        window
            .set_fullscreen(true)
            .map_err(|_| "Nie można włączyć pełnego ekranu.")?;
        window
            .set_decorations(false)
            .map_err(|_| "Nie można ukryć ramki okna.")?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_tv_mode(
    app: AppHandle,
    display_id: Option<String>,
    fullscreen: bool,
) -> Result<TvModeStatus, String> {
    let _guard = CONFIG_LOCK
        .try_lock()
        .map_err(|_| "Ustawienia ekranu są zajęte.")?;
    // Reject corrupt/future settings before changing the live window.
    let previous = preference(&app)?;
    let window = app
        .get_webview_window("main")
        .ok_or("Okno VELORA jest niedostępne.")?;
    if let Some(selected) = display_id.as_ref() {
        if !valid_id(selected) {
            return Err("Nieprawidłowy identyfikator ekranu.".into());
        }
        let monitor = window
            .available_monitors()
            .map_err(|_| "Nie można odczytać ekranów.")?
            .into_iter()
            .find(|monitor| &id(monitor) == selected)
            .ok_or("Wybrany ekran jest odłączony. Odśwież listę ekranów.")?;
        place(&window, &monitor, fullscreen)?;
    } else if !fullscreen {
        window
            .set_fullscreen(false)
            .map_err(|_| "Nie można przywrócić trybu okienkowego.")?;
        window
            .set_decorations(true)
            .map_err(|_| "Nie można przywrócić ramki okna.")?;
    } else {
        return Err("Wybierz dostępny ekran.".into());
    }
    persist(
        &app,
        &TvPreference {
            version: 1,
            display_id: display_id.or(previous.display_id),
            fullscreen,
        },
    )?;
    get_tv_mode_status(app)
}

/// Called at startup, or after the existing display monitor reports a topology change.
/// A disconnected saved screen never changes Windows topology or triggers repeated launches.
pub(crate) fn restore_tv_mode(app: &AppHandle) -> Result<(), String> {
    if std::env::args().any(|arg| arg == "--windowed") {
        return Ok(());
    }
    // Display notifications can overlap an explicit local change. Never block the
    // UI thread behind a dispatcher operation or overwrite that user's choice.
    let Ok(_guard) = CONFIG_LOCK.try_lock() else {
        return Ok(());
    };
    let config = preference(app)?;
    let Some(selected) = config.display_id else {
        return Ok(());
    };
    let window = app
        .get_webview_window("main")
        .ok_or("Okno VELORA jest niedostępne.")?;
    let monitors = window
        .available_monitors()
        .map_err(|_| "Nie można odczytać ekranów.")?;
    if let Some(monitor) = monitors.iter().find(|monitor| id(monitor) == selected) {
        place(&window, monitor, config.fullscreen)
    } else if let Some(primary) = window
        .primary_monitor()
        .map_err(|_| "Nie można odczytać ekranu głównego.")?
    {
        place(&window, &primary, false)
    } else {
        Err("Nie znaleziono dostępnego ekranu.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_uses_actual_name_position_and_resolution() {
        let baseline = monitor_id(Some("TV"), 1920, 0, 3840, 2160);
        assert!(valid_id(&baseline));
        assert_ne!(baseline, monitor_id(Some("Laptop"), 1920, 0, 3840, 2160));
        assert_ne!(baseline, monitor_id(Some("TV"), 0, 0, 3840, 2160));
        assert_ne!(baseline, monitor_id(Some("TV"), 1920, 0, 1920, 1080));
    }
    #[test]
    fn rejects_client_coordinates_paths_and_noncanonical_identity() {
        for value in [
            "",
            "DISPLAY1",
            "C:\\user",
            "1920,0",
            &"A".repeat(64),
            &"f".repeat(63),
        ] {
            assert!(!valid_id(value));
        }
        assert!(valid_id(&"a".repeat(64)));
    }
    #[test]
    fn config_does_not_accept_extra_process_or_system_fields() {
        assert!(serde_json::from_str::<TvPreference>(
            r#"{"version":1,"displayId":null,"fullscreen":false,"command":"cmd"}"#
        )
        .is_err());
    }
}
