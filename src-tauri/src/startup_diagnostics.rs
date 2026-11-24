use std::{
    collections::BTreeSet,
    fs::{File, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_EVENTS: usize = 32;
const MAX_TRACE_BYTES: usize = 4 * 1024;
pub(crate) const FRONTEND_READY_EVENT: &str = "velora-startup-frontend-ready";

struct Trace<W> {
    writer: W,
    events: BTreeSet<&'static str>,
    remaining_bytes: usize,
}

impl<W: Write> Trace<W> {
    fn new(writer: W) -> Self {
        Self {
            writer,
            events: BTreeSet::new(),
            remaining_bytes: MAX_TRACE_BYTES,
        }
    }

    fn record(&mut self, event: &'static str, detail: std::fmt::Arguments<'_>) {
        if self.events.len() >= MAX_EVENTS || self.events.contains(event) {
            return;
        }
        let line = format!("{event}{detail}\n");
        if line.len() > self.remaining_bytes {
            return;
        }
        if self.writer.write_all(line.as_bytes()).is_ok() {
            self.remaining_bytes -= line.len();
            self.events.insert(event);
        } else {
            // An incomplete write may have left part of this record on disk.
            // Stop before appending another record to that partial line.
            self.remaining_bytes = 0;
        }
    }

    fn record_shutdown(&mut self) {
        let event = if self.events.contains("frontend-ready") {
            "exit-orderly"
        } else {
            "exit-before-frontend-ready"
        };
        self.record(event, format_args!(""));
    }
}

static TRACE: OnceLock<Mutex<Trace<File>>> = OnceLock::new();

pub(crate) fn begin(root: &Path) -> io::Result<()> {
    let pid = std::process::id();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // Unique to this process, including when a duplicate launches. Never open
    // an existing path for writing or follow a file link.
    let path = root.join(format!("startup-{pid}-{timestamp}.log"));
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let _ = TRACE.set(Mutex::new(Trace::new(file)));
    record_detail(
        "process-start",
        format_args!(
            " pid={pid} unix_ms={timestamp} version={} commit={} portable=true arch={}",
            env!("CARGO_PKG_VERSION"),
            env!("VELORA_BUILD_SHA"),
            std::env::consts::ARCH
        ),
    );
    std::panic::set_hook(Box::new(|info| {
        // Panic messages and backtraces can contain paths and secrets. Keep
        // only the source category and numeric line/column.
        if let Some(location) = info.location() {
            let source = if location.file().contains("tauri-") {
                "tauri"
            } else {
                "rust"
            };
            record_panic(format_args!(
                " source={source} line={} column={}",
                location.line(),
                location.column()
            ));
        } else {
            record_panic(format_args!(""));
        }
    }));
    Ok(())
}

pub(crate) fn record(event: &'static str) {
    record_detail(event, format_args!(""));
}

pub(crate) fn record_io_error(event: &'static str, error: &io::Error) {
    record_detail(
        event,
        format_args!(
            " kind={:?} os_code={:?}",
            error.kind(),
            error.raw_os_error()
        ),
    );
}

pub(crate) fn record_profile_error(stage: &'static str, error: &io::Error) {
    record_detail(
        "exit-profile-error",
        format_args!(
            " stage={stage} kind={:?} os_code={:?}",
            error.kind(),
            error.raw_os_error()
        ),
    );
}

pub(crate) fn record_shutdown() {
    if let Some(trace) = TRACE.get() {
        if let Ok(mut trace) = trace.lock() {
            trace.record_shutdown();
        }
    }
}

pub(crate) fn record_tauri_error(event: &'static str, error: &tauri::Error) {
    let category = match error {
        tauri::Error::Io(error) => return record_io_error(event, error),
        #[cfg(windows)]
        tauri::Error::Runtime(error) => {
            use tauri_runtime::Error;
            match error {
                Error::CreateWebview(cause) => {
                    if let Some(error) = cause.downcast_ref::<wry::Error>() {
                        return record_wry_error(event, error);
                    }
                    "webview-create"
                }
                Error::CreateWindow => "native-window-create",
                Error::WebviewRuntimeNotInstalled => "webview2-runtime-unavailable",
                _ => "native-runtime",
            }
        }
        #[cfg(not(windows))]
        tauri::Error::Runtime(_) => "native-runtime",
        tauri::Error::InvalidAppDirectoriesOverride(..) => "profile-path",
        tauri::Error::PluginInitialization(..) => "plugin-initialization",
        tauri::Error::WindowLabelAlreadyExists(_) | tauri::Error::WebviewLabelAlreadyExists(_) => {
            "duplicate-label"
        }
        tauri::Error::AssetNotFound(_) => "missing-asset",
        tauri::Error::InvalidWindowHandle | tauri::Error::WindowNotFound => "native-window",
        _ => "tauri-initialization",
    };
    record_detail(event, format_args!(" category={category}"));
}

#[cfg(windows)]
pub(crate) fn probe_webview2() -> bool {
    record("webview2-probe-start");
    match tauri::webview_version() {
        Ok(_) => {
            record("webview2-runtime-detected");
            true
        }
        Err(error) => {
            record_wry_error("exit-webview2-runtime-error", &error);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_trace_records_each_phase_once() {
        let mut trace = Trace::new(Vec::new());
        trace.record("window-created", format_args!(""));
        trace.record("window-created", format_args!(""));
        trace.record("window-visible", format_args!(""));
        assert_eq!(trace.writer.as_slice(), b"window-created\nwindow-visible\n");
    }

    #[test]
    fn startup_trace_skips_over_budget_records_and_keeps_complete_lines() {
        let mut trace = Trace::new(Vec::new());
        let too_long = "a".repeat(MAX_TRACE_BYTES);
        trace.record("oversized", format_args!(" {too_long}"));
        assert!(trace.writer.is_empty());
        let payload = "b".repeat(MAX_TRACE_BYTES - "phase \n".len());
        trace.record("phase", format_args!(" {payload}"));
        trace.record("beyond-limit", format_args!(""));
        assert_eq!(trace.writer.len(), MAX_TRACE_BYTES);
        assert!(trace.writer.ends_with(b"\n"));
        assert_eq!(trace.events, BTreeSet::from(["phase"]));
    }

    #[test]
    fn orderly_shutdown_requires_frontend_readiness() {
        let mut early = Trace::new(Vec::new());
        early.record("window-visible", format_args!(""));
        early.record_shutdown();
        assert!(early.writer.ends_with(b"exit-before-frontend-ready\n"));

        let mut ready = Trace::new(Vec::new());
        ready.record("frontend-ready", format_args!(""));
        ready.record_shutdown();
        assert!(ready.writer.ends_with(b"exit-orderly\n"));
    }

    #[cfg(windows)]
    #[test]
    fn webview2_error_categories_distinguish_missing_from_other_loader_failures() {
        assert_eq!(
            webview2_error_category(0x8007_0002),
            "webview2-runtime-unavailable"
        );
        assert_eq!(webview2_error_category(0x8007_0005), "webview2");
    }
}

#[cfg(windows)]
fn webview2_error_category(hresult: u32) -> &'static str {
    // GetAvailableCoreWebView2BrowserVersionString returns this HRESULT when
    // the loader cannot find a supported runtime for the current process.
    if hresult == 0x8007_0002 {
        "webview2-runtime-unavailable"
    } else {
        "webview2"
    }
}

#[cfg(windows)]
fn record_wry_error(event: &'static str, error: &wry::Error) {
    match error {
        wry::Error::WebView2Error(webview2_com::Error::WindowsError(error)) => {
            let hresult = error.code().0 as u32;
            let category = webview2_error_category(hresult);
            record_detail(
                event,
                format_args!(" category={category} hresult=0x{hresult:08X}"),
            );
        }
        wry::Error::Io(error) => record_io_error(event, error),
        _ => record_detail(event, format_args!(" category=webview-create")),
    }
}

fn record_detail(event: &'static str, detail: std::fmt::Arguments<'_>) {
    if let Some(trace) = TRACE.get() {
        if let Ok(mut trace) = trace.lock() {
            trace.record(event, detail);
        }
    }
}

fn record_panic(detail: std::fmt::Arguments<'_>) {
    // The panic hook must never wait on a lock held by the panicking thread.
    if let Some(trace) = TRACE.get() {
        if let Ok(mut trace) = trace.try_lock() {
            trace.record("panic", detail);
        }
    }
}
