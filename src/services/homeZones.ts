/**
 * Home-screen zones for pad navigation, in visual order from top to bottom.
 * The dock is the only zone with several items; Left/Right inside the dock stay
 * with the existing dock navigation. Only VELORA's own elements are touched.
 */
export const DOCK_ZONE = 2;

const ZONE_MEMBER_SELECTORS: readonly string[] = [
  ".quick-settings-trigger",
  ".music-mini-player",
  ".dock",
  ".diagnostics-trigger",
];

/** Element that receives focus when a zone is entered. Null means the dock, handled by the caller. */
const ZONE_FOCUS_SELECTORS: readonly (string | null)[] = [
  ".quick-settings-trigger",
  ".music-mini-player button:not(:disabled)",
  null,
  ".diagnostics-trigger",
];

/** Returns the zone an element belongs to, or -1 when it is outside every zone. */
export function homeZoneOf(element: Element | null): number {
  if (typeof HTMLElement === "undefined" || !(element instanceof HTMLElement)) return -1;
  return ZONE_MEMBER_SELECTORS.findIndex((selector) => element.closest(selector) !== null);
}

/** Zones that have something to focus right now (the dock always counts). */
export function availableHomeZones(root: ParentNode = document): number[] {
  return ZONE_FOCUS_SELECTORS.map((_, zone) => zone).filter((zone) => {
    if (zone === DOCK_ZONE) return true;
    const selector = ZONE_FOCUS_SELECTORS[zone];
    return selector !== null && root.querySelector(selector) !== null;
  });
}

/** The element to focus when entering a zone, or null for the dock. */
export function homeZoneTarget(zone: number, root: ParentNode = document): HTMLElement | null {
  const selector = ZONE_FOCUS_SELECTORS[zone];
  return selector ? root.querySelector<HTMLElement>(selector) : null;
}

/**
 * Next zone in the given direction. Never wraps. If the current element is not in
 * a zone, movement starts from the dock.
 */
export function nextHomeZone(current: number, available: readonly number[], delta: -1 | 1): number {
  if (available.length === 0) return current;
  const position = available.indexOf(current);
  const from = position === -1 ? available.indexOf(DOCK_ZONE) : position;
  const start = from === -1 ? 0 : from;
  return available[Math.min(Math.max(start + delta, 0), available.length - 1)];
}

/**
 * Left/Right inside the Background Mode player. Returns false when the focused element
 * is not one of its buttons, so the caller can fall back to the dock.
 */
export function stepMiniPlayer(delta: -1 | 1, active: Element | null, root: ParentNode = document): boolean {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".music-mini-player button:not(:disabled)"));
  const index = buttons.findIndex((button) => button === active);
  if (index < 0) return false;
  buttons[Math.min(Math.max(index + delta, 0), buttons.length - 1)]?.focus({ preventScroll: true });
  return true;
}
