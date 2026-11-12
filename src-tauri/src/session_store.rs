//! Durable session state used only for crash/restart recovery.
//!
//! The file contains the session snapshot (state, revision, launch context and
//! PIDs). It deliberately contains no window titles, credentials, pairing data
//! or user paths. The path itself is the application data directory.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::session_orchestrator::SessionSnapshot;

pub(crate) const STATE_FILE: &str = "velora-session.json";
pub(crate) const STATE_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedSession {
    pub version: u32,
    pub snapshot: SessionSnapshot,
    pub clean_shutdown: bool,
    pub saved_at_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn state_path(base: &Path) -> PathBuf {
    base.join(STATE_FILE)
}

pub(crate) fn read_state_at(path: &Path) -> Result<Option<PersistedSession>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Nie można odczytać zapisanego stanu sesji VELORA.".into()),
    };
    if contents.len() > 64 * 1024 {
        return Err("Zapisany stan sesji przekroczył bezpieczny rozmiar.".into());
    }
    let state: PersistedSession = serde_json::from_str(&contents)
        .map_err(|_| "Zapisany stan sesji jest uszkodzony.".to_string())?;
    if state.version != STATE_VERSION {
        return Err(format!(
            "Nieobsługiwana wersja zapisanego stanu sesji: {}.",
            state.version
        ));
    }
    Ok(Some(state))
}

pub(crate) fn write_state_at(
    path: &Path,
    snapshot: &SessionSnapshot,
    clean_shutdown: bool,
) -> Result<(), String> {
    let state = PersistedSession {
        version: STATE_VERSION,
        snapshot: snapshot.clone(),
        clean_shutdown,
        saved_at_ms: now_ms(),
    };
    let serialized = serde_json::to_vec(&state)
        .map_err(|_| "Nie można zserializować stanu sesji VELORA.".to_string())?;
    if serialized.len() > 64 * 1024 {
        return Err("Stan sesji przekroczył bezpieczny rozmiar.".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Nie można utworzyć katalogu stanu sesji VELORA.".to_string())?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        use std::io::Write as _;
        let mut file = fs::File::create(&temporary)
            .map_err(|_| "Nie można utworzyć tymczasowego stanu sesji VELORA.".to_string())?;
        file.write_all(&serialized)
            .map_err(|_| "Nie można zapisać tymczasowego stanu sesji VELORA.".to_string())?;
        file.sync_all()
            .map_err(|_| "Nie można utrwalić stanu sesji VELORA.".to_string())?;
    }
    // Windows cannot atomically replace an existing destination with rename.
    // The recovery reader treats a truncated file as corrupt and falls back to
    // Home, so a failed replacement is safe rather than silently trusted.
    if fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(path);
        fs::rename(&temporary, path).map_err(|_| {
            let _ = fs::remove_file(&temporary);
            "Nie można zapisać stanu sesji VELORA.".to_string()
        })?;
    }
    Ok(())
}

fn app_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Windows nie udostępnił katalogu danych VELORA.".to_string())?;
    Ok(state_path(&directory))
}

pub(crate) fn load(app: &AppHandle) -> Result<Option<PersistedSession>, String> {
    read_state_at(&app_state_path(app)?)
}

pub(crate) fn save(
    app: &AppHandle,
    snapshot: &SessionSnapshot,
    clean_shutdown: bool,
) -> Result<(), String> {
    write_state_at(&app_state_path(app)?, snapshot, clean_shutdown)
}

#[cfg(test)]
mod tests {
    use super::{read_state_at, write_state_at, PersistedSession, STATE_VERSION};
    use crate::session_orchestrator::{
        SessionContext, SessionId, SessionRecovery, SessionSnapshot,
    };
    use std::path::PathBuf;

    fn path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "velora-session-test-{}-{name}.json",
            std::process::id()
        ))
    }

    fn snapshot() -> SessionSnapshot {
        SessionSnapshot {
            current: SessionId::Game,
            previous: Some(SessionId::VeloraHome),
            revision: 7,
            transitioned_at_ms: 1_000,
            context: Some(SessionContext {
                launch_id: Some("game-1".into()),
                app_id: Some("1091500".into()),
                process_id: Some(4242),
                session_revision: Some(7),
            }),
            allowed_targets: vec![SessionId::VeloraHome, SessionId::Cinema],
            recovery: Some(SessionRecovery {
                recovered_at_ms: 900,
                previous_session: SessionId::Cinema,
                previous_revision: 6,
                reason: crate::session_orchestrator::RecoveryReason::UnexpectedExit,
                message: "test".into(),
            }),
        }
    }

    #[test]
    fn round_trips_session_state_without_secrets() {
        let file = path("roundtrip");
        let _ = std::fs::remove_file(&file);
        write_state_at(&file, &snapshot(), false).unwrap();
        let state = read_state_at(&file).unwrap().unwrap();
        assert_eq!(state.version, STATE_VERSION);
        assert_eq!(state.snapshot, snapshot());
        assert!(!state.clean_shutdown);
        let contents = std::fs::read_to_string(&file).unwrap();
        for forbidden in ["token", "pairing", "password", "secret", "authorization"] {
            assert!(!contents.to_ascii_lowercase().contains(forbidden));
        }
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn omitted_optional_fields_survive_a_round_trip() {
        let file = path("optional");
        let _ = std::fs::remove_file(&file);
        let mut minimal = snapshot();
        minimal.current = crate::session_orchestrator::SessionId::VeloraHome;
        minimal.previous = None;
        minimal.context = None;
        minimal.recovery = None;
        write_state_at(&file, &minimal, true).unwrap();
        let state = read_state_at(&file).unwrap().unwrap();
        assert_eq!(state.snapshot, minimal);
        assert!(state.clean_shutdown);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn missing_state_is_not_an_error() {
        let file = path("missing");
        let _ = std::fs::remove_file(&file);
        assert!(read_state_at(&file).unwrap().is_none());
    }

    #[test]
    fn corrupt_or_oversized_state_is_rejected() {
        let file = path("corrupt");
        std::fs::write(&file, b"{not-json").unwrap();
        assert!(read_state_at(&file).is_err());
        std::fs::write(&file, vec![b'x'; 65 * 1024]).unwrap();
        assert!(read_state_at(&file).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn unsupported_versions_are_rejected() {
        let file = path("version");
        let mut state = PersistedSession {
            version: STATE_VERSION + 1,
            snapshot: snapshot(),
            clean_shutdown: true,
            saved_at_ms: 1,
        };
        std::fs::write(&file, serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(read_state_at(&file).is_err());
        state.version = STATE_VERSION;
        std::fs::write(&file, serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(read_state_at(&file).unwrap().is_some());
        let _ = std::fs::remove_file(&file);
    }
}
