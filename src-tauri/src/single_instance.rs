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

/// Session-local mutex name: each Windows user session gets its own instance.
pub(crate) const MUTEX_NAME: &str = "Local\\pl.nexus.aurea.single-instance";
/// Class and title of the main Tauri window. The title must match `tauri.conf.json`
/// (checked by a unit test below).
pub(crate) const WINDOW_CLASS: &str = "Tauri Window";
pub(crate) const WINDOW_TITLE: &str = "VELORA";

const ERROR_ALREADY_EXISTS: u32 = 183;
const SW_RESTORE: i32 = 9;

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
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *const c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
        fn GetLastError() -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let name = wide(MUTEX_NAME);
    // SAFETY: `name` is a valid NUL-terminated UTF-16 string that outlives the call.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        // Fail open: if the mutex cannot be created, start normally.
        return true;
    }
    // SAFETY: plain Win32 call with no pointer arguments.
    let last_error = unsafe { GetLastError() };
    match classify_mutex_error(last_error) {
        Claim::Primary => {
            // Keep the handle open for the life of the process; closing it releases the lock.
            true
        }
        Claim::AlreadyRunning => {
            // SAFETY: `handle` was returned by CreateMutexW in this process.
            unsafe {
                CloseHandle(handle);
            }
            activate_existing_window(&wide(WINDOW_CLASS), &wide(WINDOW_TITLE));
            false
        }
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
    use super::{classify_mutex_error, Claim, MUTEX_NAME, WINDOW_CLASS, WINDOW_TITLE};

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
        assert!(MUTEX_NAME.starts_with("Local\\"));
    }

    #[test]
    fn window_title_matches_tauri_config() {
        let config = include_str!("../tauri.conf.json");
        assert!(
            config.contains(&format!("\"title\": \"{WINDOW_TITLE}\"")),
            "tauri.conf.json main window title must equal {WINDOW_TITLE}"
        );
    }

    #[test]
    fn window_class_is_the_tauri_default() {
        assert_eq!(WINDOW_CLASS, "Tauri Window");
    }
}
