//! Session-only, non-activating pointer indicator above a validated streaming window.
//! Callers supply an already validated owned foreground HWND. The indicator never
//! acquires input and independently hides on focus loss or a stale controller feed.

const STALE_UPDATE_MS: u64 = 750;

fn should_show(visible: bool, owner: u64, foreground: u64, age_ms: u64) -> bool {
    visible && owner != 0 && owner == foreground && age_ms < STALE_UPDATE_MS
}

/// Publish the latest desired state, without adding messages to a queue.
/// `visible=false` never starts a thread or creates a window.
pub(crate) fn update(owner_hwnd: u64, visible: bool) {
    #[cfg(target_os = "windows")]
    native::update(owner_hwnd, visible);
    #[cfg(not(target_os = "windows"))]
    let _ = (owner_hwnd, visible);
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
            param: *const c_void,
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
    }

    struct Runtime {
        origin: Instant,
        owner: AtomicU64,
        visible: AtomicBool,
        updated_ms: AtomicU64,
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
                std::ptr::null(),
            )
        };
        if hwnd.is_null() {
            return;
        }
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
            let mut rect = Rect::default();
            let show =
                super::should_show(rt.visible.load(Ordering::Acquire), owner, foreground, age)
                    && unsafe {
                        IsWindow(owner as usize as Hwnd) != 0
                            && GetWindowRect(owner as usize as Hwnd, &mut rect) != 0
                    };
            if show && rect.right - rect.left >= 220 && rect.bottom - rect.top >= 60 {
                // Top-right, inside the owned window bounds. HWND_TOPMOST plus
                // NOACTIVATE/SHOWWINDOW; no SetForegroundWindow or focus call.
                unsafe {
                    SetWindowPos(
                        hwnd,
                        -1_isize as Hwnd,
                        rect.right - 216,
                        rect.top + 16,
                        200,
                        34,
                        0x0010 | 0x0040,
                    );
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indicator_is_hidden_without_recent_owned_foreground_state() {
        // Force both public native entrypoints to compile without invoking them.
        std::hint::black_box(update as fn(u64, bool));
        std::hint::black_box(stop as fn());
        assert!(should_show(true, 42, 42, 0));
        assert!(should_show(true, 42, 42, STALE_UPDATE_MS - 1));
        assert!(!should_show(true, 42, 42, STALE_UPDATE_MS));
        assert!(!should_show(true, 42, 7, 0));
        assert!(!should_show(true, 0, 0, 0));
        assert!(!should_show(false, 42, 42, 0));
    }
}
