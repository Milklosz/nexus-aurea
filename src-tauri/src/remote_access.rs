#[cfg(windows)]
use crate::credential_store::{CredentialStore, CredentialStoreError, WindowsCredentialStore};
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

#[derive(Default)]
struct Vault {
    ca_cert_pem: Option<String>,
    ca_key_pem: Option<String>,
    devices: Vec<PairedDevice>,
}

#[cfg(windows)]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIndex {
    version: u8,
    devices: Vec<DeviceIndexRecord>,
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
    fn with_credential_store(credential_store: Arc<dyn CredentialStore>) -> Self {
        Self {
            status: Mutex::new(RemoteAccessStatus::default()),
            pairing: Mutex::new(None),
            server: Mutex::new(None),
            vault: Mutex::new(Vault::default()),
            vault_loaded: Mutex::new(false),
            credential_store,
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
        Self::with_credential_store(Arc::new(WindowsCredentialStore::new(CREDENTIAL_SERVICE)))
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
    fn with_credential_store(credential_store: Arc<dyn CredentialStore>) -> Self {
        Self {
            inner: Arc::new(RemoteInner::with_credential_store(credential_store)),
        }
    }

    pub fn status(&self) -> RemoteAccessStatus {
        #[cfg(windows)]
        if self.ensure_vault_loaded().is_ok() {
            let vault = lock(&self.inner.vault);
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
    fn ensure_vault_loaded(&self) -> Result<(), String> {
        let mut loaded = lock(&self.inner.vault_loaded);
        if *loaded {
            return Ok(());
        }
        let vault = load_vault(self.inner.credential_store.as_ref())?;
        *lock(&self.inner.vault) = vault;
        *loaded = true;
        Ok(())
    }

    #[cfg(windows)]
    pub fn prepare_trust_profile(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<RemoteAccessStatus, String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose};
        use sha2::{Digest, Sha256};
        use std::fs;
        use tauri::Manager;
        use time::{Duration as TimeDuration, OffsetDateTime};

        self.ensure_vault_loaded()?;
        let mut vault = lock(&self.inner.vault);
        if vault.ca_cert_pem.is_none() && vault.ca_key_pem.is_none() {
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
            let cert_pem = cert.pem();
            let key_pem = key.serialize_pem();
            persist_trust_material(self.inner.credential_store.as_ref(), &cert_pem, &key_pem)?;
            vault.ca_cert_pem = Some(cert_pem);
            vault.ca_key_pem = Some(key_pem);
        }
        let cert_pem = vault
            .ca_cert_pem
            .as_ref()
            .ok_or("Niekompletny certyfikat zaufania.")?;
        let cert_der = der_from_pem(cert_pem)?;
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
        self.ensure_vault_loaded()?;
        let (ip, host, origin) = local_remote_address()?;
        let (cert_pem, key_pem) = {
            let vault = lock(&self.inner.vault);
            let ca_cert = vault
                .ca_cert_pem
                .as_ref()
                .ok_or("Brak certyfikatu zaufania.")?;
            let ca_key_pem = vault
                .ca_key_pem
                .as_ref()
                .ok_or("Brak klucza certyfikatu.")?;
            let ca_key = KeyPair::from_pem(ca_key_pem)
                .map_err(|_| "Nie można odczytać klucza certyfikatu.".to_string())?;
            let issuer_params = CertificateParams::from_ca_cert_pem(ca_cert)
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
        self.ensure_vault_loaded()?;
        let mut vault = lock(&self.inner.vault);
        let previous_devices = vault.devices.clone();
        vault.devices.clear();
        if let Err(error) = save_device_index(self.inner.credential_store.as_ref(), &vault) {
            vault.devices = previous_devices;
            return Err(error);
        }
        let mut cleanup_failed = false;
        for device in &previous_devices {
            cleanup_failed |= self
                .inner
                .credential_store
                .delete_password(&device_token_account(&device.id))
                .is_err();
        }
        let mut status = lock(&self.inner.status);
        status.paired_devices.clear();
        status.paired_device_count = 0;
        let status = status.clone();
        if cleanup_failed {
            return Err("Urządzenia zostały odwołane, ale systemowy magazyn nie usunął wszystkich osieroconych rekordów.".into());
        }
        Ok(status)
    }

    #[cfg(windows)]
    pub fn revoke_device(&self, device_id: &str) -> Result<RemoteAccessStatus, String> {
        self.ensure_vault_loaded()?;
        let mut vault = lock(&self.inner.vault);
        let previous_devices = vault.devices.clone();
        vault.devices.retain(|device| device.id != device_id);
        if let Err(error) = save_device_index(self.inner.credential_store.as_ref(), &vault) {
            vault.devices = previous_devices;
            return Err(error);
        }
        let was_revoked = previous_devices.iter().any(|device| device.id == device_id);
        let cleanup_failed = was_revoked
            && self
                .inner
                .credential_store
                .delete_password(&device_token_account(device_id))
                .is_err();
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
        let status = status.clone();
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
        self.ensure_vault_loaded()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let mut vault = lock(&self.inner.vault);
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
        if persist_new_device(self.inner.credential_store.as_ref(), &vault, &device).is_err() {
            vault.devices.retain(|device| device.id != device_id);
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        *pairing_slot = None;
        let summaries = vault
            .devices
            .iter()
            .map(|device| RemoteDeviceSummary {
                id: device.id.clone(),
                name: device.name.clone(),
            })
            .collect::<Vec<_>>();
        let mut status = lock(&self.inner.status);
        status.paired_devices = summaries;
        status.paired_device_count = vault.devices.len();
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
        self.ensure_vault_loaded()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let mut vault = lock(&self.inner.vault);
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
                if save_device_index(self.inner.credential_store.as_ref(), &vault).is_err() {
                    vault.devices[index].last_sequence = previous_sequence;
                    return Err(StatusCode::SERVICE_UNAVAILABLE);
                }
                Ok(CommandReservation::Execute { previous_sequence })
            }
            ReplayDecision::AcknowledgeReplay => Ok(CommandReservation::Acknowledge),
            ReplayDecision::Ambiguous => Err(StatusCode::CONFLICT),
            ReplayDecision::RejectReplay => Err(StatusCode::UNAUTHORIZED),
        }
    }

    #[cfg(windows)]
    fn rollback_command_reservation(&self, device_id: &str, sequence: u64, previous: u64) {
        let mut vault = lock(&self.inner.vault);
        let Some(device) = vault
            .devices
            .iter_mut()
            .find(|device| device.id == device_id)
        else {
            return;
        };
        if device.last_sequence == sequence {
            device.last_sequence = previous;
            if save_device_index(self.inner.credential_store.as_ref(), &vault).is_err() {
                // Keep the reservation in memory if its durable rollback
                // failed. Releasing it only in memory could permit a retry
                // that the persistent replay guard still considers consumed.
                if let Some(device) = vault
                    .devices
                    .iter_mut()
                    .find(|device| device.id == device_id)
                {
                    device.last_sequence = sequence;
                }
            }
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
fn load_vault(store: &dyn CredentialStore) -> Result<Vault, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use std::collections::HashSet;

    let ca_cert_pem = store
        .get_password(CA_CERT_ACCOUNT)
        .map_err(credential_store_error)?;
    let ca_key_pem = store
        .get_password(CA_KEY_ACCOUNT)
        .map_err(credential_store_error)?;
    if ca_cert_pem.is_some() != ca_key_pem.is_some() {
        return Err("Trwały klucz zaufania iPhone Remote jest niekompletny. Serwer pozostaje wyłączony; utwórz nowy profil zaufania i sparuj urządzenia ponownie.".into());
    }

    let index_value = store
        .get_password(DEVICE_INDEX_ACCOUNT)
        .map_err(credential_store_error)?;
    let Some(index_value) = index_value else {
        return Ok(Vault {
            ca_cert_pem,
            ca_key_pem,
            devices: Vec::new(),
        });
    };
    let index: DeviceIndex = serde_json::from_str(&index_value)
        .map_err(|_| "Zapisany indeks urządzeń iPhone Remote jest nieczytelny.".to_string())?;
    if index.version != DEVICE_INDEX_VERSION || index.devices.len() > MAX_PAIRED_DEVICES {
        return Err(
            "Zapisany indeks urządzeń iPhone Remote ma nieobsługiwaną wersję lub rozmiar.".into(),
        );
    }
    if ca_cert_pem.is_none() && !index.devices.is_empty() {
        return Err("Brakuje trwałego CA dla sparowanych urządzeń iPhone Remote. Serwer pozostaje wyłączony; przygotuj nowy profil zaufania i sparuj urządzenia ponownie.".into());
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
            return Err(
                "Zapisane urządzenia iPhone Remote zawierają nieprawidłowe metadane.".into(),
            );
        }
        let token = store.get_password(&device_token_account(&record.id))
            .map_err(credential_store_error)?
            .ok_or_else(|| "Brakuje sekretu dla sparowanego urządzenia iPhone Remote. Serwer pozostaje wyłączony.".to_string())?;
        let token_bytes = URL_SAFE_NO_PAD.decode(&token).map_err(|_| {
            "Sekret sparowanego urządzenia iPhone Remote jest nieprawidłowy.".to_string()
        })?;
        if token_bytes.len() != 32 {
            return Err(
                "Sekret sparowanego urządzenia iPhone Remote ma nieprawidłowy rozmiar.".into(),
            );
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
        _ => return Err("Istniejący materiał zaufania nie zostanie automatycznie zastąpiony. Serwer pozostaje wyłączony; użyj kontrolowanego ponownego parowania.".into()),
    }

    store
        .set_password(CA_KEY_ACCOUNT, private_key)
        .map_err(credential_store_error)?;
    if let Err(error) = store.set_password(CA_CERT_ACCOUNT, certificate) {
        let cleanup_error = store.delete_password(CA_KEY_ACCOUNT).err();
        let mut message = credential_store_error(error);
        if cleanup_error.is_some() {
            message.push_str(" Nie udało się też usunąć niedokończonego rekordu zaufania; serwer pozostaje wyłączony.");
        }
        return Err(message);
    }
    Ok(())
}

#[cfg(windows)]
fn save_device_index(store: &dyn CredentialStore, vault: &Vault) -> Result<(), String> {
    let index = DeviceIndex {
        version: DEVICE_INDEX_VERSION,
        devices: vault
            .devices
            .iter()
            .map(|device| DeviceIndexRecord {
                id: device.id.clone(),
                name: device.name.clone(),
                last_sequence: device.last_sequence,
            })
            .collect(),
    };
    let value = serde_json::to_string(&index)
        .map_err(|_| "Nie udało się przygotować indeksu sparowanych urządzeń.".to_string())?;
    store
        .set_password(DEVICE_INDEX_ACCOUNT, &value)
        .map_err(credential_store_error)
}

#[cfg(windows)]
fn persist_new_device(
    store: &dyn CredentialStore,
    vault: &Vault,
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
    let status = context.remote.status();
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

    match context.remote.pair(
        address.ip(),
        &request.code,
        &request.device_id,
        &request.device_name,
        &request.token,
    ) {
        Ok(()) => {
            let _ = context
                .app
                .emit("remote-access-status", context.remote.status());
            StatusCode::CREATED.into_response()
        }
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
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    use std::{
        collections::HashSet,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    const TEST_CA_CERT: &str =
        "synthetic test certificate for Credential Manager integration tests";
    const TEST_CA_KEY: &str = "synthetic test private key for Credential Manager integration tests";
    const PROBE_SERVICE_ENV: &str = "VELORA_TEST_REMOTE_CREDENTIAL_SERVICE";
    const PROBE_COUNT_ENV: &str = "VELORA_TEST_REMOTE_DEVICE_COUNT";
    const PROBE_SEQUENCE_ENV: &str = "VELORA_TEST_REMOTE_FIRST_SEQUENCE";
    const PROBE_FINGERPRINT_ENV: &str = "VELORA_TEST_REMOTE_CA_FINGERPRINT";
    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TestRemoteStore {
        service: String,
        native: WindowsCredentialStore,
        created_accounts: Mutex<HashSet<String>>,
        failed_writes: Mutex<HashSet<String>>,
        failed_deletes: Mutex<HashSet<String>>,
    }

    impl TestRemoteStore {
        fn new(label: &str) -> Arc<Self> {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let counter = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let service = format!(
                "com.nexus.aurea.remote.tests.{label}.{}.{unique}.{counter}",
                std::process::id()
            );
            Arc::new(Self {
                native: WindowsCredentialStore::new(service.clone()),
                service,
                created_accounts: Mutex::new(HashSet::new()),
                failed_writes: Mutex::new(HashSet::new()),
                failed_deletes: Mutex::new(HashSet::new()),
            })
        }

        fn fail_write(&self, account: &str) {
            lock(&self.failed_writes).insert(account.to_string());
        }

        fn fail_delete(&self, account: &str) {
            lock(&self.failed_deletes).insert(account.to_string());
        }
    }

    impl Drop for TestRemoteStore {
        fn drop(&mut self) {
            let accounts = self
                .created_accounts
                .get_mut()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            for account in accounts {
                let _ = self.native.delete_password(&account);
            }
        }
    }

    impl CredentialStore for TestRemoteStore {
        fn get_password(&self, account: &str) -> Result<Option<String>, CredentialStoreError> {
            self.native.get_password(account)
        }

        fn set_password(&self, account: &str, value: &str) -> Result<(), CredentialStoreError> {
            if lock(&self.failed_writes).contains(account) {
                return Err(CredentialStoreError::Unavailable);
            }
            lock(&self.created_accounts).insert(account.to_string());
            self.native.set_password(account, value)
        }

        fn delete_password(&self, account: &str) -> Result<(), CredentialStoreError> {
            if lock(&self.failed_deletes).contains(account) {
                return Err(CredentialStoreError::Unavailable);
            }
            self.native.delete_password(account)?;
            lock(&self.created_accounts).remove(account);
            Ok(())
        }
    }

    fn remote_with_test_store(label: &str) -> (RemoteAccess, Arc<TestRemoteStore>) {
        let store = TestRemoteStore::new(label);
        (RemoteAccess::with_credential_store(store.clone()), store)
    }

    fn device_id(index: u64) -> String {
        format!("{index:032x}")
    }

    fn device_token(index: u64) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        URL_SAFE_NO_PAD.encode([index as u8; 32])
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
        let index = DeviceIndex {
            version: DEVICE_INDEX_VERSION,
            devices: vec![DeviceIndexRecord {
                id: device_id(1),
                name: "Synthetic Remote".into(),
                last_sequence: 0,
            }],
        };
        store
            .set_password(
                DEVICE_INDEX_ACCOUNT,
                &serde_json::to_string(&index).unwrap(),
            )
            .unwrap();
        store
            .set_password(&device_token_account(&device_id(1)), &device_token(1))
            .unwrap();

        let error = match load_vault(&store) {
            Ok(_) => panic!("missing CA with a paired device must fail closed"),
            Err(error) => error,
        };
        assert!(error.contains("Brakuje trwałego CA"));
        assert!(error.contains("Serwer pozostaje wyłączony"));
        assert!(store
            .get_password(&device_token_account(&device_id(1)))
            .unwrap()
            .is_some());
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

    fn fingerprint(value: &str) -> String {
        Sha256::digest(value.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn run_vault_probe(service: &str, device_count: usize, first_sequence: u64) {
        let status = Command::new(std::env::current_exe().expect("test executable path"))
            .arg("--exact")
            .arg("remote_access::windows_tests::credential_vault_process_probe")
            .arg("--nocapture")
            .env(PROBE_SERVICE_ENV, service)
            .env(PROBE_COUNT_ENV, device_count.to_string())
            .env(PROBE_SEQUENCE_ENV, first_sequence.to_string())
            .env(PROBE_FINGERPRINT_ENV, fingerprint(TEST_CA_CERT))
            .status()
            .expect("start a separate test process");
        assert!(
            status.success(),
            "a separate process could not read its test-only vault"
        );
    }

    #[test]
    fn credential_vault_process_probe() {
        let (Ok(service), Ok(expected_count), Ok(expected_sequence), Ok(expected_fingerprint)) = (
            std::env::var(PROBE_SERVICE_ENV),
            std::env::var(PROBE_COUNT_ENV),
            std::env::var(PROBE_SEQUENCE_ENV),
            std::env::var(PROBE_FINGERPRINT_ENV),
        ) else {
            return;
        };
        let store = WindowsCredentialStore::new(service);
        let vault = load_vault(&store).expect("read test vault in a separate process");
        assert_eq!(
            vault.devices.len(),
            expected_count.parse::<usize>().unwrap()
        );
        assert_eq!(
            vault
                .devices
                .first()
                .map(|device| device.last_sequence)
                .unwrap_or(0),
            expected_sequence.parse::<u64>().unwrap()
        );
        assert_eq!(
            vault.ca_cert_pem.as_deref().map(fingerprint),
            Some(expected_fingerprint)
        );
    }

    #[test]
    fn windows_vault_persists_trust_devices_and_sequences_through_restart_and_revoke() {
        let (remote, store) = remote_with_test_store("vault");
        assert!(load_vault(store.as_ref()).unwrap().devices.is_empty());
        persist_trust_material(store.as_ref(), TEST_CA_CERT, TEST_CA_KEY)
            .expect("write synthetic trust material");
        assert_eq!(
            WindowsCredentialStore::new(store.service.clone())
                .get_password(CA_CERT_ACCOUNT)
                .unwrap(),
            Some(TEST_CA_CERT.into())
        );

        remote.ensure_vault_loaded().expect("load the test vault");
        lock(&remote.inner.status).enabled = true;
        let long_name = "Synthetic Remote Controller With A Name Longer Than Thirty Two Characters";
        pair_test_device(&remote, 1, long_name).expect("pair one synthetic device");
        assert_eq!(load_vault(store.as_ref()).unwrap().devices.len(), 1);
        for index in 2..=MAX_PAIRED_DEVICES as u64 {
            pair_test_device(&remote, index, "Synthetic Remote Controller")
                .expect("pair within the eight-device limit");
        }
        assert_eq!(
            load_vault(store.as_ref()).unwrap().devices.len(),
            MAX_PAIRED_DEVICES
        );
        assert_eq!(lock(&remote.inner.vault).devices[0].name.len(), 32);
        assert_eq!(
            pair_test_device(&remote, 9, "Ninth Device"),
            Err(StatusCode::CONFLICT)
        );

        {
            let mut vault = lock(&remote.inner.vault);
            vault.devices[0].last_sequence = u64::MAX - 1;
            save_device_index(store.as_ref(), &vault).expect("persist maximum sequence");
        }
        let command = RemoteCommand::VolumeUp;
        assert_eq!(
            remote.authenticate_command(
                &device_id(1),
                u64::MAX,
                &command,
                &sign_command(1, u64::MAX, &command)
            ),
            Ok(CommandReservation::Execute {
                previous_sequence: u64::MAX - 1
            })
        );
        let index_json = store
            .get_password(DEVICE_INDEX_ACCOUNT)
            .unwrap()
            .expect("device index");
        assert!(credential_password_size_bytes(&index_json) <= MAX_CREDENTIAL_PASSWORD_BYTES);
        let restarted = RemoteAccess::with_credential_store(store.clone());
        restarted
            .ensure_vault_loaded()
            .expect("restart and reload vault through a new handle");
        assert_eq!(
            lock(&restarted.inner.vault).devices[0].last_sequence,
            u64::MAX
        );
        lock(&restarted.inner.status).enabled = true;
        assert_eq!(
            restarted.authenticate_command(
                &device_id(1),
                u64::MAX,
                &command,
                &sign_command(1, u64::MAX, &command)
            ),
            Err(StatusCode::CONFLICT)
        );
        run_vault_probe(&store.service, MAX_PAIRED_DEVICES, u64::MAX);

        remote
            .revoke_device(&device_id(8))
            .expect("revoke one test device");
        let after_one_revoke = RemoteAccess::with_credential_store(store.clone());
        after_one_revoke
            .ensure_vault_loaded()
            .expect("reload after revoke");
        assert_eq!(
            lock(&after_one_revoke.inner.vault).devices.len(),
            MAX_PAIRED_DEVICES - 1
        );
        assert!(store
            .get_password(&device_token_account(&device_id(8)))
            .unwrap()
            .is_none());

        remote.revoke_all().expect("revoke all test devices");
        let after_all_revoke = RemoteAccess::with_credential_store(store.clone());
        after_all_revoke
            .ensure_vault_loaded()
            .expect("reload after revoke-all");
        assert!(lock(&after_all_revoke.inner.vault).devices.is_empty());
        run_vault_probe(&store.service, 0, 0);

        for account in [CA_CERT_ACCOUNT, CA_KEY_ACCOUNT, DEVICE_INDEX_ACCOUNT] {
            let value = store
                .get_password(account)
                .unwrap()
                .expect("persisted test account");
            assert!(credential_password_size_bytes(&value) <= MAX_CREDENTIAL_PASSWORD_BYTES);
        }
    }

    #[test]
    fn failed_credential_writes_never_report_pair_or_advance_sequence() {
        let (_, failed_ca_key_store) = remote_with_test_store("fail-ca-key");
        failed_ca_key_store.fail_write(CA_KEY_ACCOUNT);
        assert!(
            persist_trust_material(failed_ca_key_store.as_ref(), TEST_CA_CERT, TEST_CA_KEY)
                .is_err()
        );
        assert!(failed_ca_key_store
            .get_password(CA_CERT_ACCOUNT)
            .unwrap()
            .is_none());
        assert!(failed_ca_key_store
            .get_password(CA_KEY_ACCOUNT)
            .unwrap()
            .is_none());

        let (_, failed_ca_cert_store) = remote_with_test_store("fail-ca-cert");
        failed_ca_cert_store.fail_write(CA_CERT_ACCOUNT);
        assert!(
            persist_trust_material(failed_ca_cert_store.as_ref(), TEST_CA_CERT, TEST_CA_KEY)
                .is_err()
        );
        assert!(failed_ca_cert_store
            .get_password(CA_CERT_ACCOUNT)
            .unwrap()
            .is_none());
        assert!(failed_ca_cert_store
            .get_password(CA_KEY_ACCOUNT)
            .unwrap()
            .is_none());

        let (failed_token_remote, failed_token_store) = remote_with_test_store("fail-device-token");
        failed_token_remote.ensure_vault_loaded().unwrap();
        lock(&failed_token_remote.inner.status).enabled = true;
        failed_token_store.fail_write(&device_token_account(&device_id(1)));
        assert_eq!(
            pair_test_device(&failed_token_remote, 1, "Synthetic Remote"),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert!(load_vault(failed_token_store.as_ref())
            .unwrap()
            .devices
            .is_empty());

        let (failed_index_remote, failed_index_store) = remote_with_test_store("fail-pair-index");
        failed_index_remote.ensure_vault_loaded().unwrap();
        lock(&failed_index_remote.inner.status).enabled = true;
        failed_index_store.fail_write(DEVICE_INDEX_ACCOUNT);
        assert_eq!(
            pair_test_device(&failed_index_remote, 1, "Synthetic Remote"),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert!(failed_index_store
            .get_password(&device_token_account(&device_id(1)))
            .unwrap()
            .is_none());
        assert!(load_vault(failed_index_store.as_ref())
            .unwrap()
            .devices
            .is_empty());

        let (sequence_remote, sequence_store) = remote_with_test_store("fail-sequence-index");
        sequence_remote.ensure_vault_loaded().unwrap();
        lock(&sequence_remote.inner.status).enabled = true;
        pair_test_device(&sequence_remote, 1, "Synthetic Remote")
            .expect("pair test device before injecting the failure");
        sequence_store.fail_write(DEVICE_INDEX_ACCOUNT);
        let command = RemoteCommand::VolumeUp;
        let signature = sign_command(1, 1, &command);
        assert_eq!(
            sequence_remote.authenticate_command(&device_id(1), 1, &command, &signature),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert_eq!(
            lock(&sequence_remote.inner.vault).devices[0].last_sequence,
            0
        );
        assert_eq!(
            load_vault(sequence_store.as_ref()).unwrap().devices[0].last_sequence,
            0
        );
    }

    #[test]
    fn revoke_write_failure_is_visible_and_failed_cleanup_stays_revoked() {
        let (remote, store) = remote_with_test_store("revoke-errors");
        remote.ensure_vault_loaded().unwrap();
        lock(&remote.inner.status).enabled = true;
        pair_test_device(&remote, 1, "Synthetic Remote").expect("pair test device");

        store.fail_write(DEVICE_INDEX_ACCOUNT);
        assert!(remote.revoke_device(&device_id(1)).is_err());
        assert_eq!(lock(&remote.inner.vault).devices.len(), 1);
        assert_eq!(load_vault(store.as_ref()).unwrap().devices.len(), 1);
        lock(&store.failed_writes).remove(DEVICE_INDEX_ACCOUNT);

        store.fail_delete(&device_token_account(&device_id(1)));
        let error = remote.revoke_device(&device_id(1)).unwrap_err();
        assert!(error.contains("zostało odwołane"));
        assert!(lock(&remote.inner.vault).devices.is_empty());
        assert!(load_vault(store.as_ref()).unwrap().devices.is_empty());
        assert!(store
            .get_password(&device_token_account(&device_id(1)))
            .unwrap()
            .is_some());
    }
}
