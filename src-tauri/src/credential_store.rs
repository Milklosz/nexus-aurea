use std::fmt;

/// Leave a small margin below Windows Credential Manager's 2560-byte password
/// limit. The Windows keyring backend stores passwords as UTF-16, so counting
/// UTF-8 bytes is not sufficient.
pub const MAX_CREDENTIAL_PASSWORD_BYTES: usize = 2400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialStoreError {
    Unavailable,
    TooLarge,
}

impl fmt::Display for CredentialStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("system credential store is unavailable"),
            Self::TooLarge => formatter.write_str("credential value exceeds the safe size limit"),
        }
    }
}

pub trait CredentialStore: Send + Sync {
    fn get_password(&self, account: &str) -> Result<Option<String>, CredentialStoreError>;
    fn set_password(&self, account: &str, value: &str) -> Result<(), CredentialStoreError>;
    fn delete_password(&self, account: &str) -> Result<(), CredentialStoreError>;
}

pub fn credential_password_size_bytes(value: &str) -> usize {
    value.encode_utf16().count().saturating_mul(2)
}

pub fn validate_credential_password_size(value: &str) -> Result<(), CredentialStoreError> {
    if credential_password_size_bytes(value) > MAX_CREDENTIAL_PASSWORD_BYTES {
        return Err(CredentialStoreError::TooLarge);
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Clone)]
pub struct WindowsCredentialStore {
    service: String,
}

#[cfg(windows)]
impl WindowsCredentialStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }
}

#[cfg(windows)]
impl CredentialStore for WindowsCredentialStore {
    fn get_password(&self, account: &str) -> Result<Option<String>, CredentialStoreError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|_| CredentialStoreError::Unavailable)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CredentialStoreError::Unavailable),
        }
    }

    fn set_password(&self, account: &str, value: &str) -> Result<(), CredentialStoreError> {
        validate_credential_password_size(value)?;
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|_| CredentialStoreError::Unavailable)?;
        entry
            .set_password(value)
            .map_err(|_| CredentialStoreError::Unavailable)
    }

    fn delete_password(&self, account: &str) -> Result<(), CredentialStoreError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|_| CredentialStoreError::Unavailable)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialStoreError::Unavailable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_limit_counts_windows_utf16_bytes() {
        assert_eq!(credential_password_size_bytes(&"a".repeat(1200)), 2400);
        assert_eq!(validate_credential_password_size(&"a".repeat(1200)), Ok(()));
        assert_eq!(credential_password_size_bytes(&"a".repeat(1201)), 2402);
        assert_eq!(
            validate_credential_password_size(&"a".repeat(1201)),
            Err(CredentialStoreError::TooLarge)
        );
        assert_eq!(credential_password_size_bytes(&"😀".repeat(600)), 2400);
        assert_eq!(validate_credential_password_size(&"😀".repeat(600)), Ok(()));
        assert_eq!(credential_password_size_bytes(&"😀".repeat(601)), 2404);
        assert_eq!(
            validate_credential_password_size(&"😀".repeat(601)),
            Err(CredentialStoreError::TooLarge)
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::{
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);
    const PROBE_SERVICE_ENV: &str = "VELORA_TEST_CREDENTIAL_SERVICE";
    const PROBE_ACCOUNT_ENV: &str = "VELORA_TEST_CREDENTIAL_ACCOUNT";

    struct TestEntry {
        store: WindowsCredentialStore,
        account: String,
    }

    impl Drop for TestEntry {
        fn drop(&mut self) {
            let _ = self.store.delete_password(&self.account);
        }
    }

    fn test_entry(label: &str) -> (TestEntry, String) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let counter = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let service = format!(
            "com.nexus.aurea.remote.tests.{label}.{}.{unique}.{counter}",
            std::process::id()
        );
        let account = "synthetic-roundtrip-v1".to_string();
        (
            TestEntry {
                store: WindowsCredentialStore::new(service.clone()),
                account,
            },
            service,
        )
    }

    #[test]
    fn credential_store_process_probe() {
        let (Ok(service), Ok(account)) = (
            std::env::var(PROBE_SERVICE_ENV),
            std::env::var(PROBE_ACCOUNT_ENV),
        ) else {
            return;
        };
        let store = WindowsCredentialStore::new(service);
        assert_eq!(
            store.get_password(&account).expect("read test credential"),
            Some("synthetic-credential-probe-value".to_string())
        );
    }

    #[test]
    fn windows_credential_store_persists_across_handles_and_processes() {
        let (entry, service) = test_entry("process");
        entry
            .store
            .set_password(&entry.account, "synthetic-credential-probe-value")
            .expect("write only a test credential");

        let second_handle = WindowsCredentialStore::new(service.clone());
        assert_eq!(
            second_handle
                .get_password(&entry.account)
                .expect("read through an independent handle"),
            Some("synthetic-credential-probe-value".to_string())
        );

        let status = Command::new(std::env::current_exe().expect("test executable path"))
            .arg("--exact")
            .arg("credential_store::windows_tests::credential_store_process_probe")
            .arg("--nocapture")
            .env(PROBE_SERVICE_ENV, service)
            .env(PROBE_ACCOUNT_ENV, &entry.account)
            .status()
            .expect("start independent test process");
        assert!(
            status.success(),
            "the child process could not read its test-only credential"
        );
    }

    #[test]
    fn windows_credential_store_enforces_safe_payload_boundary() {
        let (entry, _) = test_entry("limits");
        let exact_limit = "a".repeat(MAX_CREDENTIAL_PASSWORD_BYTES / 2);
        entry
            .store
            .set_password(&entry.account, &exact_limit)
            .expect("write exact safe UTF-16 boundary");
        assert_eq!(
            entry
                .store
                .get_password(&entry.account)
                .expect("read exact safe boundary"),
            Some(exact_limit)
        );
        assert_eq!(
            entry.store.set_password(
                &entry.account,
                &"a".repeat(MAX_CREDENTIAL_PASSWORD_BYTES / 2 + 1)
            ),
            Err(CredentialStoreError::TooLarge)
        );
    }
}
