use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::State;
#[cfg(windows)]
use axum::http::StatusCode;

#[cfg(windows)]
const REMOTE_PORT: u16 = 47862;
const PAIRING_TTL: Duration = Duration::from_secs(60);
const PAIRING_WINDOW: Duration = Duration::from_secs(300);
const PAIRING_ATTEMPTS: u32 = 5;
const COMMAND_WINDOW: Duration = Duration::from_secs(1);
const COMMANDS_PER_WINDOW: u32 = 20;
const MAX_PAIRED_DEVICES: usize = 8;
#[cfg(windows)]
const MAX_CREDENTIAL_BYTES: usize = 2400;
#[cfg(windows)]
const MAX_REQUEST_BYTES: usize = 4096;
#[cfg(windows)]
const CREDENTIAL_SERVICE: &str = "com.nexus.aurea.remote";
#[cfg(windows)]
const CREDENTIAL_ACCOUNT: &str = "encrypted-state-v1";

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

#[derive(Clone, Serialize, Deserialize)]
struct PairedDevice {
    id: String,
    name: String,
    token: String,
    last_sequence: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Vault {
    ca_cert_pem: Option<String>,
    ca_key_pem: Option<String>,
    devices: Vec<PairedDevice>,
}

struct PairingCode {
    value: String,
    expires_at: Instant,
}

struct RateBucket {
    started_at: Instant,
    count: u32,
}

#[derive(Default)]
struct RemoteInner {
    status: Mutex<RemoteAccessStatus>,
    pairing: Mutex<Option<PairingCode>>,
    #[cfg(windows)]
    server: Mutex<Option<axum_server::Handle>>,
    #[cfg(windows)]
    vault: Mutex<Vault>,
    #[cfg(windows)]
    vault_loaded: Mutex<bool>,
    pair_attempts: Mutex<HashMap<IpAddr, RateBucket>>,
    command_attempts: Mutex<HashMap<String, RateBucket>>,
}

#[derive(Clone, Default)]
pub struct RemoteAccess {
    inner: Arc<RemoteInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn remote_command_payload(device_id: &str, sequence: u64, command: &RemoteCommand) -> String {
    format!("NEXUS-AUREA-REMOTE-V1\n{device_id}\n{sequence}\n{}", command.as_str())
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
    pub fn status(&self) -> RemoteAccessStatus {
        #[cfg(windows)]
        if self.ensure_vault_loaded().is_ok() {
            let vault = lock(&self.inner.vault);
            let mut status = lock(&self.inner.status);
            status.paired_devices = vault.devices.iter()
                .map(|device| RemoteDeviceSummary { id: device.id.clone(), name: device.name.clone() })
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
        let vault = load_vault()?;
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
        use tauri::Manager;
        use std::fs;
        use time::{Duration as TimeDuration, OffsetDateTime};

        self.ensure_vault_loaded()?;
        let mut vault = lock(&self.inner.vault);
        if vault.ca_cert_pem.is_none() && vault.ca_key_pem.is_none() {
            let mut params = CertificateParams::default();
            let now = OffsetDateTime::now_utc();
            params.not_before = now - TimeDuration::minutes(5);
            params.not_after = now + TimeDuration::days(365 * 5);
            params.distinguished_name.push(DnType::CommonName, "NEXUS AUREA LAN Remote CA");
            params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            let key = KeyPair::generate().map_err(|_| "Nie udało się utworzyć certyfikatu zaufania.".to_string())?;
            let cert = params.self_signed(&key).map_err(|_| "Nie udało się utworzyć certyfikatu zaufania.".to_string())?;
            vault.ca_cert_pem = Some(cert.pem());
            vault.ca_key_pem = Some(key.serialize_pem());
            if let Err(error) = save_vault(&vault) {
                vault.ca_cert_pem = None;
                vault.ca_key_pem = None;
                return Err(error);
            }
        }
        let cert_pem = vault.ca_cert_pem.as_ref().ok_or("Niekompletny certyfikat zaufania.")?;
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
<key>PayloadDescription</key><string>Trust NEXUS AUREA local HTTPS only when you approve this profile.</string>
<key>PayloadDisplayName</key><string>NEXUS AUREA LAN Remote CA</string>
<key>PayloadIdentifier</key><string>com.nexus.aurea.remote.ca</string>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadUUID</key><string>{}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDisplayName</key><string>NEXUS AUREA LAN Remote</string>
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
        fs::create_dir_all(&profile_path).map_err(|_| "Nie można przygotować folderu Pobrane.".to_string())?;
        profile_path.push("NEXUS-AUREA-LAN-Remote.mobileconfig");
        fs::write(&profile_path, profile).map_err(|_| "Nie udało się zapisać profilu zaufania.".to_string())?;
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
        use axum::{extract::ConnectInfo, middleware, routing::{get, post}, Json, Router};
        use axum_server::tls_rustls::RustlsConfig;
        use rcgen::{CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType};
        use std::net::{TcpListener, SocketAddr};
        use tauri::Emitter;
        use time::{Duration as TimeDuration, OffsetDateTime};

        if !trust_confirmed {
            return Err("Zainstaluj profil zaufania na iPhonie i włącz jego pełne zaufanie przed startem serwera.".into());
        }
        if lock(&self.inner.status).enabled {
            return Ok(self.status());
        }
        let prepared = self.prepare_trust_profile(&app)?;
        let fingerprint = prepared.ca_fingerprint.ok_or("Brak certyfikatu zaufania.")?;
        self.ensure_vault_loaded()?;
        let (ip, host, origin) = local_remote_address()?;
        let vault = lock(&self.inner.vault);
        let ca_cert = vault.ca_cert_pem.as_ref().ok_or("Brak certyfikatu zaufania.")?;
        let ca_key_pem = vault.ca_key_pem.as_ref().ok_or("Brak klucza certyfikatu.")?;
        let ca_key = KeyPair::from_pem(ca_key_pem).map_err(|_| "Nie można odczytać klucza certyfikatu.".to_string())?;
        let issuer = Issuer::from_ca_cert_pem(ca_cert, ca_key)
            .map_err(|_| "Nie można odczytać wystawcy certyfikatu.".to_string())?;
        let now = OffsetDateTime::now_utc();
        let mut leaf_params = CertificateParams::default();
        leaf_params.not_before = now - TimeDuration::minutes(5);
        leaf_params.not_after = now + TimeDuration::days(90);
        leaf_params.subject_alt_names = vec![SanType::IpAddress(IpAddr::V4(ip))];
        leaf_params.distinguished_name.push(DnType::CommonName, "NEXUS AUREA LAN Remote");
        leaf_params.is_ca = IsCa::NoCa;
        leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let leaf_key = KeyPair::generate().map_err(|_| "Nie udało się utworzyć certyfikatu HTTPS.".to_string())?;
        let leaf_cert = leaf_params.signed_by(&leaf_key, &issuer)
            .map_err(|_| "Nie udało się podpisać certyfikatu HTTPS.".to_string())?;
        let cert_pem = leaf_cert.pem();
        let key_pem = leaf_key.serialize_pem();
        drop(vault);
        let tls = RustlsConfig::from_pem(cert_pem.into_bytes(), key_pem.into_bytes())
            .await
            .map_err(|_| "Nie udało się skonfigurować HTTPS.".to_string())?;
        let address = SocketAddr::new(IpAddr::V4(ip), REMOTE_PORT);
        let listener = TcpListener::bind(address)
            .map_err(|_| "Nie udało się otworzyć portu HTTPS w sieci prywatnej.".to_string())?;
        listener.set_nonblocking(true)
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
            .map_err(|_| "Nie udało się przygotować serwera HTTPS.".to_string())?
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
        if let Err(error) = save_vault(&vault) {
            vault.devices = previous_devices;
            return Err(error);
        }
        let mut status = lock(&self.inner.status);
        status.paired_devices.clear();
        status.paired_device_count = 0;
        Ok(status.clone())
    }

    #[cfg(windows)]
    pub fn revoke_device(&self, device_id: &str) -> Result<RemoteAccessStatus, String> {
        self.ensure_vault_loaded()?;
        let mut vault = lock(&self.inner.vault);
        let previous_devices = vault.devices.clone();
        vault.devices.retain(|device| device.id != device_id);
        if let Err(error) = save_vault(&vault) {
            vault.devices = previous_devices;
            return Err(error);
        }
        let mut status = lock(&self.inner.status);
        status.paired_devices = vault.devices.iter()
            .map(|device| RemoteDeviceSummary { id: device.id.clone(), name: device.name.clone() })
            .collect();
        status.paired_device_count = vault.devices.len();
        Ok(status.clone())
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
            && device_id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        let token_bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| StatusCode::BAD_REQUEST)?;
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
        self.ensure_vault_loaded().map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let mut vault = lock(&self.inner.vault);
        if vault.devices.len() >= MAX_PAIRED_DEVICES
            || vault.devices.iter().any(|device| device.id == device_id)
        {
            return Err(StatusCode::CONFLICT);
        }
        let clean_name = name.chars()
            .filter(|character| character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_' | '.'))
            .take(32)
            .collect::<String>()
            .trim()
            .to_string();
        if clean_name.is_empty() {
            return Err(StatusCode::BAD_REQUEST);
        }
        vault.devices.push(PairedDevice {
            id: device_id.to_ascii_lowercase(),
            name: clean_name,
            token: token.to_string(),
            last_sequence: 0,
        });
        if save_vault(&vault).is_err() {
            vault.devices.retain(|device| device.id != device_id);
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        *pairing_slot = None;
        let summaries = vault.devices.iter()
            .map(|device| RemoteDeviceSummary { id: device.id.clone(), name: device.name.clone() })
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
    ) -> Result<(), StatusCode> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

        if !lock(&self.inner.status).enabled {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        self.ensure_vault_loaded().map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let mut vault = lock(&self.inner.vault);
        let Some(device) = vault.devices.iter_mut().find(|device| device.id == device_id) else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        let token_bytes = URL_SAFE_NO_PAD.decode(&device.token).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if !verify_command_signature(&token_bytes, device_id, sequence, command, signature)
            || !sequence_is_fresh(device.last_sequence, sequence)
        {
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
        device.last_sequence = sequence;
        save_vault(&vault).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        Ok(())
    }
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
    let bucket = buckets.entry(key).or_insert(RateBucket { started_at: now, count: 0 });
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

    let body = pem.lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    STANDARD.decode(body).map_err(|_| "Nie można odczytać certyfikatu zaufania.".to_string())
}

#[cfg(windows)]
fn local_remote_address() -> Result<(Ipv4Addr, String, String), String> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|_| "Nie można wykryć prywatnego interfejsu sieciowego.".to_string())?;
    socket.connect("192.0.2.1:9")
        .map_err(|_| "Nie można wykryć prywatnego interfejsu sieciowego.".to_string())?;
    let ip = match socket.local_addr().map_err(|_| "Nie można odczytać adresu sieciowego.".to_string())?.ip() {
        IpAddr::V4(ip) if ip.is_private() => ip,
        _ => return Err("Nie znaleziono trasy przez prywatny adres IPv4. Serwer pozostał wyłączony.".into()),
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
fn load_vault() -> Result<Vault, String> {
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|_| "Systemowy magazyn poświadczeń jest niedostępny.".to_string())?;
    match entry.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map_err(|_| "Zapisany stan iPhone Remote jest nieczytelny.".to_string()),
        Err(keyring::Error::NoEntry) => Ok(Vault::default()),
        Err(_) => Err("Systemowy magazyn poświadczeń jest niedostępny.".into()),
    }
}

#[cfg(windows)]
fn save_vault(vault: &Vault) -> Result<(), String> {
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|_| "Systemowy magazyn poświadczeń jest niedostępny.".to_string())?;
    let value = serde_json::to_string(vault)
        .map_err(|_| "Nie udało się przygotować bezpiecznego stanu pilota.".to_string())?;
    if value.len() > MAX_CREDENTIAL_BYTES {
        return Err("Magazyn poświadczeń Windows nie może zapisać tego zestawu sparowanych urządzeń.".into());
    }
    entry.set_password(&value)
        .map_err(|_| "Nie udało się zapisać sekretów w systemowym magazynie poświadczeń.".to_string())
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

    let host = request.headers().get(header::HOST).and_then(|value| value.to_str().ok());
    let origin = request.headers().get(header::ORIGIN).and_then(|value| value.to_str().ok());
    let method = request.method().as_str();
    let path = request.uri().path();
    if !is_allowed_request(host, origin, method, path, &context.expected_host, &context.expected_origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if path.starts_with("/api/") && method == "POST" {
        let content_type = request.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok());
        if !content_type.is_some_and(|value| value.starts_with("application/json")) {
            return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
        }
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(HeaderName::from_static("x-content-type-options"), HeaderValue::from_static("nosniff"));
    headers.insert(HeaderName::from_static("referrer-policy"), HeaderValue::from_static("no-referrer"));
    headers.insert(HeaderName::from_static("x-frame-options"), HeaderValue::from_static("DENY"));
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"),
    );
    response
}

#[cfg(windows)]
async fn remote_index() -> impl axum::response::IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")], include_str!("../../public/remote/index.html"))
}

#[cfg(windows)]
async fn remote_app_js() -> impl axum::response::IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "application/javascript; charset=utf-8")], include_str!("../../public/remote/app.js"))
}

#[cfg(windows)]
async fn remote_style() -> impl axum::response::IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")], include_str!("../../public/remote/style.css"))
}

#[cfg(windows)]
async fn remote_manifest() -> impl axum::response::IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "application/manifest+json")], include_str!("../../public/remote/manifest.webmanifest"))
}

#[cfg(windows)]
async fn remote_service_worker() -> impl axum::response::IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "application/javascript; charset=utf-8"), (axum::http::header::HeaderName::from_static("service-worker-allowed"), "/")], include_str!("../../public/remote/sw.js"))
}

#[cfg(windows)]
async fn remote_icon() -> impl axum::response::IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "image/svg+xml")], include_str!("../../public/remote/icon.svg"))
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

    match context.remote.pair(address.ip(), &request.code, &request.device_id, &request.device_name, &request.token) {
        Ok(()) => {
            let _ = context.app.emit("remote-access-status", context.remote.status());
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
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use tauri::Emitter;

    let Ok(signature) = URL_SAFE_NO_PAD.decode(&request.signature) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if let Err(status) = context.remote.authenticate_command(&request.device_id, request.sequence, &request.command, &signature) {
        return status.into_response();
    }
    if context.app.emit("nexus-remote-command", request.command).is_err() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
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
        assert!(is_allowed_request(Some("192.168.1.4:47862"), Some("https://192.168.1.4:47862"), "POST", "/api/pair", "192.168.1.4:47862", "https://192.168.1.4:47862"));
        assert!(!is_allowed_request(Some("attacker.example"), Some("https://192.168.1.4:47862"), "POST", "/api/pair", "192.168.1.4:47862", "https://192.168.1.4:47862"));
        assert!(!is_allowed_request(Some("192.168.1.4:47862"), Some("https://evil.example"), "POST", "/api/command", "192.168.1.4:47862", "https://192.168.1.4:47862"));
        assert!(!is_allowed_request(Some("192.168.1.4:47862"), None, "POST", "/api/command", "192.168.1.4:47862", "https://192.168.1.4:47862"));
        assert!(is_allowed_request(Some("192.168.1.4:47862"), None, "GET", "/api/status", "192.168.1.4:47862", "https://192.168.1.4:47862"));
    }

    #[test]
    fn commands_are_authenticated_and_replay_protected() {
        let token = [7_u8; 32];
        let command = RemoteCommand::VolumeUp;
        let sequence = 3;
        let payload = remote_command_payload("0123456789abcdef0123456789abcdef", sequence, &command);
        let mut mac = Hmac::<Sha256>::new_from_slice(&token).unwrap();
        mac.update(payload.as_bytes());
        let signature = mac.finalize().into_bytes();
        assert!(verify_command_signature(&token, "0123456789abcdef0123456789abcdef", sequence, &command, &signature));
        assert!(!verify_command_signature(&token, "0123456789abcdef0123456789abcdef", sequence + 1, &command, &signature));
        assert!(sequence_is_fresh(2, sequence));
        assert!(!sequence_is_fresh(sequence, sequence));
    }

    #[test]
    fn pair_and_command_rate_limits_are_bounded() {
        let mut pair = HashMap::new();
        let ip = "192.168.1.4".parse().unwrap();
        for _ in 0..PAIRING_ATTEMPTS {
            assert!(allow_rate(&mut pair, ip, PAIRING_WINDOW, PAIRING_ATTEMPTS, 64));
        }
        assert!(!allow_rate(&mut pair, ip, PAIRING_WINDOW, PAIRING_ATTEMPTS, 64));
        let mut commands = HashMap::new();
        let id = "0123456789abcdef0123456789abcdef";
        for _ in 0..COMMANDS_PER_WINDOW {
            assert!(allow_rate(&mut commands, id.to_string(), COMMAND_WINDOW, COMMANDS_PER_WINDOW, MAX_PAIRED_DEVICES));
        }
        assert!(!allow_rate(&mut commands, id.to_string(), COMMAND_WINDOW, COMMANDS_PER_WINDOW, MAX_PAIRED_DEVICES));
    }

    #[test]
    fn command_deserialization_rejects_unlisted_operations() {
        assert_eq!(serde_json::from_str::<RemoteCommand>("\"volume-up\"").unwrap(), RemoteCommand::VolumeUp);
        assert!(serde_json::from_str::<RemoteCommand>("\"run-shell\"").is_err());
    }
}

