//! Local Claude Code discovery. There is no supported subscription-usage export
//! in the discovered CLI. Never turn `/usage` into a model prompt or read tokens.
use serde::Serialize;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CACHE_MS: u64 = 15 * 60 * 1000;
const MAX_TEXT: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageError {
    NotInstalled,
    NotAuthenticated,
    UsageUnavailable,
    ParserIncompatible,
    Timeout,
    AwaitingUsage,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    pub category_id: String,
    pub category_label: String,
    pub used_percent: f64,
    pub reset_at: Option<String>,
    pub reset_timezone: Option<String>,
    /// Yearless CLI dates stay source text; the application must not guess a year.
    pub reset_text: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub source: &'static str,
    /// Unix milliseconds, only ever the last successful usage read.
    pub fetched_at: Option<u64>,
    pub status: &'static str,
    pub limits: Vec<UsageLimit>,
    pub source_version: Option<String>,
    pub stale: bool,
    pub refreshing: bool,
    pub error_code: Option<UsageError>,
    pub automatic_usage_supported: bool,
}

impl Default for UsageSnapshot {
    fn default() -> Self {
        Self {
            source: "claude-code",
            fetched_at: None,
            status: "unavailable",
            limits: Vec::new(),
            source_version: None,
            stale: false,
            refreshing: false,
            error_code: Some(UsageError::UsageUnavailable),
            automatic_usage_supported: false,
        }
    }
}

struct SourceRead {
    version: Option<String>,
    result: Result<Vec<UsageLimit>, UsageError>,
    captured_at: Option<u64>,
}

trait UsageSource: Send + Sync {
    fn read(&self) -> SourceRead;
    fn automatic_supported(&self) -> bool {
        false
    }
}

struct StatusLineSource;

impl UsageSource for StatusLineSource {
    fn automatic_supported(&self) -> bool {
        true
    }
    fn read(&self) -> SourceRead {
        let missing = || {
            let mut read = OfficialCliSource.read();
            if matches!(read.result, Err(UsageError::UsageUnavailable)) {
                read.result = Err(UsageError::AwaitingUsage);
            }
            read
        };
        let Some(path) = statusline_path() else {
            return missing();
        };
        match read_statusline(&path) {
            Ok(read) => read,
            Err(None) => missing(),
            Err(Some(error)) => SourceRead {
                version: None,
                result: Err(error),
                captured_at: None,
            },
        }
    }
}

fn statusline_path() -> Option<std::path::PathBuf> {
    let base = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    // Windows-only integration: never follow a network or frontend-supplied path.
    if !is_local_usage_base(&base) {
        return None;
    }
    Some(base.join("VELORA").join("claude-usage.json"))
}

fn is_local_usage_base(base: &std::path::Path) -> bool {
    base.is_absolute() && !base.to_string_lossy().replace('\\', "/").starts_with("//")
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusLineFile {
    schema_version: u8,
    source: String,
    captured_at: u64,
    source_version: Option<String>,
    rate_limits: std::collections::BTreeMap<String, StatusLineWindow>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusLineWindow {
    used_percentage: f64,
    resets_at: i64,
}

fn read_statusline(path: &std::path::Path) -> Result<SourceRead, Option<UsageError>> {
    use std::io::Read;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            None
        } else {
            Some(UsageError::UsageUnavailable)
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_TEXT as u64
    {
        return Err(Some(UsageError::ParserIncompatible));
    }
    let file = std::fs::File::open(path).map_err(|_| Some(UsageError::UsageUnavailable))?;
    let mut bytes = Vec::new();
    file.take((MAX_TEXT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Some(UsageError::UsageUnavailable))?;
    parse_statusline_file(&bytes, now_ms()).map_err(Some)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn parse_statusline_file(bytes: &[u8], now: u64) -> Result<SourceRead, UsageError> {
    if bytes.len() > MAX_TEXT {
        return Err(UsageError::ParserIncompatible);
    }
    let file: StatusLineFile =
        serde_json::from_slice(bytes).map_err(|_| UsageError::ParserIncompatible)?;
    if file.schema_version != 1
        || file.source != "claude-code-statusline"
        || file.captured_at == 0
        || file.captured_at > now.saturating_add(60_000)
        || file.source_version.as_ref().is_some_and(|v| {
            v.len() > 80
                || !v
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || " .()-".contains(c))
        })
    {
        return Err(UsageError::ParserIncompatible);
    }
    let mut limits = Vec::new();
    // Only these two subscription windows are officially documented. No Fable
    // or per-model quota is synthesized from context/cost/statistical fields.
    for (key, label) in [
        ("five_hour", "Current session"),
        ("seven_day", "Current week (all models)"),
    ] {
        let Some(window) = file.rate_limits.get(key) else {
            continue;
        };
        if !window.used_percentage.is_finite() || !(0.0..=100.0).contains(&window.used_percentage) {
            return Err(UsageError::ParserIncompatible);
        }
        if window.resets_at <= 0
            || window.resets_at.saturating_mul(1000) <= now.min(i64::MAX as u64) as i64
        {
            continue;
        }
        let reset = time::OffsetDateTime::from_unix_timestamp(window.resets_at)
            .map_err(|_| UsageError::ParserIncompatible)?;
        let reset = reset
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| UsageError::ParserIncompatible)?;
        limits.push(UsageLimit {
            category_id: key.into(),
            category_label: label.into(),
            used_percent: window.used_percentage,
            reset_at: Some(reset),
            reset_timezone: Some("Europe/Warsaw".into()),
            reset_text: None,
        });
    }
    if !valid_limits(&limits) {
        return Err(UsageError::AwaitingUsage);
    }
    Ok(SourceRead {
        version: file.source_version,
        result: Ok(limits),
        captured_at: Some(file.captured_at),
    })
}

struct OfficialCliSource;

impl UsageSource for OfficialCliSource {
    fn read(&self) -> SourceRead {
        let probe = || -> Result<SourceRead, UsageError> {
            let program = discover_cli().ok_or(UsageError::NotInstalled)?;
            let (success, version) =
                bounded_command(&program, &["--version"], Duration::from_secs(4))?;
            let version = version.trim();
            if !success
                || version.len() > 80
                || !version.ends_with(" (Claude Code)")
                || !version
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || " .()-".contains(c))
            {
                return Err(UsageError::UsageUnavailable);
            }
            let version = version.to_string();
            // Official read-only authentication command. Do not return or log its
            // raw output (it can contain account information).
            let auth = bounded_command(
                &program,
                &["auth", "status", "--json"],
                Duration::from_secs(4),
            );
            let result = match auth {
                Err(error) => Err(error),
                Ok((success, text)) => match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(value) if value.get("loggedIn").and_then(|v| v.as_bool()) == Some(false) => {
                        Err(UsageError::NotAuthenticated)
                    }
                    Ok(value)
                        if success
                            && value.get("loggedIn").and_then(|v| v.as_bool()) == Some(true) =>
                    {
                        Err(UsageError::UsageUnavailable)
                    }
                    _ => Err(UsageError::UsageUnavailable),
                },
            };
            Ok(SourceRead {
                version: Some(version),
                result,
                captured_at: None,
            })
        };
        probe().unwrap_or_else(|error| SourceRead {
            version: None,
            result: Err(error),
            captured_at: None,
        })
    }
}

fn discover_cli() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .filter(|p| p.is_absolute())
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}

/// Owns only the diagnostic process and its descendants. Closing a Windows
/// Job Object (or a Unix process group) never touches an existing Claude session.
struct OwnedProbe {
    child: std::process::Child,
    #[cfg(windows)]
    job: Option<windows::Win32::Foundation::HANDLE>,
}

impl OwnedProbe {
    fn spawn(command: &mut std::process::Command) -> Result<Self, UsageError> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No CLI code runs before its Job Object owns it. Only this newly
            // created process's primary thread is resumed after assignment.
            command.creation_flags(0x08000000 | 0x00000004); // NO_WINDOW | SUSPENDED
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command.spawn().map_err(|_| UsageError::UsageUnavailable)?;
        let mut owned = Self {
            child,
            #[cfg(windows)]
            job: None,
        };
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::System::JobObjects::*;
            let job = unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }
                .map_err(|_| UsageError::UsageUnavailable)?;
            owned.job = Some(job);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                )
                .map_err(|_| UsageError::UsageUnavailable)?;
                AssignProcessToJobObject(job, HANDLE(owned.child.as_raw_handle()))
                    .map_err(|_| UsageError::UsageUnavailable)?;
            }
            resume_owned_primary_thread(owned.child.id())?;
        }
        Ok(owned)
    }
}

#[cfg(windows)]
fn resume_owned_primary_thread(process_id: u32) -> Result<(), UsageError> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // The process handle stays alive and it has never run user code. Refuse an
    // unexpected thread layout; never touch another process or an existing session.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
        .map_err(|_| UsageError::UsageUnavailable)?;
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut threads = Vec::new();
    if unsafe { Thread32First(snapshot, &mut entry) }.is_ok() {
        loop {
            if entry.th32OwnerProcessID == process_id {
                threads.push(entry.th32ThreadID);
            }
            if unsafe { Thread32Next(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    if threads.len() != 1 {
        return Err(UsageError::UsageUnavailable);
    }
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, threads[0]) }
        .map_err(|_| UsageError::UsageUnavailable)?;
    let previous = unsafe { ResumeThread(thread) };
    unsafe {
        let _ = CloseHandle(thread);
    }
    if previous != 1 {
        return Err(UsageError::UsageUnavailable);
    }
    Ok(())
}

impl Drop for OwnedProbe {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Nonblocking bounded capture: no reader thread can outlive a request, even if
/// a descendant inherits stdout. Windows pipe reads happen only after PeekNamedPipe.
fn bounded_command(
    program: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String), UsageError> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut owned = OwnedProbe::spawn(&mut command)?;
    let mut stdout = owned
        .child
        .stdout
        .take()
        .ok_or(UsageError::UsageUnavailable)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let fd = stdout.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(UsageError::UsageUnavailable);
        }
    }
    let deadline = std::time::Instant::now() + timeout;
    let mut bytes = Vec::new();
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(UsageError::Timeout);
        }
        let status = owned
            .child
            .try_wait()
            .map_err(|_| UsageError::UsageUnavailable)?;
        let mut available = 4096u32;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::{ERROR_BROKEN_PIPE, HANDLE};
            if let Err(error) = unsafe {
                windows::Win32::System::Pipes::PeekNamedPipe(
                    HANDLE(stdout.as_raw_handle()),
                    None,
                    0,
                    None,
                    Some(&mut available),
                    None,
                )
            } {
                if error.code() == windows::core::HRESULT::from_win32(ERROR_BROKEN_PIPE.0) {
                    available = 0;
                } else {
                    return Err(UsageError::UsageUnavailable);
                }
            }
        }
        let mut read = 0;
        if available > 0 {
            let mut buffer = [0u8; 4096];
            let count = (available as usize).min(buffer.len());
            match stdout.read(&mut buffer[..count]) {
                Ok(size) => {
                    bytes.extend_from_slice(&buffer[..size]);
                    read = size;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return Err(UsageError::UsageUnavailable),
            }
            if bytes.len() > MAX_TEXT {
                return Err(UsageError::ParserIncompatible);
            }
        }
        if read == 0 {
            if let Some(status) = status {
                let text = String::from_utf8(bytes).map_err(|_| UsageError::ParserIncompatible)?;
                return Ok((status.success(), text));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[derive(Default)]
struct Cache {
    snapshot: UsageSnapshot,
    next_attempt_at: u64,
    failures: u32,
}

#[derive(Clone)]
pub struct ClaudeUsageService {
    source: Arc<dyn UsageSource>,
    cache: Arc<Mutex<Cache>>,
    flight: Arc<Mutex<()>>,
}

impl Default for ClaudeUsageService {
    fn default() -> Self {
        Self {
            source: Arc::new(StatusLineSource),
            cache: Arc::new(Mutex::new(Cache::default())),
            flight: Arc::new(Mutex::new(())),
        }
    }
}

impl ClaudeUsageService {
    fn snapshot(&self, now: u64, refreshing: bool) -> UsageSnapshot {
        let mut result = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot
            .clone();
        result.stale |= result
            .fetched_at
            .is_some_and(|at| now.saturating_sub(at) >= CACHE_MS);
        result.stale |= limits_expired(&result.limits, now);
        if result.stale {
            result.status = "stale";
        }
        result.refreshing = refreshing;
        result
    }

    fn refresh(&self, manual: bool, now: u64) -> UsageSnapshot {
        let _flight = match self.flight.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(error)) => error.into_inner(),
            Err(TryLockError::WouldBlock) => return self.snapshot(now, true),
        };
        {
            let cache = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Even manual refresh honours failure backoff. Successful cache can
            // be refreshed manually after the minimum one-minute process gate.
            if now < cache.next_attempt_at
                || (!manual
                    && !limits_expired(&cache.snapshot.limits, now)
                    && cache
                        .snapshot
                        .fetched_at
                        .is_some_and(|at| now.saturating_sub(at) < CACHE_MS))
            {
                drop(cache);
                return self.snapshot(now, false);
            }
        }
        let read = self.source.read();
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache.snapshot.source_version = read
            .version
            .or_else(|| cache.snapshot.source_version.clone());
        cache.snapshot.automatic_usage_supported = self.source.automatic_supported();
        match read.result {
            Ok(limits) if valid_limits(&limits) => {
                cache.failures = 0;
                cache.snapshot.limits = limits;
                let captured_at = read.captured_at.unwrap_or(now);
                cache.snapshot.fetched_at = Some(captured_at);
                cache.snapshot.stale = now.saturating_sub(captured_at) >= CACHE_MS;
                cache.snapshot.status = if cache.snapshot.stale {
                    "stale"
                } else {
                    "available"
                };
                cache.snapshot.error_code = None;
                cache.next_attempt_at = now.saturating_add(60_000);
            }
            result => {
                cache.failures = cache.failures.saturating_add(1);
                cache.snapshot.stale = cache.snapshot.fetched_at.is_some();
                cache.snapshot.status = if cache.snapshot.stale {
                    "stale"
                } else {
                    "unavailable"
                };
                cache.snapshot.error_code =
                    Some(result.err().unwrap_or(UsageError::ParserIncompatible));
                cache.next_attempt_at = now.saturating_add(
                    (60_000u64 << cache.failures.min(4).saturating_sub(1)).min(CACHE_MS),
                );
            }
        }
        drop(cache);
        self.snapshot(now, false)
    }
}

fn limits_expired(limits: &[UsageLimit], now: u64) -> bool {
    limits.iter().any(|limit| {
        limit.reset_at.as_ref().is_some_and(|reset| {
            time::OffsetDateTime::parse(reset, &time::format_description::well_known::Rfc3339)
                .is_ok_and(|at| at.unix_timestamp_nanos() / 1_000_000 <= i128::from(now))
        })
    })
}

fn valid_limits(limits: &[UsageLimit]) -> bool {
    !limits.is_empty()
        && limits.len() <= 32
        && limits.iter().all(|limit| {
            !limit.category_label.is_empty()
                && limit.category_label.len() <= 120
                && limit.used_percent.is_finite()
                && (0.0..=100.0).contains(&limit.used_percent)
        })
}

#[tauri::command]
pub async fn get_claude_usage(
    service: tauri::State<'_, ClaudeUsageService>,
    manual: bool,
) -> Result<UsageSnapshot, &'static str> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        service.refresh(manual, now)
    })
    .await
    .map_err(|_| "claudeUsageUnavailable")
}

/// Parser is intentionally dormant until a safe source adapter is available.
/// It accepts terminal fixtures, never a frontend-supplied command or live claim.
#[allow(dead_code)]
pub(crate) fn parse_usage(input: &str) -> Result<Vec<UsageLimit>, UsageError> {
    if input.len() > MAX_TEXT {
        return Err(UsageError::ParserIncompatible);
    }
    let text = strip_ansi(input)?;
    let mut result: Vec<UsageLimit> = Vec::new();
    let mut heading: Option<String> = None;
    for raw_line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let normalized = raw_line.split_whitespace().collect::<Vec<_>>().join(" ");
        let line = normalized.as_str();
        if line.starts_with("Current ") && !line.contains('%') && line.len() <= 120 {
            if heading.is_some() {
                return Err(UsageError::ParserIncompatible);
            }
            heading = Some(line.to_string());
        } else if let Some(prefix) = line.strip_suffix("% used") {
            let label = heading.take().ok_or(UsageError::ParserIncompatible)?;
            let number = prefix
                .split_whitespace()
                .last()
                .ok_or(UsageError::ParserIncompatible)?;
            let value: f64 = number.parse().map_err(|_| UsageError::ParserIncompatible)?;
            let bar = prefix.trim().strip_suffix(number).unwrap_or("");
            if !bar
                .chars()
                .all(|c| c.is_whitespace() || "[]#=|-█░▒▓▏▎▍▌▋▊▉▐─".contains(c))
            {
                return Err(UsageError::ParserIncompatible);
            }
            if !value.is_finite()
                || !(0.0..=100.0).contains(&value)
                || result.iter().any(|r| r.category_label == label)
            {
                return Err(UsageError::ParserIncompatible);
            }
            result.push(UsageLimit {
                category_id: label.to_ascii_lowercase(),
                category_label: label,
                used_percent: value,
                reset_at: None,
                reset_timezone: None,
                reset_text: None,
            });
        } else if let Some(reset) = line.strip_prefix("Resets ") {
            let limit = result
                .last_mut()
                .filter(|_| heading.is_none())
                .ok_or(UsageError::ParserIncompatible)?;
            if reset.len() > 200 || limit.reset_text.is_some() {
                return Err(UsageError::ParserIncompatible);
            }
            if let Some((date, timezone)) = reset.rsplit_once(" (") {
                let timezone = timezone
                    .strip_suffix(')')
                    .ok_or(UsageError::ParserIncompatible)?;
                if !timezone
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
                    || timezone.is_empty()
                {
                    return Err(UsageError::ParserIncompatible);
                }
                limit.reset_timezone = Some(timezone.into());
                if time::OffsetDateTime::parse(date, &time::format_description::well_known::Rfc3339)
                    .is_ok()
                {
                    limit.reset_at = Some(date.into());
                }
            } else if time::OffsetDateTime::parse(
                reset,
                &time::format_description::well_known::Rfc3339,
            )
            .is_ok()
            {
                limit.reset_at = Some(reset.into());
            }
            limit.reset_text = Some(reset.into());
        } else if line.contains("% used")
            || heading.is_some()
                && !line
                    .chars()
                    .all(|c| c.is_whitespace() || "[]#=|-█░▒▓▏▎▍▌▋▊▉▐─".contains(c))
        {
            return Err(UsageError::ParserIncompatible);
        }
    }
    if heading.is_some() || !valid_limits(&result) {
        return Err(UsageError::ParserIncompatible);
    }
    Ok(result)
}

fn strip_ansi(input: &str) -> Result<String, UsageError> {
    let mut out = String::new();
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    let mut closed = false;
                    for ch in chars.by_ref() {
                        if ('@'..='~').contains(&ch) {
                            closed = true;
                            break;
                        }
                    }
                    if !closed {
                        return Err(UsageError::ParserIncompatible);
                    }
                }
                Some(']') => {
                    let mut previous = '\0';
                    let mut closed = false;
                    for ch in chars.by_ref() {
                        if ch == '\x07' || previous == '\x1b' && ch == '\\' {
                            closed = true;
                            break;
                        }
                        previous = ch;
                    }
                    if !closed {
                        return Err(UsageError::ParserIncompatible);
                    }
                }
                _ => return Err(UsageError::ParserIncompatible),
            }
        } else if !c.is_control() || c == '\n' || c == '\t' {
            out.push(c);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    const FIXTURE: &str = include_str!("../test-fixtures/claude-usage.txt");
    fn statusline_fixture() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "source": "claude-code-statusline", "capturedAt": 1_000_000,
            "sourceVersion": "2.1.322", "rateLimits": {
                "five_hour": { "used_percentage": 0, "resets_at": 10_000 },
                "seven_day": { "used_percentage": 79, "resets_at": 90_000 }
            }
        }))
        .unwrap()
    }
    #[test]
    fn official_statusline_file_has_real_windows_and_no_invented_model_quota() {
        let read = parse_statusline_file(&statusline_fixture(), 1_000_000).unwrap();
        assert_eq!(read.captured_at, Some(1_000_000));
        let limits = read.result.unwrap();
        assert_eq!(limits.len(), 2);
        assert_eq!(limits[0].used_percent, 0.0);
        assert_eq!(limits[1].used_percent, 79.0);
        assert!(limits
            .iter()
            .all(|l| l.reset_at.is_some() && !l.category_label.contains("Fable")));
    }
    #[test]
    fn statusline_drops_expired_windows_and_rejects_future_malformed_or_private_fields() {
        let read = parse_statusline_file(&statusline_fixture(), 11_000_000).unwrap();
        assert_eq!(read.result.unwrap().len(), 1);
        assert!(matches!(
            parse_statusline_file(&statusline_fixture(), 91_000_000),
            Err(UsageError::AwaitingUsage)
        ));
        for (field, value) in [
            ("capturedAt", serde_json::json!(9_000_000)),
            ("source", serde_json::json!("manual")),
            ("schemaVersion", serde_json::json!(999)),
            ("token", serde_json::json!("must never be accepted")),
        ] {
            let mut data: serde_json::Value =
                serde_json::from_slice(&statusline_fixture()).unwrap();
            data[field] = value;
            assert!(matches!(
                parse_statusline_file(&serde_json::to_vec(&data).unwrap(), 1_000_000),
                Err(UsageError::ParserIncompatible)
            ));
        }
    }
    #[test]
    fn statusline_file_cache_preserves_capture_time_and_staleness() {
        struct FixtureSource;
        impl UsageSource for FixtureSource {
            fn read(&self) -> SourceRead {
                parse_statusline_file(&statusline_fixture(), 2_000_000).unwrap()
            }
            fn automatic_supported(&self) -> bool {
                true
            }
        }
        let service = ClaudeUsageService {
            source: Arc::new(FixtureSource),
            ..ClaudeUsageService::default()
        };
        let snapshot = service.refresh(true, 2_000_000);
        assert_eq!(snapshot.fetched_at, Some(1_000_000));
        assert!(snapshot.stale);
        assert_eq!(snapshot.status, "stale");
        assert!(snapshot.automatic_usage_supported);
    }
    #[test]
    fn local_file_reader_handles_missing_regular_and_oversized_files_without_cli() {
        let path = std::env::temp_dir().join(format!(
            "velora-usage-{}-{}.json",
            std::process::id(),
            now_ms()
        ));
        assert!(matches!(read_statusline(&path), Err(None)));
        let mut data: serde_json::Value = serde_json::from_slice(&statusline_fixture()).unwrap();
        data["rateLimits"]["five_hour"]["resets_at"] = serde_json::json!(now_ms() / 1000 + 100);
        data["rateLimits"]["seven_day"]["resets_at"] = serde_json::json!(now_ms() / 1000 + 500);
        std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        let read = read_statusline(&path).unwrap();
        assert_eq!(read.captured_at, Some(1_000_000));
        std::fs::write(&path, vec![b'x'; MAX_TEXT + 1]).unwrap();
        assert!(matches!(
            read_statusline(&path),
            Err(Some(UsageError::ParserIncompatible))
        ));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn expired_reset_marks_cache_stale_and_bypasses_success_ttl_after_process_gate() {
        let mut rows = limits();
        rows[0].reset_at = Some("1970-01-01T00:01:40Z".into());
        let (service, source) = service(Ok(rows));
        assert!(!service.refresh(false, 1_000).stale);
        assert!(service.snapshot(200_000, false).stale);
        let snapshot = service.refresh(false, 200_000);
        assert!(snapshot.stale);
        assert_eq!(snapshot.status, "stale");
        assert_eq!(source.calls.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn local_usage_paths_reject_both_unc_spellings() {
        for base in ["//server/share", r"\\server\share"] {
            assert!(!is_local_usage_base(std::path::Path::new(base)));
        }
        assert!(is_local_usage_base(&std::env::temp_dir()));
    }
    fn limits() -> Vec<UsageLimit> {
        parse_usage(FIXTURE).unwrap()
    }
    struct MockSource {
        calls: AtomicUsize,
        result: Mutex<Result<Vec<UsageLimit>, UsageError>>,
    }
    impl UsageSource for MockSource {
        fn read(&self) -> SourceRead {
            self.calls.fetch_add(1, Ordering::SeqCst);
            SourceRead {
                version: Some("test fixture".into()),
                result: self.result.lock().unwrap().clone(),
                captured_at: None,
            }
        }
    }
    fn service(
        result: Result<Vec<UsageLimit>, UsageError>,
    ) -> (ClaudeUsageService, Arc<MockSource>) {
        let source = Arc::new(MockSource {
            calls: AtomicUsize::new(0),
            result: Mutex::new(result),
        });
        (
            ClaudeUsageService {
                source: source.clone(),
                ..ClaudeUsageService::default()
            },
            source,
        )
    }
    #[test]
    fn parses_supplied_example_without_inventing_a_reset_year() {
        let rows = limits();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows.iter().map(|r| r.used_percent).collect::<Vec<_>>(),
            vec![0.0, 79.0, 19.0]
        );
        assert_eq!(rows[2].category_label, "Current week (Fable)");
        assert_eq!(rows[1].reset_at, None);
        assert_eq!(rows[1].reset_timezone.as_deref(), Some("Europe/Warsaw"));
        assert!(rows[0].reset_text.is_none());
    }
    #[test]
    fn strips_ansi_csi_and_osc_and_tolerates_spacing_and_terminal_bars() {
        let decorated = format!(
            "\x1b]0;private title\x07\x1b[32m{}\x1b[0m",
            FIXTURE.replace("79% used", "79%    used")
        );
        assert_eq!(parse_usage(&decorated).unwrap(), limits());
        assert_eq!(
            parse_usage(&FIXTURE.replace("███████████████░░░░", "[###]   ")).unwrap(),
            limits()
        );
    }
    #[test]
    fn accepts_new_model_categories_and_missing_resets() {
        let rows = parse_usage("Current week (Future Model)\n42% used").unwrap();
        assert_eq!(rows[0].used_percent, 42.0);
        assert_eq!(rows[0].reset_at, None);
    }
    #[test]
    fn rejects_empty_partial_unassociated_and_out_of_range_values() {
        for text in [
            "",
            "79% used",
            "stats 79 tokens",
            "Current session",
            "Current session\n101% used",
            "Current session\n-1% used",
            "Current session\nNaN% used",
            "Current session\nnotes 79% used",
            "Current session\n0% used\nCurrent week (Fable)",
            "Current session\n0% used\nCurrent session\n1% used",
            "Current session\n0% used\nResets ??? (",
            "\x1b[",
            "\x1b]unfinished",
        ] {
            assert_eq!(
                parse_usage(text),
                Err(UsageError::ParserIncompatible),
                "{text:?}"
            );
        }
    }
    #[test]
    fn reset_requires_explicit_offset_and_preserves_warsaw_dst_instants() {
        for date in ["2026-11-18T14:59:00+01:00", "2026-07-18T14:59:00+02:00"] {
            let rows = parse_usage(&format!(
                "Current week (all models)\n79% used\nResets {date} (Europe/Warsaw)"
            ))
            .unwrap();
            assert_eq!(rows[0].reset_at.as_deref(), Some(date));
        }
        let rows =
            parse_usage("Current session\n0% used\nResets 2026-11-18T14:59:00 (Europe/Warsaw)")
                .unwrap();
        assert!(rows[0].reset_at.is_none());
    }
    #[test]
    fn parser_limits_input_and_category_count() {
        assert!(parse_usage(&"x".repeat(MAX_TEXT + 1)).is_err());
        let input: String = (0..33)
            .map(|n| format!("Current category {n}\n0% used\n"))
            .collect();
        assert!(parse_usage(&input).is_err());
    }
    #[test]
    fn cache_manual_refresh_ttl_and_failure_keep_original_timestamp() {
        let (service, source) = service(Ok(limits()));
        let first = service.refresh(false, 1000);
        assert_eq!(first.fetched_at, Some(1000));
        service.refresh(false, 70_000);
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
        let manual = service.refresh(true, 70_000);
        assert_eq!(manual.fetched_at, Some(70_000));
        *source.result.lock().unwrap() = Err(UsageError::Timeout);
        let stale = service.refresh(true, 140_000);
        assert!(stale.stale);
        assert_eq!(stale.status, "stale");
        assert_eq!(stale.fetched_at, Some(70_000));
        assert_eq!(stale.limits, first.limits);
        assert_eq!(stale.error_code, Some(UsageError::Timeout));
        assert!(service.snapshot(CACHE_MS + 70_000, false).stale);
    }
    #[test]
    fn errors_and_backoff_are_explicit_without_fabricated_limits() {
        for error in [
            UsageError::NotInstalled,
            UsageError::NotAuthenticated,
            UsageError::UsageUnavailable,
            UsageError::ParserIncompatible,
            UsageError::Timeout,
        ] {
            let (service, source) = service(Err(error.clone()));
            let result = service.refresh(false, 1000);
            assert_eq!(result.error_code, Some(error));
            assert!(result.limits.is_empty());
            assert!(result.fetched_at.is_none());
            service.refresh(true, 1001);
            assert_eq!(source.calls.load(Ordering::SeqCst), 1);
            service.refresh(true, 61_000);
            assert_eq!(source.calls.load(Ordering::SeqCst), 2);
            service.refresh(true, 121_000);
            assert_eq!(source.calls.load(Ordering::SeqCst), 2);
        }
    }
    #[test]
    fn concurrent_requests_never_start_a_second_source_read() {
        struct BlockingSource {
            started: Mutex<std::sync::mpsc::SyncSender<()>>,
            resume: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl UsageSource for BlockingSource {
            fn read(&self) -> SourceRead {
                self.started.lock().unwrap().send(()).unwrap();
                self.resume
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap();
                SourceRead {
                    version: None,
                    result: Ok(limits()),
                    captured_at: None,
                }
            }
        }
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(1);
        let service = ClaudeUsageService {
            source: Arc::new(BlockingSource {
                started: Mutex::new(started_tx),
                resume: Mutex::new(resume_rx),
            }),
            ..ClaudeUsageService::default()
        };
        let other = service.clone();
        let worker = std::thread::spawn(move || other.refresh(true, 1000));
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(service.refresh(true, 1001).refreshing);
        resume_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap().status, "available");
    }
    #[test]
    fn invalid_source_results_never_enter_the_cache() {
        let (service, _) = service(Ok(vec![]));
        assert_eq!(
            service.refresh(false, 1).error_code,
            Some(UsageError::ParserIncompatible)
        );
    }
    #[test]
    fn process_timeout_kills_and_reaps_only_the_owned_fixture_child() {
        let exe = std::env::current_exe().unwrap();
        let result = bounded_command(
            &exe,
            &["--exact", "claude_usage::tests::fixture_child", "--ignored"],
            Duration::from_millis(100),
        );
        assert_eq!(result, Err(UsageError::Timeout));
    }
    #[cfg(windows)]
    #[test]
    fn inherited_stdout_cannot_keep_a_request_or_its_descendant_alive() {
        let started = std::time::Instant::now();
        let (_, output) = bounded_command(
            &std::env::current_exe().unwrap(),
            &[
                "--exact",
                "claude_usage::tests::fixture_parent",
                "--ignored",
                "--nocapture",
            ],
            Duration::from_secs(2),
        )
        .unwrap();
        let pid: u32 = output
            .lines()
            .find_map(|line| line.strip_prefix("descendant="))
            .unwrap()
            .parse()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while crate::process_table::snapshot(true).unwrap().contains(pid)
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!crate::process_table::snapshot(true).unwrap().contains(pid));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess helper; invoked only by the inherited-stdout test"]
    fn fixture_parent() {
        use std::io::Write;
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "claude_usage::tests::fixture_child", "--ignored"])
            .stdout(std::process::Stdio::inherit())
            .spawn()
            .unwrap();
        println!("descendant={}", child.id());
        std::io::stdout().flush().unwrap();
        // This fixture intentionally leaves its owned descendant to the Job Object.
        std::mem::forget(child);
    }
    #[test]
    #[ignore = "subprocess helper; invoked only by the timeout test"]
    fn fixture_child() {
        std::thread::sleep(Duration::from_secs(10));
    }
}
