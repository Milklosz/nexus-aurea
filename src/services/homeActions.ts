/**
 * The focusable horizontal rows of the Home screen: the top-bar actions
 * (Szukaj, Pilot, Ustawienia) and the context sections row (.lr-sections).
 * Pure DOM helper so keyboard, controller and remote share it. Never wraps and
 * never leaves the row: at an end the move is consumed and focus stays put.
 */
export const HOME_ACTIONS_SELECTOR = ".home-actions, .lr-sections";

/** Circle closes the focused Home disclosure before returning to the dock. */
export function closeHomeDisclosure(active: Element | null): boolean {
  const trigger = active?.closest("[data-home-disclosure]")?.querySelector<HTMLButtonElement>("button[aria-expanded=true]");
  if (!trigger) return false;
  trigger.click();
  return true;
}

/**
 * Returns true when `active` is inside a Home row (the top-bar actions or the
 * sections row; the move is handled, even when focus is already at an end).
 * Returns false otherwise so the caller can fall back to moving through the dock.
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
 * Confirm on a Home row item (top-bar action or section tile) presses that item.
 * Returns false when focus is elsewhere, so the caller falls back to launching
 * the selected dock app.
 */
export function activateHomeAction(active: Element | null): boolean {
  if (!active || typeof active.closest !== "function" || !active.closest(HOME_ACTIONS_SELECTOR)) return false;
  if (active instanceof HTMLElement) active.click();
  return true;
}
