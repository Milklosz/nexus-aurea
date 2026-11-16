use crate::display_audio::{self, AudioEndpointInfo};

fn volume_scalar(percent: f64) -> Result<f32, String> {
    if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
        return Err("Głośność musi należeć do zakresu 0–100%.".into());
    }
    Ok((percent / 100.0) as f32)
}

fn validate_endpoint_id(id: &str) -> Result<(), String> {
    if id.len() != 16 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Odśwież bieżące wyjście audio przed zmianą głośności.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_system_audio() -> Result<AudioEndpointInfo, String> {
    tauri::async_runtime::spawn_blocking(|| display_audio::control_default_audio(None, None, None))
        .await
        .map_err(|_| "Odczyt audio został przerwany.".to_string())?
}

#[tauri::command]
pub async fn set_system_audio_volume(
    percent: f64,
    expected_endpoint_id: String,
) -> Result<AudioEndpointInfo, String> {
    let scalar = volume_scalar(percent)?;
    validate_endpoint_id(&expected_endpoint_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        display_audio::control_default_audio(Some(scalar), None, Some(&expected_endpoint_id))
    })
    .await
    .map_err(|_| "Zmiana głośności została przerwana.".to_string())?
}

#[tauri::command]
pub async fn set_system_audio_mute(
    muted: bool,
    expected_endpoint_id: String,
) -> Result<AudioEndpointInfo, String> {
    validate_endpoint_id(&expected_endpoint_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        display_audio::control_default_audio(None, Some(muted), Some(&expected_endpoint_id))
    })
    .await
    .map_err(|_| "Zmiana wyciszenia została przerwana.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_nonfinite_and_out_of_range_volume_without_writing() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1, 100.1] {
            assert!(volume_scalar(value).is_err());
        }
        assert_eq!(volume_scalar(0.0).unwrap(), 0.0);
        assert_eq!(volume_scalar(50.0).unwrap(), 0.5);
        assert_eq!(volume_scalar(100.0).unwrap(), 1.0);
    }

    #[test]
    fn endpoint_identity_is_a_bounded_hash_not_a_path_or_device_name() {
        assert!(validate_endpoint_id("0123456789abcdef").is_ok());
        for value in [
            "",
            "default",
            "0123456789abcdeg",
            "0123456789abcdef0",
            "C:\\audio",
        ] {
            assert!(validate_endpoint_id(value).is_err());
        }
    }
}
