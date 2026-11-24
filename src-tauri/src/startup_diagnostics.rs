use std::{
    collections::BTreeSet,
    fs::{File, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_EVENTS: usize = 32;
pub(crate) const FRONTEND_READY_EVENT: &str = "velora-startup-frontend-ready";

struct Trace {
    file: File,
    events: BTreeSet<&'static str>,
}

impl Trace {
    fn record(&mut self, event: &'static str, detail: std::fmt::Arguments<'_>) {
        if self.events.len() < MAX_EVENTS && self.events.insert(event) {
            let _ = writeln!(self.file, "{event}{detail}");
        }
    }
}

static TRACE: OnceLock<Mutex<Trace>> = OnceLock::new();

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
    let _ = TRACE.set(Mutex::new(Trace {
        file,
        events: BTreeSet::new(),
    }));
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
pub(crate) fn probe_webview2() {
    record("webview2-probe-start");
    match tauri::webview_version() {
        Ok(_) => record("webview2-runtime-detected"),
        Err(error) => record_wry_error("webview2-runtime-probe-failed", &error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_trace_records_each_phase_once() {
        let path =
            std::env::temp_dir().join(format!("velora-startup-test-{}.log", std::process::id()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let mut trace = Trace {
            file,
            events: BTreeSet::new(),
        };
        trace.record("window-created", format_args!(""));
        trace.record("window-created", format_args!(""));
        trace.record("window-visible", format_args!(""));
        trace.record("exit-orderly", format_args!(""));
        drop(trace);
        let output = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(
            output.lines().collect::<Vec<_>>(),
            ["window-created", "window-visible", "exit-orderly"]
        );
    }
}

#[cfg(windows)]
fn record_wry_error(event: &'static str, error: &wry::Error) {
    match error {
        wry::Error::WebView2Error(webview2_com::Error::WindowsError(error)) => {
            record_detail(
                event,
                format_args!(" category=webview2 hresult=0x{:08X}", error.code().0 as u32),
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
