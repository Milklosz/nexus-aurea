use serde::Serialize;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackHotkey {
    pub id: String,
    pub label: String,
    pub modifiers: u32,
    pub virtual_key: u32,
}

const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_NOREPEAT: u32 = 0x4000;
const VK_N: u32 = 0x4e;

pub(crate) const FALLBACK_HOTKEY_PRESETS: &[(&str, &str, u32, u32)] = &[
    ("ctrlAltN", "Ctrl+Alt+N", MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_N),
    (
        "ctrlShiftN",
        "Ctrl+Shift+N",
        MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
        VK_N,
    ),
    (
        "altShiftN",
        "Alt+Shift+N",
        MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
        VK_N,
    ),
];

pub(crate) fn fallback_hotkey_preset(id: &str) -> Option<FallbackHotkey> {
    FALLBACK_HOTKEY_PRESETS
        .iter()
        .find(|(preset, ..)| *preset == id)
        .map(|(preset, label, modifiers, virtual_key)| FallbackHotkey {
            id: (*preset).into(),
            label: (*label).into(),
            modifiers: *modifiers,
            virtual_key: *virtual_key,
        })
}

pub(crate) fn available_fallback_hotkeys() -> Vec<FallbackHotkey> {
    FALLBACK_HOTKEY_PRESETS
        .iter()
        .filter_map(|(id, ..)| fallback_hotkey_preset(id))
        .collect()
}

pub(crate) const INPUT_ISOLATION_AFTER_MS: u64 = 8_000;

/// A Sony controller visible to HID enumeration but absent from Raw Input for
/// several seconds is a strong hint that Steam Input or another layer consumed
/// the device. It is only a warning: VELORA never claims the reason with
/// certainty and never blocks the game's input.
pub(crate) fn input_isolation_warning(
    playstation_count: usize,
    raw_devices: usize,
    elapsed_ms: u64,
) -> Option<String> {
    (playstation_count > 0 && raw_devices == 0 && elapsed_ms >= INPUT_ISOLATION_AFTER_MS).then(|| {
        "Windows widzi kontroler Sony, ale DualSense Home nie odebrał raportów Raw Input. Sprawdź Steam Input lub inny program przechwytujący pada. Skrót klawiaturowy pozostaje dostępny."
            .to_string()
    })
}

pub(crate) fn default_fallback_hotkey() -> FallbackHotkey {
    fallback_hotkey_preset("ctrlAltN").expect("default shortcut preset")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlServiceStatus {
    pub windows: bool,
    pub running: bool,
    pub game_mode: bool,
    pub controller_count: usize,
    pub playstation_controller_count: usize,
    pub foreground_process: Option<String>,
    pub return_hotkey_registered: bool,
    pub fallback_hotkey: String,
    pub gamepad_home_running: bool,
    pub gamepad_home_device_count: usize,
    pub gamepad_home_last_combo_at_ms: Option<u64>,
    pub gamepad_home_last_error: Option<String>,
    pub gamepad_home_warning: Option<String>,
    pub gamepad_home_devices: Vec<crate::gamepad_home::GamepadDeviceInfo>,
    pub gamepad_home_duplicate_reports: u64,
    pub gamepad_home_reconnects: u64,
    pub gamepad_home_last_report_at_ms: Option<u64>,
    pub gamepad_home_last_chord: Option<crate::gamepad_home::ChordDiagnostic>,
    pub last_error: Option<String>,
}

impl ControlServiceStatus {
    fn disabled() -> Self {
        Self {
            windows: cfg!(target_os = "windows"),
            running: false,
            game_mode: false,
            controller_count: 0,
            playstation_controller_count: 0,
            foreground_process: None,
            return_hotkey_registered: false,
            fallback_hotkey: default_fallback_hotkey().label,
            gamepad_home_running: false,
            gamepad_home_device_count: 0,
            gamepad_home_last_combo_at_ms: None,
            gamepad_home_last_error: None,
            gamepad_home_warning: None,
            gamepad_home_devices: Vec::new(),
            gamepad_home_duplicate_reports: 0,
            gamepad_home_reconnects: 0,
            gamepad_home_last_report_at_ms: None,
            gamepad_home_last_chord: None,
            last_error: None,
        }
    }
}

fn is_controller_collection(usage_page: u16, usage: u16) -> bool {
    usage_page == 0x01 && matches!(usage, 0x04 | 0x05)
}

fn is_playstation_controller(vendor_id: u32, usage_page: u16, usage: u16) -> bool {
    vendor_id == 0x054c && is_controller_collection(usage_page, usage)
}

pub(crate) fn foreground_process_name() -> Option<String> {
    #[cfg(target_os = "windows")]
    { windows::foreground_process_name() }
    #[cfg(not(target_os = "windows"))]
    { None }
}

struct Worker {
    enabled: Arc<std::sync::atomic::AtomicBool>,
    game_mode: Arc<std::sync::atomic::AtomicBool>,
    join: std::thread::JoinHandle<()>,
}

pub struct ControlService {
    worker: Mutex<Option<Worker>>,
    latest: Arc<RwLock<ControlServiceStatus>>,
    fallback_hotkey: Arc<RwLock<FallbackHotkey>>,
    hotkey_generation: Arc<AtomicU64>,
}

impl Default for ControlService {
    fn default() -> Self {
        Self {
            worker: Mutex::new(None),
            latest: Arc::new(RwLock::new(ControlServiceStatus::disabled())),
            fallback_hotkey: Arc::new(RwLock::new(default_fallback_hotkey())),
            hotkey_generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl ControlService {
    fn status_with_worker(&self, worker: Option<&Worker>) -> ControlServiceStatus {
        let mut status = self
            .latest
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        status.fallback_hotkey = self
            .fallback_hotkey
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .label
            .clone();
        status.running = worker.is_some_and(|worker| {
            worker
                .enabled
                .load(std::sync::atomic::Ordering::Acquire)
        });
        status.game_mode = worker.is_some_and(|worker| {
            worker
                .game_mode
                .load(std::sync::atomic::Ordering::Acquire)
        });
        status
    }

    pub fn set_fallback_hotkey(&self, id: &str) -> Result<ControlServiceStatus, String> {
        let hotkey = fallback_hotkey_preset(id)
            .ok_or_else(|| "Nieznany zestaw skrótu powrotu VELORA.".to_string())?;
        *self
            .fallback_hotkey
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = hotkey;
        self.hotkey_generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(self.status_with_worker(worker.as_ref()))
    }

    pub fn status(&self) -> ControlServiceStatus {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.status_with_worker(worker.as_ref())
    }

    pub fn start(&self, app: AppHandle) -> Result<ControlServiceStatus, String> {
        #[cfg(not(target_os = "windows"))]
        {
            let _ = app;
            Err("VELORA Control Service jest dostępny tylko w natywnej aplikacji Windows.".into())
        }

        #[cfg(target_os = "windows")]
        {
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::mpsc;
            use std::time::Duration;

            let mut worker_slot = self
                .worker
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if worker_slot.as_ref().is_some_and(|worker| {
                worker.enabled.load(Ordering::Acquire)
            }) {
                return Ok(self.status_with_worker(worker_slot.as_ref()));
            }

            if let Some(old_worker) = worker_slot.take() {
                old_worker.enabled.store(false, Ordering::Release);
                let _ = old_worker.join.join();
            }

            let enabled = Arc::new(AtomicBool::new(true));
            let game_mode = Arc::new(AtomicBool::new(false));
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let app_for_thread = app.clone();
            let enabled_for_thread = Arc::clone(&enabled);
            let game_mode_for_thread = Arc::clone(&game_mode);
            let latest_for_thread = Arc::clone(&self.latest);
            let hotkey_for_thread = Arc::clone(&self.fallback_hotkey);
            let generation_for_thread = Arc::clone(&self.hotkey_generation);
            let join = std::thread::Builder::new()
                .name("nexus-control-session".into())
                .spawn(move || {
                    windows::run_worker(
                        app_for_thread,
                        enabled_for_thread,
                        game_mode_for_thread,
                        latest_for_thread,
                        hotkey_for_thread,
                        generation_for_thread,
                        started_tx,
                    );
                })
                .map_err(|_| "Nie udało się uruchomić wątku Control Service.".to_string())?;

            match started_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(())) => {
                    *worker_slot = Some(Worker {
                        enabled,
                        game_mode,
                        join,
                    });
                    Ok(self.status_with_worker(worker_slot.as_ref()))
                }
                Ok(Err(error)) => {
                    let _ = join.join();
                    if let Ok(mut status) = self.latest.write() {
                        status.last_error = Some(error.clone());
                    }
                    Err(error)
                }
                Err(_) => {
                    enabled.store(false, Ordering::Release);
                    let _ = join.join();
                    let error = "Control Service nie odpowiedział podczas uruchamiania.".to_string();
                    if let Ok(mut status) = self.latest.write() {
                        status.running = false;
                        status.last_error = Some(error.clone());
                    }
                    Err(error)
                }
            }
        }
    }

    pub fn set_game_mode(&self, enabled: bool) -> Result<ControlServiceStatus, String> {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(worker) = worker.as_ref() else {
            return Err("Najpierw uruchom Control Service.".into());
        };
        if !worker.enabled.load(std::sync::atomic::Ordering::Acquire) {
            return Err("Control Service jest wyłączony.".into());
        }
        worker
            .game_mode
            .store(enabled, std::sync::atomic::Ordering::Release);
        let mut status = self.status_with_worker(Some(worker));
        status.return_hotkey_registered = !enabled;
        if let Ok(mut latest) = self.latest.write() {
            latest.game_mode = enabled;
            latest.return_hotkey_registered = !enabled;
        }
        Ok(status)
    }

    pub fn stop(&self) -> ControlServiceStatus {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            worker
                .enabled
                .store(false, std::sync::atomic::Ordering::Release);
            let _ = worker.join.join();
        }
        if let Ok(mut latest) = self.latest.write() {
            latest.running = false;
            latest.game_mode = false;
            latest.controller_count = 0;
            latest.playstation_controller_count = 0;
            latest.foreground_process = None;
            latest.return_hotkey_registered = false;
            latest.gamepad_home_running = false;
            latest.gamepad_home_device_count = 0;
            latest.gamepad_home_last_combo_at_ms = None;
            latest.gamepad_home_last_error = None;
            latest.gamepad_home_warning = None;
            latest.gamepad_home_devices.clear();
            latest.gamepad_home_duplicate_reports = 0;
            latest.gamepad_home_reconnects = 0;
            latest.gamepad_home_last_report_at_ms = None;
            latest.gamepad_home_last_chord = None;
        }
        self.status()
    }
}

#[tauri::command]
pub async fn get_control_service_status(app: AppHandle) -> ControlServiceStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<ControlService>();
        service.status()
    })
    .await
    .unwrap_or_else(|_| ControlServiceStatus::disabled())
}

#[tauri::command]
pub async fn start_control_service(app: AppHandle) -> Result<ControlServiceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<ControlService>();
        service.start(app.clone())
    })
    .await
    .map_err(|_| "Wątek Control Service został przerwany.".to_string())?
}

#[tauri::command]
pub async fn set_control_game_mode(
    enabled: bool,
    app: AppHandle,
) -> Result<ControlServiceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<ControlService>();
        service.set_game_mode(enabled)
    })
    .await
    .map_err(|_| "Wątek Control Service został przerwany.".to_string())?
}

#[tauri::command]
pub async fn stop_control_service(app: AppHandle) -> Result<ControlServiceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<ControlService>();
        service.stop()
    })
    .await
    .map_err(|_| "Wątek Control Service został przerwany.".to_string())
}

#[tauri::command]
pub fn get_fallback_hotkey_options() -> Vec<FallbackHotkey> {
    available_fallback_hotkeys()
}

#[tauri::command]
pub async fn set_fallback_hotkey(
    id: String,
    app: AppHandle,
) -> Result<ControlServiceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<ControlService>();
        service.set_fallback_hotkey(&id)
    })
    .await
    .map_err(|_| "Wątek Control Service został przerwany.".to_string())?
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{
        is_controller_collection, is_playstation_controller, ControlServiceStatus, FallbackHotkey,
    };
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};
    use std::path::Path;
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::SyncSender;
    use std::sync::{Arc, RwLock};
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};

    const RIM_TYPE_HID: u32 = 2;
    const RIDI_DEVICE_INFO: u32 = 0x2000_000b;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    const WM_HOTKEY: u32 = 0x0312;
    const PM_REMOVE: u32 = 0x0001;
    const MOD_ALT: u32 = 0x0001;
    const MOD_CONTROL: u32 = 0x0002;
    const MOD_NOREPEAT: u32 = 0x4000;
    const VK_F12: u32 = 0x7b;
    const RETURN_HOTKEY_ID: i32 = 0x4e58;
    const EMERGENCY_HOTKEY_ID: i32 = 0x4e59;

    type Handle = *mut c_void;
    type Hwnd = *mut c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RawInputDeviceList {
        device: Handle,
        device_type: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RawInputHidInfo {
        vendor_id: u32,
        product_id: u32,
        version: u32,
        usage_page: u16,
        usage: u16,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    union RawInputDeviceInfoData {
        mouse: [u32; 4],
        keyboard: [u32; 6],
        hid: RawInputHidInfo,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RawInputDeviceInfo {
        size: u32,
        device_type: u32,
        data: RawInputDeviceInfoData,
    }

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct Message {
        window: Hwnd,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        point: Point,
        private: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetRawInputDeviceList(
            devices: *mut RawInputDeviceList,
            count: *mut u32,
            device_list_size: u32,
        ) -> u32;
        fn GetRawInputDeviceInfoW(
            device: Handle,
            command: u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> u32;
        fn PeekMessageW(
            message: *mut Message,
            window: Hwnd,
            min_filter: u32,
            max_filter: u32,
            remove: u32,
        ) -> i32;
        fn RegisterHotKey(window: Hwnd, id: i32, modifiers: u32, key: u32) -> i32;
        fn UnregisterHotKey(window: Hwnd, id: i32) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: u32,
            image_name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }

    pub(super) fn run_worker(
        app: AppHandle,
        enabled: Arc<AtomicBool>,
        game_mode: Arc<AtomicBool>,
        latest: Arc<RwLock<ControlServiceStatus>>,
        fallback_hotkey: Arc<RwLock<FallbackHotkey>>,
        hotkey_generation: Arc<AtomicU64>,
        started: SyncSender<Result<(), String>>,
    ) {
        let mut current_hotkey = fallback_hotkey
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let mut observed_hotkey_generation = hotkey_generation.load(Ordering::Acquire);
        let emergency_modifiers = MOD_CONTROL | MOD_ALT | MOD_NOREPEAT;
        let message_queue_ready = unsafe {
            let mut message = MaybeUninit::<Message>::zeroed();
            PeekMessageW(message.as_mut_ptr(), null_mut(), 0, 0, PM_REMOVE)
        };
        let _ = message_queue_ready;

        let return_registered = unsafe {
            RegisterHotKey(
                null_mut(),
                RETURN_HOTKEY_ID,
                current_hotkey.modifiers,
                current_hotkey.virtual_key,
            ) != 0
        };
        if !return_registered {
            fail_startup(
                &latest,
                &started,
                &format!(
                    "Skrót {} jest już zajęty. Usługa pozostała wyłączona.",
                    current_hotkey.label
                ),
            );
            return;
        }

        let emergency_registered = unsafe {
            RegisterHotKey(null_mut(), EMERGENCY_HOTKEY_ID, emergency_modifiers, VK_F12) != 0
        };
        if !emergency_registered {
            unsafe { UnregisterHotKey(null_mut(), RETURN_HOTKEY_ID) };
            fail_startup(
                &latest,
                &started,
                "Nie udało się zarejestrować awaryjnego skrótu. Usługa pozostała wyłączona.",
            );
            return;
        }

        let (controller_count, playstation_count) = match enumerate_controllers() {
            Ok(counts) => counts,
            Err(error) => {
                unsafe {
                    UnregisterHotKey(null_mut(), RETURN_HOTKEY_ID);
                    UnregisterHotKey(null_mut(), EMERGENCY_HOTKEY_ID);
                }
                fail_startup(&latest, &started, &error);
                return;
            }
        };

        let (mut gamepad_home, gamepad_start_error) =
            match crate::gamepad_home::GamepadHomeRuntime::start() {
                Ok(runtime) => (Some(runtime), None),
                Err(error) => {
                    // Keyboard return remains available. The failure is surfaced
                    // instead of silently claiming global gamepad support.
                    let _ = app.emit("control-service-gamepad-fallback", error.clone());
                    (None, Some(error))
                }
            };
        let gamepad_started_at = gamepad_home.as_ref().map(|_| Instant::now());
        let mut status = ControlServiceStatus {
            windows: true,
            running: true,
            game_mode: false,
            controller_count,
            playstation_controller_count: playstation_count,
            foreground_process: foreground_process_name(),
            return_hotkey_registered: true,
            fallback_hotkey: current_hotkey.label.clone(),
            gamepad_home_running: gamepad_home.is_some(),
            gamepad_home_device_count: 0,
            gamepad_home_last_combo_at_ms: None,
            gamepad_home_last_error: None,
            gamepad_home_warning: None,
            gamepad_home_devices: Vec::new(),
            gamepad_home_duplicate_reports: 0,
            gamepad_home_reconnects: 0,
            gamepad_home_last_report_at_ms: None,
            gamepad_home_last_chord: None,
            last_error: None,
        };
        status.gamepad_home_last_error = gamepad_start_error
            .map(|error| format!("{error} Działa powrót {}.", current_hotkey.label));
        write_status(&latest, status.clone());
        publish_status(&app, &status);
        let _ = started.send(Ok(()));

        let mut return_key_registered = true;
        let mut observed_game_mode = false;
        let mut last_refresh = Instant::now();

        while enabled.load(Ordering::Acquire) {
            let requested_generation = hotkey_generation.load(Ordering::Acquire);
            if requested_generation != observed_hotkey_generation {
                observed_hotkey_generation = requested_generation;
                let requested = fallback_hotkey
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                if observed_game_mode {
                    // The key is released in game mode; the new preset is
                    // registered when gaming ends.
                    current_hotkey = requested;
                } else {
                    if return_key_registered {
                        unsafe { UnregisterHotKey(null_mut(), RETURN_HOTKEY_ID) };
                    }
                    let registered = unsafe {
                        RegisterHotKey(
                            null_mut(),
                            RETURN_HOTKEY_ID,
                            requested.modifiers,
                            requested.virtual_key,
                        ) != 0
                    };
                    if registered {
                        current_hotkey = requested;
                        return_key_registered = true;
                        status.last_error = None;
                    } else {
                        let restored = unsafe {
                            RegisterHotKey(
                                null_mut(),
                                RETURN_HOTKEY_ID,
                                current_hotkey.modifiers,
                                current_hotkey.virtual_key,
                            ) != 0
                        };
                        if restored {
                            return_key_registered = true;
                            *fallback_hotkey
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                                current_hotkey.clone();
                            status.last_error = Some(format!(
                                "Nie udało się zarejestrować skrótu {}. Przywrócono {}.",
                                requested.label, current_hotkey.label
                            ));
                        } else {
                            return_key_registered = false;
                            status.last_error = Some(format!(
                                "Nie udało się zarejestrować skrótu {} ani przywrócić poprzedniego. Control Service wyłączono.",
                                requested.label
                            ));
                            write_status(&latest, status.clone());
                            publish_status(&app, &status);
                            enabled.store(false, Ordering::Release);
                            break;
                        }
                    }
                }
                status.fallback_hotkey = current_hotkey.label.clone();
                status.return_hotkey_registered = return_key_registered;
                write_status(&latest, status.clone());
                publish_status(&app, &status);
            }

            let current_game_mode = game_mode.load(Ordering::Acquire);
            if current_game_mode != observed_game_mode {
                if current_game_mode {
                    let unregistered = unsafe { UnregisterHotKey(null_mut(), RETURN_HOTKEY_ID) != 0 };
                    if !unregistered {
                        status.last_error = Some(
                            "Nie udało się zwolnić skrótu powrotu; Control Service wyłączono.".into(),
                        );
                        write_status(&latest, status.clone());
                        publish_status(&app, &status);
                        enabled.store(false, Ordering::Release);
                        break;
                    }
                    return_key_registered = false;
                } else {
                    current_hotkey = fallback_hotkey
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .clone();
                    let registered = unsafe {
                        RegisterHotKey(
                            null_mut(),
                            RETURN_HOTKEY_ID,
                            current_hotkey.modifiers,
                            current_hotkey.virtual_key,
                        ) != 0
                    };
                    if !registered {
                        status.last_error = Some(format!(
                            "Skrót {} został zajęty; Control Service wyłączono.",
                            current_hotkey.label
                        ));
                        write_status(&latest, status.clone());
                        publish_status(&app, &status);
                        enabled.store(false, Ordering::Release);
                        break;
                    }
                    return_key_registered = true;
                }
                observed_game_mode = current_game_mode;
                status.game_mode = current_game_mode;
                status.return_hotkey_registered = return_key_registered;
                status.fallback_hotkey = current_hotkey.label.clone();
                write_status(&latest, status.clone());
                publish_status(&app, &status);
            }

            loop {
                let mut queued = MaybeUninit::<Message>::zeroed();
                let has_message = unsafe {
                    PeekMessageW(queued.as_mut_ptr(), null_mut(), 0, 0, PM_REMOVE) != 0
                };
                if !has_message {
                    break;
                }
                let message = unsafe { queued.assume_init() };
                if matches!(
                    message.message,
                    crate::gamepad_home::WM_INPUT_MESSAGE
                        | crate::gamepad_home::WM_INPUT_DEVICE_CHANGE_MESSAGE
                ) {
                    if let Some(runtime) = gamepad_home.as_mut() {
                        runtime.handle_message(
                            &app,
                            message.message,
                            message.w_param,
                            message.l_param,
                        );
                    }
                    continue;
                }
                if message.message != WM_HOTKEY {
                    continue;
                }
                match message.w_param as i32 {
                    RETURN_HOTKEY_ID if !observed_game_mode && return_key_registered => {
                        // The local fallback is an explicit user gesture, so it
                        // may request focus. Dispatch must never block the
                        // message pump that also handles WM_INPUT and F12.
                        let queued = crate::session_orchestrator::request_return_home(
                            app.clone(),
                            crate::session_orchestrator::TransitionCause::ControlService,
                            crate::session_orchestrator::HomeRequestSource::ExplicitUser,
                            |_| {},
                        );
                        if queued {
                            let _ = app.emit("nexus-control-return", ());
                        } else {
                            status.last_error = Some(
                                "Kolejka powrotu do Home jest zajęta; spróbuj ponownie.".into(),
                            );
                            write_status(&latest, status.clone());
                            publish_status(&app, &status);
                        }
                    }
                    EMERGENCY_HOTKEY_ID => {
                        enabled.store(false, Ordering::Release);
                        let _ = app.emit("control-service-stopped", "keyboard-emergency");
                        break;
                    }
                    _ => {}
                }
            }

            if last_refresh.elapsed() >= Duration::from_millis(750) {
                match enumerate_controllers() {
                    Ok((controllers, playstation)) => {
                        status.controller_count = controllers;
                        status.playstation_controller_count = playstation;
                        status.foreground_process = foreground_process_name();
                        status.game_mode = observed_game_mode;
                        status.return_hotkey_registered = return_key_registered;
                        status.fallback_hotkey = current_hotkey.label.clone();
                        status.gamepad_home_warning = None;
                        if let Some(runtime) = gamepad_home.as_mut() {
                            runtime.refresh_devices();
                            let gamepad = runtime.status(true);
                            status.gamepad_home_running = gamepad.running;
                            status.gamepad_home_device_count = gamepad.device_count;
                            status.gamepad_home_last_combo_at_ms = gamepad.last_combo_at_ms;
                            status.gamepad_home_last_error = gamepad.last_error;
                            status.gamepad_home_devices = gamepad.devices;
                            status.gamepad_home_duplicate_reports = gamepad.duplicate_reports;
                            status.gamepad_home_reconnects = gamepad.reconnects;
                            status.gamepad_home_last_report_at_ms = gamepad.last_report_at_ms;
                            status.gamepad_home_last_chord = gamepad.last_chord;
                            status.gamepad_home_warning = super::input_isolation_warning(
                                status.playstation_controller_count,
                                gamepad.device_count,
                                gamepad_started_at
                                    .map(|started| started.elapsed().as_millis() as u64)
                                    .unwrap_or(0),
                            );
                        }
                        status.last_error = None;
                        write_status(&latest, status.clone());
                        publish_status(&app, &status);
                    }
                    Err(error) => {
                        status.last_error = Some(error);
                        write_status(&latest, status.clone());
                        publish_status(&app, &status);
                        let _ = app.emit("control-service-stopped", "device-enumeration-failed");
                        enabled.store(false, Ordering::Release);
                        break;
                    }
                }
                last_refresh = Instant::now();
            }
            thread::sleep(Duration::from_millis(40));
        }

        unsafe {
            if return_key_registered {
                UnregisterHotKey(null_mut(), RETURN_HOTKEY_ID);
            }
            UnregisterHotKey(null_mut(), EMERGENCY_HOTKEY_ID);
        }
        status.running = false;
        status.game_mode = false;
        status.controller_count = 0;
        status.playstation_controller_count = 0;
        status.foreground_process = None;
        status.return_hotkey_registered = false;
        status.gamepad_home_running = false;
        status.gamepad_home_device_count = 0;
        status.gamepad_home_last_combo_at_ms = None;
        status.gamepad_home_warning = None;
        status.gamepad_home_devices.clear();
        status.gamepad_home_duplicate_reports = 0;
        status.gamepad_home_reconnects = 0;
        status.gamepad_home_last_report_at_ms = None;
        status.gamepad_home_last_chord = None;
        write_status(&latest, status.clone());
        publish_status(&app, &status);
    }

    fn fail_startup(
        latest: &RwLock<ControlServiceStatus>,
        started: &SyncSender<Result<(), String>>,
        message: &str,
    ) {
        if let Ok(mut status) = latest.write() {
            status.running = false;
            status.last_error = Some(message.to_string());
        }
        let _ = started.send(Err(message.to_string()));
    }

    fn write_status(latest: &RwLock<ControlServiceStatus>, status: ControlServiceStatus) {
        if let Ok(mut target) = latest.write() {
            *target = status;
        }
    }

    fn publish_status(app: &AppHandle, status: &ControlServiceStatus) {
        let _ = app.emit("control-service-status", status.clone());
    }

    fn enumerate_controllers() -> Result<(usize, usize), String> {
        for _ in 0..2 {
            let mut count = 0u32;
            let first_result = unsafe {
                GetRawInputDeviceList(
                    null_mut(),
                    &mut count,
                    size_of::<RawInputDeviceList>() as u32,
                )
            };
            if first_result == u32::MAX {
                return Err("Windows nie udostępnił listy urządzeń HID.".into());
            }
            if count == 0 {
                return Ok((0, 0));
            }
            if count > 4096 {
                return Err("Lista urządzeń HID przekroczyła bezpieczny limit.".into());
            }

            let mut devices = Vec::<RawInputDeviceList>::with_capacity(count as usize);
            let actual = unsafe {
                GetRawInputDeviceList(
                    devices.as_mut_ptr(),
                    &mut count,
                    size_of::<RawInputDeviceList>() as u32,
                )
            };
            if actual == u32::MAX {
                continue;
            }
            unsafe { devices.set_len(actual as usize) };

            let mut controllers = 0;
            let mut playstation = 0;
            for device in devices.iter().filter(|device| device.device_type == RIM_TYPE_HID) {
                let mut info = RawInputDeviceInfo {
                    size: size_of::<RawInputDeviceInfo>() as u32,
                    device_type: 0,
                    data: RawInputDeviceInfoData { keyboard: [0; 6] },
                };
                let mut info_size = info.size;
                let result = unsafe {
                    GetRawInputDeviceInfoW(
                        device.device,
                        RIDI_DEVICE_INFO,
                        (&mut info as *mut RawInputDeviceInfo).cast::<c_void>(),
                        &mut info_size,
                    )
                };
                // A controller can disconnect between list and detail reads; skip that stale row.
                if result == u32::MAX || info.device_type != RIM_TYPE_HID {
                    continue;
                }
                let hid = unsafe { info.data.hid };
                if is_controller_collection(hid.usage_page, hid.usage) {
                    controllers += 1;
                    if is_playstation_controller(hid.vendor_id, hid.usage_page, hid.usage) {
                        playstation += 1;
                    }
                }
            }
            return Ok((controllers, playstation));
        }
        Err("Lista urządzeń HID zmieniała się podczas odczytu; usługę wyłączono.".into())
    }

    pub(super) fn foreground_process_name() -> Option<String> {
        let window = unsafe { GetForegroundWindow() };
        if window.is_null() {
            return None;
        }
        let mut process_id = 0u32;
        if unsafe { GetWindowThreadProcessId(window, &mut process_id) } == 0 || process_id == 0 {
            return None;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            return None;
        }
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        let succeeded = unsafe {
            QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) != 0
        };
        unsafe { CloseHandle(process) };
        if !succeeded {
            return None;
        }
        let path = String::from_utf16_lossy(&path[..length as usize]);
        Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }

}

#[cfg(test)]
mod tests {
    use super::{
        available_fallback_hotkeys, default_fallback_hotkey, fallback_hotkey_preset,
        input_isolation_warning, ControlService, ControlServiceStatus, INPUT_ISOLATION_AFTER_MS,
    };

    #[test]
    fn service_is_disabled_by_default() {
        let service = ControlService::default();
        let status = service.status();
        assert!(!status.running);
        assert!(!status.game_mode);
        assert!(!status.return_hotkey_registered);
        assert_eq!(status.controller_count, 0);
    }

    #[test]
    fn disabled_status_does_not_claim_global_input_mapping() {
        let status = ControlServiceStatus::disabled();
        assert!(!status.running);
        assert!(!status.return_hotkey_registered);
        assert!(status.last_error.is_none());
    }

    #[test]
    fn control_service_commands_do_not_block_the_main_thread() {
        let source = include_str!("control_service.rs");
        for command in [
            "get_control_service_status",
            "start_control_service",
            "set_control_game_mode",
            "stop_control_service",
        ] {
            assert!(source.contains(&format!("pub async fn {command}")));
        }
        assert!(source.contains("tauri::async_runtime::spawn_blocking"));
    }

    #[test]
    fn return_hotkey_is_dispatched_to_the_home_worker_not_run_inline() {
        let source = include_str!("control_service.rs");
        let forbidden = ["session_orchestrator::", "return_home("].concat();
        assert!(
            !source.contains(&forbidden),
            "the message pump must never call the blocking Home transaction directly"
        );
        assert!(source.contains("request_return_home"));
    }

    #[test]
    fn only_generic_desktop_joysticks_and_gamepads_are_counted() {
        assert!(super::is_controller_collection(0x01, 0x04));
        assert!(super::is_controller_collection(0x01, 0x05));
        assert!(!super::is_controller_collection(0x01, 0x02));
        assert!(!super::is_controller_collection(0x0c, 0x05));
    }

    #[test]
    fn fallback_hotkey_presets_are_allowlisted_and_never_accept_raw_keys() {
        let defaults = default_fallback_hotkey();
        assert_eq!(defaults.id, "ctrlAltN");
        assert!(defaults.modifiers & 0x4000 != 0, "MOD_NOREPEAT must be set");
        assert_eq!(available_fallback_hotkeys().len(), 3);
        assert!(fallback_hotkey_preset("ctrlShiftN").is_some());
        assert!(fallback_hotkey_preset("win+anything").is_none());
        assert!(fallback_hotkey_preset("").is_none());
        assert!(super::ControlService::default()
            .set_fallback_hotkey("not-a-preset")
            .is_err());
        let service = ControlService::default();
        let status = service.set_fallback_hotkey("altShiftN").unwrap();
        assert_eq!(status.fallback_hotkey, "Alt+Shift+N");
    }

    #[test]
    fn input_isolation_warning_is_delayed_and_never_claims_a_root_cause() {
        assert!(input_isolation_warning(1, 0, INPUT_ISOLATION_AFTER_MS - 1).is_none());
        assert!(input_isolation_warning(0, 0, INPUT_ISOLATION_AFTER_MS).is_none());
        assert!(input_isolation_warning(1, 1, INPUT_ISOLATION_AFTER_MS).is_none());
        let warning = input_isolation_warning(1, 0, INPUT_ISOLATION_AFTER_MS).unwrap();
        assert!(warning.contains("Steam Input"));
        assert!(warning.contains("Raw Input"));
        assert!(warning.contains("Skrót klawiaturowy"));
    }

    #[test]
    fn playstation_detection_requires_sony_vendor_and_gamepad_usage() {
        assert!(super::is_playstation_controller(0x054c, 0x01, 0x05));
        assert!(!super::is_playstation_controller(0x045e, 0x01, 0x05));
        assert!(!super::is_playstation_controller(0x054c, 0x01, 0x02));
    }
}
