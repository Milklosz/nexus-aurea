//! Shared, bounded process inspection.
//!
//! A full Toolhelp32 snapshot is relatively cheap but not free, and several
//! runtime loops used to scan the whole table independently. This module keeps
//! one short-lived cache for polling and offers a forced refresh for launch
//! baselines, where an extra 350 ms of staleness could attach a pre-existing
//! process to a new session.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Polling loops tolerate a short cache window; launch baselines do not.
pub(crate) const PROCESS_CACHE_TTL_MS: u64 = 350;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessEntry {
    pub process_id: u32,
    pub parent_process_id: u32,
    pub image_name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProcessTable {
    entries: Vec<ProcessEntry>,
}

impl ProcessTable {
    #[cfg(test)]
    pub(crate) fn from_entries(entries: Vec<(u32, u32, &str)>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|(process_id, parent_process_id, image_name)| ProcessEntry {
                    process_id,
                    parent_process_id,
                    image_name: image_name.to_string(),
                })
                .collect(),
        }
    }

    pub(crate) fn entries(&self) -> &[ProcessEntry] {
        &self.entries
    }

    pub(crate) fn contains(&self, process_id: u32) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.process_id == process_id)
    }

    pub(crate) fn image_name(&self, process_id: u32) -> Option<&str> {
        self.entries
            .iter()
            .find(|entry| entry.process_id == process_id)
            .map(|entry| entry.image_name.as_str())
    }

    pub(crate) fn descendants_of(&self, root_process_id: u32) -> HashSet<u32> {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for entry in &self.entries {
            children
                .entry(entry.parent_process_id)
                .or_default()
                .push(entry.process_id);
        }
        let mut descendants = HashSet::new();
        let mut pending = vec![root_process_id];
        while let Some(parent) = pending.pop() {
            for child in children.get(&parent).into_iter().flatten() {
                if *child != root_process_id && descendants.insert(*child) {
                    pending.push(*child);
                }
            }
        }
        descendants
    }

    pub(crate) fn count_image(&self, image_name: &str) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.image_name.eq_ignore_ascii_case(image_name))
            .count()
    }

    pub(crate) fn find_process_id(&self, image_name: &str) -> Option<u32> {
        self.entries
            .iter()
            .find(|entry| entry.image_name.eq_ignore_ascii_case(image_name))
            .map(|entry| entry.process_id)
    }
}

/// A PID alone is not a process identity: Windows reuses PIDs. The creation
/// timestamp makes reuse detectable without touching process memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessIdentity {
    pub process_id: u32,
    pub created_at_100ns: u64,
}

impl ProcessIdentity {
    pub(crate) fn matches(self, other: ProcessIdentity) -> bool {
        self.process_id == other.process_id && self.created_at_100ns == other.created_at_100ns
    }
}

#[cfg(target_os = "windows")]
mod native {
    use super::{ProcessEntry, ProcessIdentity, ProcessTable};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    struct CachedTable {
        captured_at: Instant,
        table: Arc<ProcessTable>,
    }

    static CACHE: OnceLock<Mutex<Option<CachedTable>>> = OnceLock::new();

    fn cache() -> &'static Mutex<Option<CachedTable>> {
        CACHE.get_or_init(|| Mutex::new(None))
    }

    fn scan() -> Result<ProcessTable, String> {
        use windows::core::HRESULT;
        use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES};
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|_| "Nie można odczytać stanu procesów Windows.".to_string())?;
        let no_more_files = HRESULT::from_win32(ERROR_NO_MORE_FILES.0);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let first = unsafe { Process32FirstW(snapshot, &mut entry) };
        let mut entries = Vec::new();
        let result = match first {
            Ok(()) => loop {
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|character| *character == 0)
                    .unwrap_or(entry.szExeFile.len());
                entries.push(ProcessEntry {
                    process_id: entry.th32ProcessID,
                    parent_process_id: entry.th32ParentProcessID,
                    image_name: String::from_utf16_lossy(&entry.szExeFile[..length]),
                });
                match unsafe { Process32NextW(snapshot, &mut entry) } {
                    Ok(()) => {}
                    Err(error) if error.code() == no_more_files => break Ok(()),
                    Err(_) => break Err("Nie udało się odczytać stanu procesów Windows.".into()),
                }
            },
            Err(error) if error.code() == no_more_files => Ok(()),
            Err(_) => Err("Nie udało się odczytać stanu procesów Windows.".into()),
        };
        let close_result = unsafe { CloseHandle(snapshot) };
        if result.is_ok() && close_result.is_err() {
            return Err("Nie udało się zamknąć migawki procesów Windows.".into());
        }
        result.map(|_| ProcessTable { entries })
    }

    /// `force_refresh` is used for launch baselines. Polling callers share a
    /// 350 ms cache, which cuts duplicate Toolhelp scans without hiding a
    /// process exit for longer than the existing poll cadence.
    pub(crate) fn snapshot(force_refresh: bool) -> Result<Arc<ProcessTable>, String> {
        let mut guard = cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !force_refresh {
            if let Some(cached) = guard.as_ref() {
                if cached.captured_at.elapsed()
                    <= Duration::from_millis(super::PROCESS_CACHE_TTL_MS)
                {
                    return Ok(Arc::clone(&cached.table));
                }
            }
        }
        let table = Arc::new(scan()?);
        *guard = Some(CachedTable {
            captured_at: Instant::now(),
            table: Arc::clone(&table),
        });
        Ok(table)
    }

    pub(crate) fn identity(process_id: u32) -> Option<ProcessIdentity> {
        use std::ffi::c_void;

        type Handle = *mut c_void;
        #[repr(C)]
        #[derive(Default)]
        struct FileTime {
            low: u32,
            high: u32,
        }
        impl FileTime {
            fn as_u64(&self) -> u64 {
                (u64::from(self.high) << 32) | u64::from(self.low)
            }
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
            fn GetProcessTimes(
                process: Handle,
                creation: *mut FileTime,
                exit: *mut FileTime,
                kernel: *mut FileTime,
                user: *mut FileTime,
            ) -> i32;
            fn CloseHandle(object: Handle) -> i32;
        }

        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            return None;
        }
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        let succeeded =
            unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
        unsafe { CloseHandle(process) };
        (succeeded != 0 && creation.as_u64() != 0).then_some(ProcessIdentity {
            process_id,
            created_at_100ns: creation.as_u64(),
        })
    }
}

#[cfg(not(target_os = "windows"))]
mod native {
    use super::{ProcessIdentity, ProcessTable};
    use std::sync::Arc;

    pub(crate) fn snapshot(_force_refresh: bool) -> Result<Arc<ProcessTable>, String> {
        Err("Inspekcja procesów jest dostępna tylko w natywnej aplikacji Windows.".into())
    }

    pub(crate) fn identity(_process_id: u32) -> Option<ProcessIdentity> {
        None
    }
}

pub(crate) use native::identity;
pub(crate) use native::snapshot;

#[cfg(test)]
mod tests {
    use super::{ProcessEntry, ProcessIdentity, ProcessTable};

    #[test]
    fn descendant_walk_is_bounded_and_excludes_the_root() {
        let table = ProcessTable::from_entries(vec![
            (100, 0, "steam.exe"),
            (101, 100, "steamwebhelper.exe"),
            (102, 100, "Game.exe"),
            (103, 102, "child.exe"),
            (200, 0, "chrome.exe"),
        ]);
        let descendants = table.descendants_of(100);
        assert_eq!(
            descendants,
            std::collections::HashSet::from([101, 102, 103])
        );
        assert!(!descendants.contains(&200));
    }

    #[test]
    fn cyclic_parent_links_cannot_loop_forever() {
        let table = ProcessTable::from_entries(vec![(10, 11, "a.exe"), (11, 10, "b.exe")]);
        let descendants = table.descendants_of(10);
        assert_eq!(descendants, std::collections::HashSet::from([11]));
    }

    #[test]
    fn image_counts_are_case_insensitive_and_do_not_guess_paths() {
        let table = ProcessTable::from_entries(vec![
            (1, 0, "Chrome.ExE"),
            (2, 0, "chrome.exe"),
            (3, 0, "not-chrome.exe"),
        ]);
        assert_eq!(table.count_image("chrome.exe"), 2);
        assert_eq!(table.count_image("CHROME.EXE"), 2);
        assert_eq!(table.find_process_id("chrome.exe"), Some(1));
        let serialized = serde_json::to_value(ProcessEntry {
            process_id: 7,
            parent_process_id: 1,
            image_name: "game.exe".into(),
        })
        .unwrap();
        assert_eq!(serialized["imageName"], "game.exe");
    }

    #[test]
    fn process_identity_requires_both_pid_and_creation_time() {
        let first = ProcessIdentity {
            process_id: 42,
            created_at_100ns: 1_000,
        };
        assert!(first.matches(ProcessIdentity {
            process_id: 42,
            created_at_100ns: 1_000,
        }));
        assert!(!first.matches(ProcessIdentity {
            process_id: 42,
            created_at_100ns: 2_000,
        }));
        assert!(!first.matches(ProcessIdentity {
            process_id: 43,
            created_at_100ns: 1_000,
        }));
    }
}
