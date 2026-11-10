use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleMusicStatus {
    pub windows: bool,
    pub bridge_available: bool,
    pub apple_session_found: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub playback_state: Option<String>,
    pub position_seconds: Option<u64>,
    pub duration_seconds: Option<u64>,
    pub can_toggle_play_pause: bool,
    pub can_next: bool,
    pub can_previous: bool,
    pub artwork_supported: bool,
    pub audio_device_name: Option<String>,
    pub bluetooth_latency_ms: Option<u32>,
    pub message: Option<String>,
}

impl AppleMusicStatus {
    fn unavailable(windows: bool, message: Option<String>) -> Self {
        Self {
            windows,
            bridge_available: false,
            apple_session_found: false,
            title: None,
            artist: None,
            album: None,
            playback_state: None,
            position_seconds: None,
            duration_seconds: None,
            can_toggle_play_pause: false,
            can_next: false,
            can_previous: false,
            artwork_supported: false,
            audio_device_name: None,
            bluetooth_latency_ms: None,
            message,
        }
    }
}

#[tauri::command]
pub fn get_apple_music_status() -> AppleMusicStatus {
    #[cfg(target_os = "windows")]
    { windows::status() }
    #[cfg(not(target_os = "windows"))]
    { AppleMusicStatus::unavailable(false, Some("Mostek Apple Music wymaga natywnej aplikacji Windows.".into())) }
}

#[tauri::command]
pub fn control_apple_music(action: String) -> Result<(), String> {
    if !matches!(action.as_str(), "toggle" | "next" | "previous") {
        return Err("Nieznane polecenie sterowania Apple Music.".into());
    }
    #[cfg(target_os = "windows")]
    { windows::control(&action) }
    #[cfg(not(target_os = "windows"))]
    { Err("Sterowanie sesją Apple Music wymaga natywnej aplikacji Windows.".into()) }
}

#[tauri::command]
pub fn adjust_system_volume(action: String) -> Result<(), String> {
    if volume_key(&action).is_none() {
        return Err("Nieznane polecenie regulacji głośności.".into());
    }
    #[cfg(target_os = "windows")]
    { windows::adjust_volume(&action) }
    #[cfg(not(target_os = "windows"))]
    { Err("Regulacja głośności systemu wymaga natywnej aplikacji Windows.".into()) }
}

fn volume_key(action: &str) -> Option<u8> {
    match action {
        "up" => Some(0xaf),
        "down" => Some(0xae),
        "mute" => Some(0xad),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{volume_key, AppleMusicStatus};
    use futures_lite::future::block_on;
    use ::windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use ::windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    struct WinRtApartment;

    impl WinRtApartment {
        fn initialize() -> Result<Self, String> {
            unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
                .map_err(|error| format!("Nie można zainicjalizować WinRT: {error}"))?;
            Ok(Self)
        }
    }

    impl Drop for WinRtApartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }

    pub(super) fn status() -> AppleMusicStatus {
        let result = std::thread::Builder::new()
            .name("nexus-apple-music-status".into())
            .spawn(|| {
                let _apartment = WinRtApartment::initialize()?;
                block_on(async { read_status().await })
            })
            .and_then(|thread| thread.join().map_err(|_| std::io::Error::other("wątek WinRT zakończył się błędem")));
        match result {
            Ok(Ok(status)) => status,
            Ok(Err(error)) => AppleMusicStatus::unavailable(true, Some(error)),
            Err(error) => AppleMusicStatus::unavailable(true, Some(format!("Nie uruchomiono mostka SMTC: {error}"))),
        }
    }

    pub(super) fn control(action: &str) -> Result<(), String> {
        let action = action.to_string();
        std::thread::Builder::new()
            .name("nexus-apple-music-control".into())
            .spawn(move || {
                let _apartment = WinRtApartment::initialize()?;
                block_on(async { control_session(&action).await })
            })
            .map_err(|_| "Nie uruchomiono wątku sterowania SMTC.".to_string())?
            .join()
            .map_err(|_| "Wątek sterowania Apple Music zakończył się błędem.".to_string())?
    }

    pub(super) fn adjust_volume(action: &str) -> Result<(), String> {
        let key = volume_key(action).ok_or_else(|| "Nieznane polecenie głośności.".to_string())?;
        unsafe {
            keybd_event(key, 0, 0, 0);
            keybd_event(key, 0, KEYEVENTF_KEYUP, 0);
        }
        Ok(())
    }

    async fn read_status() -> Result<AppleMusicStatus, String> {
        let session = match apple_session().await? {
            Some(session) => session,
            None => {
                let mut status = AppleMusicStatus::unavailable(
                    true,
                    Some("Brak aktywnej sesji Apple Music. Uruchom oficjalną aplikację; metadane i sterowanie pojawią się, jeśli Windows udostępni sesję SMTC.".into()),
                );
                status.bridge_available = true;
                return Ok(status);
            }
        };

        let properties = session.TryGetMediaPropertiesAsync()
            .map_err(|error| format!("Apple Music nie udostępnił metadanych SMTC: {error}"))?
            .await
            .map_err(|error| format!("Nie odczytano metadanych Apple Music: {error}"))?;
        let playback = session.GetPlaybackInfo().map_err(|error| error.to_string())?;
        let controls = playback.Controls().map_err(|error| error.to_string())?;
        let timeline = session.GetTimelineProperties().map_err(|error| error.to_string())?;
        let position_ticks = timeline.Position().map(|value| value.Duration).unwrap_or(0);
        let start_ticks = timeline.StartTime().map(|value| value.Duration).unwrap_or(0);
        let end_ticks = timeline.EndTime().map(|value| value.Duration).unwrap_or(0);
        let duration_ticks = end_ticks.saturating_sub(start_ticks);

        Ok(AppleMusicStatus {
            windows: true,
            bridge_available: true,
            apple_session_found: true,
            title: non_empty(properties.Title().ok().map(|value| value.to_string())),
            artist: non_empty(properties.Artist().ok().map(|value| value.to_string())),
            album: non_empty(properties.AlbumTitle().ok().map(|value| value.to_string())),
            playback_state: Some(playback_state(playback.PlaybackStatus().map_err(|error| error.to_string())?).into()),
            position_seconds: ticks_to_seconds(position_ticks),
            duration_seconds: ticks_to_seconds(duration_ticks),
            can_toggle_play_pause: controls.IsPlayPauseToggleEnabled().unwrap_or(false),
            can_next: controls.IsNextEnabled().unwrap_or(false),
            can_previous: controls.IsPreviousEnabled().unwrap_or(false),
            // Thumbnail is exposed by SMTC but is not read by this prototype; no artwork is fabricated.
            artwork_supported: false,
            // The default Windows route is used. Device-name and Bluetooth latency inspection are not included yet.
            audio_device_name: None,
            bluetooth_latency_ms: None,
            message: Some("Sesja Apple Music pochodzi z Windows SMTC. Okładka, nazwa wyjścia audio i opóźnienie Bluetooth nie są udostępniane przez ten prototyp.".into()),
        })
    }

    async fn apple_session() -> Result<Option<GlobalSystemMediaTransportControlsSession>, String> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .map_err(|error| format!("Windows SMTC jest niedostępne (wymaga systemowego globalMediaControl): {error}"))?
            .await
            .map_err(|error| format!("Windows odmówił dostępu do sesji SMTC: {error}"))?;
        let sessions = manager.GetSessions().map_err(|error| error.to_string())?;
        let count = sessions.Size().map_err(|error| error.to_string())?;
        for index in 0..count {
            let Ok(session) = sessions.GetAt(index) else { continue };
            let Ok(app_id) = session.SourceAppUserModelId() else { continue };
            let app_id = app_id.to_string().to_ascii_lowercase();
            if app_id.contains("appleinc.applemusicwin") || app_id.contains("applemusic") {
                return Ok(Some(session));
            }
        }
        Ok(None)
    }

    async fn control_session(action: &str) -> Result<(), String> {
        let session = apple_session().await?
            .ok_or_else(|| "Brak aktywnej sesji Apple Music SMTC; polecenie nie zostało przekazane do innej aplikacji.".to_string())?;
        let succeeded = match action {
            "toggle" => session.TryTogglePlayPauseAsync().map_err(|error| error.to_string())?.await,
            "next" => session.TrySkipNextAsync().map_err(|error| error.to_string())?.await,
            "previous" => session.TrySkipPreviousAsync().map_err(|error| error.to_string())?.await,
            _ => return Err("Nieznane polecenie Apple Music.".into()),
        }.map_err(|error| format!("Windows nie wykonał polecenia Apple Music: {error}"))?;
        if succeeded { Ok(()) } else { Err("Sesja Apple Music nie obsługuje tego polecenia.".into()) }
    }

    fn playback_state(value: GlobalSystemMediaTransportControlsSessionPlaybackStatus) -> &'static str {
        match value {
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing => "playing",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused => "paused",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped => "stopped",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing => "changing",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Opened => "opened",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed => "closed",
            _ => "unknown",
        }
    }

    fn non_empty(value: Option<String>) -> Option<String> {
        value.filter(|text| !text.trim().is_empty())
    }

    fn ticks_to_seconds(ticks: i64) -> Option<u64> {
        (ticks > 0).then_some((ticks / 10_000_000) as u64)
    }

    const KEYEVENTF_KEYUP: u32 = 0x0002;
    #[link(name = "user32")]
    extern "system" {
        fn keybd_event(vk: u8, scan: u8, flags: u32, extra_info: usize);
    }
}

#[cfg(test)]
mod tests {
    use super::{volume_key, AppleMusicStatus};

    #[test]
    fn only_system_volume_up_down_and_mute_keys_are_supported() {
        assert_eq!(volume_key("up"), Some(0xaf));
        assert_eq!(volume_key("down"), Some(0xae));
        assert_eq!(volume_key("mute"), Some(0xad));
        assert_eq!(volume_key("set-device"), None);
    }

    #[test]
    fn unavailable_bridge_never_returns_fake_track_metadata() {
        let status = AppleMusicStatus::unavailable(true, Some("no-session".into()));
        assert!(!status.apple_session_found);
        assert!(status.title.is_none());
        assert!(status.artist.is_none());
        assert!(status.album.is_none());
        assert!(status.position_seconds.is_none());
    }
}

