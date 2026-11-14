/**
 * Left/right inside the Home top-bar actions (Szukaj, Pilot, Ustawienia).
 * Pure DOM helper so keyboard, controller and remote share it. Never wraps and
 * never leaves the row: at an end the move is consumed and focus stays put.
 */
export const HOME_ACTIONS_SELECTOR = ".home-actions";

/**
 * Returns true when `active` is inside the actions row (the move is handled, even
 * when focus is already at an end). Returns false otherwise so the caller can
 * fall back to moving through the dock.
 */
export function moveWithinHomeActions(active: Element | null, delta: -1 | 1): boolean {
  if (!active || typeof active.closest !== "function") return false;
  const row = active.closest(HOME_ACTIONS_SELECTOR);
  if (!row) return false;
  const items = Array.from(row.querySelectorAll<HTMLElement>("button:not(:disabled)"));
  const index = items.indexOf(active as HTMLElement);
  if (index < 0) return false;
  const next = items[index + delta];
  if (next) next.focus({ preventScroll: true });
  return true;
}

/**
 * Confirm on a Home top-bar action presses that action. Returns false when focus is
 * elsewhere, so the caller falls back to launching the selected dock app.
 */
export function activateHomeAction(active: Element | null): boolean {
  if (!active || typeof active.closest !== "function" || !active.closest(HOME_ACTIONS_SELECTOR)) return false;
  if (active instanceof HTMLElement) active.click();
  return true;
}
