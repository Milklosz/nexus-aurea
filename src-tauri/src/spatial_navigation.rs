//! Opt-in UI Automation navigation scoped to an already-owned streaming window.
//! Never reads names, values, URLs or text. Call only on a non-UI MTA worker.
use crate::edge_cinema::StreamingWindowTarget;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpatialOutcome {
    pub candidate_count: usize,
    pub query_ms: u64,
    pub effect: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Bounds {
    fn valid(self) -> bool {
        [self.left, self.top, self.right, self.bottom]
            .iter()
            .all(|v| v.is_finite())
            && self.right > self.left
            && self.bottom > self.top
    }
    fn center(self) -> (f64, f64) {
        (
            (self.left + self.right) / 2.0,
            (self.top + self.bottom) / 2.0,
        )
    }
    fn contains(self, other: Self) -> bool {
        self.valid()
            && other.valid()
            && other.left >= self.left
            && other.top >= self.top
            && other.right <= self.right
            && other.bottom <= self.bottom
    }
}

/// Directional alignment dominates distance, while overlapping rows/columns
/// remain preferable to a nearer diagonal tile. Stable index breaks ties.
fn next_candidate(origin: Bounds, candidates: &[Bounds], direction: Direction) -> Option<usize> {
    if !origin.valid() {
        return None;
    }
    let (ox, oy) = origin.center();
    candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| {
            if !candidate.valid() || *candidate == origin {
                return None;
            }
            let (cx, cy) = candidate.center();
            let (forward, lateral, aligned) = match direction {
                Direction::Up => (
                    oy - cy,
                    (cx - ox).abs(),
                    candidate.right > origin.left && candidate.left < origin.right,
                ),
                Direction::Down => (
                    cy - oy,
                    (cx - ox).abs(),
                    candidate.right > origin.left && candidate.left < origin.right,
                ),
                Direction::Left => (
                    ox - cx,
                    (cy - oy).abs(),
                    candidate.bottom > origin.top && candidate.top < origin.bottom,
                ),
                Direction::Right => (
                    cx - ox,
                    (cy - oy).abs(),
                    candidate.bottom > origin.top && candidate.top < origin.bottom,
                ),
            };
            if forward <= 0.0 {
                return None;
            }
            // A dimensionless alignment rank keeps selection consistent when
            // Windows scales the entire page at another DPI setting.
            let score = forward + lateral * 3.0;
            Some((index, !aligned, score))
        })
        .min_by(|a, b| a.1.cmp(&b.1).then(a.2.total_cmp(&b.2)).then(a.0.cmp(&b.0)))
        .map(|(index, _, _)| index)
}

pub(crate) fn navigate(
    app: &AppHandle,
    target: &StreamingWindowTarget,
    direction: Direction,
    still_authorized: &dyn Fn() -> bool,
) -> Result<SpatialOutcome, String> {
    if !crate::edge_cinema::streaming_target_is_current(app, target) {
        invalidate();
        return Err("Spatial: focus or owned session changed.".into());
    }
    #[cfg(target_os = "windows")]
    {
        native::run(app, target, Some(direction), still_authorized)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (direction, still_authorized);
        Err("Spatial navigation requires Windows UI Automation.".into())
    }
}

pub(crate) fn activate(
    app: &AppHandle,
    target: &StreamingWindowTarget,
    still_authorized: &dyn Fn() -> bool,
) -> Result<SpatialOutcome, String> {
    if !crate::edge_cinema::streaming_target_is_current(app, target) {
        invalidate();
        return Err("Spatial: focus or owned session changed.".into());
    }
    #[cfg(target_os = "windows")]
    {
        native::run(app, target, None, still_authorized)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = still_authorized;
        Err("Spatial navigation requires Windows UI Automation.".into())
    }
}

pub(crate) fn invalidate() {
    #[cfg(target_os = "windows")]
    native::invalidate();
}

/// Media shortcuts must not type into search/login controls. An unavailable
/// provider is an error, so callers can fail closed rather than guessing.
pub(crate) fn is_editable_focus(
    app: &AppHandle,
    target: &StreamingWindowTarget,
) -> Result<bool, String> {
    if !crate::edge_cinema::streaming_target_is_current(app, target) {
        return Err("Spatial: foreground changed before editable-focus check.".into());
    }
    #[cfg(target_os = "windows")]
    {
        native::editable(app, target)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Editable-focus detection requires Windows UI Automation.".into())
    }
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use std::{
        cell::RefCell,
        time::{Duration, Instant},
    };
    use windows::Win32::{
        Foundation::{HWND, RECT},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::Accessibility::{
            CUIAutomation8, IUIAutomation2, IUIAutomationElement, IUIAutomationInvokePattern,
            IUIAutomationTreeWalker, IUIAutomationWindowPattern, UIA_ComboBoxControlTypeId,
            UIA_EditControlTypeId, UIA_InvokePatternId, UIA_WindowPatternId,
        },
    };

    const MAX_NODES: usize = 256;
    const MAX_DEPTH: usize = 32;
    const QUERY_BUDGET: Duration = Duration::from_millis(40);
    const ACTION_BUDGET: Duration = Duration::from_millis(250);
    const CACHE_TTL: Duration = Duration::from_millis(500);

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }
    struct Candidate {
        element: IUIAutomationElement,
        bounds: Bounds,
    }
    struct Provider {
        // COM references must drop before the apartment is uninitialized.
        automation: IUIAutomation2,
        walker: IUIAutomationTreeWalker,
        scope: Option<IUIAutomationElement>,
        candidates: Vec<Candidate>,
        target: StreamingWindowTarget,
        captured: Instant,
        _apartment: ComApartment,
    }
    thread_local! { static PROVIDER: RefCell<Option<Provider>> = const { RefCell::new(None) }; }

    fn bounds(rect: RECT) -> Bounds {
        Bounds {
            left: rect.left as f64,
            top: rect.top as f64,
            right: rect.right as f64,
            bottom: rect.bottom as f64,
        }
    }
    fn error() -> String {
        "Spatial: accessibility provider unavailable or stale; select keyboard or pointer mode."
            .into()
    }

    fn check_budget(started: Instant) -> Result<(), String> {
        if started.elapsed() >= ACTION_BUDGET {
            Err("Spatial: accessibility action exceeded its work budget; action cancelled.".into())
        } else {
            Ok(())
        }
    }

    impl Provider {
        fn new(target: &StreamingWindowTarget) -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }.map_err(|_| error())?;
            let apartment = ComApartment;
            let automation: IUIAutomation2 =
                unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                    .map_err(|_| error())?;
            unsafe {
                automation.SetConnectionTimeout(100).map_err(|_| error())?;
                automation.SetTransactionTimeout(100).map_err(|_| error())?;
                automation.SetAutoSetFocus(false).map_err(|_| error())?;
            }
            let walker = unsafe { automation.ControlViewWalker() }.map_err(|_| error())?;
            Ok(Self {
                automation,
                walker,
                scope: None,
                candidates: Vec::new(),
                target: target.clone(),
                captured: Instant::now(),
                _apartment: apartment,
            })
        }

        /// Find a UIA modal ancestor of focus, only after proving ancestry to
        /// this exact root. Never escape into desktop or a different window.
        fn current_scope(
            &self,
            root: &IUIAutomationElement,
            started: Instant,
        ) -> Result<IUIAutomationElement, String> {
            check_budget(started)?;
            let mut current =
                unsafe { self.automation.GetFocusedElement() }.map_err(|_| error())?;
            let mut modal = None;
            for _ in 0..MAX_DEPTH {
                check_budget(started)?;
                if unsafe { self.automation.CompareElements(&current, root) }
                    .map_err(|_| error())?
                    .as_bool()
                {
                    return Ok(modal.unwrap_or_else(|| root.clone()));
                }
                if modal.is_none() {
                    check_budget(started)?;
                    if let Ok(pattern) = unsafe {
                        current
                            .GetCurrentPatternAs::<IUIAutomationWindowPattern>(UIA_WindowPatternId)
                    } {
                        if unsafe { pattern.CurrentIsModal() }
                            .map_err(|_| error())?
                            .as_bool()
                        {
                            modal = Some(current.clone());
                        }
                    }
                }
                check_budget(started)?;
                current = unsafe { self.walker.GetParentElement(&current) }.map_err(|_| error())?;
            }
            Err("Spatial: focus ancestry exceeds safe scope.".into())
        }

        fn eligible(
            &self,
            element: &IUIAutomationElement,
            scope_bounds: Bounds,
            started: Instant,
        ) -> Option<Bounds> {
            unsafe {
                check_budget(started).ok()?;
                if !element.CurrentIsEnabled().ok()?.as_bool()
                    || check_budget(started).is_err()
                    || element.CurrentIsOffscreen().ok()?.as_bool()
                    || check_budget(started).is_err()
                    || element.CurrentIsPassword().ok()?.as_bool()
                    || check_budget(started).is_err()
                    || !element.CurrentIsKeyboardFocusable().ok()?.as_bool()
                {
                    return None;
                }
                check_budget(started).ok()?;
                let rect = bounds(element.CurrentBoundingRectangle().ok()?);
                scope_bounds.contains(rect).then_some(rect)
            }
        }

        fn in_scope(
            &self,
            element: &IUIAutomationElement,
            scope: &IUIAutomationElement,
            started: Instant,
        ) -> bool {
            let mut current = element.clone();
            for _ in 0..MAX_DEPTH {
                if check_budget(started).is_err() {
                    return false;
                }
                if unsafe { self.automation.CompareElements(&current, scope) }
                    .is_ok_and(|same| same.as_bool())
                {
                    return true;
                }
                if check_budget(started).is_err() {
                    return false;
                }
                match unsafe { self.walker.GetParentElement(&current) } {
                    Ok(parent) => current = parent,
                    Err(_) => return false,
                }
            }
            false
        }

        fn refresh(
            &mut self,
            scope: &IUIAutomationElement,
            started: Instant,
        ) -> Result<(), String> {
            self.candidates.clear();
            self.scope = None;
            let scope_bounds =
                bounds(unsafe { scope.CurrentBoundingRectangle() }.map_err(|_| error())?);
            if !scope_bounds.valid() {
                return Err(error());
            }
            let mut pending = Vec::with_capacity(MAX_DEPTH + 1);
            // Never consider the root itself as a selectable page element.
            if let Ok(first) = unsafe { self.walker.GetFirstChildElement(scope) } {
                pending.push((first, 1));
            }
            let mut visited = 0;
            while let Some((element, depth)) = pending.pop() {
                if visited >= MAX_NODES || started.elapsed() >= QUERY_BUDGET {
                    break;
                }
                visited += 1;
                if let Some(rect) = self.eligible(&element, scope_bounds, started) {
                    self.candidates.push(Candidate {
                        element: element.clone(),
                        bounds: rect,
                    });
                }
                if started.elapsed() >= QUERY_BUDGET {
                    break;
                }
                if let Ok(sibling) = unsafe { self.walker.GetNextSiblingElement(&element) } {
                    pending.push((sibling, depth));
                }
                if depth < MAX_DEPTH {
                    if let Ok(child) = unsafe { self.walker.GetFirstChildElement(&element) } {
                        pending.push((child, depth + 1));
                    }
                }
            }
            self.scope = Some(scope.clone());
            self.captured = Instant::now();
            if self.candidates.is_empty() {
                return Err(
                    "Spatial: no eligible controls within query budget; select pointer mode."
                        .into(),
                );
            }
            Ok(())
        }

        fn act(
            &mut self,
            app: &AppHandle,
            target: &StreamingWindowTarget,
            direction: Option<Direction>,
            still_authorized: &dyn Fn() -> bool,
        ) -> Result<SpatialOutcome, String> {
            let started = Instant::now();
            let root = unsafe {
                self.automation
                    .ElementFromHandle(HWND(target.hwnd as usize as *mut _))
            }
            .map_err(|_| error())?;
            let scope = self.current_scope(&root, started)?;
            let same_scope = self.scope.as_ref().is_some_and(|old| {
                unsafe { self.automation.CompareElements(old, &scope) }
                    .is_ok_and(|same| same.as_bool())
            });
            if !same_scope || self.captured.elapsed() >= CACHE_TTL {
                self.refresh(&scope, started)?;
            }
            let focused = unsafe { self.automation.GetFocusedElement() }.map_err(|_| error())?;
            let origin =
                bounds(unsafe { focused.CurrentBoundingRectangle() }.map_err(|_| error())?);
            let selected = if let Some(direction) = direction {
                next_candidate(
                    origin,
                    &self.candidates.iter().map(|c| c.bounds).collect::<Vec<_>>(),
                    direction,
                )
            } else {
                self.candidates.iter().position(|candidate| {
                    unsafe {
                        self.automation
                            .CompareElements(&candidate.element, &focused)
                    }
                    .is_ok_and(|same| same.as_bool())
                })
            }
            .ok_or_else(|| {
                "Spatial: no actionable control in this direction; use keyboard or pointer mode."
                    .to_string()
            })?;
            let candidate = &self.candidates[selected];
            let current_bounds = self
                .eligible(
                    &candidate.element,
                    bounds(unsafe { scope.CurrentBoundingRectangle() }.map_err(|_| error())?),
                    started,
                )
                .ok_or_else(error)?;
            // Moving/removed controls invalidate selection instead of activating
            // an old rectangle after a dynamic page update.
            if current_bounds != candidate.bounds {
                return Err("Spatial: selected control moved; selection invalidated.".into());
            }
            let current_scope = self.current_scope(&root, started)?;
            if !unsafe { self.automation.CompareElements(&scope, &current_scope) }
                .map_err(|_| error())?
                .as_bool()
                || !self.in_scope(&candidate.element, &scope, started)
                || !still_authorized()
                || !crate::edge_cinema::streaming_target_is_current(app, target)
            {
                return Err(
                    "Spatial: session, focus or modal scope changed; action cancelled.".into(),
                );
            }
            check_budget(started)?;
            let effect = if direction.is_some() {
                unsafe { candidate.element.SetFocus() }.map_err(|_| error())?;
                if !unsafe { candidate.element.CurrentHasKeyboardFocus() }
                    .map_err(|_| error())?
                    .as_bool()
                {
                    return Err(
                        "Spatial: provider accepted focus request but focus was not observed."
                            .into(),
                    );
                }
                "focus-observed"
            } else {
                let pattern = unsafe { candidate.element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }.map_err(|_| "Spatial: focused control has no supported Invoke pattern; use keyboard or pointer mode.".to_string())?;
                check_budget(started)?;
                if !still_authorized()
                    || !crate::edge_cinema::streaming_target_is_current(app, target)
                {
                    return Err("Spatial: foreground changed before Invoke.".into());
                }
                unsafe { pattern.Invoke() }.map_err(|_| error())?;
                "invoke-accepted-effect-unverified"
            };
            Ok(SpatialOutcome {
                candidate_count: self.candidates.len(),
                query_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                effect,
            })
        }
    }

    pub(super) fn run(
        app: &AppHandle,
        target: &StreamingWindowTarget,
        direction: Option<Direction>,
        still_authorized: &dyn Fn() -> bool,
    ) -> Result<SpatialOutcome, String> {
        PROVIDER.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot
                .as_ref()
                .map_or(true, |provider| provider.target != *target)
            {
                *slot = Some(Provider::new(target)?);
            }
            let result =
                slot.as_mut()
                    .ok_or_else(error)?
                    .act(app, target, direction, still_authorized);
            // No retry after failure; discard every stale COM reference.
            if result.is_err() || direction.is_none() {
                *slot = None;
            }
            result
        })
    }
    pub(super) fn invalidate() {
        PROVIDER.with(|slot| *slot.borrow_mut() = None);
    }

    pub(super) fn editable(
        app: &AppHandle,
        target: &StreamingWindowTarget,
    ) -> Result<bool, String> {
        PROVIDER.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot
                .as_ref()
                .map_or(true, |provider| provider.target != *target)
            {
                *slot = Some(Provider::new(target)?);
            }
            let result = (|| {
                let started = Instant::now();
                let provider = slot.as_ref().ok_or_else(error)?;
                let root = unsafe {
                    provider
                        .automation
                        .ElementFromHandle(HWND(target.hwnd as usize as *mut _))
                }
                .map_err(|_| error())?;
                provider.current_scope(&root, started)?;
                let focused =
                    unsafe { provider.automation.GetFocusedElement() }.map_err(|_| error())?;
                let kind = unsafe { focused.CurrentControlType() }.map_err(|_| error())?;
                let password = unsafe { focused.CurrentIsPassword() }
                    .map_err(|_| error())?
                    .as_bool();
                let final_focus =
                    unsafe { provider.automation.GetFocusedElement() }.map_err(|_| error())?;
                check_budget(started)?;
                if !unsafe { provider.automation.CompareElements(&focused, &final_focus) }
                    .map_err(|_| error())?
                    .as_bool()
                {
                    return Err(
                        "Spatial: editable-focus identity changed during inspection.".into(),
                    );
                }
                if !crate::edge_cinema::streaming_target_is_current(app, target) {
                    return Err("Spatial: foreground changed during editable-focus check.".into());
                }
                Ok(password || kind == UIA_EditControlTypeId || kind == UIA_ComboBoxControlTypeId)
            })();
            if result.is_err() {
                *slot = None;
            }
            result
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x: f64, y: f64) -> Bounds {
        Bounds {
            left: x,
            top: y,
            right: x + 100.0,
            bottom: y + 100.0,
        }
    }
    #[test]
    fn directions_exclude_behind_and_select_aligned_tiles() {
        let origin = rect(100.0, 100.0);
        let items = [
            rect(100.0, 0.0),
            rect(100.0, 220.0),
            rect(0.0, 100.0),
            rect(220.0, 100.0),
            rect(205.0, 205.0),
        ];
        for (direction, index) in [
            (Direction::Up, 0),
            (Direction::Down, 1),
            (Direction::Left, 2),
            (Direction::Right, 3),
        ] {
            assert_eq!(next_candidate(origin, &items, direction), Some(index));
        }
    }
    #[test]
    fn invalid_geometry_and_no_candidate_fail_closed() {
        let invalid = Bounds {
            right: f64::NAN,
            ..rect(0.0, 0.0)
        };
        assert_eq!(
            next_candidate(rect(0.0, 0.0), &[invalid, rect(0.0, 0.0)], Direction::Right),
            None
        );
        assert_eq!(
            next_candidate(invalid, &[rect(100.0, 0.0)], Direction::Right),
            None
        );
    }
    #[test]
    fn multi_monitor_negative_coordinates_and_stable_ties() {
        let origin = rect(-1600.0, 20.0);
        assert_eq!(
            next_candidate(
                origin,
                &[rect(-1450.0, 20.0), rect(-1450.0, 20.0)],
                Direction::Right
            ),
            Some(0)
        );
    }
    #[test]
    fn bounds_require_visible_finite_containment() {
        let scope = rect(0.0, 0.0);
        assert!(scope.contains(scope));
        assert!(!scope.contains(rect(-1.0, 0.0)));
        assert!(!scope.contains(Bounds {
            left: 10.0,
            right: 9.0,
            ..scope
        }));
    }

    #[test]
    fn uniform_dpi_scaling_preserves_directional_ranking() {
        let origin = rect(0.0, 0.0);
        let candidates = [rect(1200.0, 0.0), rect(110.0, 101.0)];
        let scale = |r: Bounds| Bounds {
            left: r.left * 2.0,
            top: r.top * 2.0,
            right: r.right * 2.0,
            bottom: r.bottom * 2.0,
        };
        let scaled: Vec<_> = candidates.iter().copied().map(scale).collect();
        assert_eq!(
            next_candidate(origin, &candidates, Direction::Right),
            Some(0)
        );
        assert_eq!(
            next_candidate(scale(origin), &scaled, Direction::Right),
            Some(0)
        );
    }
}
