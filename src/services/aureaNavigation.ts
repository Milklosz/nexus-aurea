/**
 * AUREA Navigation — pure 2D grid helpers plus a single active-grid registry.
 *
 * This module is intentionally DOM-agnostic at import time: `remoteCommand.ts`
 * is exercised in Node-based unit tests (no DOM), so every `document` access is
 * guarded with `typeof document === "undefined"`. Nothing here touches Tauri,
 * global HID or native focus — it only moves focus inside VELORA's own UI.
 */

export type NavigationDirection = "up" | "down" | "left" | "right";

export type FocusSource = "keyboard" | "gamepad" | "remote";

export function isNavigationDirection(value: string): value is NavigationDirection {
  return value === "up" || value === "down" || value === "left" || value === "right";
}

export const DIRECTION_KEYS: Record<string, NavigationDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

export function directionFromKey(key: string): NavigationDirection | null {
  const direction = DIRECTION_KEYS[key];
  // The extra type checks also neutralise prototype keys (e.g. "toString"),
  // which would otherwise resolve to something from Object.prototype.
  return typeof direction === "string" && isNavigationDirection(direction) ? direction : null;
}

/**
 * Pure, row-major 2D grid movement.
 *
 * Items `[0, count)` are laid out left-to-right, top-to-bottom in `columns`
 * columns. The returned index is ALWAYS an integer in `[0, count)`:
 *  - left/right step within the current row and are clamped to that row
 *    (they never wrap into an adjacent row);
 *  - up/down step a full row (`columns` positions) and are clamped to the
 *    grid bounds (a partial last row clamps to its final item);
 *  - `count <= 0` yields 0, `columns <= 0` (or non-finite) yields the clamped
 *    input index;
 *  - non-finite or out-of-range indices are normalised, so the result is never
 *    NaN or negative for any input.
 */
export function resolveGridIndex(
  index: number,
  direction: NavigationDirection,
  columns: number,
  count: number,
): number {
  if (count <= 0) return 0;
  const clamped = Number.isFinite(index)
    ? Math.min(Math.max(Math.trunc(index), 0), count - 1)
    : 0;
  if (!Number.isFinite(columns) || columns <= 0) return clamped;

  const colCount = Math.max(1, Math.trunc(columns));
  // A single-row grid has no vertical neighbour. Moving up/down must leave the
  // selection where it is instead of jumping to the first/last item (remote
  // Up/Down on the one-row AUREA dock).
  if ((direction === "up" || direction === "down") && colCount >= count) {
    return clamped;
  }
  const rowStart = Math.floor(clamped / colCount) * colCount;
  const rowEnd = Math.min(rowStart + colCount - 1, count - 1);

  let next: number;
  switch (direction) {
    case "left":
      next = Math.max(rowStart, clamped - 1);
      break;
    case "right":
      next = Math.min(rowEnd, clamped + 1);
      break;
    case "up":
      next = clamped - colCount;
      break;
    case "down":
      next = clamped + colCount;
      break;
    default:
      next = clamped;
  }
  return Math.min(Math.max(next, 0), count - 1);
}

/** Declarative focus attributes for a single grid item. */
export function focusStateAttributes(active: boolean, source: FocusSource): Record<string, string> {
  return {
    "data-aurea-focus": active ? "active" : "idle",
    "data-focus-source": source,
    // `aria-current` is "true" only for the active item ("false" otherwise).
    "aria-current": active ? "true" : "false",
  };
}

/** Apply the focus attributes declared above to a concrete DOM element. */
export function applyFocusState(element: HTMLElement, active: boolean, source: FocusSource): void {
  for (const [name, value] of Object.entries(focusStateAttributes(active, source))) {
    element.setAttribute(name, value);
  }
}

/**
 * The single registered grid. `registerAureaGrid` makes the last registration
 * win; `moveAureaFocus` drives exactly that grid.
 */
export interface AureaGrid {
  id: string;
  columns: number;
  items: HTMLElement[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
}

let activeGrid: AureaGrid | null = null;

export function registerAureaGrid(grid: AureaGrid): void {
  activeGrid = grid;
}

export function unregisterAureaGrid(id: string): void {
  if (activeGrid && activeGrid.id === id) {
    activeGrid = null;
  }
}

/**
 * Moves focus inside the active grid. Returns false when no grid is
 * registered, when `document` is unavailable (Node/SSR), or when the grid is
 * empty — allowing callers to fall back to their legacy linear navigation.
 */
export function moveAureaFocus(direction: NavigationDirection): boolean {
  if (!activeGrid || typeof document === "undefined") return false;
  const grid = activeGrid;
  const items = grid.items;
  const count = items.length;
  if (count === 0) return false;

  const nextIndex = resolveGridIndex(grid.activeIndex, direction, grid.columns, count);
  // Flag the source before focusing so `onFocus` handlers can tell remote
  // input apart from keyboard / gamepad input.
  if (document.body) document.body.dataset.focusSource = "remote";
  grid.setActiveIndex(nextIndex);
  const nextItem = items[nextIndex];
  if (nextItem && typeof nextItem.focus === "function") {
    nextItem.focus({ preventScroll: true });
  }
  items.forEach((item, index) => applyFocusState(item, index === nextIndex, "remote"));
  return true;
}
