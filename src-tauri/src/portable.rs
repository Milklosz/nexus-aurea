//! Portable validation build isolation.
//!
//! The portable build always uses a sibling profile, even on direct launch.
//! Standard builds retain the explicit development override and installed defaults.

use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

const DATA_DIR_NAME: &str = "VELORA-Portable-Data";

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

pub(crate) fn startup_data_dir() -> io::Result<Option<PathBuf>> {
    if !cfg!(all(windows, feature = "portable-validation")) {
        return Ok(data_dir());
    }
    let executable = env::current_exe()?;
    let directory = executable.parent().ok_or(io::ErrorKind::InvalidInput)?;
    Ok(Some(directory.join(DATA_DIR_NAME)))
}

/// Create the isolated root and reject redirected profile directories before
/// installing process-local overrides or letting the runtime open any files.
pub(crate) fn ensure_profile_directory(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            validate_profile_directory(path)
        }
        Err(error) => Err(error),
    }
}

fn validate_profile_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct ProfileInitError {
    pub(crate) stage: &'static str,
    pub(crate) source: io::Error,
}

pub(crate) fn initialize_profile(root: &Path) -> Result<(), ProfileInitError> {
    let local = root.join("Local");
    let roaming = root.join("Roaming");
    let temp = root.join("Temp");
    #[cfg(windows)]
    validate_webview2_data_root(root).map_err(|source| ProfileInitError {
        stage: "webview2-overrides",
        source,
    })?;
    for (stage, directory) in [("local", &local), ("roaming", &roaming), ("temp", &temp)] {
        ensure_profile_directory(directory).map_err(|source| ProfileInitError { stage, source })?;
    }
    #[cfg(windows)]
    {
        ensure_profile_directory(&root.join("EBWebView")).map_err(|source| ProfileInitError {
            stage: "webview2-data",
            source,
        })?;
        env::set_var(DATA_DIR_ENV, root);
        env::set_var("LOCALAPPDATA", local);
        env::set_var("APPDATA", roaming);
        env::set_var("USERPROFILE", root);
        env::set_var("TEMP", &temp);
        env::set_var("TMP", temp);
    }
    Ok(())
}

#[cfg(windows)]
fn validate_webview2_data_root(root: &Path) -> io::Result<()> {
    let override_path = env::var_os("WEBVIEW2_USER_DATA_FOLDER").filter(|value| !value.is_empty());
    if let Some(path) = override_path {
        let path = PathBuf::from(path);
        if !path.is_absolute()
            || validate_profile_directory(&path).is_err()
            || fs::canonicalize(path)? != fs::canonicalize(root)?
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "WebView2 data directory override",
            ));
        }
    }
    // Check without setting loader environment flags, which can take precedence
    // over the operator's configured WebView2 policies.
    use std::{
        ffi::OsString,
        os::windows::ffi::{OsStrExt, OsStringExt},
    };
    use windows::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
        System::{
            Com::CoTaskMemFree,
            Registry::{
                RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_ANY,
                RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY,
            },
        },
        UI::Shell::GetCurrentProcessExplicitAppUserModelID,
    };
    use windows_core::{w, PCWSTR};
    let executable = env::current_exe()?;
    // SAFETY: a successful Shell call returns an allocated UTF-16 string. Copy
    // it before freeing the allocation. Ordinary direct EXE launches may have
    // no explicit AppUserModelID.
    let app_id = unsafe {
        GetCurrentProcessExplicitAppUserModelID()
            .ok()
            .filter(|id| !id.is_null())
            .map(|id| {
                let text = OsString::from_wide(id.as_wide());
                CoTaskMemFree(Some(id.as_ptr().cast()));
                text
            })
    };
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for view in [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY] {
            for name in webview2_policy_names(&executable, app_id.as_deref()) {
                let wide: Vec<u16> = name.encode_wide().chain(Some(0)).collect();
                let mut size = 0;
                // SAFETY: the name is NUL-terminated and the size pointer is
                // writable during this read-only value-existence query.
                let status = unsafe {
                    RegGetValueW(
                        hive,
                        w!("Software\\Policies\\Microsoft\\Edge\\WebView2\\UserDataFolder"),
                        PCWSTR(wide.as_ptr()),
                        RRF_RT_ANY | view,
                        None,
                        None,
                        Some(&mut size),
                    )
                };
                match status {
                    ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => {}
                    ERROR_SUCCESS => {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "WebView2 data directory policy",
                        ))
                    }
                    error => return Err(io::Error::from_raw_os_error(error.0 as i32)),
                }
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn webview2_policy_names<'a>(
    executable: &'a Path,
    app_id: Option<&'a std::ffi::OsStr>,
) -> impl Iterator<Item = &'a std::ffi::OsStr> {
    // Microsoft excludes the wildcard name from the userDataFolder option.
    [app_id, executable.file_name(), executable.file_stem()]
        .into_iter()
        .flatten()
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

fn credential_service_for(portable: bool) -> &'static str {
    if portable {
        PORTABLE_CREDENTIAL_SERVICE
    } else {
        INSTALLED_CREDENTIAL_SERVICE
    }
}

/// A distinct name separates portable and installed instance claims.
pub(crate) fn mutex_name_for(portable: bool) -> &'static str {
    if portable {
        PORTABLE_MUTEX_NAME
    } else {
        INSTALLED_MUTEX_NAME
    }
}

/// Shared by startup window creation and duplicate-instance activation.
pub(crate) fn window_title_for(portable: bool) -> &'static str {
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
        assert_eq!(
            mutex_name_for(false),
            "Local\\pl.nexus.aurea.single-instance"
        );
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

    #[test]
    fn profile_creation_is_repeatable_and_rejects_a_file_in_place_of_a_directory() {
        let fixture = env::temp_dir().join(format!("velora-profile-test-{}", std::process::id()));
        ensure_profile_directory(&fixture).unwrap();
        ensure_profile_directory(&fixture).unwrap();
        let file = fixture.join("blocked");
        fs::write(&file, b"test fixture").unwrap();
        let result = ensure_profile_directory(&file);
        fs::remove_file(file).unwrap();
        fs::remove_dir(fixture).unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        assert_eq!(
            ensure_profile_directory(Path::new("relative/profile"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[cfg(windows)]
    #[test]
    fn webview2_policy_names_include_an_explicit_process_appid() {
        use std::ffi::OsStr;

        let executable = Path::new("nexus-aurea.exe");
        let named = webview2_policy_names(executable, Some(OsStr::new("Velora.Custom")));
        assert!(named.eq(["Velora.Custom", "nexus-aurea.exe", "nexus-aurea"].map(OsStr::new)));
        let unnamed = webview2_policy_names(executable, None);
        assert!(unnamed.eq(["nexus-aurea.exe", "nexus-aurea"].map(OsStr::new)));
    }

    #[cfg(unix)]
    #[test]
    fn profile_creation_rejects_a_redirected_directory() {
        let root = env::temp_dir().join(format!("velora-profile-link-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let link = root.join("redirected");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let result = ensure_profile_directory(&link);
        fs::remove_file(link).unwrap();
        fs::remove_dir(root).unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
    }
}
