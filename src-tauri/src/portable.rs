//! Portable validation build isolation.
//!
//! The portable candidate is compiled from the same source as the installed
//! VELORA 2.0 binary. Isolation is opt-in at runtime: the bundled launcher sets
//! `VELORA_PORTABLE_DATA_DIR` before starting the executable. When the variable
//! is absent every helper returns the installed-app value, so normal builds and
//! the existing test suite keep their behaviour.
//!
//! This module is deliberately small and free of OS calls so its decisions can
//! be unit-tested without touching the real user profile.

use std::path::PathBuf;

/// Environment variable consumed by the launcher and by `lib.rs`. Its value is
/// the absolute root of a data directory next to the portable executable.
pub(crate) const DATA_DIR_ENV: &str = "VELORA_PORTABLE_DATA_DIR";

/// Installed-app Windows Credential Manager service (kept for reference and
/// asserted by tests so the portable value can never silently drift back to it).
pub(crate) const INSTALLED_CREDENTIAL_SERVICE: &str = "com.nexus.aurea.remote";
const PORTABLE_CREDENTIAL_SERVICE: &str = "com.nexus.aurea.remote.portable-validation";

pub(crate) const INSTALLED_MUTEX_NAME: &str = "Local\\pl.nexus.aurea.single-instance";
const PORTABLE_MUTEX_NAME: &str = "Local\\pl.nexus.aurea.portable-validation.single-instance";

pub(crate) const INSTALLED_WINDOW_TITLE: &str = "VELORA";
const PORTABLE_WINDOW_TITLE: &str = "VELORA (Portable Validation)";

/// Returns the configured portable data root, if the process was launched by
/// the portable wrapper. Empty values are treated as "not portable".
pub(crate) fn data_dir() -> Option<PathBuf> {
    std::env::var_os(DATA_DIR_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// True when this process is the isolated portable validation candidate.
pub(crate) fn is_portable() -> bool {
    data_dir().is_some()
}

/// Windows Credential Manager service used for pairing secrets and device
/// tokens. The portable suffix guarantees a disjoint target namespace from the
/// installed VELORA 0.9.2 / 2.0 build.
pub(crate) fn credential_service() -> &'static str {
    credential_service_for(is_portable())
}

/// Single-instance mutex. A distinct name prevents the portable candidate from
/// activating or being activated by the installed VELORA window.
pub(crate) fn mutex_name() -> &'static str {
    mutex_name_for(is_portable())
}

/// Main-window title shown to the operator. Kept in sync with the title written
/// into the Tauri context in `lib.rs` so `FindWindowW` targets the right window.
pub(crate) fn window_title() -> &'static str {
    window_title_for(is_portable())
}

fn credential_service_for(portable: bool) -> &'static str {
    if portable {
        PORTABLE_CREDENTIAL_SERVICE
    } else {
        INSTALLED_CREDENTIAL_SERVICE
    }
}

fn mutex_name_for(portable: bool) -> &'static str {
    if portable {
        PORTABLE_MUTEX_NAME
    } else {
        INSTALLED_MUTEX_NAME
    }
}

fn window_title_for(portable: bool) -> &'static str {
    if portable {
        PORTABLE_WINDOW_TITLE
    } else {
        INSTALLED_WINDOW_TITLE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_identity_is_unchanged() {
        assert_eq!(
            credential_service_for(false),
            "com.nexus.aurea.remote",
            "the installed app's credential service must never change"
        );
        assert_eq!(mutex_name_for(false), "Local\\pl.nexus.aurea.single-instance");
        assert_eq!(window_title_for(false), "VELORA");
    }

    #[test]
    fn portable_identity_is_disjoint_from_installed_identity() {
        for portable in [true, false] {
            assert_ne!(
                credential_service_for(portable),
                credential_service_for(!portable)
            );
            assert_ne!(mutex_name_for(portable), mutex_name_for(!portable));
            assert_ne!(window_title_for(portable), window_title_for(!portable));
        }
    }

    #[test]
    fn portable_credential_service_keeps_the_installed_name_as_a_prefix() {
        // Makes the relationship auditable: same account layout, different
        // namespace, so no credential from the installed build is importable.
        assert!(credential_service_for(true).starts_with(INSTALLED_CREDENTIAL_SERVICE));
        assert!(credential_service_for(true).contains("portable"));
    }

    #[test]
    fn portable_mutex_is_still_session_local() {
        assert!(mutex_name_for(true).starts_with("Local\\"));
    }
}
