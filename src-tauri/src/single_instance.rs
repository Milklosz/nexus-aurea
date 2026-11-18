//! Single-instance guard for VELORA.
//!
//! A second launch (Start Menu, Startup folder, double-click) must not create a
//! second process with its own full-screen window. The first instance keeps a
//! named mutex; a later launch finds the running window, brings it forward and
//! exits before Tauri starts.
//!
//! The Win32 calls are declared by hand, as in `window_broker.rs`, so this module
//! needs no new crate or `windows` feature and `Cargo.lock` does not change.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

/// Class of the main Tauri window. The portable build uses a different title
/// (see `crate::portable`) so the two builds never activate each other's window.
pub(crate) const WINDOW_CLASS: &str = "Tauri Window";

const ERROR_ALREADY_EXISTS: u32 = 183;
const SW_RESTORE: i32 = 9;

#[cfg(windows)]
static INSTANCE_HANDLE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Claim {
    /// This process created the mutex and is the only instance.
    Primary,
    /// Another instance already holds the mutex.
    AlreadyRunning,
}

/// Decide what a `CreateMutexW` call means, from the `GetLastError` value it left.
pub(crate) fn classify_mutex_error(last_error: u32) -> Claim {
    if last_error == ERROR_ALREADY_EXISTS {
        Claim::AlreadyRunning
    } else {
        Claim::Primary
    }
}

/// Returns `true` when this process should continue starting up. Returns `false`
/// when another instance is already running; that instance has been brought to
/// the front and this process should exit without starting Tauri.
#[cfg(target_os = "windows")]
pub(crate) fn claim_or_activate_existing() -> bool {
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let Some((handle, claim)) = native::create(crate::portable::mutex_name()) else {
        // Fail open: if the mutex cannot be created, start normally.
        return true;
    };
    match claim {
        Claim::Primary => {
            INSTANCE_HANDLE.store(handle, std::sync::atomic::Ordering::Release);
            true
        }
        Claim::AlreadyRunning => {
            native::close(handle);
            activate_existing_window(
                &wide(WINDOW_CLASS),
                &wide(crate::portable::window_title()),
            );
            false
        }
    }
}

/// Called only after Tauri enters its orderly Exit event and worker shutdown
/// has been requested. Tauri spawns a restart child before the old process exits;
/// retaining this handle until process teardown would make that child reject
/// itself as a duplicate. Never release it on a mere restart request or read.
pub(crate) fn release_for_shutdown() {
    #[cfg(windows)]
    release_handle(&INSTANCE_HANDLE);
}

#[cfg(windows)]
fn release_handle(slot: &std::sync::atomic::AtomicUsize) {
    let handle = slot.swap(0, std::sync::atomic::Ordering::AcqRel);
    if handle != 0 {
        native::close(handle);
    }
}

#[cfg(windows)]
mod native {
    use super::{classify_mutex_error, Claim};
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            attributes: *const c_void,
            initial_owner: i32,
            name: *const u16,
        ) -> *mut c_void;
        fn GetLastError() -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub(super) fn create(name: &str) -> Option<(usize, Claim)> {
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        // SAFETY: the NUL-terminated name lives throughout the call. No ownership
        // is acquired: handle lifetime is the existing single-instance protocol.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return None;
        }
        let last_error = unsafe { GetLastError() };
        Some((handle as usize, classify_mutex_error(last_error)))
    }
    pub(super) fn close(handle: usize) {
        // SAFETY: handles originate in CreateMutexW and each caller releases
        // its own reference exactly once (the shared slot uses an atomic swap).
        let _ = unsafe { CloseHandle(handle as *mut c_void) };
    }
}

#[cfg(target_os = "windows")]
fn activate_existing_window(class_name: &[u16], window_name: &[u16]) {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class_name: *const u16, window_name: *const u16) -> *mut c_void;
        fn IsIconic(window: *mut c_void) -> i32;
        fn ShowWindow(window: *mut c_void, command: i32) -> i32;
        fn SetForegroundWindow(window: *mut c_void) -> i32;
    }

    // SAFETY: both slices are NUL-terminated and live for the duration of the call.
    let window = unsafe { FindWindowW(class_name.as_ptr(), window_name.as_ptr()) };
    if window.is_null() {
        return;
    }
    // SAFETY: `window` was just returned by FindWindowW.
    unsafe {
        if IsIconic(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        }
        SetForegroundWindow(window);
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn claim_or_activate_existing() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{classify_mutex_error, Claim, WINDOW_CLASS};
    use crate::portable::{INSTALLED_MUTEX_NAME, INSTALLED_WINDOW_TITLE};

    #[test]
    fn existing_mutex_means_another_instance_is_running() {
        assert_eq!(classify_mutex_error(183), Claim::AlreadyRunning);
    }

    #[test]
    fn fresh_mutex_means_this_is_the_primary_instance() {
        assert_eq!(classify_mutex_error(0), Claim::Primary);
    }

    #[test]
    fn mutex_name_is_session_local() {
        assert!(INSTALLED_MUTEX_NAME.starts_with("Local\\"));
    }

    #[test]
    fn window_title_matches_tauri_config() {
        let config = include_str!("../tauri.conf.json");
        assert!(
            config.contains(&format!("\"title\": \"{INSTALLED_WINDOW_TITLE}\"")),
            "tauri.conf.json main window title must equal {INSTALLED_WINDOW_TITLE}"
        );
    }

    #[test]
    fn window_class_is_the_tauri_default() {
        assert_eq!(WINDOW_CLASS, "Tauri Window");
    }

    #[cfg(windows)]
    #[test]
    fn orderly_exit_releases_only_its_guard_before_restart_and_is_idempotent() {
        use std::sync::atomic::AtomicUsize;
        // Test-only name: never touch the running user's real VELORA guard.
        let name = format!("Local\\pl.nexus.aurea.tests.restart.{}", std::process::id());
        let (first, claim) = super::native::create(&name).expect("create isolated test mutex");
        assert_eq!(claim, Claim::Primary);
        let slot = AtomicUsize::new(first);
        let (duplicate, claim) = super::native::create(&name).unwrap();
        assert_eq!(claim, Claim::AlreadyRunning);
        super::native::close(duplicate);
        // A normal second launch remains a duplicate until orderly shutdown.
        super::release_handle(&slot);
        super::release_handle(&slot);
        let (replacement, claim) = super::native::create(&name).unwrap();
        assert_eq!(claim, Claim::Primary);
        super::native::close(replacement);
    }
}
