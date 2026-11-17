//! Session-only, non-activating pointer indicator above a validated streaming window.
//! Callers supply an already validated owned foreground HWND. The indicator never
//! acquires input and independently hides on focus loss or a stale controller feed.

const STALE_UPDATE_MS: u64 = 750;

fn should_show(visible: bool, owner: u64, foreground: u64, age_ms: u64) -> bool {
    visible && owner != 0 && owner == foreground && age_ms < STALE_UPDATE_MS
}

/// All values are physical desktop pixels; the owner may live at a negative
/// virtual-desktop origin. Bounds include the owner's non-client frame.
/// Hide rather than draw outside a small owner window.
fn indicator_layout(bounds: (i32, i32, i32, i32), dpi: u32) -> Option<(i32, i32, i32, i32)> {
    let (left, top, right, bottom) = bounds;
    let scale = f64::from(if dpi == 0 { 96 } else { dpi.clamp(96, 384) }) / 96.0;
    let width = (200.0 * scale).round() as i32;
    let height = (34.0 * scale).round() as i32;
    let margin = (16.0 * scale).round() as i32;
    let x = right.checked_sub(width)?.checked_sub(margin)?;
    let y = top.checked_add(margin)?;
    (x >= left && y.checked_add(height)?.checked_add(margin)? <= bottom)
        .then_some((x, y, width, height))
}

/// Publish the latest desired state, without adding messages to a queue.
/// `visible=false` never starts a thread or creates a window.
pub(crate) fn update(owner_hwnd: u64, visible: bool) {
    #[cfg(target_os = "windows")]
    native::update(owner_hwnd, visible);
    #[cfg(not(target_os = "windows"))]
    let _ = (owner_hwnd, visible);
}

/// A brief dispatch acknowledgment, not confirmation of a page-side effect.
pub(crate) fn click_feedback(owner_hwnd: u64) {
    #[cfg(target_os = "windows")]
    native::click_feedback(owner_hwnd);
    #[cfg(not(target_os = "windows"))]
    let _ = owner_hwnd;
}

/// Stop and join the indicator thread. No window survives application shutdown.
pub(crate) fn stop() {
    #[cfg(target_os = "windows")]
    native::stop();
}

#[cfg(target_os = "windows")]
mod native {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Condvar, Mutex, OnceLock};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    type Hwnd = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct Message {
        hwnd: Hwnd,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        point: Point,
        private: u32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn CreateWindowExW(
            ex_style: u32,
            class: *const u16,
            text: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: *mut c_void,
            instance: *mut c_void,
            param: *mut c_void,
        ) -> Hwnd;
        fn DestroyWindow(hwnd: Hwnd) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn SetWindowPos(
            hwnd: Hwnd,
            after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
        fn SetLayeredWindowAttributes(hwnd: Hwnd, color: u32, alpha: u8, flags: u32) -> i32;
        fn PeekMessageW(message: *mut Message, hwnd: Hwnd, min: u32, max: u32, remove: u32) -> i32;
        fn TranslateMessage(message: *const Message) -> i32;
        fn DispatchMessageW(message: *const Message) -> isize;
        fn GetDpiForWindow(hwnd: Hwnd) -> u32;
        fn SetThreadDpiAwarenessContext(context: *mut c_void) -> *mut c_void;
        fn SendMessageW(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
        fn SetWindowTextW(hwnd: Hwnd, text: *const u16) -> i32;
    }
    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateFontW(
            height: i32,
            width: i32,
            escapement: i32,
            orientation: i32,
            weight: i32,
            italic: u32,
            underline: u32,
            strikeout: u32,
            charset: u32,
            out_precision: u32,
            clip_precision: u32,
            quality: u32,
            pitch: u32,
            face: *const u16,
        ) -> *mut c_void;
        fn DeleteObject(object: *mut c_void) -> i32;
    }

    struct Runtime {
        origin: Instant,
        owner: AtomicU64,
        visible: AtomicBool,
        updated_ms: AtomicU64,
        clicked_ms: AtomicU64,
        clicked_owner: AtomicU64,
        stop: AtomicBool,
        wake: Condvar,
        worker: Mutex<Option<JoinHandle<()>>>,
        wait_gate: Mutex<()>,
    }

    fn runtime() -> &'static Runtime {
        static RUNTIME: OnceLock<Runtime> = OnceLock::new();
        RUNTIME.get_or_init(|| Runtime {
            origin: Instant::now(),
            owner: AtomicU64::new(0),
            visible: AtomicBool::new(false),
            updated_ms: AtomicU64::new(0),
            clicked_ms: AtomicU64::new(u64::MAX),
            clicked_owner: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            wake: Condvar::new(),
            worker: Mutex::new(None),
            wait_gate: Mutex::new(()),
        })
    }

    pub(super) fn update(owner: u64, visible: bool) {
        let rt = runtime();
        // Configuration calls are infrequent; controller reports only update
        // atomics, rather than posting one native message per HID packet.
        rt.owner.store(owner, Ordering::Release);
        rt.updated_ms
            .store(rt.origin.elapsed().as_millis() as u64, Ordering::Release);
        rt.visible.store(visible, Ordering::Release);
        if visible && !rt.stop.load(Ordering::Acquire) {
            if let Ok(mut worker) = rt.worker.try_lock() {
                if worker.is_none() && !rt.stop.load(Ordering::Acquire) {
                    if let Ok(join) = std::thread::Builder::new()
                        .name("velora-pointer-indicator".into())
                        .spawn(run)
                    {
                        *worker = Some(join);
                    }
                }
            }
        }
        // At most one latest desired state; no message queue can grow here.
        if !visible {
            rt.wake.notify_one();
        }
    }

    pub(super) fn click_feedback(owner: u64) {
        update(owner, true);
        let rt = runtime();
        rt.clicked_owner.store(owner, Ordering::Release);
        rt.clicked_ms
            .store(rt.origin.elapsed().as_millis() as u64, Ordering::Release);
        rt.wake.notify_one();
    }

    pub(super) fn stop() {
        let rt = runtime();
        rt.visible.store(false, Ordering::Release);
        rt.stop.store(true, Ordering::Release);
        rt.wake.notify_all();
        if let Some(join) = rt.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = join.join();
        }
    }

    fn run() {
        let rt = runtime();
        if rt.stop.load(Ordering::Acquire) {
            return;
        }
        // This dedicated thread exits below; no process/global DPI policy changes.
        // PMv2 keeps window bounds, overlay placement and font size physical.
        if unsafe { SetThreadDpiAwarenessContext(-4_isize as *mut c_void) }.is_null() {
            return; // Physical placement could not be established; keep hidden.
        }
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let text: Vec<u16> = "VELORA · Wskaźnik\0".encode_utf16().collect();
        // NOACTIVATE | TOOLWINDOW | TRANSPARENT | LAYERED. WS_DISABLED also
        // prevents keyboard/mouse input. This window is never activated.
        let hwnd = unsafe {
            CreateWindowExW(
                0x0800_0000 | 0x0000_0080 | 0x0000_0020 | 0x0008_0000,
                class.as_ptr(),
                text.as_ptr(),
                0x8000_0000 | 0x0800_0000 | 0x0000_0001 | 0x0000_0200,
                0,
                0,
                200,
                34,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if hwnd.is_null() {
            return;
        }
        let mut font: *mut c_void = std::ptr::null_mut();
        let mut font_dpi = 0;
        let mut showing_click = false;
        unsafe { SetLayeredWindowAttributes(hwnd, 0, 235, 0x02) };
        while !rt.stop.load(Ordering::Acquire) {
            let mut message = Message::default();
            // Only messages belonging to this thread's indicator are pumped.
            while unsafe { PeekMessageW(&mut message, hwnd, 0, 0, 0x01) } != 0 {
                unsafe {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            let owner = rt.owner.load(Ordering::Acquire);
            let age = (rt.origin.elapsed().as_millis() as u64)
                .saturating_sub(rt.updated_ms.load(Ordering::Acquire));
            let foreground = unsafe { GetForegroundWindow() } as usize as u64;
            let now = rt.origin.elapsed().as_millis() as u64;
            let clicked = rt.clicked_ms.load(Ordering::Acquire);
            let show_click = rt.clicked_owner.load(Ordering::Acquire) == owner
                && clicked <= now
                && now.saturating_sub(clicked) < 350;
            if show_click != showing_click {
                let text: Vec<u16> = if show_click {
                    "VELORA · klik wysłany\0"
                } else {
                    "VELORA · Wskaźnik\0"
                }
                .encode_utf16()
                .collect();
                unsafe { SetWindowTextW(hwnd, text.as_ptr()) };
                showing_click = show_click;
            }
            let mut rect = Rect::default();
            let show =
                super::should_show(rt.visible.load(Ordering::Acquire), owner, foreground, age)
                    && unsafe {
                        IsWindow(owner as usize as Hwnd) != 0
                            && GetWindowRect(owner as usize as Hwnd, &mut rect) != 0
                    };
            let dpi = if show {
                unsafe { GetDpiForWindow(owner as usize as Hwnd) }
            } else {
                96
            };
            let layout =
                super::indicator_layout((rect.left, rect.top, rect.right, rect.bottom), dpi);
            if let Some((x, y, width, height)) = layout.filter(|_| show) {
                let dpi = if dpi == 0 { 96 } else { dpi.clamp(96, 384) };
                if font_dpi != dpi {
                    let face: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
                    let next = unsafe {
                        CreateFontW(
                            -((16 * dpi / 96) as i32),
                            0,
                            0,
                            0,
                            400,
                            0,
                            0,
                            0,
                            1,
                            0,
                            0,
                            5,
                            0,
                            face.as_ptr(),
                        )
                    };
                    if !next.is_null() {
                        unsafe {
                            SendMessageW(hwnd, 0x0030, next as usize, 1);
                            if !font.is_null() {
                                DeleteObject(font);
                            }
                        }
                        font = next;
                        font_dpi = dpi;
                    }
                }
                // Top-right, inside the owned window bounds. HWND_TOPMOST plus
                // NOACTIVATE/SHOWWINDOW; no SetForegroundWindow or focus call.
                unsafe {
                    SetWindowPos(hwnd, -1_isize as Hwnd, x, y, width, height, 0x0010 | 0x0040);
                }
            } else {
                unsafe { ShowWindow(hwnd, 0) };
            }
            let wait = rt.wait_gate.lock().unwrap_or_else(|e| e.into_inner());
            let _ = rt
                .wake
                .wait_timeout(wait, Duration::from_millis(100))
                .unwrap_or_else(|e| e.into_inner());
        }
        unsafe { DestroyWindow(hwnd) };
        if !font.is_null() {
            unsafe { DeleteObject(font) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_scales_on_4k_and_stays_inside_negative_origin_monitor() {
        assert_eq!(
            indicator_layout((0, 0, 3840, 2160), 144),
            Some((3516, 24, 300, 51))
        );
        assert_eq!(
            indicator_layout((-1920, -1080, 0, 0), 96),
            Some((-216, -1064, 200, 34))
        );
        assert!(indicator_layout((0, 0, 200, 50), 96).is_none());
        assert_eq!(
            indicator_layout((0, 0, 1920, 1080), 0),
            indicator_layout((0, 0, 1920, 1080), 96)
        );
    }

    #[test]
    fn indicator_is_hidden_without_recent_owned_foreground_state() {
        // Force both public native entrypoints to compile without invoking them.
        std::hint::black_box(update as fn(u64, bool));
        std::hint::black_box(stop as fn());
        std::hint::black_box(click_feedback as fn(u64));
        assert!(should_show(true, 42, 42, 0));
        assert!(should_show(true, 42, 42, STALE_UPDATE_MS - 1));
        assert!(!should_show(true, 42, 42, STALE_UPDATE_MS));
        assert!(!should_show(true, 42, 7, 0));
        assert!(!should_show(true, 0, 0, 0));
        assert!(!should_show(false, 42, 42, 0));
    }
}
