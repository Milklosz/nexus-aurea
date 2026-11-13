//! Cross-process exclusive lock for the iPhone Remote credential state.
//!
//! The Windows Credential Manager entries written by `remote_access` are shared
//! by every process of the same Windows user, including other Windows sessions.
//! An in-process `Mutex` cannot order read-modify-write cycles between two
//! VELORA processes, so every state transition takes this lock first, re-reads
//! the stored state while holding it, and writes the result before releasing it.
//!
//! The lock is a byte-range lock (`LockFileEx`) on a small file inside the
//! user's profile. It is:
//!
//! * per user profile, not per Windows session (unlike the `Local\` mutex used
//!   by the single-instance guard), so two sessions of one user exclude each other;
//! * released by the operating system when the owning process dies, so a crash
//!   can never leave the store permanently locked;
//! * not squattable by another user (the file lives under the user's profile),
//!   unlike a `Global\` named object;
//! * fail-closed: if the lock cannot be created or acquired in time, the caller
//!   gets an error and must not touch the stored state;
//! * pinned: the file is opened without `FILE_SHARE_DELETE`, so while any
//!   VELORA process holds it open, other processes cannot delete or rename it
//!   (or its parent directories) and then create a second, independent lock at
//!   the same path.
//!
//! The Win32 calls are declared by hand, as in `single_instance.rs`, so no new
//! crate or `windows` feature is needed and `Cargo.lock` does not change.

use std::{
    fmt,
    fs::{File, OpenOptions},
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateLockError {
    /// The lock file could not be created or opened.
    Unavailable,
    /// Another writer held the lock for longer than the caller was willing to wait.
    Timeout,
}

impl fmt::Display for StateLockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("the credential state lock is unavailable"),
            Self::Timeout => formatter.write_str("the credential state lock is busy"),
        }
    }
}

/// Dropping the guard releases the lock.
pub struct StateLockGuard {
    _release: Box<dyn Send>,
}

impl StateLockGuard {
    pub fn new(release: Box<dyn Send>) -> Self {
        Self { _release: release }
    }
}

pub trait StateLock: Send + Sync {
    fn acquire(&self, timeout: Duration) -> Result<StateLockGuard, StateLockError>;
}

/// Lock-file location for one credential service inside the user's local
/// application data directory.
pub fn default_lock_path(service: &str) -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty())?;
    let file_name: String = service
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let mut path = PathBuf::from(base);
    path.push("VELORA");
    path.push("locks");
    path.push(format!("{file_name}.lock"));
    Some(path)
}

/// Lock whose location could not be determined. Every acquisition fails, so the
/// store stays closed instead of running unprotected.
pub struct UnavailableStateLock;

impl StateLock for UnavailableStateLock {
    fn acquire(&self, _timeout: Duration) -> Result<StateLockGuard, StateLockError> {
        Err(StateLockError::Unavailable)
    }
}

#[cfg(windows)]
pub struct FileStateLock {
    path: PathBuf,
}

#[cfg(windows)]
impl FileStateLock {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

}

#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;

    pub const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x1;
    pub const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x2;
    pub const ERROR_LOCK_VIOLATION: i32 = 33;
    pub const ERROR_SHARING_VIOLATION: i32 = 32;
    pub const FILE_SHARE_READ: u32 = 0x1;
    pub const FILE_SHARE_WRITE: u32 = 0x2;

    #[repr(C)]
    pub struct Overlapped {
        pub internal: usize,
        pub internal_high: usize,
        pub offset: u32,
        pub offset_high: u32,
        pub event: *mut c_void,
    }

    impl Overlapped {
        pub fn zeroed() -> Self {
            Self {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: std::ptr::null_mut(),
            }
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn LockFileEx(
            file: *mut c_void,
            flags: u32,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        pub fn UnlockFileEx(
            file: *mut c_void,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }
}

#[cfg(windows)]
struct HeldFileLock {
    file: File,
}

#[cfg(windows)]
impl Drop for HeldFileLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        let mut overlapped = win32::Overlapped::zeroed();
        // SAFETY: the handle is owned by `self.file` and still open; the
        // overlapped structure is a valid zeroed OVERLAPPED. A failed unlock is
        // harmless: closing the handle releases the lock as well.
        unsafe {
            win32::UnlockFileEx(self.file.as_raw_handle().cast(), 0, 1, 0, &mut overlapped);
        }
    }
}

#[cfg(windows)]
impl StateLock for FileStateLock {
    fn acquire(&self, timeout: Duration) -> Result<StateLockGuard, StateLockError> {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| StateLockError::Unavailable)?;
        }
        let deadline = Instant::now() + timeout;
        // Rust's default share mode includes FILE_SHARE_DELETE, which would let
        // any process of this user delete or rename the file while it is held and
        // then create a fresh file at the same path with an independent lock.
        // Sharing only READ | WRITE keeps the byte-range lock shared between
        // cooperating VELORA processes (they all open with the same mode) while
        // Windows refuses delete / rename of the file, and of its parent
        // directories, for as long as any handle is open.
        let file = loop {
            match OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .share_mode(win32::FILE_SHARE_READ | win32::FILE_SHARE_WRITE)
                .open(&self.path)
            {
                Ok(file) => break file,
                // A foreign handle that asked for DELETE access (a scanner or
                // indexer) can transiently conflict with the stricter mode.
                // Retry until the deadline; never fall back to a weaker mode.
                Err(error)
                    if error.raw_os_error() == Some(win32::ERROR_SHARING_VIOLATION) =>
                {
                    if Instant::now() >= deadline {
                        return Err(StateLockError::Timeout);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return Err(StateLockError::Unavailable),
            }
        };
        loop {
            let mut overlapped = win32::Overlapped::zeroed();
            // SAFETY: valid open handle and OVERLAPPED; locks one byte at offset 0.
            let locked = unsafe {
                win32::LockFileEx(
                    file.as_raw_handle().cast(),
                    win32::LOCKFILE_EXCLUSIVE_LOCK | win32::LOCKFILE_FAIL_IMMEDIATELY,
                    0,
                    1,
                    0,
                    &mut overlapped,
                )
            };
            if locked != 0 {
                return Ok(StateLockGuard::new(Box::new(HeldFileLock { file })));
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(win32::ERROR_LOCK_VIOLATION)
            {
                return Err(StateLockError::Unavailable);
            }
            if Instant::now() >= deadline {
                return Err(StateLockError::Timeout);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::Path;
    use std::{
        process::Command,
        sync::{Arc, Barrier},
        time::{SystemTime, UNIX_EPOCH},
    };

    const CHILD_PATH_ENV: &str = "VELORA_TEST_STATE_LOCK_PATH";
    const CHILD_READY_ENV: &str = "VELORA_TEST_STATE_LOCK_READY";
    const CHILD_HOLD_MS_ENV: &str = "VELORA_TEST_STATE_LOCK_HOLD_MS";

    fn temp_lock_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "velora-lock-test-{label}-{}-{unique}",
            std::process::id()
        ));
        path.push("state.lock");
        path
    }

    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn state_lock_child_holder() {
        let (Ok(path), Ok(ready), Ok(hold_ms)) = (
            std::env::var(CHILD_PATH_ENV),
            std::env::var(CHILD_READY_ENV),
            std::env::var(CHILD_HOLD_MS_ENV),
        ) else {
            return;
        };
        let lock = FileStateLock::new(path);
        let _guard = lock
            .acquire(Duration::from_secs(5))
            .expect("child acquires the lock");
        std::fs::write(ready, b"ready").expect("signal that the lock is held");
        std::thread::sleep(Duration::from_millis(hold_ms.parse().unwrap()));
    }

    #[test]
    fn lock_is_exclusive_between_independent_handles_and_released_on_drop() {
        let path = temp_lock_path("handles");
        let first = FileStateLock::new(&path);
        let second = FileStateLock::new(&path);
        let guard = first.acquire(Duration::from_secs(1)).expect("first lock");
        assert_eq!(
            second.acquire(Duration::from_millis(50)).err(),
            Some(StateLockError::Timeout)
        );
        drop(guard);
        let again = second
            .acquire(Duration::from_secs(1))
            .expect("lock is available after release");
        drop(again);
        cleanup(&path);
    }

    #[test]
    fn lock_excludes_a_separate_process_and_is_released_when_it_exits() {
        let path = temp_lock_path("process");
        let ready = path.with_file_name("ready.flag");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut child = Command::new(std::env::current_exe().expect("test executable"))
            .arg("--exact")
            .arg("remote_state_lock::tests::state_lock_child_holder")
            .arg("--nocapture")
            .env(CHILD_PATH_ENV, &path)
            .env(CHILD_READY_ENV, &ready)
            .env(CHILD_HOLD_MS_ENV, "1500")
            .spawn()
            .expect("start the lock-holding process");
        let started = Instant::now();
        while !ready.exists() {
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "child never reported the lock as held"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let lock = FileStateLock::new(&path);
        assert_eq!(
            lock.acquire(Duration::from_millis(100)).err(),
            Some(StateLockError::Timeout),
            "a second process must not enter the critical section"
        );
        child.wait().expect("child exits");
        let guard = lock
            .acquire(Duration::from_secs(2))
            .expect("the operating system released the exited process's lock");
        drop(guard);
        cleanup(&path);
    }

    #[test]
    fn held_lock_file_cannot_be_deleted_or_renamed_by_another_handle() {
        let path = temp_lock_path("pinned");
        let lock = FileStateLock::new(&path);
        let guard = lock.acquire(Duration::from_secs(1)).expect("lock");
        let renamed = path.with_file_name("renamed.lock");
        assert!(
            std::fs::remove_file(&path).is_err(),
            "deleting a held lock file must be refused"
        );
        assert!(
            std::fs::rename(&path, &renamed).is_err(),
            "renaming a held lock file must be refused"
        );
        assert!(path.exists() && !renamed.exists());
        // The directory that contains the pinned file cannot be swapped out either.
        let parent = path.parent().unwrap();
        let moved_parent = parent.with_file_name(format!(
            "{}-moved",
            parent.file_name().unwrap().to_string_lossy()
        ));
        assert!(
            std::fs::rename(parent, &moved_parent).is_err(),
            "renaming the lock directory must be refused"
        );
        // The pin must not weaken sharing: a second independent handle still
        // contends for the byte-range lock instead of failing to open.
        assert_eq!(
            FileStateLock::new(&path)
                .acquire(Duration::from_millis(50))
                .err(),
            Some(StateLockError::Timeout)
        );
        drop(guard);
        // Once released the file is an ordinary file again (recovery path).
        std::fs::rename(&path, &renamed).expect("rename after release");
        let _recreated = FileStateLock::new(&path)
            .acquire(Duration::from_secs(1))
            .expect("lock is re-created after release");
        drop(_recreated);
        cleanup(&path);
    }

    #[test]
    fn separate_process_cannot_delete_or_rename_a_lock_file_held_by_another_process() {
        let path = temp_lock_path("pinned-process");
        let ready = path.with_file_name("ready.flag");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Process A: holds the lock.
        let mut child = Command::new(std::env::current_exe().expect("test executable"))
            .arg("--exact")
            .arg("remote_state_lock::tests::state_lock_child_holder")
            .arg("--nocapture")
            .env(CHILD_PATH_ENV, &path)
            .env(CHILD_READY_ENV, &ready)
            .env(CHILD_HOLD_MS_ENV, "2500")
            .spawn()
            .expect("start the lock-holding process");
        let started = Instant::now();
        while !ready.exists() {
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "child never reported the lock as held"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        // Process B (this test process): tries to delete / rename the lock file.
        let renamed = path.with_file_name("stolen.lock");
        let delete_result = std::fs::remove_file(&path);
        let rename_result = std::fs::rename(&path, &renamed);
        let still_exists = path.exists();
        let lock = FileStateLock::new(&path);
        let contended = lock.acquire(Duration::from_millis(100)).err();
        child.wait().expect("child exits");
        assert!(delete_result.is_err(), "process B deleted a held lock file");
        assert!(rename_result.is_err(), "process B renamed a held lock file");
        assert!(still_exists && !renamed.exists());
        assert_eq!(contended, Some(StateLockError::Timeout));
        // After process A exits the lock synchronises later processes normally.
        let guard = lock
            .acquire(Duration::from_secs(2))
            .expect("lock is available after the holder exits");
        drop(guard);
        cleanup(&path);
    }

    #[test]
    fn contending_threads_never_overlap() {
        let path = temp_lock_path("threads");
        let inside = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(6));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let path = path.clone();
                let inside = inside.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let lock = FileStateLock::new(path);
                    barrier.wait();
                    for _ in 0..10 {
                        let _guard = lock.acquire(Duration::from_secs(10)).expect("lock");
                        let now = inside.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        assert_eq!(now, 0, "two holders were inside the critical section");
                        std::thread::sleep(Duration::from_millis(2));
                        inside.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("thread finished without overlap");
        }
        cleanup(&path);
    }

    #[test]
    fn unusable_lock_location_fails_closed() {
        let lock = FileStateLock::new(std::env::temp_dir()); // a directory, not a file
        assert_eq!(
            lock.acquire(Duration::from_millis(50)).err(),
            Some(StateLockError::Unavailable)
        );
        assert_eq!(
            UnavailableStateLock.acquire(Duration::from_millis(1)).err(),
            Some(StateLockError::Unavailable)
        );
    }
}
