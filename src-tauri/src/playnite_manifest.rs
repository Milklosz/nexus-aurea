//! VELORA 1.0 — Ecosystem (moduł A2): parser lokalnego, tylko-do-odczytu
//! manifestu biblioteki Playnite.
//!
//! VELORA czyta WYŁĄCZNIE jawny plik JSON wygenerowany przez rozszerzenie
//! Playnite (`%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json`).
//! Nie otwiera żadnych nieudokumentowanych plików biblioteki, nie zgaduje ich
//! układu, nie kopiuje tokenów/ciastek ani nie zapisuje czegokolwiek w danych
//! Playnite. Uruchomienie gry jest możliwe wyłącznie przez oficjalne URI
//! `playnite://playnite/start/<Game.Id>`.
//!
//! Cała walidacja i parsowanie są czyste i niezależne od platformy, dzięki
//! czemu `cargo test --lib` działa na macOS. Jedynie `read_default_manifest()`
//! ma wariant czytający `LOCALAPPDATA` na Windows; poza Windows zwraca jawny
//! błąd `NonWindows` (integracja NIE została uruchomiona na macOS).

// Część helperów jest używana wyłącznie na Windows lub w testach jednostkowych;
// utrzymujemy moduł bez ostrzeżeń `dead_code` na macOS w buildzie nie-testowym.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MANIFEST_KIND: &str = "velora.playnite.library-manifest";
const MANIFEST_SOURCE: &str = "playnite-api";
const EXTENSION_ID: &str = "velora-library-exporter";
const LAUNCH_KIND: &str = "playnite-uri";
const SCHEMA_VERSION: i64 = 1;
const MAX_GAMES: usize = 10_000;
const MAX_COVER_LEN: usize = 2_000_000;
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PATH_LEN: usize = 1024;
const MAX_GENERATED_AT_LEN: usize = 64;

/* ------------------------------------------------------------------------- *
 * Typowane struktury (kształt zgodny z kontraktem / schema JSON).
 * ------------------------------------------------------------------------- */

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VeloraLibraryManifest {
    pub schema_version: i64,
    pub kind: String,
    pub generated_at: String,
    pub extension: ManifestExtension,
    pub source: String,
    pub read_only: bool,
    pub games: Vec<ManifestGame>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestExtension {
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestGame {
    pub id: String,
    pub name: String,
    pub cover: Option<String>,
    pub source: String,
    pub last_played: Option<String>,
    pub favorite: bool,
    pub installed: bool,
    #[serde(default)]
    pub play_count: u64,
    #[serde(default)]
    pub playtime_seconds: u64,
    pub launch: Option<ManifestLaunch>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLaunch {
    pub kind: String,
    pub uri: String,
}

/* ------------------------------------------------------------------------- *
 * Błędy: `code()` jest stabilnym identyfikatorem, `user_message()` to czysty,
 * polski komunikat BEZ surowych ścieżek, `os error`, `Error:`, `0x` i BEZ
 * jakiejkolwiek danych z wariantów (te są wyłącznie diagnostyką).
 * ------------------------------------------------------------------------- */

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManifestError {
    IoNotFound,
    IoPermission,
    IoOther,
    TooLarge,
    InvalidJson,
    UnsupportedSchemaVersion(i64),
    InvalidKind,
    ReadOnlyRequired,
    InvalidSource,
    InvalidGeneratedAt,
    InvalidExtension,
    TooManyGames,
    InvalidGame(String),
    DuplicateGameId(String),
    InvalidPath,
    NonWindows,
}

impl ManifestError {
    pub fn code(&self) -> &'static str {
        match self {
            ManifestError::IoNotFound
            | ManifestError::IoPermission
            | ManifestError::IoOther
            | ManifestError::TooLarge => "file-access",
            ManifestError::InvalidJson
            | ManifestError::UnsupportedSchemaVersion(_)
            | ManifestError::InvalidKind
            | ManifestError::ReadOnlyRequired
            | ManifestError::InvalidSource
            | ManifestError::InvalidGeneratedAt
            | ManifestError::InvalidExtension
            | ManifestError::TooManyGames
            | ManifestError::InvalidGame(_)
            | ManifestError::DuplicateGameId(_) => "invalid-manifest",
            ManifestError::InvalidPath => "invalid-path",
            ManifestError::NonWindows => "unavailable",
        }
    }

    pub fn user_message(&self) -> String {
        let text = match self {
            ManifestError::IoNotFound => "Nie znaleziono pliku manifestu biblioteki Playnite.",
            ManifestError::IoPermission => "Brak uprawnień do odczytu pliku manifestu biblioteki Playnite.",
            ManifestError::IoOther => "Nie udało się odczytać pliku manifestu biblioteki Playnite.",
            ManifestError::TooLarge => "Plik manifestu biblioteki Playnite jest zbyt duży.",
            ManifestError::InvalidJson => "Plik manifestu biblioteki Playnite ma nieprawidłowy format.",
            ManifestError::UnsupportedSchemaVersion(_) => "Nieobsługiwana wersja schematu manifestu biblioteki Playnite.",
            ManifestError::InvalidKind => "Nieprawidłowy typ manifestu biblioteki Playnite.",
            ManifestError::ReadOnlyRequired => "Manifest biblioteki Playnite musi być oznaczony jako tylko do odczytu.",
            ManifestError::InvalidSource => "Nieprawidłowe źródło manifestu biblioteki Playnite.",
            ManifestError::InvalidGeneratedAt => "Nieprawidłowa data wygenerowania manifestu biblioteki Playnite.",
            ManifestError::InvalidExtension => "Nieprawidłowe dane rozszerzenia w manifeście biblioteki Playnite.",
            ManifestError::TooManyGames => "Manifest biblioteki Playnite zawiera zbyt wiele gier.",
            ManifestError::InvalidGame(_) => "Manifest biblioteki Playnite zawiera nieprawidłowe dane gry.",
            ManifestError::DuplicateGameId(_) => "Manifest biblioteki Playnite zawiera powtarzające się identyfikatory gier.",
            ManifestError::InvalidPath => "Nieprawidłowa ścieżka do pliku manifestu biblioteki Playnite.",
            ManifestError::NonWindows => "Odczyt manifestu biblioteki Playnite jest dostępny tylko w natywnej aplikacji Windows.",
        };
        text.to_string()
    }
}

/* ------------------------------------------------------------------------- *
 * Czyste, ręcznie napisane walidatory (bez crate'a regex).
 * ------------------------------------------------------------------------- */

fn has_control_chars(value: &str) -> bool {
    value.chars().any(char::is_control)
}

/// `^[0-9a-fA-F]{8}-...-{12}$` — dokładnie 36 znaków, grupy 8-4-4-4-12.
fn is_valid_game_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8usize, 4, 4, 4, 12];
    let mut pos = 0usize;
    for (index, &len) in groups.iter().enumerate() {
        for offset in 0..len {
            if !bytes[pos + offset].is_ascii_hexdigit() {
                return false;
            }
        }
        pos += len;
        if index + 1 < groups.len() {
            if bytes[pos] != b'-' {
                return false;
            }
            pos += 1;
        }
    }
    pos == 36
}

/// `YYYY-MM-DDTHH:MM:SS(.sss)?Z`, ≤ 64 znaki (kształty, nie zakresy dat).
fn is_iso_utc(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes.len() > MAX_GENERATED_AT_LEN {
        return false;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }
    for &i in &[0usize, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !bytes[i].is_ascii_digit() {
            return false;
        }
    }
    if bytes[19] == b'Z' {
        return bytes.len() == 20;
    }
    if bytes[19] != b'.' || *bytes.last().unwrap() != b'Z' {
        return false;
    }
    let fraction = &bytes[20..bytes.len() - 1];
    !fraction.is_empty() && fraction.iter().all(u8::is_ascii_digit)
}

/// `data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}`, ≤ 2 000 000.
fn is_valid_cover(value: &str) -> bool {
    if value.len() > MAX_COVER_LEN {
        return false;
    }
    let after = match value.strip_prefix("data:image/") {
        Some(rest) => rest,
        None => return false,
    };
    let separator = ";base64,";
    let separator_pos = match after.find(separator) {
        Some(pos) => pos,
        None => return false,
    };
    let mime = &after[..separator_pos];
    if !matches!(mime, "png" | "jpeg" | "webp" | "gif") {
        return false;
    }
    let data = &after[separator_pos + separator.len()..];
    let bytes = data.as_bytes();
    let mut padding = 0usize;
    for &byte in bytes.iter().rev() {
        if byte == b'=' {
            padding += 1;
        } else {
            break;
        }
    }
    if padding > 2 {
        return false;
    }
    let core = &bytes[..bytes.len() - padding];
    if core.is_empty() {
        return false;
    }
    core.iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
}

fn validate_game(game: &ManifestGame) -> Result<(), ManifestError> {
    if !is_valid_game_id(&game.id)
        || game.id.contains("..")
        || has_control_chars(&game.id)
    {
        return Err(ManifestError::InvalidGame("id".to_string()));
    }
    if game.name.is_empty()
        || game.name.len() > 512
        || has_control_chars(&game.name)
        || game.name.contains("..")
    {
        return Err(ManifestError::InvalidGame("name".to_string()));
    }
    if let Some(cover) = &game.cover {
        if !is_valid_cover(cover) {
            return Err(ManifestError::InvalidGame("cover".to_string()));
        }
    }
    if game.source.len() > 128 || has_control_chars(&game.source) {
        return Err(ManifestError::InvalidGame("source".to_string()));
    }
    if let Some(last_played) = &game.last_played {
        if !is_iso_utc(last_played) {
            return Err(ManifestError::InvalidGame("lastPlayed".to_string()));
        }
    }
    if let Some(launch) = &game.launch {
        if launch.kind != LAUNCH_KIND {
            return Err(ManifestError::InvalidGame("launch.kind".to_string()));
        }
        let expected = format!("playnite://playnite/start/{}", game.id);
        if launch.uri != expected {
            return Err(ManifestError::InvalidGame("launch.uri".to_string()));
        }
    }
    Ok(())
}

fn validate_manifest(manifest: &VeloraLibraryManifest) -> Result<(), ManifestError> {
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(ManifestError::UnsupportedSchemaVersion(
            manifest.schema_version,
        ));
    }
    if manifest.kind != MANIFEST_KIND {
        return Err(ManifestError::InvalidKind);
    }
    if !manifest.read_only {
        return Err(ManifestError::ReadOnlyRequired);
    }
    if manifest.source != MANIFEST_SOURCE {
        return Err(ManifestError::InvalidSource);
    }
    if manifest.extension.id != EXTENSION_ID
        || manifest.extension.version.is_empty()
        || manifest.extension.version.len() > 32
    {
        return Err(ManifestError::InvalidExtension);
    }
    if !is_iso_utc(&manifest.generated_at) {
        return Err(ManifestError::InvalidGeneratedAt);
    }
    if manifest.games.len() > MAX_GAMES {
        return Err(ManifestError::TooManyGames);
    }
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for game in &manifest.games {
        validate_game(game)?;
        if !seen.insert(game.id.as_str()) {
            return Err(ManifestError::DuplicateGameId(game.id.clone()));
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------------- *
 * Publiczne, czyste API parsera.
 * ------------------------------------------------------------------------- */

/// Parsuje i waliduje KAŻDĄ regułę kontraktu. Zwraca bezpieczny błąd przy
/// dowolnym odchyleniu — nigdy nie „przyjmuje czegokolwiek".
pub fn parse_manifest(bytes: &[u8]) -> Result<VeloraLibraryManifest, ManifestError> {
    let manifest: VeloraLibraryManifest =
        serde_json::from_slice(bytes).map_err(|_| ManifestError::InvalidJson)?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// `SystemTime` → RFC3339-ish `YYYY-MM-DDTHH:MM:SSZ` (bez zewnętrznych crate'ów).
pub fn now_timestamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format_utc_timestamp(seconds)
}

/// Algorytm `civil_from_days` (Howard Hinnant) dla dni od 1970-01-01.
fn format_utc_timestamp(seconds: u64) -> String {
    let days = seconds / 86_400;
    let rem = seconds % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;

    let z = days as i64 + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + (if mp < 10 { 3 } else { -9 });
    if month <= 2 {
        year += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

/// Rozwiązuje ścieżkę manifestu wyłącznie z absolutnego `LOCALAPPDATA`.
/// Odrzuca ścieżki puste, względne, z `..`, ze znakami sterującymi/NUL i zbyt długie.
pub fn resolve_manifest_path(local_app_data: &str) -> Result<PathBuf, ManifestError> {
    if local_app_data.is_empty() || local_app_data.len() > MAX_PATH_LEN {
        return Err(ManifestError::InvalidPath);
    }
    if has_control_chars(local_app_data) || local_app_data.contains('\0') {
        return Err(ManifestError::InvalidPath);
    }
    if local_app_data.contains("..") {
        return Err(ManifestError::InvalidPath);
    }
    if !Path::new(local_app_data).is_absolute() {
        return Err(ManifestError::InvalidPath);
    }
    Ok(Path::new(local_app_data)
        .join("VELORA")
        .join("Playnite")
        .join("velora-library-manifest.json"))
}

pub fn classify_io_error(kind: std::io::ErrorKind) -> ManifestError {
    match kind {
        std::io::ErrorKind::NotFound => ManifestError::IoNotFound,
        std::io::ErrorKind::PermissionDenied => ManifestError::IoPermission,
        _ => ManifestError::IoOther,
    }
}

/// Czyta plik z limitem 32 MiB przed parsowaniem — wyłącznie `fs::read`.
pub fn read_manifest_from(path: &Path) -> Result<VeloraLibraryManifest, ManifestError> {
    let metadata = std::fs::metadata(path).map_err(|error| classify_io_error(error.kind()))?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(ManifestError::TooLarge);
    }
    let bytes = std::fs::read(path).map_err(|error| classify_io_error(error.kind()))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(ManifestError::TooLarge);
    }
    parse_manifest(&bytes)
}

/// Windows: realny odczyt z `%LOCALAPPDATA%`.
#[cfg(target_os = "windows")]
pub fn read_default_manifest() -> Result<VeloraLibraryManifest, ManifestError> {
    let local_app_data =
        std::env::var("LOCALAPPDATA").map_err(|_| ManifestError::IoNotFound)?;
    let path = resolve_manifest_path(&local_app_data)?;
    read_manifest_from(&path)
}

/// Poza Windows: HONESTY — integracja nie została uruchomiona; brak realnego odczytu.
#[cfg(not(target_os = "windows"))]
pub fn read_default_manifest() -> Result<VeloraLibraryManifest, ManifestError> {
    Err(ManifestError::NonWindows)
}

/// Mapuje zwalidowany manifest na istniejący `PlayniteLibrarySnapshot`.
/// Dzięki temu dotychczasowy UI i `normalizeSnapshot()` działają bez zmian.
pub fn snapshot_from_manifest(
    manifest: &VeloraLibraryManifest,
) -> crate::playnite_library::PlayniteLibrarySnapshot {
    use crate::playnite_library::{PlayniteGame, PlayniteLibrarySnapshot};
    PlayniteLibrarySnapshot {
        source: MANIFEST_SOURCE.to_string(),
        available: true,
        reason: None,
        games: manifest
            .games
            .iter()
            .map(|game| PlayniteGame {
                id: game.id.clone(),
                name: game.name.clone(),
                cover: game.cover.clone(),
                source: game.source.clone(),
                last_played: game.last_played.clone(),
            })
            .collect(),
        read_only: true,
    }
}

/* ------------------------------------------------------------------------- *
 * Bogatszy, typowany widok dla nowej komendy `get_playnite_manifest`.
 * ------------------------------------------------------------------------- */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestGameView {
    pub id: String,
    pub name: String,
    pub cover: Option<String>,
    pub source: String,
    pub last_played: Option<String>,
    pub favorite: bool,
    pub installed: bool,
    pub play_count: u64,
    pub playtime_seconds: u64,
    pub launch: Option<ManifestLaunch>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayniteManifestView {
    pub schema_version: i64,
    pub generated_at: String,
    pub source: String,
    pub read_only: bool,
    pub game_count: usize,
    pub games: Vec<ManifestGameView>,
    pub diagnostics: Vec<String>,
}

pub fn manifest_view(manifest: &VeloraLibraryManifest) -> PlayniteManifestView {
    PlayniteManifestView {
        schema_version: manifest.schema_version,
        generated_at: manifest.generated_at.clone(),
        source: manifest.source.clone(),
        read_only: manifest.read_only,
        game_count: manifest.games.len(),
        games: manifest
            .games
            .iter()
            .map(|game| ManifestGameView {
                id: game.id.clone(),
                name: game.name.clone(),
                cover: game.cover.clone(),
                source: game.source.clone(),
                last_played: game.last_played.clone(),
                favorite: game.favorite,
                installed: game.installed,
                play_count: game.play_count,
                playtime_seconds: game.playtime_seconds,
                launch: game.launch.clone(),
            })
            .collect(),
        diagnostics: Vec::new(),
    }
}

#[tauri::command]
pub fn get_playnite_manifest() -> Result<PlayniteManifestView, String> {
    read_default_manifest()
        .map(|manifest| manifest_view(&manifest))
        .map_err(|error| error.user_message())
}

/* ------------------------------------------------------------------------- *
 * Testy: WSZYSTKIE czyste (bez API Windows, bez sieci). Jeden test integracyjny
 * używa `std::env::temp_dir()` z unikalną nazwą i sprzątaniem przez `Drop`.
 * ------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_MANIFEST: &str = r#"{
      "schemaVersion": 1,
      "kind": "velora.playnite.library-manifest",
      "generatedAt": "2026-11-12T00:00:00Z",
      "extension": { "id": "velora-library-exporter", "version": "1.0.0" },
      "source": "playnite-api",
      "readOnly": true,
      "games": [
        {
          "id": "64f78cd1-0b00-4271-a9e1-89abc55f66cc",
          "name": "Example Game",
          "cover": "data:image/png;base64,iVBORw0KGgo=",
          "source": "Steam",
          "lastPlayed": "2026-11-10T18:22:00Z",
          "favorite": true,
          "installed": true,
          "playCount": 12,
          "playtimeSeconds": 36000,
          "launch": {
            "kind": "playnite-uri",
            "uri": "playnite://playnite/start/64f78cd1-0b00-4271-a9e1-89abc55f66cc"
          }
        }
      ]
    }"#;

    const GAME_ID: &str = "64f78cd1-0b00-4271-a9e1-89abc55f66cc";
    const LAUNCH_URI: &str =
        "playnite://playnite/start/64f78cd1-0b00-4271-a9e1-89abc55f66cc";

    fn valid_value() -> serde_json::Value {
        serde_json::from_str(VALID_MANIFEST).expect("VALID_MANIFEST is valid JSON")
    }

    fn to_bytes(value: &serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(value).expect("value serializes to JSON")
    }

    fn parse(value: &serde_json::Value) -> Result<VeloraLibraryManifest, ManifestError> {
        parse_manifest(&to_bytes(value))
    }

    fn with_game_field(key: &str, value: serde_json::Value) -> serde_json::Value {
        let mut manifest = valid_value();
        let mut game = manifest["games"][0].clone();
        game[key] = value;
        manifest["games"] = serde_json::Value::Array(vec![game]);
        manifest
    }

    fn with_launch_field(field: &str, value: serde_json::Value) -> serde_json::Value {
        let mut manifest = valid_value();
        let mut game = manifest["games"][0].clone();
        let mut launch = game["launch"].clone();
        launch[field] = value;
        game["launch"] = launch;
        manifest["games"] = serde_json::Value::Array(vec![game]);
        manifest
    }

    #[test]
    fn valid_manifest_parses_and_snapshot_is_real() {
        let manifest = parse_manifest(VALID_MANIFEST.as_bytes()).expect("valid manifest parses");
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.games.len(), 1);

        let snapshot = snapshot_from_manifest(&manifest);
        assert_eq!(snapshot.source, "playnite-api");
        assert!(snapshot.available);
        assert!(snapshot.read_only);
        assert!(snapshot.reason.is_none());
        assert_eq!(snapshot.games.len(), 1);
        assert_eq!(snapshot.games[0].id, GAME_ID);
        assert_eq!(snapshot.games[0].name, "Example Game");
        assert_eq!(
            snapshot.games[0].cover.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgo=")
        );
        assert_eq!(snapshot.games[0].source, "Steam");
        assert_eq!(
            snapshot.games[0].last_played.as_deref(),
            Some("2026-11-10T18:22:00Z")
        );
    }

    #[test]
    fn malformed_json_is_rejected() {
        assert!(matches!(
            parse_manifest(b"{not json"),
            Err(ManifestError::InvalidJson)
        ));
        assert!(matches!(
            parse_manifest(b""),
            Err(ManifestError::InvalidJson)
        ));
        assert!(matches!(
            parse_manifest(b"[]"),
            Err(ManifestError::InvalidJson)
        ));
    }

    #[test]
    fn unsupported_schema_versions_are_rejected() {
        for version in [0i64, 2, 999, -1] {
            let mut value = valid_value();
            value["schemaVersion"] = serde_json::json!(version);
            assert!(
                matches!(
                    parse(&value),
                    Err(ManifestError::UnsupportedSchemaVersion(found)) if found == version
                ),
                "schemaVersion {version} must be rejected"
            );
        }
    }

    #[test]
    fn wrong_kind_is_rejected() {
        let mut value = valid_value();
        value["kind"] = serde_json::json!("velora.playnite.something-else");
        assert!(matches!(parse(&value), Err(ManifestError::InvalidKind)));
    }

    #[test]
    fn read_only_false_is_rejected() {
        let mut value = valid_value();
        value["readOnly"] = serde_json::json!(false);
        assert!(matches!(
            parse(&value),
            Err(ManifestError::ReadOnlyRequired)
        ));
    }

    #[test]
    fn wrong_source_is_rejected() {
        let mut value = valid_value();
        value["source"] = serde_json::json!("steam-api");
        assert!(matches!(
            parse(&value),
            Err(ManifestError::InvalidSource)
        ));
    }

    #[test]
    fn bad_generated_at_is_rejected() {
        let bad = [
            "".to_string(),
            "2026-11-12".to_string(),
            "2026-11-12T00:00:00".to_string(),
            "2026-11-12T00:00:00+01:00".to_string(),
            "not-a-date".to_string(),
            format!("2026-11-12T00:00:00Z{}", "0".repeat(50)),
        ];
        for generated in bad {
            let mut value = valid_value();
            value["generatedAt"] = serde_json::json!(generated);
            assert!(
                matches!(parse(&value), Err(ManifestError::InvalidGeneratedAt)),
                "generatedAt {generated:?} must be rejected"
            );
        }
        assert!(is_iso_utc("2026-11-12T00:00:00.123Z"));
    }

    #[test]
    fn bad_extension_is_rejected() {
        let mut value = valid_value();
        value["extension"] = serde_json::json!({ "id": "evil-exporter", "version": "1.0.0" });
        assert!(matches!(
            parse(&value),
            Err(ManifestError::InvalidExtension)
        ));

        let mut value = valid_value();
        value["extension"] = serde_json::json!({ "id": "velora-library-exporter", "version": "" });
        assert!(matches!(
            parse(&value),
            Err(ManifestError::InvalidExtension)
        ));

        let mut value = valid_value();
        let mut extension = serde_json::Map::new();
        extension.insert(
            "id".to_string(),
            serde_json::Value::String("velora-library-exporter".to_string()),
        );
        extension.insert(
            "version".to_string(),
            serde_json::Value::String("x".repeat(33)),
        );
        value["extension"] = serde_json::Value::Object(extension);
        assert!(matches!(
            parse(&value),
            Err(ManifestError::InvalidExtension)
        ));
    }

    #[test]
    fn too_many_games_is_rejected() {
        let one = serde_json::json!({
            "id": GAME_ID,
            "name": "G",
            "cover": null,
            "source": "S",
            "lastPlayed": null,
            "favorite": false,
            "installed": false,
            "launch": null,
        });
        let games: Vec<serde_json::Value> = (0..10_001).map(|_| one.clone()).collect();
        let mut value = valid_value();
        value["games"] = serde_json::json!(games);
        assert!(matches!(parse(&value), Err(ManifestError::TooManyGames)));
    }

    #[test]
    fn null_cover_is_accepted_as_none() {
        let value = with_game_field("cover", serde_json::Value::Null);
        let manifest = parse(&value).expect("null cover is valid");
        assert!(manifest.games[0].cover.is_none());
        let snapshot = snapshot_from_manifest(&manifest);
        assert!(snapshot.games[0].cover.is_none());
    }

    #[test]
    fn unsafe_covers_are_rejected() {
        let bad_covers = [
            "javascript:alert(1)",
            "file:///C:/games/cover.png",
            "http://example.com/cover.png",
            "https://cdn.example.com/cover.png",
            "data:text/html;base64,AAAA",
            "data:image/svg+xml;base64,AAAA",
            "data:image/png;base64,",
            "data:image/png;base64,@@@@",
            "data:image/png;base64,AAAA ",
            "data:image/png;base64,AAAA with space",
            "data:image/png;base64,AA=A",
            "data:image/png;base64,AAAA===",
            "data:image/png;base64,AAAA\"",
            "data:image/png;base64,AAAA\n",
            "",
        ];
        for cover in bad_covers {
            let value = with_game_field("cover", serde_json::json!(cover));
            assert!(
                matches!(parse(&value), Err(ManifestError::InvalidGame(_))),
                "cover must be rejected: {cover:?}"
            );
        }
    }

    #[test]
    fn valid_covers_are_accepted() {
        let good_covers = [
            "data:image/png;base64,iVBORw0KGgo=",
            "data:image/jpeg;base64,/9j/4AA=",
            "data:image/webp;base64,UklGRg==",
            "data:image/gif;base64,R0lGODlh",
        ];
        for cover in good_covers {
            let value = with_game_field("cover", serde_json::json!(cover));
            let manifest = parse(&value).expect("valid cover must parse");
            assert_eq!(manifest.games[0].cover.as_deref(), Some(cover));
        }
    }

    #[test]
    fn oversized_cover_is_rejected() {
        let huge = format!("data:image/png;base64,{}", "A".repeat(2_000_001));
        let value = with_game_field("cover", serde_json::json!(huge));
        assert!(matches!(
            parse(&value),
            Err(ManifestError::InvalidGame(_))
        ));
    }

    #[test]
    fn invalid_game_ids_are_rejected() {
        let bad_ids = [
            "",
            "not-a-guid",
            "64f78cd1-0b00-4271-a9e1-89abc55f66c",
            "64f78cd1-0b00-4271-a9e1-89abc55f66ccc",
            "64f7..cd1-0b00-4271-a9e1-89abc55f66cc",
            "zzzzzzzz-0b00-4271-a9e1-89abc55f66cc",
            "64f78cd1-0b00-4271-a9e1-89abc55f66cc\u{0007}",
        ];
        for id in bad_ids {
            let value = with_game_field("id", serde_json::json!(id));
            assert!(
                matches!(parse(&value), Err(ManifestError::InvalidGame(_))),
                "id must be rejected: {id:?}"
            );
        }
        // Brak pola id → odrzucenie (deserializacja lub walidacja).
        let mut value = valid_value();
        let mut game = value["games"][0].clone();
        game.as_object_mut().unwrap().remove("id");
        value["games"] = serde_json::Value::Array(vec![game]);
        assert!(parse(&value).is_err());
    }

    #[test]
    fn duplicate_game_ids_are_rejected() {
        let mut value = valid_value();
        let game = value["games"][0].clone();
        value["games"] = serde_json::Value::Array(vec![game.clone(), game]);
        assert!(matches!(
            parse(&value),
            Err(ManifestError::DuplicateGameId(_))
        ));
    }

    #[test]
    fn launch_uri_injection_is_rejected() {
        let bad_uris = [
            "file:///C:/x.exe",
            "playnite://playnite/start/64f78cd1-0b00-4271-a9e1-89abc55f66cd",
            "https://evil.example.com/start",
            "playnite://playnite/start/64f78cd1-0b00-4271-a9e1-89abc55f66cc --kiosk",
            "javascript:alert(1)",
            "",
        ];
        for uri in bad_uris {
            let value = with_launch_field("uri", serde_json::json!(uri));
            assert!(
                matches!(parse(&value), Err(ManifestError::InvalidGame(_))),
                "launch uri must be rejected: {uri:?}"
            );
        }
        let value = with_launch_field("kind", serde_json::json!("file"));
        assert!(matches!(
            parse(&value),
            Err(ManifestError::InvalidGame(_))
        ));
    }

    #[test]
    fn exact_launch_uri_is_accepted() {
        let manifest = parse_manifest(VALID_MANIFEST.as_bytes()).expect("valid");
        let launch = manifest.games[0].launch.as_ref().expect("launch present");
        assert_eq!(launch.kind, LAUNCH_KIND);
        assert_eq!(launch.uri, LAUNCH_URI);
    }

    #[test]
    fn invalid_paths_are_rejected() {
        let invalid = [
            "".to_string(),
            "relative/dir".to_string(),
            "../escape".to_string(),
            "/tmp/../etc".to_string(),
            "/tmp/\0evil".to_string(),
            format!("/tmp/\u{0007}evil"),
            format!("/{}", "a".repeat(1030)),
        ];
        for path in invalid {
            assert!(
                matches!(resolve_manifest_path(&path), Err(ManifestError::InvalidPath)),
                "path must be rejected: {path:?}"
            );
        }
    }

    #[test]
    fn valid_path_resolves_to_manifest_file() {
        let base = if cfg!(target_os = "windows") {
            "C:\\Users\\velora\\AppData\\Local"
        } else {
            "/tmp/velora-localappdata"
        };
        let path = resolve_manifest_path(base).expect("absolute base resolves");
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("velora-library-manifest.json")
        );
        let rendered = path.to_string_lossy();
        assert!(rendered.contains("VELORA"));
        assert!(rendered.contains("Playnite"));
    }

    #[test]
    fn classify_io_error_maps_kinds() {
        assert_eq!(
            classify_io_error(std::io::ErrorKind::NotFound),
            ManifestError::IoNotFound
        );
        assert_eq!(
            classify_io_error(std::io::ErrorKind::PermissionDenied),
            ManifestError::IoPermission
        );
        assert_eq!(
            classify_io_error(std::io::ErrorKind::InvalidData),
            ManifestError::IoOther
        );
    }

    #[test]
    fn codes_are_stable() {
        assert_eq!(ManifestError::IoNotFound.code(), "file-access");
        assert_eq!(ManifestError::TooLarge.code(), "file-access");
        assert_eq!(ManifestError::InvalidJson.code(), "invalid-manifest");
        assert_eq!(
            ManifestError::DuplicateGameId("x".to_string()).code(),
            "invalid-manifest"
        );
        assert_eq!(ManifestError::InvalidPath.code(), "invalid-path");
        assert_eq!(ManifestError::NonWindows.code(), "unavailable");
    }

    #[test]
    fn user_messages_are_clean_and_never_leak_payloads() {
        let errors = [
            ManifestError::IoNotFound,
            ManifestError::IoPermission,
            ManifestError::IoOther,
            ManifestError::TooLarge,
            ManifestError::InvalidJson,
            ManifestError::UnsupportedSchemaVersion(999),
            ManifestError::InvalidKind,
            ManifestError::ReadOnlyRequired,
            ManifestError::InvalidSource,
            ManifestError::InvalidGeneratedAt,
            ManifestError::InvalidExtension,
            ManifestError::TooManyGames,
            ManifestError::InvalidGame("C:\\Users\\secret\\game.db / os error 5".to_string()),
            ManifestError::DuplicateGameId("0xDEADBEEF Error: leak".to_string()),
            ManifestError::InvalidPath,
            ManifestError::NonWindows,
        ];
        for error in &errors {
            let message = error.user_message();
            assert!(!message.is_empty());
            assert!(!message.contains("Error:"), "{message}");
            assert!(!message.contains("0x"), "{message}");
            assert!(!message.contains("os error"), "{message}");
            assert!(!message.contains("C:"), "{message}");
            assert!(!message.contains("secret"), "{message}");
            assert!(!message.contains(".db"), "{message}");
            assert!(!message.contains("DEADBEEF"), "{message}");
            assert!(!error.code().is_empty());
        }
    }

    #[test]
    fn read_manifest_from_disk_roundtrip_and_missing_file() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();

        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }

        let file = std::env::temp_dir()
            .join(format!("velora-manifest-test-{pid}-{sequence}.json"));
        let _guard = Cleanup(file.clone());
        std::fs::write(&file, VALID_MANIFEST.as_bytes()).expect("write temp manifest");
        let manifest = read_manifest_from(&file).expect("read valid manifest");
        assert_eq!(manifest.games.len(), 1);
        assert_eq!(manifest.source, "playnite-api");

        let missing = std::env::temp_dir()
            .join(format!("velora-manifest-missing-{pid}-{sequence}.json"));
        let _missing_guard = Cleanup(missing.clone());
        assert!(matches!(
            read_manifest_from(&missing),
            Err(ManifestError::IoNotFound)
        ));
    }

    #[test]
    fn empty_manifest_snapshot_never_invents_games() {
        let mut value = valid_value();
        value["games"] = serde_json::Value::Array(Vec::new());
        let manifest = parse(&value).expect("empty games array is valid");
        let snapshot = snapshot_from_manifest(&manifest);
        assert_eq!(snapshot.source, "playnite-api");
        assert!(snapshot.available);
        assert!(snapshot.read_only);
        assert!(snapshot.reason.is_none());
        assert!(snapshot.games.is_empty());
        let view = manifest_view(&manifest);
        assert_eq!(view.game_count, 0);
        assert!(view.games.is_empty());
    }

    #[test]
    fn manifest_view_exposes_richer_typed_fields() {
        let manifest = parse_manifest(VALID_MANIFEST.as_bytes()).expect("valid");
        let view = manifest_view(&manifest);
        assert_eq!(view.schema_version, 1);
        assert_eq!(view.generated_at, "2026-11-12T00:00:00Z");
        assert_eq!(view.source, "playnite-api");
        assert!(view.read_only);
        assert_eq!(view.game_count, 1);
        assert_eq!(view.games.len(), 1);
        let game = &view.games[0];
        assert_eq!(game.id, GAME_ID);
        assert!(game.favorite);
        assert!(game.installed);
        assert_eq!(game.play_count, 12);
        assert_eq!(game.playtime_seconds, 36000);
        assert_eq!(game.launch.as_ref().map(|l| l.uri.as_str()), Some(LAUNCH_URI));

        let json = serde_json::to_value(&view).expect("view serializes");
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["gameCount"], 1);
        assert_eq!(json["games"][0]["playCount"], 12);
        assert_eq!(json["games"][0]["lastPlayed"], "2026-11-10T18:22:00Z");
    }

    #[test]
    fn now_timestamp_is_valid_iso_utc() {
        let timestamp = now_timestamp();
        assert!(
            is_iso_utc(&timestamp),
            "now_timestamp must be ISO-8601 UTC: {timestamp}"
        );
    }

    #[test]
    fn known_epochs_format_correctly() {
        assert_eq!(format_utc_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc_timestamp(86_400), "1970-01-02T00:00:00Z");
    }

    #[test]
    fn negative_or_fractional_counters_are_rejected_by_serde() {
        let value = with_game_field("playCount", serde_json::json!(-1));
        assert!(matches!(parse(&value), Err(ManifestError::InvalidJson)));

        let value = with_game_field("playtimeSeconds", serde_json::json!(1.5));
        assert!(matches!(parse(&value), Err(ManifestError::InvalidJson)));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn default_manifest_is_unavailable_off_windows() {
        match read_default_manifest() {
            Ok(_) => panic!("off-Windows must not read or invent a real manifest"),
            Err(error) => {
                assert_eq!(error, ManifestError::NonWindows);
                assert!(!error.user_message().is_empty());
            }
        }
    }
}
