#[cfg(windows)]
use crate::credential_store::{CredentialStore, CredentialStoreError, WindowsCredentialStore};
#[cfg(windows)]
use crate::remote_state_lock::{
    default_lock_path, FileStateLock, StateLock, StateLockError, StateLockGuard,
    UnavailableStateLock,
};
#[cfg(windows)]
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::State;

use crate::remote_reliability::{classify_replay, CommandReceiptLog, ReplayDecision};

#[cfg(windows)]
const REMOTE_PORT: u16 = 47862;
const PAIRING_TTL: Duration = Duration::from_secs(60);
const PAIRING_WINDOW: Duration = Duration::from_secs(300);
const PAIRING_ATTEMPTS: u32 = 5;
const COMMAND_WINDOW: Duration = Duration::from_secs(1);
const COMMANDS_PER_WINDOW: u32 = 20;
const MAX_PAIRED_DEVICES: usize = 8;
#[cfg(windows)]
const MAX_REQUEST_BYTES: usize = 4096;
#[cfg(windows)]
const CREDENTIAL_SERVICE: &str = "com.nexus.aurea.remote";
#[cfg(windows)]
const CA_CERT_ACCOUNT: &str = "trust-ca-cert-v2";
#[cfg(windows)]
const CA_KEY_ACCOUNT: &str = "trust-ca-key-v2";
#[cfg(windows)]
const DEVICE_INDEX_ACCOUNT: &str = "device-index-v2";
#[cfg(windows)]
const DEVICE_INDEX_VERSION: u8 = 2;
/// Present only while a user-initiated recovery is unfinished. While it exists
/// the store stays closed, so a half-reset trust set can never be used.
#[cfg(windows)]
const RECOVERY_JOURNAL_ACCOUNT: &str = "recovery-journal-v1";
#[cfg(windows)]
const RECOVERY_JOURNAL_VERSION: u8 = 1;
/// How long a remote command waits for another VELORA process that is writing
/// the credential state. A busy or unavailable lock rejects the command.
#[cfg(windows)]
const COMMAND_LOCK_WAIT: Duration = Duration::from_millis(2500);
/// Wait used by user-initiated operations from the local UI.
#[cfg(windows)]
const UI_LOCK_WAIT: Duration = Duration::from_secs(5);
/// Wait used by read-only status refreshes so the UI never stalls.
#[cfg(windows)]
const STATUS_LOCK_WAIT: Duration = Duration::from_millis(150);
#[cfg(windows)]
const RECOVERY_CONFIRMATION_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteCommand {
    Up,
    Down,
    Left,
    Right,
    Select,
    Back,
    Home,
    VolumeUp,
    VolumeDown,
    Mute,
    ProfileCinema,
    ProfileGaming,
    ProfileDesktop,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeviceSummary {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub enabled: bool,
    pub secure_origin_available: bool,
    pub pairing_available: bool,
    pub paired_device_count: usize,
    pub paired_devices: Vec<RemoteDeviceSummary>,
    pub origin: Option<String>,
    pub ca_fingerprint: Option<String>,
    pub trust_profile_path: Option<String>,
    pub pairing_code: Option<String>,
    pub pairing_expires_in_seconds: u64,
    /// `unknown`, `ok`, `unavailable`, `locked`, `damaged`, `rolled-back` or
    /// `recovery-pending`. Distinguishes an unreadable or damaged credential
    /// store from simply having no paired devices.
    pub store_state: String,
    pub store_message: Option<String>,
    /// True when only the local, user-initiated recovery can restore the store.
    pub recovery_required: bool,
}

impl Default for RemoteAccessStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            secure_origin_available: false,
            pairing_available: false,
            paired_device_count: 0,
            paired_devices: Vec::new(),
            origin: None,
            ca_fingerprint: None,
            trust_profile_path: None,
            pairing_code: None,
            pairing_expires_in_seconds: 0,
            store_state: "unknown".into(),
            store_message: None,
            recovery_required: false,
        }
    }
}

#[derive(Clone)]
struct PairedDevice {
    id: String,
    name: String,
    token: String,
    last_sequence: u64,
}

#[derive(Clone, Default)]
struct Vault {
    ca_cert_pem: Option<String>,
    ca_key_pem: Option<String>,
    devices: Vec<PairedDevice>,
    /// Monotonic generation of the stored device index. Every committed change
    /// raises it, so a store that goes backwards while this process runs is
    /// detected instead of being trusted.
    revision: u64,
    /// The exact stored index text this vault was read from or last wrote.
    index_json: Option<String>,
}

#[cfg(windows)]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIndex {
    version: u8,
    #[serde(default)]
    revision: u64,
    devices: Vec<DeviceIndexRecord>,
}

#[cfg(windows)]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryJournal {
    version: u8,
    mode: String,
    #[serde(default)]
    device_ids: Vec<String>,
}

/// Why the credential state cannot be used.
#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoreFault {
    /// Credential Manager itself failed. Nothing is known about the contents,
    /// so no destructive recovery is offered.
    Unavailable,
    /// Another VELORA process holds the state lock, or the lock cannot exist.
    Locked,
    /// Index, token or metadata is unreadable or inconsistent.
    IndexDamaged,
    /// CA certificate or key is missing, malformed, expired or mismatched.
    CaDamaged,
    /// The stored state went backwards while this process was running.
    RolledBack,
    /// A user-initiated recovery started and has not finished.
    RecoveryPending,
}

#[cfg(windows)]
#[derive(Clone, Debug)]
struct VaultError {
    fault: StoreFault,
    message: String,
}

#[cfg(windows)]
impl VaultError {
    fn new(fault: StoreFault, message: impl Into<String>) -> Self {
        Self {
            fault,
            message: message.into(),
        }
    }

    fn status(&self) -> StatusCode {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

#[cfg(windows)]
impl std::fmt::Display for VaultError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[cfg(windows)]
impl From<VaultError> for String {
    fn from(error: VaultError) -> Self {
        error.message
    }
}

#[cfg(windows)]
impl StoreFault {
    fn state_name(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Locked => "locked",
            Self::IndexDamaged | Self::CaDamaged => "damaged",
            Self::RolledBack => "rolled-back",
            Self::RecoveryPending => "recovery-pending",
        }
    }

    fn recovery_required(self) -> bool {
        matches!(
            self,
            Self::IndexDamaged | Self::CaDamaged | Self::RolledBack | Self::RecoveryPending
        )
    }
}

/// Which stored entries a recovery removes. Both modes only touch VELORA's own
/// remote-access entries and never rotate or delete anything automatically.
#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryMode {
    /// Revoke every paired device and keep the CA (no new iPhone profile needed).
    RevokeAllDevices,
    /// Also delete the CA certificate and key. A new CA is created only when the
    /// user later prepares a trust profile, which must be installed on the iPhone.
    ResetTrust,
}

#[cfg(windows)]
impl RecoveryMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::RevokeAllDevices => "revoke-all-devices",
            Self::ResetTrust => "reset-trust",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "revoke-all-devices" => Some(Self::RevokeAllDevices),
            "reset-trust" => Some(Self::ResetTrust),
            _ => None,
        }
    }

    /// The broader mode wins when a journal and a new request disagree.
    fn merge(self, other: Self) -> Self {
        if self == Self::ResetTrust || other == Self::ResetTrust {
            Self::ResetTrust
        } else {
            Self::RevokeAllDevices
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOption {
    pub mode: String,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRecoveryPlan {
    pub store_state: String,
    pub message: Option<String>,
    pub recovery_required: bool,
    pub options: Vec<RecoveryOption>,
    /// One-time code the local UI must send back to run a recovery.
    pub confirmation: String,
    pub confirmation_expires_in_seconds: u64,
}

#[cfg(windows)]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIndexRecord {
    id: String,
    name: String,
    last_sequence: u64,
}

struct PairingCode {
    value: String,
    expires_at: Instant,
}

struct RateBucket {
    started_at: Instant,
    count: u32,
}

struct RemoteInner {
    status: Mutex<RemoteAccessStatus>,
    pairing: Mutex<Option<PairingCode>>,
    #[cfg(windows)]
    server: Mutex<Option<axum_server::Handle>>,
    #[cfg(windows)]
    vault: Mutex<Vault>,
    #[cfg(windows)]
    vault_loaded: Mutex<bool>,
    #[cfg(windows)]
    credential_store: Arc<dyn CredentialStore>,
    /// Cross-process lock: held across re-read, validation and write of the
    /// credential state. `vault` below is only a cache for display and for
    /// cheap pre-checks; no security decision is taken from it alone.
    #[cfg(windows)]
    state_lock: Arc<dyn StateLock>,
    #[cfg(windows)]
    store_health: Mutex<Option<VaultError>>,
    #[cfg(windows)]
    recovery_confirmation: Mutex<Option<(String, Instant)>>,
    pair_attempts: Mutex<HashMap<IpAddr, RateBucket>>,
    command_attempts: Mutex<HashMap<String, RateBucket>>,
    /// Successful command receipts for exact duplicate acknowledgement. Bounded
    /// and in-memory; never contains a token or signature.
    command_receipts: Mutex<CommandReceiptLog>,
    /// Serializes the whole command transaction for one server process. A
    /// sequence is reserved before its side effect, and a parallel duplicate
    /// waits here instead of observing an "in flight" sequence as an attack.
    #[cfg(windows)]
    command_gate: Mutex<()>,
}

impl RemoteInner {
    #[cfg(windows)]
    fn with_credential_store(
        credential_store: Arc<dyn CredentialStore>,
        state_lock: Arc<dyn StateLock>,
    ) -> Self {
        Self {
            status: Mutex::new(RemoteAccessStatus::default()),
            pairing: Mutex::new(None),
            server: Mutex::new(None),
            vault: Mutex::new(Vault::default()),
            vault_loaded: Mutex::new(false),
            credential_store,
            state_lock,
            store_health: Mutex::new(None),
            recovery_confirmation: Mutex::new(None),
            pair_attempts: Mutex::new(HashMap::new()),
            command_attempts: Mutex::new(HashMap::new()),
            command_receipts: Mutex::new(CommandReceiptLog::default()),
            command_gate: Mutex::new(()),
        }
    }
}

#[cfg(windows)]
impl Default for RemoteInner {
    fn default() -> Self {
        // Without a lock file location the state lock cannot exist and every
        // state operation fails closed; it never runs unprotected.
        let state_lock: Arc<dyn StateLock> = match default_lock_path(CREDENTIAL_SERVICE) {
            Some(path) => Arc::new(FileStateLock::new(path)),
            None => Arc::new(UnavailableStateLock),
        };
        Self::with_credential_store(
            Arc::new(WindowsCredentialStore::new(CREDENTIAL_SERVICE)),
            state_lock,
        )
    }
}

#[cfg(not(windows))]
impl Default for RemoteInner {
    fn default() -> Self {
        Self {
            status: Mutex::new(RemoteAccessStatus::default()),
            pairing: Mutex::new(None),
            pair_attempts: Mutex::new(HashMap::new()),
            command_attempts: Mutex::new(HashMap::new()),
            command_receipts: Mutex::new(CommandReceiptLog::default()),
        }
    }
}

#[derive(Clone, Default)]
pub struct RemoteAccess {
    inner: Arc<RemoteInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn remote_command_payload(device_id: &str, sequence: u64, command: &RemoteCommand) -> String {
    format!(
        "NEXUS-AUREA-REMOTE-V1\n{device_id}\n{sequence}\n{}",
        command.as_str()
    )
}

impl RemoteCommand {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
            Self::Select => "select",
            Self::Back => "back",
            Self::Home => "home",
            Self::VolumeUp => "volume-up",
            Self::VolumeDown => "volume-down",
            Self::Mute => "mute",
            Self::ProfileCinema => "profile-cinema",
            Self::ProfileGaming => "profile-gaming",
            Self::ProfileDesktop => "profile-desktop",
        }
    }
}

fn verify_command_signature(
    token: &[u8],
    device_id: &str,
    sequence: u64,
    command: &RemoteCommand,
    signature: &[u8],
) -> bool {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(token) else {
        return false;
    };
    mac.update(remote_command_payload(device_id, sequence, command).as_bytes());
    mac.verify_slice(signature).is_ok()
}

fn is_allowed_request(
    host: Option<&str>,
    origin: Option<&str>,
    method: &str,
    path: &str,
    expected_host: &str,
    expected_origin: &str,
) -> bool {
    if host != Some(expected_host) {
        return false;
    }
    if path.starts_with("/api/") && method != "GET" {
        return origin == Some(expected_origin);
    }
    true
}

impl RemoteAccess {
    #[cfg(windows)]
    fn with_credential_store(
        credential_store: Arc<dyn CredentialStore>,
        state_lock: Arc<dyn StateLock>,
    ) -> Self {
        Self {
            inner: Arc::new(RemoteInner::with_credential_store(
                credential_store,
                state_lock,
            )),
        }
    }

    /// Status for the local UI. Refreshes the cache from the credential store
    /// (bounded wait) so changes made by another VELORA process become visible.
    pub fn status(&self) -> RemoteAccessStatus {
        #[cfg(windows)]
        {
            let _ = self.refresh_cache(STATUS_LOCK_WAIT);
        }
        self.status_cached()
    }

    /// Status built only from memory. Used by the unauthenticated LAN status
    /// endpoint so that a network client can never cause credential-store I/O.
    pub fn status_cached(&self) -> RemoteAccessStatus {
        #[cfg(windows)]
        {
            let vault = lock(&self.inner.vault);
            let health = lock(&self.inner.store_health).clone();
            let mut status = lock(&self.inner.status);
            status.paired_devices = vault
                .devices
                .iter()
                .map(|device| RemoteDeviceSummary {
                    id: device.id.clone(),
                    name: device.name.clone(),
                })
                .collect();
            status.paired_device_count = vault.devices.len();
            match health {
                Some(error) => {
                    status.store_state = error.fault.state_name().into();
                    status.store_message = Some(error.message);
                    status.recovery_required = error.fault.recovery_required();
                }
                None if *lock(&self.inner.vault_loaded) => {
                    status.store_state = "ok".into();
                    status.store_message = None;
                    status.recovery_required = false;
                }
                None => {}
            }
        }
        let mut status = lock(&self.inner.status).clone();
        if let Some(pairing) = lock(&self.inner.pairing).as_ref() {
            if let Some(remaining) = pairing.expires_at.checked_duration_since(Instant::now()) {
                status.pairing_code = Some(pairing.value.clone());
                status.pairing_expires_in_seconds = remaining.as_secs().saturating_add(1);
            } else {
                status.pairing_code = None;
                status.pairing_expires_in_seconds = 0;
            }
        } else {
            status.pairing_code = None;
            status.pairing_expires_in_seconds = 0;
        }
        status
    }

    pub fn begin_pairing(&self) -> Result<RemoteAccessStatus, String> {
        #[cfg(not(windows))]
        return Err("Serwer iPhone Remote działa wyłącznie na MSI z Windows.".into());
        #[cfg(windows)]
        {
            if !lock(&self.inner.status).enabled {
                return Err("Najpierw włącz bezpieczny serwer HTTPS.".into());
            }
            use rand::Rng;
            let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000));
            *lock(&self.inner.pairing) = Some(PairingCode {
                value: code,
                expires_at: Instant::now() + PAIRING_TTL,
            });
            Ok(self.status())
        }
    }

    pub fn stop(&self) -> RemoteAccessStatus {
        *lock(&self.inner.pairing) = None;
        #[cfg(windows)]
        if let Some(handle) = lock(&self.inner.server).take() {
            handle.graceful_shutdown(Some(Duration::from_secs(2)));
        }
        *lock(&self.inner.status) = RemoteAccessStatus::default();
        self.status()
    }

    #[cfg(windows)]
    fn note_store_health(&self, outcome: Result<(), &VaultError>) {
        *lock(&self.inner.store_health) = outcome.err().cloned();
    }

    /// Takes the cross-process lock and reads the credential state again while
    /// holding it. This is the only way state used for a security decision or a
    /// write is obtained: a stale cache is never written back.
    #[cfg(windows)]
    fn locked_fresh(&self, wait: Duration) -> Result<(StateLockGuard, Vault), VaultError> {
        let guard = match self.inner.state_lock.acquire(wait) {
            Ok(guard) => guard,
            Err(error) => {
                let error = lock_error(error);
                self.note_store_health(Err(&error));
                return Err(error);
            }
        };
        match self.read_verified() {
            Ok(fresh) => {
                self.note_store_health(Ok(()));
                Ok((guard, fresh))
            }
            Err(error) => {
                self.note_store_health(Err(&error));
                Err(error)
            }
        }
    }

    /// Reads the stored state and checks it against what this process last
    /// verified. The caller must hold the state lock.
    #[cfg(windows)]
    fn read_verified(&self) -> Result<Vault, VaultError> {
        let fresh = load_vault(self.inner.credential_store.as_ref())?;
        if *lock(&self.inner.vault_loaded) {
            detect_rollback(&lock(&self.inner.vault), &fresh)?;
        }
        Ok(fresh)
    }

    /// Replaces the cache with a state that was just committed or verified
    /// under the lock.
    #[cfg(windows)]
    fn publish(&self, vault: &Vault) {
        *lock(&self.inner.vault) = vault.clone();
        *lock(&self.inner.vault_loaded) = true;
    }

    #[cfg(windows)]
    fn refresh_cache(&self, wait: Duration) -> Result<(), VaultError> {
        let (_guard, fresh) = self.locked_fresh(wait)?;
        self.publish(&fresh);
        Ok(())
    }

    /// Makes sure a valid CA exists and returns it. A CA is generated only when
    /// both the certificate and the key are absent; existing or damaged trust
    /// material is never replaced here (that needs the explicit recovery).
    #[cfg(windows)]
    fn ensure_trust_material(&self) -> Result<(String, String), String> {
        let (_guard, mut vault) = self.locked_fresh(UI_LOCK_WAIT)?;
        if vault.ca_cert_pem.is_none() && vault.ca_key_pem.is_none() {
            let (cert_pem, key_pem) = generate_ca_material()?;
            persist_trust_material(self.inner.credential_store.as_ref(), &cert_pem, &key_pem)?;
            vault.ca_cert_pem = Some(cert_pem);
            vault.ca_key_pem = Some(key_pem);
        }
        let cert = vault
            .ca_cert_pem
            .clone()
            .ok_or("Niekompletny certyfikat zaufania.")?;
        let key = vault
            .ca_key_pem
            .clone()
            .ok_or("Niekompletny certyfikat zaufania.")?;
        self.publish(&vault);
        Ok((cert, key))
    }

    #[cfg(windows)]
    pub fn prepare_trust_profile(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<RemoteAccessStatus, String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use sha2::{Digest, Sha256};
        use std::fs;
        use tauri::Manager;

        let (cert_pem, _) = self.ensure_trust_material()?;
        let cert_der = der_from_pem(&cert_pem)?;
        let fingerprint = Sha256::digest(&cert_der)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let ca_uuid = uuid_from_sha256(&cert_der);
        let profile_uuid = uuid_from_sha256(&[cert_der.as_slice(), b"profile"].concat());
        let profile = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadContent</key><data>{}</data>
<key>PayloadDescription</key><string>Trust VELORA local HTTPS only when you approve this profile.</string>
<key>PayloadDisplayName</key><string>VELORA LAN Remote CA</string>
<key>PayloadIdentifier</key><string>com.nexus.aurea.remote.ca</string>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadUUID</key><string>{}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDisplayName</key><string>VELORA LAN Remote</string>
<key>PayloadIdentifier</key><string>com.nexus.aurea.remote.profile</string>
<key>PayloadRemovalDisallowed</key><false/>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>{}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>"#,
            STANDARD.encode(&cert_der),
            ca_uuid,
            profile_uuid
        );
        let mut profile_path = app
            .path()
            .download_dir()
            .map_err(|_| "Nie można otworzyć folderu Pobrane.".to_string())?;
        fs::create_dir_all(&profile_path)
            .map_err(|_| "Nie można przygotować folderu Pobrane.".to_string())?;
        profile_path.push("VELORA-LAN-Remote.mobileconfig");
        fs::write(&profile_path, profile)
            .map_err(|_| "Nie udało się zapisać profilu zaufania.".to_string())?;
        let mut status = lock(&self.inner.status);
        status.ca_fingerprint = Some(fingerprint);
        status.trust_profile_path = Some(profile_path.to_string_lossy().into_owned());
        Ok(status.clone())
    }

    #[cfg(not(windows))]
    pub fn prepare_trust_profile(
        &self,
        _app: &tauri::AppHandle,
    ) -> Result<RemoteAccessStatus, String> {
        Err("Serwer iPhone Remote działa wyłącznie na MSI z Windows.".into())
    }

    #[cfg(windows)]
    pub async fn start(
        &self,
        app: tauri::AppHandle,
        trust_confirmed: bool,
    ) -> Result<RemoteAccessStatus, String> {
        use axum::{
            middleware,
            routing::{get, post},
            Router,
        };
        use axum_server::tls_rustls::RustlsConfig;
        use rcgen::{
            CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose,
            SanType,
        };
        use std::net::{SocketAddr, TcpListener};
        use tauri::Emitter;
        use time::{Duration as TimeDuration, OffsetDateTime};

        if !trust_confirmed {
            return Err("Zainstaluj profil zaufania na iPhonie i włącz jego pełne zaufanie przed startem serwera.".into());
        }
        if lock(&self.inner.status).enabled {
            return Ok(self.status());
        }
        let prepared = self.prepare_trust_profile(&app)?;
        let fingerprint = prepared
            .ca_fingerprint
            .ok_or("Brak certyfikatu zaufania.")?;
        let (ca_cert, ca_key_pem) = self.ensure_trust_material()?;
        let (ip, host, origin) = local_remote_address()?;
        let (cert_pem, key_pem) = {
            let ca_key = KeyPair::from_pem(&ca_key_pem)
                .map_err(|_| "Nie można odczytać klucza certyfikatu.".to_string())?;
            let issuer_params = CertificateParams::from_ca_cert_pem(&ca_cert)
                .map_err(|_| "Nie można odczytać wystawcy certyfikatu.".to_string())?;
            let issuer = issuer_params
                .self_signed(&ca_key)
                .map_err(|_| "Nie można odtworzyć wystawcy certyfikatu.".to_string())?;
            let now = OffsetDateTime::now_utc();
            let mut leaf_params = CertificateParams::default();
            leaf_params.not_before = now - TimeDuration::minutes(5);
            leaf_params.not_after = now + TimeDuration::days(90);
            leaf_params.subject_alt_names = vec![SanType::IpAddress(IpAddr::V4(ip))];
            leaf_params
                .distinguished_name
                .push(DnType::CommonName, "VELORA LAN Remote");
            leaf_params.is_ca = IsCa::NoCa;
            leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
            leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
            leaf_params.use_authority_key_identifier_extension = true;
            let leaf_key = KeyPair::generate()
                .map_err(|_| "Nie udało się utworzyć certyfikatu HTTPS.".to_string())?;
            let leaf_cert = leaf_params
                .signed_by(&leaf_key, &issuer, &ca_key)
                .map_err(|_| "Nie udało się podpisać certyfikatu HTTPS.".to_string())?;
            (leaf_cert.pem(), leaf_key.serialize_pem())
        };
        let tls = RustlsConfig::from_pem(cert_pem.into_bytes(), key_pem.into_bytes())
            .await
            .map_err(|_| "Nie udało się skonfigurować HTTPS.".to_string())?;
        let address = SocketAddr::new(IpAddr::V4(ip), REMOTE_PORT);
        let listener = TcpListener::bind(address)
            .map_err(|_| "Nie udało się otworzyć portu HTTPS w sieci prywatnej.".to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Nie udało się skonfigurować listenera HTTPS.".to_string())?;

        let context = ServerContext {
            remote: self.clone(),
            app: app.clone(),
            expected_host: host,
            expected_origin: origin.clone(),
        };
        let router = Router::new()
            .route("/", get(remote_index))
            .route("/index.html", get(remote_index))
            .route("/app.js", get(remote_app_js))
            .route("/style.css", get(remote_style))
            .route("/manifest.webmanifest", get(remote_manifest))
            .route("/sw.js", get(remote_service_worker))
            .route("/icon.svg", get(remote_icon))
            .route("/api/status", get(remote_status))
            .route("/api/pair", post(pair_device))
            .route("/api/command", post(send_command))
            .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BYTES))
            .with_state(context.clone())
            .layer(middleware::from_fn_with_state(context, validate_request));
        let handle = axum_server::Handle::new();
        let server = axum_server::from_tcp_rustls(listener, tls)
            .handle(handle.clone())
            .serve(router.into_make_service_with_connect_info::<SocketAddr>());
        {
            let mut status = lock(&self.inner.status);
            status.enabled = true;
            status.secure_origin_available = true;
            status.pairing_available = true;
            status.origin = Some(origin);
            status.ca_fingerprint = Some(fingerprint);
            status.trust_profile_path = prepared.trust_profile_path;
        }
        *lock(&self.inner.server) = Some(handle);
        let remote = self.clone();
        let app_for_task = app.clone();
        tauri::async_runtime::spawn(async move {
            if server.await.is_err() {
                let _ = remote.stop();
                let _ = app_for_task.emit("remote-access-status", remote.status());
            }
        });
        let status = self.status();
        let _ = app.emit("remote-access-status", status.clone());
        Ok(status)
    }

    #[cfg(not(windows))]
    pub async fn start(
        &self,
        _app: tauri::AppHandle,
        _trust_confirmed: bool,
    ) -> Result<RemoteAccessStatus, String> {
        Err("Serwer iPhone Remote działa wyłącznie na MSI z Windows.".into())
    }

    #[cfg(windows)]
    pub fn revoke_all(&self) -> Result<RemoteAccessStatus, String> {
        *lock(&self.inner.pairing) = None;
        // Re-read under the cross-process lock: the devices to revoke are the
        // stored ones, never a possibly stale cache.
        let (_guard, mut vault) = self.locked_fresh(UI_LOCK_WAIT)?;
        let previous_devices = vault.devices.clone();
        vault.devices.clear();
        save_device_index(self.inner.credential_store.as_ref(), &mut vault)?;
        let mut cleanup_failed = false;
        for device in &previous_devices {
            cleanup_failed |= self
                .inner
                .credential_store
                .delete_password(&device_token_account(&device.id))
                .is_err();
        }
        self.publish(&vault);
        let status = self.status_cached();
        if cleanup_failed {
            return Err("Urządzenia zostały odwołane, ale systemowy magazyn nie usunął wszystkich osieroconych rekordów.".into());
        }
        Ok(status)
    }

    #[cfg(windows)]
    pub fn revoke_device(&self, device_id: &str) -> Result<RemoteAccessStatus, String> {
        let (_guard, mut vault) = self.locked_fresh(UI_LOCK_WAIT)?;
        let was_present = vault.devices.iter().any(|device| device.id == device_id);
        vault.devices.retain(|device| device.id != device_id);
        if was_present {
            save_device_index(self.inner.credential_store.as_ref(), &mut vault)?;
        }
        let cleanup_failed = was_present
            && self
                .inner
                .credential_store
                .delete_password(&device_token_account(device_id))
                .is_err();
        self.publish(&vault);
        let status = self.status_cached();
        if cleanup_failed {
            return Err("Urządzenie zostało odwołane, ale systemowy magazyn nie usunął osieroconego rekordu.".into());
        }
        Ok(status)
    }

    #[cfg(not(windows))]
    pub fn revoke_device(&self, _device_id: &str) -> Result<RemoteAccessStatus, String> {
        Err("Serwer iPhone Remote działa wyłącznie na MSI z Windows.".into())
    }

    #[cfg(not(windows))]
    pub fn revoke_all(&self) -> Result<RemoteAccessStatus, String> {
        *lock(&self.inner.pairing) = None;
        Ok(self.status())
    }

    /// Diagnoses the credential state without changing it and issues a one-time
    /// freshness token ("confirmation") that `run_recovery` must present. The
    /// token only proves that a recovery follows a recent inspection made by this
    /// process, once; it is not proof of a human at the keyboard. That consent is
    /// the mode choice and the acknowledgement in the local UI, which the backend
    /// cannot verify. Recovery grants no capability a local process of this user
    /// does not already have (see docs/velora-s0a-credential-store.md).
    /// Works when the normal load fails, which is the point: a damaged state
    /// must not block the way out of it.
    #[cfg(windows)]
    pub fn inspect_recovery(&self) -> Result<RemoteRecoveryPlan, String> {
        let _guard = match self.inner.state_lock.acquire(UI_LOCK_WAIT) {
            Ok(guard) => guard,
            Err(error) => {
                let error = lock_error(error);
                self.note_store_health(Err(&error));
                return Ok(RemoteRecoveryPlan {
                    store_state: error.fault.state_name().into(),
                    message: Some(error.message),
                    recovery_required: false,
                    options: Vec::new(),
                    confirmation: String::new(),
                    confirmation_expires_in_seconds: 0,
                });
            }
        };
        let store = self.inner.credential_store.as_ref();
        let outcome = self.read_verified();
        let (state, message, required, fault) = match &outcome {
            Ok(_) => ("ok".to_string(), None, false, None),
            Err(error) => (
                error.fault.state_name().to_string(),
                Some(error.message.clone()),
                error.fault.recovery_required(),
                Some(error.fault),
            ),
        };
        self.note_store_health(outcome.as_ref().map(|_| ()));
        let pending = match fault {
            Some(StoreFault::RecoveryPending) => read_recovery_journal(store)
                .ok()
                .flatten()
                .map(|(mode, _)| mode),
            _ => None,
        };
        let options = recovery_options_for(fault, pending);
        let mut confirmation = String::new();
        if !options.is_empty() {
            use rand::Rng;
            const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
            let mut rng = rand::thread_rng();
            confirmation = (0..8)
                .map(|_| char::from(ALPHABET[rng.gen_range(0..ALPHABET.len())]))
                .collect();
            *lock(&self.inner.recovery_confirmation) =
                Some((confirmation.clone(), Instant::now() + RECOVERY_CONFIRMATION_TTL));
        }
        Ok(RemoteRecoveryPlan {
            store_state: state,
            message,
            recovery_required: required,
            confirmation_expires_in_seconds: if options.is_empty() {
                0
            } else {
                RECOVERY_CONFIRMATION_TTL.as_secs()
            },
            options,
            confirmation,
        })
    }

    #[cfg(not(windows))]
    pub fn inspect_recovery(&self) -> Result<RemoteRecoveryPlan, String> {
        Err("Serwer iPhone Remote działa wyłącznie na MSI z Windows.".into())
    }

    /// Runs the recovery the local user chose. The server is stopped first, the
    /// cross-process lock is held for the whole transaction, and the one-time
    /// freshness token issued by `inspect_recovery` is required and consumed
    /// (a guard against stale or repeated calls, not an authorization factor).
    /// Only the Tauri commands below call this; no HTTP route reaches it.
    #[cfg(windows)]
    pub fn run_recovery(&self, mode: &str, confirmation: &str) -> Result<RemoteAccessStatus, String> {
        let mode = RecoveryMode::parse(mode).ok_or("Nieznany tryb odzyskiwania.")?;
        let issued = lock(&self.inner.recovery_confirmation).take();
        match issued {
            Some((code, expires_at)) if Instant::now() < expires_at && code == confirmation => {}
            _ => {
                return Err("Potwierdzenie odzyskiwania jest nieprawidłowe lub wygasło. Odczytaj stan ponownie.".into());
            }
        }
        self.stop();
        let guard = self
            .inner
            .state_lock
            .acquire(UI_LOCK_WAIT)
            .map_err(|error| lock_error(error).message)?;
        let (known_ids, floor) = {
            let cache = lock(&self.inner.vault);
            (
                cache
                    .devices
                    .iter()
                    .map(|device| device.id.clone())
                    .collect::<Vec<_>>(),
                cache.revision,
            )
        };
        let store = self.inner.credential_store.as_ref();
        let result = perform_recovery(store, mode, &known_ids, floor);
        // The cache must not outlive the state it described.
        *lock(&self.inner.vault) = Vault::default();
        *lock(&self.inner.vault_loaded) = false;
        *lock(&self.inner.pairing) = None;
        match load_vault(store) {
            Ok(fresh) => {
                self.note_store_health(Ok(()));
                self.publish(&fresh);
            }
            Err(error) => self.note_store_health(Err(&error)),
        }
        drop(guard);
        result?;
        Ok(self.status_cached())
    }

    #[cfg(not(windows))]
    pub fn run_recovery(&self, _mode: &str, _confirmation: &str) -> Result<RemoteAccessStatus, String> {
        Err("Serwer iPhone Remote działa wyłącznie na MSI z Windows.".into())
    }

    #[cfg(windows)]
    fn allow_pairing_attempt(&self, address: IpAddr) -> bool {
        allow_rate(
            &mut lock(&self.inner.pair_attempts),
            address,
            PAIRING_WINDOW,
            PAIRING_ATTEMPTS,
            64,
        )
    }

    #[cfg(windows)]
    fn pair(
        &self,
        address: IpAddr,
        code: &str,
        device_id: &str,
        name: &str,
        token: &str,
    ) -> Result<(), StatusCode> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        if !self.allow_pairing_attempt(address) {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        if !lock(&self.inner.status).enabled {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        let valid_id = device_id.len() == 32
            && device_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        let token_bytes = URL_SAFE_NO_PAD
            .decode(token)
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if !valid_id || token_bytes.len() != 32 || name.trim().is_empty() {
            return Err(StatusCode::BAD_REQUEST);
        }
        let mut pairing_slot = lock(&self.inner.pairing);
        let Some(pairing) = pairing_slot.as_ref() else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        if pairing.expires_at <= Instant::now() || pairing.value != code {
            return Err(StatusCode::UNAUTHORIZED);
        }
        // Pairing changes the index, so it runs on state re-read under the
        // cross-process lock. The device list checked here is the stored one.
        let (_guard, mut vault) = self
            .locked_fresh(COMMAND_LOCK_WAIT)
            .map_err(|error| error.status())?;
        if vault.devices.len() >= MAX_PAIRED_DEVICES
            || vault.devices.iter().any(|device| device.id == device_id)
        {
            return Err(StatusCode::CONFLICT);
        }
        let clean_name = clean_device_name(name);
        if clean_name.is_empty() {
            return Err(StatusCode::BAD_REQUEST);
        }
        let device = PairedDevice {
            id: device_id.to_ascii_lowercase(),
            name: clean_name,
            token: token.to_string(),
            last_sequence: 0,
        };
        vault.devices.push(device.clone());
        if persist_new_device(self.inner.credential_store.as_ref(), &mut vault, &device).is_err() {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        *pairing_slot = None;
        self.publish(&vault);
        Ok(())
    }

    #[cfg(windows)]
    fn authenticate_command(
        &self,
        device_id: &str,
        sequence: u64,
        command: &RemoteCommand,
        signature: &[u8],
    ) -> Result<CommandReservation, StatusCode> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

        if !lock(&self.inner.status).enabled {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        // Cheap pre-check against the cache, without any credential-store I/O:
        // an unknown device or a bad signature from the LAN is rejected before
        // the lock is taken. Pairing only happens in the serving process, so a
        // device missing from its cache cannot be a valid one. Everything that
        // matters is verified again below on state re-read under the lock.
        if *lock(&self.inner.vault_loaded) {
            let cache = lock(&self.inner.vault);
            let Some(cached) = cache.devices.iter().find(|device| device.id == device_id)
            else {
                return Err(StatusCode::UNAUTHORIZED);
            };
            let cached_token = URL_SAFE_NO_PAD
                .decode(&cached.token)
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
            if !verify_command_signature(&cached_token, device_id, sequence, command, signature) {
                return Err(StatusCode::UNAUTHORIZED);
            }
        }

        // The command transaction: lock across processes, re-read the stored
        // state, validate, reserve the sequence durably, publish, unlock. A
        // second VELORA process can therefore never write back an older state.
        let (_guard, mut vault) = self
            .locked_fresh(COMMAND_LOCK_WAIT)
            .map_err(|error| error.status())?;
        let Some(index) = vault
            .devices
            .iter()
            .position(|device| device.id == device_id)
        else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        let token = vault.devices[index].token.clone();
        let token_bytes = URL_SAFE_NO_PAD
            .decode(&token)
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if !verify_command_signature(&token_bytes, device_id, sequence, command, signature) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        if !allow_rate(
            &mut lock(&self.inner.command_attempts),
            device_id.to_string(),
            COMMAND_WINDOW,
            COMMANDS_PER_WINDOW,
            MAX_PAIRED_DEVICES,
        ) {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let decision = {
            let receipts = lock(&self.inner.command_receipts);
            classify_replay(
                vault.devices[index].last_sequence,
                receipts.lookup(device_id, sequence),
                sequence,
                command.as_str(),
            )
        };
        match decision {
            ReplayDecision::Execute => {
                // Reserve before the side effect; the command gate prevents a
                // parallel duplicate from executing the same sequence.
                let previous_sequence = vault.devices[index].last_sequence;
                vault.devices[index].last_sequence = sequence;
                // A failed or ambiguous write leaves the cache untouched. The
                // next command re-reads the store, so a write that reached
                // Credential Manager but reported an error is seen as consumed
                // (equal sequence without receipt answers 409, never re-executes).
                if save_device_index(self.inner.credential_store.as_ref(), &mut vault).is_err() {
                    return Err(StatusCode::SERVICE_UNAVAILABLE);
                }
                self.publish(&vault);
                Ok(CommandReservation::Execute { previous_sequence })
            }
            ReplayDecision::AcknowledgeReplay => Ok(CommandReservation::Acknowledge),
            ReplayDecision::Ambiguous => Err(StatusCode::CONFLICT),
            ReplayDecision::RejectReplay => Err(StatusCode::UNAUTHORIZED),
        }
    }

    /// Releases a reservation whose side effect never happened. This is the
    /// only operation allowed to lower a stored sequence, and only
    /// compare-and-swap style: the freshly read stored value must still be
    /// exactly the reserved one. If another process has moved the sequence
    /// since, or the store cannot be read or written, nothing is lowered and the
    /// sequence stays consumed.
    #[cfg(windows)]
    fn rollback_command_reservation(&self, device_id: &str, sequence: u64, previous: u64) {
        let Ok((_guard, mut vault)) = self.locked_fresh(COMMAND_LOCK_WAIT) else {
            return;
        };
        let Some(device) = vault
            .devices
            .iter_mut()
            .find(|device| device.id == device_id)
        else {
            return;
        };
        if device.last_sequence != sequence || previous >= sequence {
            return;
        }
        device.last_sequence = previous;
        if save_device_index(self.inner.credential_store.as_ref(), &mut vault).is_ok() {
            self.publish(&vault);
        }
    }

    #[cfg(windows)]
    fn record_command_receipt(&self, device_id: &str, sequence: u64, command: &str) {
        lock(&self.inner.command_receipts).record(device_id, sequence, command);
    }

    #[cfg(windows)]
    fn execute_command(
        &self,
        app: &tauri::AppHandle,
        request: &CommandRequest,
        signature: &[u8],
    ) -> StatusCode {
        use tauri::Emitter;

        let _gate = lock(&self.inner.command_gate);
        let reservation = match self.authenticate_command(
            &request.device_id,
            request.sequence,
            &request.command,
            signature,
        ) {
            Ok(reservation) => reservation,
            Err(status) => return status,
        };
        let previous_sequence = match reservation {
            CommandReservation::Acknowledge => return StatusCode::NO_CONTENT,
            CommandReservation::Execute { previous_sequence } => previous_sequence,
        };

        // Home is the one command with a fully native, session-authoritative
        // action. Perform it before the HTTP acknowledgement so a hidden or
        // busy WebView cannot turn a real Home request into a false success.
        let native_home = request.command == RemoteCommand::Home;
        if native_home {
            let result = crate::session_orchestrator::return_home(
                app,
                crate::session_orchestrator::TransitionCause::ControlService,
                crate::session_orchestrator::HomeRequestSource::Device,
            );
            if result.is_err() {
                self.rollback_command_reservation(
                    &request.device_id,
                    request.sequence,
                    previous_sequence,
                );
                return StatusCode::CONFLICT;
            }
        }

        if app
            .emit("nexus-remote-command", request.command.clone())
            .is_err()
        {
            if native_home {
                // The native Home transition already happened; report it
                // truthfully and keep the receipt so a retry cannot repeat it.
                self.record_command_receipt(
                    &request.device_id,
                    request.sequence,
                    request.command.as_str(),
                );
                return StatusCode::NO_CONTENT;
            }
            // No side effect reached the UI. Release the reservation so the
            // same signed command can be retried cleanly.
            self.rollback_command_reservation(
                &request.device_id,
                request.sequence,
                previous_sequence,
            );
            return StatusCode::SERVICE_UNAVAILABLE;
        }
        self.record_command_receipt(
            &request.device_id,
            request.sequence,
            request.command.as_str(),
        );
        StatusCode::NO_CONTENT
    }
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandReservation {
    Execute { previous_sequence: u64 },
    Acknowledge,
}

fn allow_rate<K: Eq + std::hash::Hash>(
    buckets: &mut HashMap<K, RateBucket>,
    key: K,
    window: Duration,
    limit: u32,
    max_keys: usize,
) -> bool {
    let now = Instant::now();
    buckets.retain(|_, bucket| now.duration_since(bucket.started_at) < window.saturating_mul(2));
    if !buckets.contains_key(&key) && buckets.len() >= max_keys {
        return false;
    }
    let bucket = buckets.entry(key).or_insert(RateBucket {
        started_at: now,
        count: 0,
    });
    if now.duration_since(bucket.started_at) >= window {
        bucket.started_at = now;
        bucket.count = 0;
    }
    if bucket.count >= limit {
        return false;
    }
    bucket.count += 1;
    true
}

#[cfg(windows)]
fn der_from_pem(pem: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let body = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    STANDARD
        .decode(body)
        .map_err(|_| "Nie można odczytać certyfikatu zaufania.".to_string())
}

#[cfg(windows)]
fn local_remote_address() -> Result<(Ipv4Addr, String, String), String> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|_| "Nie można wykryć prywatnego interfejsu sieciowego.".to_string())?;
    socket
        .connect("192.0.2.1:9")
        .map_err(|_| "Nie można wykryć prywatnego interfejsu sieciowego.".to_string())?;
    let ip = match socket
        .local_addr()
        .map_err(|_| "Nie można odczytać adresu sieciowego.".to_string())?
        .ip()
    {
        IpAddr::V4(ip) if ip.is_private() => ip,
        _ => {
            return Err(
                "Nie znaleziono trasy przez prywatny adres IPv4. Serwer pozostał wyłączony.".into(),
            )
        }
    };
    let host = format!("{ip}:{REMOTE_PORT}");
    let origin = format!("https://{host}");
    Ok((ip, host, origin))
}

fn sequence_is_fresh(last_sequence: u64, next_sequence: u64) -> bool {
    next_sequence > last_sequence
}

#[cfg(windows)]
fn uuid_from_sha256(input: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut bytes = Sha256::digest(input)[..16].to_vec();
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

#[cfg(windows)]
fn credential_store_error(error: CredentialStoreError) -> String {
    match error {
        CredentialStoreError::Unavailable => {
            "Systemowy magazyn poświadczeń jest niedostępny.".into()
        }
        CredentialStoreError::TooLarge => {
            "Dane pilota przekraczają bezpieczny limit magazynu poświadczeń Windows.".into()
        }
    }
}

#[cfg(windows)]
fn device_token_account(device_id: &str) -> String {
    format!("device-token-v2-{device_id}")
}

#[cfg(windows)]
fn is_valid_device_id(device_id: &str) -> bool {
    device_id.len() == 32
        && device_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(windows)]
fn clean_device_name(name: &str) -> String {
    name.chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_' | '.')
        })
        .take(32)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(windows)]
fn lock_error(error: StateLockError) -> VaultError {
    VaultError::new(
        StoreFault::Locked,
        match error {
            StateLockError::Unavailable => "Blokada magazynu iPhone Remote jest niedostępna. Operacja została odrzucona, a zapisany stan nie został zmieniony.",
            StateLockError::Timeout => "Inny proces VELORA zapisuje stan iPhone Remote. Operacja została odrzucona; spróbuj ponownie.",
        },
    )
}

#[cfg(windows)]
fn store_read_error(error: CredentialStoreError) -> VaultError {
    VaultError::new(StoreFault::Unavailable, credential_store_error(error))
}

#[cfg(windows)]
const RECOVERY_HINT: &str = "Użyj lokalnego odzyskiwania zaufania w Control Center.";

/// Compares the freshly read state with what this process last verified. A
/// state that moved backwards while the process was running, or that changed
/// without a new revision, is not trusted. A missing index is accepted: it
/// grants no device any authority.
#[cfg(windows)]
fn detect_rollback(cached: &Vault, fresh: &Vault) -> Result<(), VaultError> {
    if fresh.index_json.is_none() {
        return Ok(());
    }
    let went_back = fresh.revision < cached.revision;
    let changed_in_place = fresh.revision == cached.revision
        && cached.index_json.is_some()
        && fresh.index_json != cached.index_json;
    if went_back || changed_in_place {
        return Err(VaultError::new(
            StoreFault::RolledBack,
            format!("Zapisany stan iPhone Remote cofnął się lub zmienił poza procesem VELORA. Serwer pozostaje wyłączony. {RECOVERY_HINT}"),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn generate_ca_material() -> Result<(String, String), String> {
    use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose};
    use time::{Duration as TimeDuration, OffsetDateTime};

    let mut params = CertificateParams::default();
    let now = OffsetDateTime::now_utc();
    params.not_before = now - TimeDuration::minutes(5);
    params.not_after = now + TimeDuration::days(365 * 5);
    params
        .distinguished_name
        .push(DnType::CommonName, "VELORA LAN Remote CA");
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let key = KeyPair::generate()
        .map_err(|_| "Nie udało się utworzyć certyfikatu zaufania.".to_string())?;
    let cert = params
        .self_signed(&key)
        .map_err(|_| "Nie udało się utworzyć certyfikatu zaufania.".to_string())?;
    Ok((cert.pem(), key.serialize_pem()))
}

/// Reads one DER element: `(tag, content, rest)`.
#[cfg(windows)]
fn der_element(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (length, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let length = rest[..count]
            .iter()
            .fold(0_usize, |acc, byte| (acc << 8) | usize::from(*byte));
        (length, &rest[count..])
    };
    if rest.len() < length {
        return None;
    }
    Some((tag, &rest[..length], &rest[length..]))
}

/// The DER `SubjectPublicKeyInfo` of an X.509 certificate.
#[cfg(windows)]
fn certificate_public_key_info(certificate_der: &[u8]) -> Option<Vec<u8>> {
    let (tag, certificate, _) = der_element(certificate_der)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, tbs, _) = der_element(certificate)?;
    if tag != 0x30 {
        return None;
    }
    let mut rest = tbs;
    let (tag, _, after_first) = der_element(rest)?;
    if tag == 0xa0 {
        rest = after_first; // optional explicit version
    }
    // serial, signature algorithm, issuer, validity, subject
    for _ in 0..5 {
        let (_, _, after) = der_element(rest)?;
        rest = after;
    }
    let (tag, _, after) = der_element(rest)?;
    if tag != 0x30 {
        return None;
    }
    Some(rest[..rest.len() - after.len()].to_vec())
}

/// Checks that the stored CA is usable: a real PEM certificate that is a CA,
/// currently valid, with a parsable private key that actually belongs to it.
#[cfg(windows)]
fn validate_ca_material(certificate_pem: &str, key_pem: &str) -> Result<(), String> {
    use rcgen::{CertificateParams, IsCa, KeyPair};
    use time::OffsetDateTime;

    let lines: Vec<&str> = certificate_pem.lines().map(str::trim).collect();
    if lines.first() != Some(&"-----BEGIN CERTIFICATE-----")
        || lines.last() != Some(&"-----END CERTIFICATE-----")
    {
        return Err("Zapisany certyfikat zaufania nie jest poprawnym PEM.".into());
    }
    let der = der_from_pem(certificate_pem)?;
    let params = CertificateParams::from_ca_cert_pem(certificate_pem)
        .map_err(|_| "Zapisany certyfikat zaufania jest nieczytelny.".to_string())?;
    if !matches!(params.is_ca, IsCa::Ca(_)) {
        return Err("Zapisany certyfikat zaufania nie jest urzędem certyfikacji.".into());
    }
    let now = OffsetDateTime::now_utc();
    if now > params.not_after || now < params.not_before {
        return Err("Zapisany certyfikat zaufania wygasł lub jeszcze nie obowiązuje.".into());
    }
    let key = KeyPair::from_pem(key_pem)
        .map_err(|_| "Zapisany klucz zaufania jest nieczytelny.".to_string())?;
    let certificate_key = certificate_public_key_info(&der)
        .ok_or_else(|| "Zapisany certyfikat zaufania ma nieprawidłową strukturę.".to_string())?;
    if certificate_key != key.public_key_der() {
        return Err("Zapisany klucz zaufania nie pasuje do zapisanego certyfikatu.".into());
    }
    Ok(())
}

#[cfg(windows)]
fn load_vault(store: &dyn CredentialStore) -> Result<Vault, VaultError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use std::collections::HashSet;

    let damaged = |message: &str| {
        VaultError::new(StoreFault::IndexDamaged, format!("{message} {RECOVERY_HINT}"))
    };
    let ca_damaged = |message: &str| {
        VaultError::new(StoreFault::CaDamaged, format!("{message} {RECOVERY_HINT}"))
    };

    if store
        .get_password(RECOVERY_JOURNAL_ACCOUNT)
        .map_err(store_read_error)?
        .is_some()
    {
        return Err(VaultError::new(
            StoreFault::RecoveryPending,
            format!("Odzyskiwanie zaufania iPhone Remote nie zostało dokończone. Serwer pozostaje wyłączony. {RECOVERY_HINT}"),
        ));
    }
    let ca_cert_pem = store
        .get_password(CA_CERT_ACCOUNT)
        .map_err(store_read_error)?;
    let ca_key_pem = store
        .get_password(CA_KEY_ACCOUNT)
        .map_err(store_read_error)?;
    if ca_cert_pem.is_some() != ca_key_pem.is_some() {
        return Err(ca_damaged(
            "Trwały klucz zaufania iPhone Remote jest niekompletny. Serwer pozostaje wyłączony; nic nie zostało automatycznie zmienione.",
        ));
    }
    if let (Some(certificate), Some(key)) = (&ca_cert_pem, &ca_key_pem) {
        validate_ca_material(certificate, key).map_err(|message| {
            ca_damaged(&format!(
                "{message} Serwer pozostaje wyłączony; nic nie zostało automatycznie zmienione."
            ))
        })?;
    }

    let index_value = store
        .get_password(DEVICE_INDEX_ACCOUNT)
        .map_err(store_read_error)?;
    let Some(index_value) = index_value else {
        return Ok(Vault {
            ca_cert_pem,
            ca_key_pem,
            devices: Vec::new(),
            revision: 0,
            index_json: None,
        });
    };
    let index: DeviceIndex = serde_json::from_str(&index_value)
        .map_err(|_| damaged("Zapisany indeks urządzeń iPhone Remote jest nieczytelny."))?;
    if index.version != DEVICE_INDEX_VERSION || index.devices.len() > MAX_PAIRED_DEVICES {
        return Err(damaged(
            "Zapisany indeks urządzeń iPhone Remote ma nieobsługiwaną wersję lub rozmiar.",
        ));
    }
    if ca_cert_pem.is_none() && !index.devices.is_empty() {
        return Err(damaged("Brakuje trwałego CA dla sparowanych urządzeń iPhone Remote. Serwer pozostaje wyłączony; nic nie zostało automatycznie zmienione."));
    }

    let mut seen_ids = HashSet::new();
    let mut devices = Vec::with_capacity(index.devices.len());
    for record in index.devices {
        if !is_valid_device_id(&record.id)
            || !seen_ids.insert(record.id.clone())
            || record.name.is_empty()
            || record.name.len() > 32
            || clean_device_name(&record.name) != record.name
        {
            return Err(damaged(
                "Zapisane urządzenia iPhone Remote zawierają nieprawidłowe metadane.",
            ));
        }
        let token = store
            .get_password(&device_token_account(&record.id))
            .map_err(store_read_error)?
            .ok_or_else(|| damaged("Brakuje sekretu dla sparowanego urządzenia iPhone Remote. Serwer pozostaje wyłączony."))?;
        let token_bytes = URL_SAFE_NO_PAD.decode(&token).map_err(|_| {
            damaged("Sekret sparowanego urządzenia iPhone Remote jest nieprawidłowy.")
        })?;
        if token_bytes.len() != 32 {
            return Err(damaged(
                "Sekret sparowanego urządzenia iPhone Remote ma nieprawidłowy rozmiar.",
            ));
        }
        devices.push(PairedDevice {
            id: record.id,
            name: record.name,
            token,
            last_sequence: record.last_sequence,
        });
    }

    Ok(Vault {
        ca_cert_pem,
        ca_key_pem,
        devices,
        revision: index.revision,
        index_json: Some(index_value),
    })
}

#[cfg(windows)]
fn persist_trust_material(
    store: &dyn CredentialStore,
    certificate: &str,
    private_key: &str,
) -> Result<(), String> {
    let existing_certificate = store
        .get_password(CA_CERT_ACCOUNT)
        .map_err(credential_store_error)?;
    let existing_key = store
        .get_password(CA_KEY_ACCOUNT)
        .map_err(credential_store_error)?;
    match (existing_certificate, existing_key) {
        (Some(existing_certificate), Some(existing_key))
            if existing_certificate == certificate && existing_key == private_key => return Ok(()),
        (None, None) => {}
        _ => return Err("Istniejący materiał zaufania nie zostanie automatycznie zastąpiony. Serwer pozostaje wyłączony; użyj lokalnego odzyskiwania zaufania.".into()),
    }

    store
        .set_password(CA_KEY_ACCOUNT, private_key)
        .map_err(credential_store_error)?;
    if let Err(error) = store.set_password(CA_CERT_ACCOUNT, certificate) {
        let cleanup_error = store.delete_password(CA_KEY_ACCOUNT).err();
        let mut message = credential_store_error(error);
        if cleanup_error.is_some() {
            message.push_str(" Nie udało się też usunąć niedokończonego rekordu zaufania; serwer pozostaje wyłączony. Użyj lokalnego odzyskiwania zaufania.");
        }
        return Err(message);
    }
    Ok(())
}

#[cfg(windows)]
fn index_text(devices: &[PairedDevice], revision: u64) -> Result<String, String> {
    let index = DeviceIndex {
        version: DEVICE_INDEX_VERSION,
        revision,
        devices: devices
            .iter()
            .map(|device| DeviceIndexRecord {
                id: device.id.clone(),
                name: device.name.clone(),
                last_sequence: device.last_sequence,
            })
            .collect(),
    };
    serde_json::to_string(&index)
        .map_err(|_| "Nie udało się przygotować indeksu sparowanych urządzeń.".to_string())
}

/// Commits the device index with the next revision. `vault` changes only when
/// the write succeeded; the caller holds the cross-process state lock and
/// built `vault` from a read made under that same lock.
#[cfg(windows)]
fn save_device_index(store: &dyn CredentialStore, vault: &mut Vault) -> Result<(), String> {
    let next = vault
        .revision
        .checked_add(1)
        .ok_or_else(|| "Licznik wersji indeksu urządzeń został wyczerpany.".to_string())?;
    let value = index_text(&vault.devices, next)?;
    store
        .set_password(DEVICE_INDEX_ACCOUNT, &value)
        .map_err(credential_store_error)?;
    vault.revision = next;
    vault.index_json = Some(value);
    Ok(())
}

#[cfg(windows)]
fn persist_new_device(
    store: &dyn CredentialStore,
    vault: &mut Vault,
    device: &PairedDevice,
) -> Result<(), String> {
    let account = device_token_account(&device.id);
    store
        .set_password(&account, &device.token)
        .map_err(credential_store_error)?;
    if let Err(error) = save_device_index(store, vault) {
        let cleanup_error = store.delete_password(&account).err();
        let mut message = error;
        if cleanup_error.is_some() {
            message.push_str(" Nie udało się też usunąć osieroconego rekordu urządzenia.");
        }
        return Err(message);
    }
    Ok(())
}

#[cfg(windows)]
fn read_recovery_journal(
    store: &dyn CredentialStore,
) -> Result<Option<(RecoveryMode, Vec<String>)>, String> {
    let Some(value) = store
        .get_password(RECOVERY_JOURNAL_ACCOUNT)
        .map_err(credential_store_error)?
    else {
        return Ok(None);
    };
    // An unreadable journal is finished with the broadest mode.
    let Ok(journal) = serde_json::from_str::<RecoveryJournal>(&value) else {
        return Ok(Some((RecoveryMode::ResetTrust, Vec::new())));
    };
    let mode = RecoveryMode::parse(&journal.mode).unwrap_or(RecoveryMode::ResetTrust);
    Ok(Some((mode, journal.device_ids)))
}

/// Revision and device IDs of whatever index is stored, even a damaged one.
#[cfg(windows)]
fn read_index_leniently(store: &dyn CredentialStore) -> Result<(u64, Vec<String>), String> {
    #[derive(Deserialize)]
    struct LenientIndex {
        #[serde(default)]
        revision: u64,
        #[serde(default)]
        devices: Vec<LenientRecord>,
    }
    #[derive(Deserialize)]
    struct LenientRecord {
        #[serde(default)]
        id: String,
    }
    let Some(value) = store
        .get_password(DEVICE_INDEX_ACCOUNT)
        .map_err(credential_store_error)?
    else {
        return Ok((0, Vec::new()));
    };
    let Ok(index) = serde_json::from_str::<LenientIndex>(&value) else {
        return Ok((0, Vec::new()));
    };
    let ids = index
        .devices
        .into_iter()
        .map(|record| record.id)
        .filter(|id| is_valid_device_id(id))
        .collect();
    Ok((index.revision, ids))
}

/// The controlled recovery transaction. The caller holds the cross-process
/// state lock and has stopped the server.
///
/// Order matters and every step is idempotent, so an interrupted recovery is
/// finished by running it again:
///
/// 1. a journal naming the mode and the known device IDs is written; while it
///    exists the store stays closed, so a half-reset set is never used;
/// 2. an empty index with a higher revision replaces the old one, which revokes
///    every device before any secret is touched;
/// 3. the device tokens are deleted (and, for `ResetTrust`, the CA key and then
///    the CA certificate);
/// 4. only when every deletion succeeded is the journal removed.
///
/// Only VELORA's own entries are touched. Nothing is generated or rotated: a new
/// CA exists only after the user explicitly prepares a trust profile later.
#[cfg(windows)]
fn perform_recovery(
    store: &dyn CredentialStore,
    requested: RecoveryMode,
    known_device_ids: &[String],
    revision_floor: u64,
) -> Result<(), String> {
    let journal = read_recovery_journal(store)?;
    let (stored_revision, index_ids) = read_index_leniently(store)?;
    let (mode, mut ids) = match journal {
        Some((journal_mode, journal_ids)) => (journal_mode.merge(requested), journal_ids),
        None => (requested, Vec::new()),
    };
    for id in index_ids
        .into_iter()
        .chain(known_device_ids.iter().filter(|id| is_valid_device_id(id)).cloned())
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.truncate(MAX_PAIRED_DEVICES * 2);

    let journal_text = serde_json::to_string(&RecoveryJournal {
        version: RECOVERY_JOURNAL_VERSION,
        mode: mode.as_str().into(),
        device_ids: ids.clone(),
    })
    .map_err(|_| "Nie udało się przygotować dziennika odzyskiwania.".to_string())?;
    store
        .set_password(RECOVERY_JOURNAL_ACCOUNT, &journal_text)
        .map_err(credential_store_error)?;

    // A damaged index cannot tell us its old revision, and a fresh process has no
    // cached floor, so the counter could restart at 1 and an older vault restored
    // later would look "newer" and be adopted. The wall clock in seconds is far
    // above any counter that one commit per operation can reach, so it keeps the
    // new epoch above every earlier revision without a new mechanism. It is only
    // ever a lower bound: the stored value and the process floor still win when
    // higher, so the revision never goes backwards, even if the clock does.
    let clock_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let revision = stored_revision
        .max(revision_floor)
        .max(clock_epoch)
        .checked_add(1)
        .ok_or_else(|| "Licznik wersji indeksu urządzeń został wyczerpany.".to_string())?;
    let empty_index = index_text(&[], revision)?;
    store
        .set_password(DEVICE_INDEX_ACCOUNT, &empty_index)
        .map_err(credential_store_error)?;

    let mut incomplete = false;
    for id in &ids {
        incomplete |= store.delete_password(&device_token_account(id)).is_err();
    }
    if mode == RecoveryMode::ResetTrust {
        incomplete |= store.delete_password(CA_KEY_ACCOUNT).is_err();
        incomplete |= store.delete_password(CA_CERT_ACCOUNT).is_err();
    }
    if incomplete {
        return Err("Odzyskiwanie jest niepełne: systemowy magazyn nie usunął wszystkich rekordów. Serwer pozostaje wyłączony; uruchom odzyskiwanie ponownie.".into());
    }
    store
        .delete_password(RECOVERY_JOURNAL_ACCOUNT)
        .map_err(|_| "Odzyskiwanie wykonano, ale nie udało się usunąć dziennika. Uruchom odzyskiwanie ponownie, aby je domknąć.".to_string())
}

#[cfg(windows)]
fn recovery_options_for(fault: Option<StoreFault>, pending: Option<RecoveryMode>) -> Vec<RecoveryOption> {
    let revoke = RecoveryOption {
        mode: RecoveryMode::RevokeAllDevices.as_str().into(),
        summary: "Odwołaj wszystkie sparowane urządzenia i zachowaj obecny certyfikat zaufania. Urządzenia trzeba sparować ponownie; profilu na iPhonie nie trzeba instalować od nowa.".into(),
    };
    let reset = RecoveryOption {
        mode: RecoveryMode::ResetTrust.as_str().into(),
        summary: "Odwołaj wszystkie urządzenia i usuń certyfikat zaufania VELORA. Nowy certyfikat powstanie dopiero po przygotowaniu profilu; trzeba go zainstalować i w pełni zaufać na iPhonie, a urządzenia sparować ponownie.".into(),
    };
    match (fault, pending) {
        (Some(StoreFault::Unavailable | StoreFault::Locked), _) => Vec::new(),
        (Some(StoreFault::RecoveryPending), Some(RecoveryMode::ResetTrust)) => vec![reset],
        (Some(StoreFault::CaDamaged), _) => vec![reset],
        _ => vec![revoke, reset],
    }
}

#[cfg(windows)]
#[derive(Clone)]
struct ServerContext {
    remote: RemoteAccess,
    app: tauri::AppHandle,
    expected_host: String,
    expected_origin: String,
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
    device_id: String,
    device_name: String,
    token: String,
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandRequest {
    device_id: String,
    sequence: u64,
    command: RemoteCommand,
    signature: String,
}

#[cfg(windows)]
async fn validate_request(
    axum::extract::State(context): axum::extract::State<ServerContext>,
    request: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{header, HeaderName, HeaderValue, StatusCode};
    use axum::response::IntoResponse;

    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let method = request.method().as_str();
    let path = request.uri().path();
    if !is_allowed_request(
        host,
        origin,
        method,
        path,
        &context.expected_host,
        &context.expected_origin,
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if path.starts_with("/api/") && method == "POST" {
        let content_type = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok());
        if !content_type.is_some_and(|value| value.starts_with("application/json")) {
            return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
        }
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"),
    );
    response
}

#[cfg(windows)]
async fn remote_index() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        include_str!("../../public/remote/index.html"),
    )
}

#[cfg(windows)]
async fn remote_app_js() -> impl axum::response::IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        include_str!("../../public/remote/app.js"),
    )
}

#[cfg(windows)]
async fn remote_style() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../../public/remote/style.css"),
    )
}

#[cfg(windows)]
async fn remote_manifest() -> impl axum::response::IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "application/manifest+json",
        )],
        include_str!("../../public/remote/manifest.webmanifest"),
    )
}

#[cfg(windows)]
async fn remote_service_worker() -> impl axum::response::IntoResponse {
    (
        [
            (
                axum::http::header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (
                axum::http::header::HeaderName::from_static("service-worker-allowed"),
                "/",
            ),
        ],
        include_str!("../../public/remote/sw.js"),
    )
}

#[cfg(windows)]
async fn remote_icon() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "image/svg+xml")],
        include_str!("../../public/remote/icon.svg"),
    )
}

#[cfg(windows)]
async fn remote_status(
    axum::extract::State(context): axum::extract::State<ServerContext>,
) -> impl axum::response::IntoResponse {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct StatusResponse {
        enabled: bool,
        paired_device_count: usize,
    }
    // Memory only: an unauthenticated LAN request must not cause
    // credential-store I/O or contend for the cross-process lock.
    let status = context.remote.status_cached();
    axum::Json(StatusResponse {
        enabled: status.enabled,
        paired_device_count: status.paired_device_count,
    })
}

#[cfg(windows)]
async fn pair_device(
    axum::extract::State(context): axum::extract::State<ServerContext>,
    axum::extract::ConnectInfo(address): axum::extract::ConnectInfo<SocketAddr>,
    axum::Json(request): axum::Json<PairRequest>,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use tauri::Emitter;

    // Pairing takes the cross-process lock and writes the credential store, so
    // it must not run on an async executor thread.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let outcome = context.remote.pair(
            address.ip(),
            &request.code,
            &request.device_id,
            &request.device_name,
            &request.token,
        );
        if outcome.is_ok() {
            let _ = context
                .app
                .emit("remote-access-status", context.remote.status_cached());
        }
        outcome
    })
    .await
    .unwrap_or(Err(StatusCode::INTERNAL_SERVER_ERROR));
    match result {
        Ok(()) => StatusCode::CREATED.into_response(),
        Err(status) => status.into_response(),
    }
}

#[cfg(windows)]
async fn send_command(
    axum::extract::State(context): axum::extract::State<ServerContext>,
    axum::Json(request): axum::Json<CommandRequest>,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    // Authentication, sequence reservation, the optional native Home
    // transition and the receipt are one serialized blocking transaction. A
    // parallel duplicate waits instead of being misclassified as a replay.
    let status = tauri::async_runtime::spawn_blocking(move || {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let Ok(signature) = URL_SAFE_NO_PAD.decode(&request.signature) else {
            return StatusCode::UNAUTHORIZED;
        };
        context
            .remote
            .execute_command(&context.app, &request, &signature)
    })
    .await
    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    status.into_response()
}

#[tauri::command]
pub fn get_remote_access_status(service: State<'_, RemoteAccess>) -> RemoteAccessStatus {
    service.status()
}

#[tauri::command]
pub fn prepare_remote_trust_profile(
    app: tauri::AppHandle,
    service: State<'_, RemoteAccess>,
) -> Result<RemoteAccessStatus, String> {
    service.prepare_trust_profile(&app)
}

#[tauri::command]
pub async fn start_remote_access(
    app: tauri::AppHandle,
    trust_confirmed: bool,
    service: State<'_, RemoteAccess>,
) -> Result<RemoteAccessStatus, String> {
    service.start(app, trust_confirmed).await
}

#[tauri::command]
pub fn begin_remote_pairing(
    service: State<'_, RemoteAccess>,
) -> Result<RemoteAccessStatus, String> {
    service.begin_pairing()
}

#[tauri::command]
pub fn stop_remote_access(service: State<'_, RemoteAccess>) -> RemoteAccessStatus {
    service.stop()
}

#[tauri::command]
pub fn revoke_all_remote_devices(
    service: State<'_, RemoteAccess>,
) -> Result<RemoteAccessStatus, String> {
    service.revoke_all()
}

#[tauri::command]
pub fn revoke_remote_device(
    device_id: String,
    service: State<'_, RemoteAccess>,
) -> Result<RemoteAccessStatus, String> {
    service.revoke_device(&device_id)
}

/// Reads the state and issues a one-time freshness token. Local UI only; the
/// token is not proof of a human, see `RemoteAccess::inspect_recovery`.
#[tauri::command]
pub fn inspect_remote_recovery(
    service: State<'_, RemoteAccess>,
) -> Result<RemoteRecoveryPlan, String> {
    service.inspect_recovery()
}

/// Runs the recovery the local user chose, with the token from the inspection.
#[tauri::command]
pub fn run_remote_recovery(
    mode: String,
    confirmation: String,
    service: State<'_, RemoteAccess>,
) -> Result<RemoteAccessStatus, String> {
    service.run_recovery(&mode, &confirmation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    #[test]
    fn host_and_origin_are_exact_for_mutating_api_requests() {
        assert!(is_allowed_request(
            Some("192.168.1.4:47862"),
            Some("https://192.168.1.4:47862"),
            "POST",
            "/api/pair",
            "192.168.1.4:47862",
            "https://192.168.1.4:47862"
        ));
        assert!(!is_allowed_request(
            Some("attacker.example"),
            Some("https://192.168.1.4:47862"),
            "POST",
            "/api/pair",
            "192.168.1.4:47862",
            "https://192.168.1.4:47862"
        ));
        assert!(!is_allowed_request(
            Some("192.168.1.4:47862"),
            Some("https://evil.example"),
            "POST",
            "/api/command",
            "192.168.1.4:47862",
            "https://192.168.1.4:47862"
        ));
        assert!(!is_allowed_request(
            Some("192.168.1.4:47862"),
            None,
            "POST",
            "/api/command",
            "192.168.1.4:47862",
            "https://192.168.1.4:47862"
        ));
        assert!(is_allowed_request(
            Some("192.168.1.4:47862"),
            None,
            "GET",
            "/api/status",
            "192.168.1.4:47862",
            "https://192.168.1.4:47862"
        ));
    }

    #[test]
    fn commands_are_authenticated_and_replay_protected() {
        let token = [7_u8; 32];
        let command = RemoteCommand::VolumeUp;
        let sequence = 3;
        let payload =
            remote_command_payload("0123456789abcdef0123456789abcdef", sequence, &command);
        let mut mac = Hmac::<Sha256>::new_from_slice(&token).unwrap();
        mac.update(payload.as_bytes());
        let signature = mac.finalize().into_bytes();
        assert!(verify_command_signature(
            &token,
            "0123456789abcdef0123456789abcdef",
            sequence,
            &command,
            &signature
        ));
        assert!(!verify_command_signature(
            &token,
            "0123456789abcdef0123456789abcdef",
            sequence + 1,
            &command,
            &signature
        ));
        assert!(sequence_is_fresh(2, sequence));
        assert!(!sequence_is_fresh(sequence, sequence));
    }

    #[test]
    fn pair_and_command_rate_limits_are_bounded() {
        let mut pair = HashMap::new();
        let ip: IpAddr = "192.168.1.4".parse().unwrap();
        for _ in 0..PAIRING_ATTEMPTS {
            assert!(allow_rate(
                &mut pair,
                ip,
                PAIRING_WINDOW,
                PAIRING_ATTEMPTS,
                64
            ));
        }
        assert!(!allow_rate(
            &mut pair,
            ip,
            PAIRING_WINDOW,
            PAIRING_ATTEMPTS,
            64
        ));
        let mut commands = HashMap::new();
        let id = "0123456789abcdef0123456789abcdef";
        for _ in 0..COMMANDS_PER_WINDOW {
            assert!(allow_rate(
                &mut commands,
                id.to_string(),
                COMMAND_WINDOW,
                COMMANDS_PER_WINDOW,
                MAX_PAIRED_DEVICES
            ));
        }
        assert!(!allow_rate(
            &mut commands,
            id.to_string(),
            COMMAND_WINDOW,
            COMMANDS_PER_WINDOW,
            MAX_PAIRED_DEVICES
        ));
    }

    #[test]
    fn command_deserialization_rejects_unlisted_operations() {
        assert_eq!(
            serde_json::from_str::<RemoteCommand>("\"volume-up\"").unwrap(),
            RemoteCommand::VolumeUp
        );
        assert!(serde_json::from_str::<RemoteCommand>("\"run-shell\"").is_err());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use crate::credential_store::{
        credential_password_size_bytes, CredentialStore, CredentialStoreError,
        WindowsCredentialStore, MAX_CREDENTIAL_PASSWORD_BYTES,
    };
    use crate::remote_state_lock::{FileStateLock, StateLock, UnavailableStateLock};
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
        process::Command,
        sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    const NEVER: usize = usize::MAX;
    const CHILD_SERVICE_ENV: &str = "VELORA_TEST_CHILD_SERVICE";
    const CHILD_LOCK_ENV: &str = "VELORA_TEST_CHILD_LOCK";
    const CHILD_ROLE_ENV: &str = "VELORA_TEST_CHILD_ROLE";
    const CHILD_DIR_ENV: &str = "VELORA_TEST_CHILD_DIR";
    const CHILD_ARG_ENV: &str = "VELORA_TEST_CHILD_ARG";
    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);
    /// Windows Credential Manager is a shared per-user service. The native-store
    /// tests take turns instead of hammering it from every test thread at once.
    static NATIVE_STORE_TURN: Mutex<()> = Mutex::new(());

    // ------------------------------------------------------------------
    // Test store: the real Windows Credential Manager under a unique,
    // synthetic service name, with fault injection around it.
    // ------------------------------------------------------------------

    struct TestRemoteStore {
        service: String,
        native: WindowsCredentialStore,
        owner: bool,
        created_accounts: Mutex<HashSet<String>>,
        failed_writes: Mutex<HashSet<String>>,
        /// The write reaches Credential Manager, then an error is reported.
        write_then_fail: Mutex<HashSet<String>>,
        failed_deletes: Mutex<HashSet<String>>,
        fail_all_reads: AtomicBool,
        /// Counts every attempted write or delete.
        mutations: AtomicUsize,
        /// This mutation (0-based) and every later one fail: the process "died".
        fail_from_mutation: AtomicUsize,
        /// End the whole process (exit code 86, no cleanup) once this many mutations have completed.
        abort_after_mutations: AtomicUsize,
    }

    impl TestRemoteStore {
        fn build(service: String, owner: bool, abort_after: usize) -> Arc<Self> {
            Arc::new(Self {
                native: WindowsCredentialStore::new(service.clone()),
                service,
                owner,
                created_accounts: Mutex::new(HashSet::new()),
                failed_writes: Mutex::new(HashSet::new()),
                write_then_fail: Mutex::new(HashSet::new()),
                failed_deletes: Mutex::new(HashSet::new()),
                fail_all_reads: AtomicBool::new(false),
                mutations: AtomicUsize::new(0),
                fail_from_mutation: AtomicUsize::new(NEVER),
                abort_after_mutations: AtomicUsize::new(abort_after),
            })
        }

        fn new(label: &str) -> Arc<Self> {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let counter = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            Self::build(
                format!(
                    "com.nexus.aurea.remote.tests.{label}.{}.{unique}.{counter}",
                    std::process::id()
                ),
                true,
                NEVER,
            )
        }

        fn attach(service: &str, abort_after: usize) -> Arc<Self> {
            Self::build(service.to_string(), false, abort_after)
        }

        fn fail_write(&self, account: &str) {
            lock(&self.failed_writes).insert(account.to_string());
        }

        fn fail_delete(&self, account: &str) {
            lock(&self.failed_deletes).insert(account.to_string());
        }

        fn mutation_gate(&self) -> Result<usize, CredentialStoreError> {
            let index = self.mutations.fetch_add(1, Ordering::SeqCst);
            if index >= self.fail_from_mutation.load(Ordering::SeqCst) {
                return Err(CredentialStoreError::Unavailable);
            }
            Ok(index)
        }

        fn mutation_done(&self, index: usize) {
            if index + 1 == self.abort_after_mutations.load(Ordering::SeqCst) {
                std::process::exit(86);
            }
        }

        fn raw_get(&self, account: &str) -> Option<String> {
            self.native.get_password(account).expect("raw read")
        }

        fn raw_set(&self, account: &str, value: &str) {
            lock(&self.created_accounts).insert(account.to_string());
            self.native.set_password(account, value).expect("raw write");
        }

        fn raw_delete(&self, account: &str) {
            self.native.delete_password(account).expect("raw delete");
        }
    }

    impl Drop for TestRemoteStore {
        fn drop(&mut self) {
            if !self.owner {
                return;
            }
            let mut accounts = self
                .created_accounts
                .get_mut()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            for account in [
                CA_CERT_ACCOUNT,
                CA_KEY_ACCOUNT,
                DEVICE_INDEX_ACCOUNT,
                RECOVERY_JOURNAL_ACCOUNT,
            ] {
                accounts.insert(account.to_string());
            }
            for index in 1..=12 {
                accounts.insert(device_token_account(&device_id(index)));
            }
            for account in accounts {
                // Cleanup of this test's own synthetic entries only; verified
                // and retried so a transient Credential Manager error cannot
                // leave test records behind.
                for _ in 0..8 {
                    let _ = self.native.delete_password(&account);
                    if matches!(self.native.get_password(&account), Ok(None)) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
    }

    impl CredentialStore for TestRemoteStore {
        fn get_password(&self, account: &str) -> Result<Option<String>, CredentialStoreError> {
            if self.fail_all_reads.load(Ordering::SeqCst) {
                return Err(CredentialStoreError::Unavailable);
            }
            self.native.get_password(account)
        }

        fn set_password(&self, account: &str, value: &str) -> Result<(), CredentialStoreError> {
            let index = self.mutation_gate()?;
            if lock(&self.failed_writes).contains(account) {
                return Err(CredentialStoreError::Unavailable);
            }
            lock(&self.created_accounts).insert(account.to_string());
            self.native.set_password(account, value)?;
            if lock(&self.write_then_fail).contains(account) {
                return Err(CredentialStoreError::Unavailable);
            }
            self.mutation_done(index);
            Ok(())
        }

        fn delete_password(&self, account: &str) -> Result<(), CredentialStoreError> {
            let index = self.mutation_gate()?;
            if lock(&self.failed_deletes).contains(account) {
                return Err(CredentialStoreError::Unavailable);
            }
            self.native.delete_password(account)?;
            self.mutation_done(index);
            Ok(())
        }
    }

    /// One "machine": a credential service plus the state lock every process
    /// of that machine shares.
    struct TestEnv {
        store: Arc<TestRemoteStore>,
        lock_path: PathBuf,
        /// Declared last so it is released after the store has cleaned up.
        _turn: NativeStoreTurn,
    }

    thread_local! {
        static TURNS_HELD_BY_THIS_THREAD: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    /// Re-entrant for one thread (a test may create several environments),
    /// exclusive between threads.
    struct NativeStoreTurn {
        _guard: Option<MutexGuard<'static, ()>>,
    }

    impl NativeStoreTurn {
        fn take() -> Self {
            let first = TURNS_HELD_BY_THIS_THREAD.with(|held| {
                held.set(held.get() + 1);
                held.get() == 1
            });
            Self {
                _guard: first.then(|| lock(&NATIVE_STORE_TURN)),
            }
        }
    }

    impl Drop for NativeStoreTurn {
        fn drop(&mut self) {
            TURNS_HELD_BY_THIS_THREAD.with(|held| held.set(held.get() - 1));
        }
    }

    impl TestEnv {
        fn new(label: &str) -> Self {
            let turn = NativeStoreTurn::take();
            let store = TestRemoteStore::new(label);
            let mut lock_path = std::env::temp_dir();
            lock_path.push(format!("velora-remote-test-{}", store.service));
            lock_path.push("state.lock");
            Self {
                store,
                lock_path,
                _turn: turn,
            }
        }

        /// A new process-equivalent: its own cache and in-process mutexes, the
        /// shared credential store and the shared cross-process lock.
        fn remote(&self) -> RemoteAccess {
            let remote = RemoteAccess::with_credential_store(
                self.store.clone(),
                Arc::new(FileStateLock::new(&self.lock_path)),
            );
            lock(&remote.inner.status).enabled = true;
            remote
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            if let Some(parent) = self.lock_path.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    fn device_id(index: u64) -> String {
        format!("{index:032x}")
    }

    fn device_token(index: u64) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        URL_SAFE_NO_PAD.encode([index as u8; 32])
    }

    fn sign_command(index: u64, sequence: u64, command: &RemoteCommand) -> Vec<u8> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let token = URL_SAFE_NO_PAD
            .decode(device_token(index))
            .expect("synthetic token");
        let mut mac = Hmac::<Sha256>::new_from_slice(&token).expect("synthetic HMAC key");
        mac.update(remote_command_payload(&device_id(index), sequence, command).as_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    fn pair_test_device(remote: &RemoteAccess, index: u64, name: &str) -> Result<(), StatusCode> {
        let address = IpAddr::V4(Ipv4Addr::new(198, 51, 100, index as u8));
        *lock(&remote.inner.pairing) = Some(PairingCode {
            value: "synthetic-pair-code".into(),
            expires_at: Instant::now() + PAIRING_TTL,
        });
        remote.pair(
            address,
            "synthetic-pair-code",
            &device_id(index),
            name,
            &device_token(index),
        )
    }

    /// A process with a real, valid CA and `devices` paired test devices.
    fn seeded(env: &TestEnv, devices: u64) -> RemoteAccess {
        let remote = env.remote();
        remote.ensure_trust_material().expect("create a real test CA");
        for index in 1..=devices {
            pair_test_device(&remote, index, "Synthetic Remote").expect("pair a test device");
        }
        remote
    }

    fn command_result(
        remote: &RemoteAccess,
        index: u64,
        sequence: u64,
    ) -> Result<CommandReservation, StatusCode> {
        let command = RemoteCommand::VolumeUp;
        remote.authenticate_command(
            &device_id(index),
            sequence,
            &command,
            &sign_command(index, sequence, &command),
        )
    }

    fn execute(previous_sequence: u64) -> Result<CommandReservation, StatusCode> {
        Ok(CommandReservation::Execute { previous_sequence })
    }

    fn stored(store: &dyn CredentialStore) -> Vault {
        load_vault(store).unwrap_or_else(|error| panic!("stored state must load: {error}"))
    }

    fn stored_sequence(store: &dyn CredentialStore, index: u64) -> u64 {
        stored(store)
            .devices
            .iter()
            .find(|device| device.id == device_id(index))
            .map(|device| device.last_sequence)
            .expect("device is stored")
    }

    fn fingerprint(value: &str) -> String {
        Sha256::digest(value.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn run_recovery_now(remote: &RemoteAccess, mode: &str) -> Result<RemoteAccessStatus, String> {
        let plan = remote.inspect_recovery().expect("inspect");
        remote.run_recovery(mode, &plan.confirmation)
    }

    // ------------------------------------------------------------------
    // CA validation
    // ------------------------------------------------------------------

    #[test]
    fn a_real_ca_is_accepted_and_its_key_is_matched_to_the_certificate() {
        let (cert, key) = generate_ca_material().expect("generate");
        validate_ca_material(&cert, &key).expect("a generated CA is valid");
        let der = der_from_pem(&cert).unwrap();
        let from_certificate = certificate_public_key_info(&der).expect("certificate key info");
        let from_key = rcgen::KeyPair::from_pem(&key).unwrap().public_key_der();
        assert_eq!(from_certificate, from_key);

        let (_, other_key) = generate_ca_material().expect("generate another");
        assert!(validate_ca_material(&cert, &other_key)
            .unwrap_err()
            .contains("nie pasuje"));
    }

    #[test]
    fn invalid_expired_or_non_ca_material_is_rejected() {
        use rcgen::{CertificateParams, IsCa, KeyPair};
        use time::{Duration as TimeDuration, OffsetDateTime};

        let (cert, key) = generate_ca_material().expect("generate");
        for (certificate, private_key) in [
            ("synthetic test certificate", key.as_str()),
            (cert.as_str(), "synthetic test private key"),
            ("-----BEGIN CERTIFICATE-----\n%%%%\n-----END CERTIFICATE-----", key.as_str()),
            ("", ""),
        ] {
            assert!(validate_ca_material(certificate, private_key).is_err());
        }

        let expired_key = KeyPair::generate().unwrap();
        let mut expired = CertificateParams::default();
        expired.not_before = OffsetDateTime::now_utc() - TimeDuration::days(10);
        expired.not_after = OffsetDateTime::now_utc() - TimeDuration::days(1);
        expired.is_ca = IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
        let expired_cert = expired.self_signed(&expired_key).unwrap();
        assert!(
            validate_ca_material(&expired_cert.pem(), &expired_key.serialize_pem())
                .unwrap_err()
                .contains("wygasł")
        );

        let leaf_key = KeyPair::generate().unwrap();
        let mut leaf = CertificateParams::default();
        leaf.is_ca = IsCa::NoCa;
        let leaf_cert = leaf.self_signed(&leaf_key).unwrap();
        assert!(validate_ca_material(&leaf_cert.pem(), &leaf_key.serialize_pem()).is_err());
    }

    #[test]
    fn lan_http_routes_expose_no_recovery_or_admin_operation() {
        let source = include_str!("remote_access.rs");
        let mut routes: Vec<&str> = source
            .lines()
            .filter_map(|line| line.trim().strip_prefix(".route(\""))
            .filter_map(|rest| rest.split('"').next())
            .collect();
        routes.sort_unstable();
        let mut expected = vec![
            "/",
            "/index.html",
            "/app.js",
            "/style.css",
            "/manifest.webmanifest",
            "/sw.js",
            "/icon.svg",
            "/api/status",
            "/api/pair",
            "/api/command",
        ];
        expected.sort_unstable();
        assert_eq!(routes, expected, "a new LAN route needs a security review");
        let router_start = source.find("let router = Router::new()").unwrap();
        let router_end = source[router_start..]
            .find("middleware::from_fn_with_state")
            .unwrap();
        let router = &source[router_start..router_start + router_end];
        for forbidden in ["recovery", "revoke", "reset", "trust_profile"] {
            assert!(!router.contains(forbidden), "{forbidden} reachable from LAN");
        }
    }

    // ------------------------------------------------------------------
    // Stored-state format
    // ------------------------------------------------------------------

    #[test]
    fn maximum_index_with_revision_stays_within_the_credential_limit() {
        let devices: Vec<PairedDevice> = (1..=MAX_PAIRED_DEVICES as u64)
            .map(|index| PairedDevice {
                id: device_id(index),
                name: "N".repeat(32),
                token: device_token(index),
                last_sequence: u64::MAX,
            })
            .collect();
        let text = index_text(&devices, u64::MAX).unwrap();
        assert!(credential_password_size_bytes(&text) <= MAX_CREDENTIAL_PASSWORD_BYTES);
    }

    #[test]
    fn an_index_without_a_revision_loads_as_revision_zero() {
        let env = TestEnv::new("legacy-index");
        let remote = seeded(&env, 1);
        let legacy = format!(
            "{{\"version\":2,\"devices\":[{{\"id\":\"{}\",\"name\":\"Synthetic Remote\",\"lastSequence\":4}}]}}",
            device_id(1)
        );
        env.store.raw_set(DEVICE_INDEX_ACCOUNT, &legacy);
        let vault = stored(env.store.as_ref());
        assert_eq!(vault.revision, 0);
        assert_eq!(vault.devices[0].last_sequence, 4);
        drop(remote);
    }

    #[test]
    fn missing_ca_with_paired_devices_fails_closed_instead_of_rotating_trust() {
        use std::collections::HashMap;

        #[derive(Default)]
        struct SyntheticStore(Mutex<HashMap<String, String>>);

        impl CredentialStore for SyntheticStore {
            fn get_password(&self, account: &str) -> Result<Option<String>, CredentialStoreError> {
                Ok(lock(&self.0).get(account).cloned())
            }

            fn set_password(&self, account: &str, value: &str) -> Result<(), CredentialStoreError> {
                lock(&self.0).insert(account.to_string(), value.to_string());
                Ok(())
            }

            fn delete_password(&self, account: &str) -> Result<(), CredentialStoreError> {
                lock(&self.0).remove(account);
                Ok(())
            }
        }

        let store = SyntheticStore::default();
        let device = PairedDevice {
            id: device_id(1),
            name: "Synthetic Remote".into(),
            token: device_token(1),
            last_sequence: 0,
        };
        store
            .set_password(DEVICE_INDEX_ACCOUNT, &index_text(&[device], 1).unwrap())
            .unwrap();
        store
            .set_password(&device_token_account(&device_id(1)), &device_token(1))
            .unwrap();

        let error = match load_vault(&store) {
            Ok(_) => panic!("missing CA with a paired device must fail closed"),
            Err(error) => error,
        };
        assert!(error.message.contains("Brakuje trwałego CA"));
        assert!(error.message.contains("Serwer pozostaje wyłączony"));
        assert_eq!(error.fault, StoreFault::IndexDamaged);
        assert!(store
            .get_password(&device_token_account(&device_id(1)))
            .unwrap()
            .is_some());
    }

    // ------------------------------------------------------------------
    // Persistence through restart, revoke and a separate process
    // ------------------------------------------------------------------

    const PROBE_ENV: &str = "VELORA_TEST_REMOTE_PROBE";

    #[test]
    fn credential_vault_process_probe() {
        let Ok(spec) = std::env::var(PROBE_ENV) else {
            return;
        };
        let mut parts = spec.split('|');
        let (service, count, sequence, fingerprint_value) = (
            parts.next().unwrap(),
            parts.next().unwrap().parse::<usize>().unwrap(),
            parts.next().unwrap().parse::<u64>().unwrap(),
            parts.next().unwrap(),
        );
        let vault = load_vault(&WindowsCredentialStore::new(service))
            .expect("read the test vault in a separate process");
        assert_eq!(vault.devices.len(), count);
        assert_eq!(
            vault
                .devices
                .first()
                .map(|device| device.last_sequence)
                .unwrap_or(0),
            sequence
        );
        assert_eq!(
            vault.ca_cert_pem.as_deref().map(fingerprint).as_deref(),
            Some(fingerprint_value)
        );
    }

    fn run_vault_probe(service: &str, device_count: usize, first_sequence: u64, ca: &str) {
        let status = Command::new(std::env::current_exe().expect("test executable path"))
            .arg("--exact")
            .arg("remote_access::windows_tests::credential_vault_process_probe")
            .arg("--nocapture")
            .env(
                PROBE_ENV,
                format!("{service}|{device_count}|{first_sequence}|{}", fingerprint(ca)),
            )
            .status()
            .expect("start a separate test process");
        assert!(
            status.success(),
            "a separate process could not read its test-only vault"
        );
    }

    #[test]
    fn windows_vault_persists_trust_devices_and_sequences_through_restart_and_revoke() {
        let env = TestEnv::new("vault");
        let remote = env.remote();
        assert!(stored(env.store.as_ref()).devices.is_empty());
        remote.ensure_trust_material().expect("create a real CA");
        let ca = stored(env.store.as_ref()).ca_cert_pem.expect("stored CA");
        assert_eq!(
            WindowsCredentialStore::new(env.store.service.clone())
                .get_password(CA_CERT_ACCOUNT)
                .unwrap(),
            Some(ca.clone())
        );

        let long_name = "Synthetic Remote Controller With A Name Longer Than Thirty Two Characters";
        pair_test_device(&remote, 1, long_name).expect("pair one synthetic device");
        assert_eq!(stored(env.store.as_ref()).devices.len(), 1);
        for index in 2..=MAX_PAIRED_DEVICES as u64 {
            pair_test_device(&remote, index, "Synthetic Remote Controller")
                .expect("pair within the eight-device limit");
        }
        assert_eq!(
            stored(env.store.as_ref()).devices.len(),
            MAX_PAIRED_DEVICES
        );
        assert_eq!(lock(&remote.inner.vault).devices[0].name.len(), 32);
        assert_eq!(
            pair_test_device(&remote, 9, "Ninth Device"),
            Err(StatusCode::CONFLICT)
        );

        {
            let (_guard, mut vault) = remote.locked_fresh(UI_LOCK_WAIT).unwrap();
            vault.devices[0].last_sequence = u64::MAX - 1;
            save_device_index(env.store.as_ref(), &mut vault).expect("persist maximum sequence");
            remote.publish(&vault);
        }
        assert_eq!(command_result(&remote, 1, u64::MAX), execute(u64::MAX - 1));
        let index_json = env
            .store
            .get_password(DEVICE_INDEX_ACCOUNT)
            .unwrap()
            .expect("device index");
        assert!(credential_password_size_bytes(&index_json) <= MAX_CREDENTIAL_PASSWORD_BYTES);

        // Replay after a restart: a new process has no receipts and no cache.
        let restarted = env.remote();
        restarted.refresh_cache(UI_LOCK_WAIT).expect("reload through a new handle");
        assert_eq!(
            lock(&restarted.inner.vault).devices[0].last_sequence,
            u64::MAX
        );
        assert_eq!(
            command_result(&restarted, 1, u64::MAX),
            Err(StatusCode::CONFLICT)
        );
        run_vault_probe(&env.store.service, MAX_PAIRED_DEVICES, u64::MAX, &ca);

        remote
            .revoke_device(&device_id(8))
            .expect("revoke one test device");
        assert_eq!(
            stored(env.store.as_ref()).devices.len(),
            MAX_PAIRED_DEVICES - 1
        );
        assert!(env
            .store
            .get_password(&device_token_account(&device_id(8)))
            .unwrap()
            .is_none());

        remote.revoke_all().expect("revoke all test devices");
        assert!(stored(env.store.as_ref()).devices.is_empty());
        run_vault_probe(&env.store.service, 0, 0, &ca);

        for account in [CA_CERT_ACCOUNT, CA_KEY_ACCOUNT, DEVICE_INDEX_ACCOUNT] {
            let value = env
                .store
                .get_password(account)
                .unwrap()
                .expect("persisted test account");
            assert!(credential_password_size_bytes(&value) <= MAX_CREDENTIAL_PASSWORD_BYTES);
        }
    }

    // ------------------------------------------------------------------
    // F01 — anti-replay across processes
    // ------------------------------------------------------------------

    #[test]
    fn stale_cache_cannot_lower_a_sequence_or_resurrect_a_revoked_device() {
        let env = TestEnv::new("stale-cache");
        let a = seeded(&env, 2);
        for sequence in 1..=10 {
            assert_eq!(command_result(&a, 1, sequence), execute(sequence - 1));
        }
        // B starts from the same stored state: D1 at 10, D2 paired.
        let b = env.remote();
        b.refresh_cache(UI_LOCK_WAIT).unwrap();
        assert_eq!(lock(&b.inner.vault).devices[0].last_sequence, 10);

        // A accepts 11. B still holds the older cache and revokes the other device.
        assert_eq!(command_result(&a, 1, 11), execute(10));
        b.revoke_device(&device_id(2)).expect("revoke D2 with an older cache");

        // The audited failure was 11 -> 10 here.
        assert_eq!(stored_sequence(env.store.as_ref(), 1), 11);
        assert_eq!(stored(env.store.as_ref()).devices.len(), 1);
        assert_eq!(lock(&b.inner.vault).devices[0].last_sequence, 11);

        // After a restart the used sequence is not accepted again and older ones are rejected.
        let restarted = env.remote();
        assert_eq!(command_result(&restarted, 1, 11), Err(StatusCode::CONFLICT));
        assert_eq!(command_result(&restarted, 1, 10), Err(StatusCode::UNAUTHORIZED));
        assert_eq!(command_result(&restarted, 1, 12), execute(11));

        // A's cache still lists the revoked D2; the stored state decides.
        assert_eq!(command_result(&a, 2, 1), Err(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn revoked_device_stays_revoked_when_token_cleanup_failed_and_an_older_writer_runs() {
        let env = TestEnv::new("revoke-older-writer");
        let a = seeded(&env, 2);
        let b = env.remote();
        b.refresh_cache(UI_LOCK_WAIT).unwrap(); // B caches D1 and D2

        env.store.fail_delete(&device_token_account(&device_id(1)));
        let error = a.revoke_device(&device_id(1)).unwrap_err();
        assert!(error.contains("zostało odwołane"));
        assert!(env
            .store
            .get_password(&device_token_account(&device_id(1)))
            .unwrap()
            .is_some());

        // B still believes D1 exists and performs a whole-index change.
        b.revoke_device(&device_id(2)).expect("older writer revokes D2");
        let after = stored(env.store.as_ref());
        assert!(after.devices.is_empty(), "D1 must not return to the index");
        assert_eq!(command_result(&b, 1, 1), Err(StatusCode::UNAUTHORIZED));
        assert_eq!(
            command_result(&env.remote(), 1, 1),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn a_store_that_moves_backwards_while_running_is_detected_and_recoverable() {
        let env = TestEnv::new("rollback");
        let a = seeded(&env, 1);
        for sequence in 1..=3 {
            assert_eq!(command_result(&a, 1, sequence), execute(sequence - 1));
        }
        let old_index = env.store.raw_get(DEVICE_INDEX_ACCOUNT).unwrap();
        assert_eq!(command_result(&a, 1, 4), execute(3));
        env.store.raw_set(DEVICE_INDEX_ACCOUNT, &old_index); // an older backup comes back

        assert_eq!(command_result(&a, 1, 5), Err(StatusCode::SERVICE_UNAVAILABLE));
        let status = a.status();
        assert_eq!(status.store_state, "rolled-back");
        assert!(status.recovery_required);

        let plan = a.inspect_recovery().unwrap();
        assert_eq!(plan.store_state, "rolled-back");
        assert!(plan.options.iter().any(|o| o.mode == "revoke-all-devices"));
        a.run_recovery("revoke-all-devices", &plan.confirmation)
            .expect("controlled revoke-all");
        assert_eq!(a.status().store_state, "ok");
        assert!(stored(env.store.as_ref()).devices.is_empty());
        lock(&a.inner.status).enabled = true; // recovery stopped the server
        assert_eq!(command_result(&a, 1, 5), Err(StatusCode::UNAUTHORIZED));
        // The revision never goes below what any process saw.
        assert!(stored(env.store.as_ref()).revision > 5);
    }

    fn spawn_child(env: &TestEnv, role: &str, dir: &Path, arg: &str, abort_after: usize) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("test executable path"));
        command
            .arg("--exact")
            .arg("remote_access::windows_tests::process_role_child")
            .arg("--nocapture")
            .env(CHILD_SERVICE_ENV, &env.store.service)
            .env(CHILD_LOCK_ENV, &env.lock_path)
            .env(CHILD_ROLE_ENV, role)
            .env(CHILD_DIR_ENV, dir)
            .env(CHILD_ARG_ENV, arg)
            .env("VELORA_TEST_CHILD_ABORT_AFTER", abort_after.to_string());
        command
    }

    fn wait_for(path: &Path) {
        let started = Instant::now();
        while !path.exists() {
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "timed out waiting for {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn sync_dir(env: &TestEnv, label: &str) -> PathBuf {
        let mut dir = env.lock_path.parent().unwrap().to_path_buf();
        dir.push(label);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Runs inside a separate OS process started by the tests below.
    #[test]
    fn process_role_child() {
        let (Ok(service), Ok(lock_path), Ok(role), Ok(dir), Ok(arg)) = (
            std::env::var(CHILD_SERVICE_ENV),
            std::env::var(CHILD_LOCK_ENV),
            std::env::var(CHILD_ROLE_ENV),
            std::env::var(CHILD_DIR_ENV),
            std::env::var(CHILD_ARG_ENV),
        ) else {
            return;
        };
        let abort_after = std::env::var("VELORA_TEST_CHILD_ABORT_AFTER")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(NEVER);
        let dir = PathBuf::from(dir);
        let store = TestRemoteStore::attach(&service, abort_after);
        let remote = RemoteAccess::with_credential_store(
            store.clone(),
            Arc::new(FileStateLock::new(lock_path)),
        );
        lock(&remote.inner.status).enabled = true;
        match role.as_str() {
            "stale-revoke" => {
                remote.refresh_cache(UI_LOCK_WAIT).expect("child loads its cache");
                std::fs::write(dir.join("ready"), b"1").unwrap();
                wait_for(&dir.join("go"));
                remote
                    .revoke_device(&device_id(2))
                    .expect("child revokes with an older cache");
            }
            "sequences" => {
                let mut parts = arg.split(',');
                let (start, end, tag) = (
                    parts.next().unwrap().parse::<u64>().unwrap(),
                    parts.next().unwrap().parse::<u64>().unwrap(),
                    parts.next().unwrap().to_string(),
                );
                std::fs::write(dir.join(format!("started-{tag}")), b"1").unwrap();
                wait_for(&dir.join("go"));
                let mut accepted = String::new();
                for sequence in start..=end {
                    loop {
                        match command_result(&remote, 1, sequence) {
                            Err(StatusCode::TOO_MANY_REQUESTS) => {
                                std::thread::sleep(Duration::from_millis(60));
                            }
                            Ok(CommandReservation::Execute { .. }) => {
                                accepted.push_str(&format!("{sequence}\n"));
                                break;
                            }
                            _ => break,
                        }
                    }
                }
                std::fs::write(dir.join(format!("accepted-{tag}")), accepted).unwrap();
            }
            "command" => {
                let sequence: u64 = arg.parse().unwrap();
                let _ = command_result(&remote, 1, sequence);
            }
            "revoke" => {
                let _ = remote.revoke_device(&device_id(arg.parse().unwrap()));
            }
            "recovery" => {
                let plan = remote.inspect_recovery().unwrap();
                let _ = remote.run_recovery(&arg, &plan.confirmation);
            }
            other => panic!("unknown child role {other}"),
        }
    }

    #[test]
    fn two_real_processes_cannot_lower_a_sequence_with_an_older_cache() {
        let env = TestEnv::new("two-processes");
        let a = seeded(&env, 2);
        for sequence in 1..=10 {
            assert_eq!(command_result(&a, 1, sequence), execute(sequence - 1));
        }
        let dir = sync_dir(&env, "stale");
        let mut child = spawn_child(&env, "stale-revoke", &dir, "", NEVER)
            .spawn()
            .expect("start the second VELORA process");
        wait_for(&dir.join("ready")); // the child now holds D1 at 10 in its cache

        assert_eq!(command_result(&a, 1, 11), execute(10));
        std::fs::write(dir.join("go"), b"1").unwrap();
        assert!(child.wait().unwrap().success());

        assert_eq!(stored_sequence(env.store.as_ref(), 1), 11);
        assert_eq!(stored(env.store.as_ref()).devices.len(), 1);
        let restarted = env.remote();
        assert_eq!(command_result(&restarted, 1, 11), Err(StatusCode::CONFLICT));
        assert_eq!(command_result(&restarted, 1, 10), Err(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn parallel_processes_never_accept_a_sequence_twice_or_lower_the_stored_one() {
        let env = TestEnv::new("parallel");
        let a = seeded(&env, 1);
        drop(a);
        let dir = sync_dir(&env, "parallel");
        let mut children: Vec<_> = ["x", "y", "z"]
            .iter()
            .map(|tag| {
                spawn_child(&env, "sequences", &dir, &format!("1,30,{tag}"), NEVER)
                    .spawn()
                    .expect("start a competing process")
            })
            .collect();
        for tag in ["x", "y", "z"] {
            wait_for(&dir.join(format!("started-{tag}")));
        }
        let parent = env.remote();
        std::fs::write(dir.join("go"), b"1").unwrap();

        let mut parent_accepted = Vec::new();
        let mut seen_revision = 0_u64;
        let mut seen_sequence = 0_u64;
        for sequence in 1..=30 {
            loop {
                match command_result(&parent, 1, sequence) {
                    Err(StatusCode::TOO_MANY_REQUESTS) => {
                        std::thread::sleep(Duration::from_millis(60));
                    }
                    Ok(CommandReservation::Execute { .. }) => {
                        parent_accepted.push(sequence);
                        break;
                    }
                    _ => break,
                }
            }
            let now = stored(env.store.as_ref());
            assert!(now.revision >= seen_revision, "revision went backwards");
            assert!(
                now.devices[0].last_sequence >= seen_sequence,
                "stored sequence went backwards"
            );
            seen_revision = now.revision;
            seen_sequence = now.devices[0].last_sequence;
        }
        for child in &mut children {
            assert!(child.wait().unwrap().success());
        }

        let mut all = parent_accepted;
        for tag in ["x", "y", "z"] {
            let text = std::fs::read_to_string(dir.join(format!("accepted-{tag}"))).unwrap();
            all.extend(text.lines().map(|line| line.parse::<u64>().unwrap()));
        }
        let unique: HashSet<u64> = all.iter().copied().collect();
        assert_eq!(unique.len(), all.len(), "a sequence was accepted twice: {all:?}");
        assert_eq!(all.iter().copied().max(), Some(30));
        assert_eq!(stored_sequence(env.store.as_ref(), 1), 30);
    }

    #[test]
    fn a_process_killed_mid_write_never_lowers_state_and_releases_the_lock() {
        // (role, argument, mutations before the kill)
        let cases: [(&str, &str, usize); 4] = [
            ("command", "5", 1),
            ("revoke", "2", 1),
            ("revoke", "2", 2),
            ("command", "5", 1),
        ];
        for (role, arg, abort_after) in cases {
            let env = TestEnv::new("killed");
            let a = seeded(&env, 2);
            for sequence in 1..=4 {
                assert_eq!(command_result(&a, 1, sequence), execute(sequence - 1));
            }
            let dir = sync_dir(&env, "killed");
            let status = spawn_child(&env, role, &dir, arg, abort_after)
                .status()
                .expect("start the process that will be killed");
            assert_eq!(status.code(), Some(86), "the child must have been killed mid-write");

            // The OS released the killed process's lock, and the state is readable.
            let probe = FileStateLock::new(&env.lock_path);
            let _guard = probe
                .acquire(Duration::from_secs(2))
                .expect("lock released by the dead process");
            let after = stored(env.store.as_ref());
            let d1 = after.devices.iter().find(|d| d.id == device_id(1)).unwrap();
            assert!(d1.last_sequence >= 4, "{role}: sequence went backwards");
            assert!(d1.last_sequence <= 5);
            drop(_guard);

            // A restarted process never accepts a consumed sequence again.
            let restarted = env.remote();
            if role == "command" {
                assert_eq!(d1.last_sequence, 5);
                assert_eq!(command_result(&restarted, 1, 5), Err(StatusCode::CONFLICT));
            }
            assert_eq!(command_result(&restarted, 1, 3), Err(StatusCode::UNAUTHORIZED));
        }
    }

    // ------------------------------------------------------------------
    // Credential Manager and lock failures
    // ------------------------------------------------------------------

    #[test]
    fn failed_credential_writes_never_report_pair_or_advance_sequence() {
        let failed_ca_key = TestEnv::new("fail-ca-key");
        failed_ca_key.store.fail_write(CA_KEY_ACCOUNT);
        assert!(failed_ca_key.remote().ensure_trust_material().is_err());
        assert!(failed_ca_key.store.get_password(CA_CERT_ACCOUNT).unwrap().is_none());
        assert!(failed_ca_key.store.get_password(CA_KEY_ACCOUNT).unwrap().is_none());

        let failed_ca_cert = TestEnv::new("fail-ca-cert");
        failed_ca_cert.store.fail_write(CA_CERT_ACCOUNT);
        assert!(failed_ca_cert.remote().ensure_trust_material().is_err());
        assert!(failed_ca_cert.store.get_password(CA_CERT_ACCOUNT).unwrap().is_none());
        assert!(failed_ca_cert.store.get_password(CA_KEY_ACCOUNT).unwrap().is_none());

        let failed_token = TestEnv::new("fail-device-token");
        let remote = seeded(&failed_token, 0);
        failed_token.store.fail_write(&device_token_account(&device_id(1)));
        assert_eq!(
            pair_test_device(&remote, 1, "Synthetic Remote"),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert!(stored(failed_token.store.as_ref()).devices.is_empty());

        let failed_index = TestEnv::new("fail-pair-index");
        let remote = seeded(&failed_index, 0);
        failed_index.store.fail_write(DEVICE_INDEX_ACCOUNT);
        assert_eq!(
            pair_test_device(&remote, 1, "Synthetic Remote"),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert!(failed_index
            .store
            .get_password(&device_token_account(&device_id(1)))
            .unwrap()
            .is_none());
        assert!(stored(failed_index.store.as_ref()).devices.is_empty());

        let sequence_env = TestEnv::new("fail-sequence-index");
        let remote = seeded(&sequence_env, 1);
        sequence_env.store.fail_write(DEVICE_INDEX_ACCOUNT);
        assert_eq!(
            command_result(&remote, 1, 1),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert_eq!(lock(&remote.inner.vault).devices[0].last_sequence, 0);
        assert_eq!(stored_sequence(sequence_env.store.as_ref(), 1), 0);
    }

    #[test]
    fn a_write_that_reaches_credential_manager_but_reports_an_error_never_executes_twice() {
        let env = TestEnv::new("write-then-error");
        let remote = seeded(&env, 1);
        lock(&env.store.write_then_fail).insert(DEVICE_INDEX_ACCOUNT.to_string());
        assert_eq!(
            command_result(&remote, 1, 1),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        // The error was reported, but the reservation did reach the store.
        assert_eq!(stored_sequence(env.store.as_ref(), 1), 1);
        lock(&env.store.write_then_fail).clear();
        assert_eq!(command_result(&remote, 1, 1), Err(StatusCode::CONFLICT));
        assert_eq!(command_result(&remote, 1, 2), execute(1));
    }

    #[test]
    fn credential_manager_read_errors_close_the_service_without_offering_a_reset() {
        let env = TestEnv::new("read-errors");
        let remote = seeded(&env, 1);
        env.store.fail_all_reads.store(true, Ordering::SeqCst);

        assert_eq!(command_result(&remote, 1, 1), Err(StatusCode::SERVICE_UNAVAILABLE));
        assert_eq!(
            pair_test_device(&remote, 2, "Synthetic Remote"),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert!(remote.revoke_all().is_err());
        let status = remote.status();
        assert_eq!(status.store_state, "unavailable");
        assert!(!status.recovery_required, "an unreadable store is not damaged");
        let plan = remote.inspect_recovery().unwrap();
        assert!(plan.options.is_empty());
        assert!(plan.confirmation.is_empty());
        assert!(remote.run_recovery("reset-trust", "ANYCODE1").is_err());

        env.store.fail_all_reads.store(false, Ordering::SeqCst);
        assert_eq!(stored_sequence(env.store.as_ref(), 1), 0);
        assert_eq!(command_result(&remote, 1, 1), execute(0));
        assert_eq!(remote.status().store_state, "ok");
    }

    #[test]
    fn without_the_cross_process_lock_every_state_operation_is_refused_untouched() {
        let env = TestEnv::new("no-lock");
        let seeded_remote = seeded(&env, 1);
        let writes_before = env.store.mutations.load(Ordering::SeqCst);
        let remote = RemoteAccess::with_credential_store(
            env.store.clone(),
            Arc::new(UnavailableStateLock),
        );
        lock(&remote.inner.status).enabled = true;
        assert_eq!(command_result(&remote, 1, 1), Err(StatusCode::SERVICE_UNAVAILABLE));
        assert_eq!(
            pair_test_device(&remote, 2, "Synthetic Remote"),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert!(remote.revoke_device(&device_id(1)).is_err());
        assert!(remote.revoke_all().is_err());
        assert!(remote.ensure_trust_material().is_err());
        assert!(remote.run_recovery("reset-trust", "ANYCODE1").is_err());
        assert_eq!(remote.status().store_state, "locked");
        assert_eq!(env.store.mutations.load(Ordering::SeqCst), writes_before);
        drop(seeded_remote);
    }

    #[test]
    fn a_busy_lock_rejects_commands_and_pairing_and_leaves_state_unchanged() {
        let env = TestEnv::new("busy-lock");
        let remote = seeded(&env, 1);
        let holder = FileStateLock::new(&env.lock_path);
        let _held = holder.acquire(Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        assert_eq!(command_result(&remote, 1, 1), Err(StatusCode::SERVICE_UNAVAILABLE));
        assert_eq!(
            pair_test_device(&remote, 2, "Synthetic Remote"),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        drop(_held);
        assert_eq!(stored_sequence(env.store.as_ref(), 1), 0);
        assert_eq!(command_result(&remote, 1, 1), execute(0));
    }

    #[test]
    fn revoke_write_failure_is_visible_and_failed_cleanup_stays_revoked() {
        let env = TestEnv::new("revoke-errors");
        let remote = seeded(&env, 1);

        env.store.fail_write(DEVICE_INDEX_ACCOUNT);
        assert!(remote.revoke_device(&device_id(1)).is_err());
        assert_eq!(lock(&remote.inner.vault).devices.len(), 1);
        assert_eq!(stored(env.store.as_ref()).devices.len(), 1);
        lock(&env.store.failed_writes).remove(DEVICE_INDEX_ACCOUNT);

        env.store.fail_delete(&device_token_account(&device_id(1)));
        let error = remote.revoke_device(&device_id(1)).unwrap_err();
        assert!(error.contains("zostało odwołane"));
        assert!(lock(&remote.inner.vault).devices.is_empty());
        assert!(stored(env.store.as_ref()).devices.is_empty());
        assert!(env
            .store
            .get_password(&device_token_account(&device_id(1)))
            .unwrap()
            .is_some());
    }

    #[test]
    fn a_released_reservation_is_lowered_only_if_the_stored_sequence_is_still_the_reserved_one() {
        let env = TestEnv::new("release");
        let a = seeded(&env, 1);
        assert_eq!(command_result(&a, 1, 1), execute(0));
        a.rollback_command_reservation(&device_id(1), 1, 0);
        assert_eq!(stored_sequence(env.store.as_ref(), 1), 0);

        // Another process moves on to 2; a late release of 1 must change nothing.
        assert_eq!(command_result(&a, 1, 1), execute(0));
        let other = env.remote();
        assert_eq!(command_result(&other, 1, 2), execute(1));
        a.rollback_command_reservation(&device_id(1), 1, 0);
        assert_eq!(stored_sequence(env.store.as_ref(), 1), 2);
        // A release can never raise or keep a sequence at or above the reserved one.
        a.rollback_command_reservation(&device_id(1), 2, 2);
        assert_eq!(stored_sequence(env.store.as_ref(), 1), 2);
    }

    // ------------------------------------------------------------------
    // F02 — recovery of damaged or partial state
    // ------------------------------------------------------------------

    fn assert_recovered_without_secrets(env: &TestEnv, ids: std::ops::RangeInclusive<u64>) {
        let vault = stored(env.store.as_ref());
        assert!(vault.devices.is_empty());
        assert!(env.store.get_password(RECOVERY_JOURNAL_ACCOUNT).unwrap().is_none());
        for index in ids {
            assert!(env
                .store
                .get_password(&device_token_account(&device_id(index)))
                .unwrap()
                .is_none());
        }
    }

    #[test]
    fn damaged_ca_states_block_the_service_and_reset_trust_restores_a_new_set() {
        type Damage = fn(&TestRemoteStore);
        let scenarios: [(&str, Damage); 5] = [
            ("missing certificate", |s| s.raw_delete(CA_CERT_ACCOUNT)),
            ("missing key", |s| s.raw_delete(CA_KEY_ACCOUNT)),
            ("non-PEM values", |s| {
                s.raw_set(CA_CERT_ACCOUNT, "synthetic test certificate");
                s.raw_set(CA_KEY_ACCOUNT, "synthetic test private key");
            }),
            ("key of another CA", |s| {
                let (_, other_key) = generate_ca_material().unwrap();
                s.raw_set(CA_KEY_ACCOUNT, &other_key);
            }),
            ("truncated certificate", |s| {
                let cert = s.raw_get(CA_CERT_ACCOUNT).unwrap();
                s.raw_set(CA_CERT_ACCOUNT, &cert[..cert.len() / 2]);
            }),
        ];
        for (label, damage) in scenarios {
            let env = TestEnv::new("damaged-ca");
            let remote = seeded(&env, 2);
            let old_ca = env.store.raw_get(CA_CERT_ACCOUNT).unwrap();
            damage(env.store.as_ref());

            // Fail closed: the service and every operation are refused.
            let restarted = env.remote();
            assert_eq!(command_result(&restarted, 1, 1), Err(StatusCode::SERVICE_UNAVAILABLE), "{label}");
            assert!(restarted.ensure_trust_material().is_err(), "{label}: no silent rotation");
            let status = restarted.status();
            assert_eq!(status.store_state, "damaged", "{label}");
            assert!(status.recovery_required, "{label}");

            // The way out exists and is explicit.
            let plan = restarted.inspect_recovery().unwrap();
            assert_eq!(plan.options.len(), 1, "{label}");
            assert_eq!(plan.options[0].mode, "reset-trust", "{label}");
            assert!(restarted.run_recovery("reset-trust", "WRONGCODE").is_err());
            assert_eq!(restarted.status().store_state, "damaged", "wrong code changes nothing");
            let plan = restarted.inspect_recovery().unwrap();
            restarted
                .run_recovery("reset-trust", &plan.confirmation)
                .unwrap_or_else(|error| panic!("{label}: {error}"));
            assert!(restarted
                .run_recovery("reset-trust", &plan.confirmation)
                .is_err(), "a confirmation is single use");

            // Nothing is generated by the recovery itself.
            assert_recovered_without_secrets(&env, 1..=2);
            assert!(env.store.get_password(CA_CERT_ACCOUNT).unwrap().is_none());
            assert_eq!(restarted.status().store_state, "ok");
            // The old device no longer authorizes.
            lock(&restarted.inner.status).enabled = true; // recovery stopped the server
            assert_eq!(command_result(&restarted, 1, 1), Err(StatusCode::UNAUTHORIZED));
            assert_eq!(command_result(&remote, 1, 1), Err(StatusCode::UNAUTHORIZED));

            // A new, different CA appears only when the user prepares a profile.
            let (new_cert, _) = restarted.ensure_trust_material().unwrap();
            assert_ne!(new_cert, old_ca, "{label}");
            pair_test_device(&restarted, 3, "Synthetic Remote").expect("pair again");
            assert_eq!(command_result(&restarted, 3, 1), execute(0));
        }
    }

    #[test]
    fn damaged_index_or_token_states_are_cleared_by_revoke_all_which_keeps_the_ca() {
        type Damage = fn(&TestRemoteStore);
        let scenarios: [(&str, Damage); 6] = [
            ("token of one of three devices missing", |s| {
                s.raw_delete(&device_token_account(&device_id(2)))
            }),
            ("token not decodable", |s| {
                s.raw_set(&device_token_account(&device_id(3)), "%%%not-base64%%%")
            }),
            ("index is not JSON", |s| s.raw_set(DEVICE_INDEX_ACCOUNT, "not json")),
            ("unsupported index version", |s| {
                s.raw_set(DEVICE_INDEX_ACCOUNT, "{\"version\":9,\"devices\":[]}")
            }),
            ("duplicate device ids", |s| {
                let id = device_id(1);
                s.raw_set(
                    DEVICE_INDEX_ACCOUNT,
                    &format!(
                        "{{\"version\":2,\"revision\":3,\"devices\":[{{\"id\":\"{id}\",\"name\":\"A\",\"lastSequence\":0}},{{\"id\":\"{id}\",\"name\":\"B\",\"lastSequence\":0}}]}}"
                    ),
                )
            }),
            ("CA removed while devices are paired", |s| {
                s.raw_delete(CA_CERT_ACCOUNT);
                s.raw_delete(CA_KEY_ACCOUNT);
            }),
        ];
        for (label, damage) in scenarios {
            let env = TestEnv::new("damaged-index");
            let remote = seeded(&env, 3);
            damage(env.store.as_ref());
            let ca_before = env.store.raw_get(CA_CERT_ACCOUNT);

            assert_eq!(command_result(&remote, 1, 1), Err(StatusCode::SERVICE_UNAVAILABLE), "{label}");
            let plan = remote.inspect_recovery().unwrap();
            assert!(plan.recovery_required, "{label}");
            assert!(
                plan.options.iter().any(|o| o.mode == "revoke-all-devices"),
                "{label}: revoke-all must be possible from a damaged state"
            );
            remote
                .run_recovery("revoke-all-devices", &plan.confirmation)
                .unwrap_or_else(|error| panic!("{label}: {error}"));

            assert_recovered_without_secrets(&env, 1..=3);
            assert_eq!(env.store.raw_get(CA_CERT_ACCOUNT), ca_before, "{label}: CA untouched");
            assert_eq!(remote.status().store_state, "ok", "{label}");
            for index in 1..=3 {
                lock(&remote.inner.status).enabled = true; // recovery stopped the server
                assert_eq!(command_result(&remote, index, 1), Err(StatusCode::UNAUTHORIZED));
            }
        }
    }

    #[test]
    fn a_restarted_process_cleans_what_the_stored_index_still_names_and_orphans_never_authorize() {
        let env = TestEnv::new("restart-recovery");
        let _first = seeded(&env, 2);
        // The index becomes unreadable, so its device IDs are unknown after a restart.
        env.store.raw_set(DEVICE_INDEX_ACCOUNT, "not json");
        let restarted = env.remote();
        run_recovery_now(&restarted, "revoke-all-devices").expect("recover");
        assert!(stored(env.store.as_ref()).devices.is_empty());
        // Tokens that no readable record names may remain, but they cannot authorize.
        lock(&restarted.inner.status).enabled = true; // recovery stopped the server
        assert_eq!(command_result(&restarted, 1, 1), Err(StatusCode::UNAUTHORIZED));
        assert_eq!(restarted.status().store_state, "ok");
    }

    #[test]
    fn recovery_from_an_unreadable_index_starts_above_any_earlier_revision_so_an_older_vault_is_detected() {
        let env = TestEnv::new("revision-epoch");
        let first = seeded(&env, 2);
        for sequence in 1..=3 {
            assert_eq!(command_result(&first, 1, sequence), execute(sequence - 1));
        }
        // What a backup restore would bring back later: the vault as it is now.
        let old_index = env.store.raw_get(DEVICE_INDEX_ACCOUNT).unwrap();
        let old_revision = stored(env.store.as_ref()).revision;
        drop(first);

        // The index becomes unreadable and a fresh process (no cached revision)
        // recovers: the old revision cannot be read back from the damaged text.
        env.store.raw_set(DEVICE_INDEX_ACCOUNT, "not json");
        let restarted = env.remote();
        run_recovery_now(&restarted, "revoke-all-devices").expect("recover");
        let recovered = stored(env.store.as_ref()).revision;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(recovered > old_revision, "revision restarted at {recovered}, below the earlier {old_revision}");
        assert!(recovered + 60 >= now, "a revision after a lossy recovery starts at the clock epoch");

        // An older vault restored while the process runs would silently
        // re-trust the revoked device (its token entry is an orphan the
        // recovery could not name) as soon as the UI's status poll refreshes
        // the cache. It must be detected instead.
        lock(&restarted.inner.status).enabled = true; // recovery stopped the server
        env.store.raw_set(DEVICE_INDEX_ACCOUNT, &old_index);
        assert_eq!(
            restarted.status().store_state,
            "rolled-back",
            "an older vault must not be adopted after a recovery"
        );
        assert!(
            command_result(&restarted, 1, 4).is_err(),
            "the revoked device must not be accepted again"
        );

        // The revision still only moves forward across later recoveries.
        let plan = restarted.inspect_recovery().unwrap();
        restarted.run_recovery("revoke-all-devices", &plan.confirmation).expect("second recovery");
        assert!(stored(env.store.as_ref()).revision > recovered);
    }

    #[test]
    fn an_interrupted_recovery_keeps_the_store_closed_and_is_finished_by_running_it_again() {
        let prepare = |label: &str| {
            let env = TestEnv::new(label);
            let remote = seeded(&env, 2);
            env.store.raw_delete(CA_KEY_ACCOUNT); // incomplete CA
            drop(remote);
            env
        };

        // Count the mutations of an uninterrupted recovery.
        let probe = prepare("recovery-count");
        probe.store.mutations.store(0, Ordering::SeqCst);
        run_recovery_now(&probe.remote(), "reset-trust").expect("uninterrupted recovery");
        let total = probe.store.mutations.load(Ordering::SeqCst);
        assert!(total >= 6, "journal, index, tokens, CA entries, journal removal");

        for interrupted_at in 0..total {
            let env = prepare("recovery-interrupted");
            let device_token_before = env.store.raw_get(&device_token_account(&device_id(1)));
            env.store.mutations.store(0, Ordering::SeqCst);
            env.store.fail_from_mutation.store(interrupted_at, Ordering::SeqCst);
            let first = env.remote();
            assert!(
                run_recovery_now(&first, "reset-trust").is_err(),
                "interruption {interrupted_at} must be reported"
            );
            env.store.fail_from_mutation.store(NEVER, Ordering::SeqCst);

            let restarted = env.remote();
            if interrupted_at == 0 {
                // Nothing was written: nothing was lost.
                assert_eq!(
                    env.store.raw_get(&device_token_account(&device_id(1))),
                    device_token_before
                );
                assert!(env.store.raw_get(RECOVERY_JOURNAL_ACCOUNT).is_none());
            } else {
                assert!(
                    load_vault(env.store.as_ref()).is_err(),
                    "interruption {interrupted_at}: a half-reset store must stay closed"
                );
            }
            // Neither the old nor a half-reset device is ever accepted.
            let outcome = command_result(&restarted, 1, 1);
            assert!(
                matches!(
                    outcome,
                    Err(StatusCode::SERVICE_UNAVAILABLE | StatusCode::UNAUTHORIZED)
                ),
                "interruption {interrupted_at}: {outcome:?}"
            );

            // Running the recovery again finishes it.
            let plan = restarted.inspect_recovery().unwrap();
            assert!(!plan.options.is_empty());
            restarted
                .run_recovery("reset-trust", &plan.confirmation)
                .unwrap_or_else(|error| panic!("interruption {interrupted_at}: {error}"));
            assert_recovered_without_secrets(&env, 1..=2);
            assert!(env.store.get_password(CA_CERT_ACCOUNT).unwrap().is_none());
            assert_eq!(restarted.status().store_state, "ok");
        }
    }

    #[test]
    fn a_real_process_killed_during_recovery_leaves_a_closed_store_that_recovery_finishes() {
        for abort_after in 1..=6 {
            let env = TestEnv::new("recovery-killed");
            let remote = seeded(&env, 2);
            env.store.raw_delete(CA_CERT_ACCOUNT);
            drop(remote);
            let dir = sync_dir(&env, "recovery-killed");
            let status = spawn_child(&env, "recovery", &dir, "reset-trust", abort_after)
                .status()
                .expect("start the process that will be killed");
            assert_eq!(status.code(), Some(86), "child must be killed after {abort_after} writes");
            assert!(
                load_vault(env.store.as_ref()).is_err(),
                "after {abort_after} writes the store must be closed"
            );
            let restarted = env.remote();
            run_recovery_now(&restarted, "reset-trust").expect("finish the recovery");
            assert_recovered_without_secrets(&env, 1..=2);
            assert_eq!(restarted.status().store_state, "ok");
        }
    }

    #[test]
    fn recovery_stops_the_server_state_and_needs_the_issued_code() {
        let env = TestEnv::new("recovery-guard");
        let remote = seeded(&env, 1);
        *lock(&remote.inner.pairing) = Some(PairingCode {
            value: "123456".into(),
            expires_at: Instant::now() + PAIRING_TTL,
        });
        assert!(remote.run_recovery("reset-trust", "").is_err());
        assert!(remote.run_recovery("not-a-mode", "ABC").is_err());
        assert_eq!(stored(env.store.as_ref()).devices.len(), 1, "no code, no change");

        let plan = remote.inspect_recovery().unwrap();
        *lock(&remote.inner.recovery_confirmation) = Some((
            plan.confirmation.clone(),
            Instant::now()
                .checked_sub(Duration::from_secs(1))
                .unwrap_or_else(Instant::now),
        ));
        assert!(remote.run_recovery("reset-trust", &plan.confirmation).is_err());
        assert_eq!(stored(env.store.as_ref()).devices.len(), 1, "an expired code changes nothing");

        let plan = remote.inspect_recovery().unwrap();
        remote.run_recovery("revoke-all-devices", &plan.confirmation).unwrap();
        assert!(lock(&remote.inner.pairing).is_none());
        assert!(!lock(&remote.inner.status).enabled);
    }
}
