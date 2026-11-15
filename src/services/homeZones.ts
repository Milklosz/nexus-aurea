/**
 * Vertical zones of the home screen, top to bottom. Up/down move between zones;
 * left/right keep their existing meaning inside a zone (the dock is the only zone
 * with several items). Zones that are not on screen are skipped, never focused.
 */
export const HOME_ZONES = ["controlCenter", "music", "dock", "diagnostics"] as const;
export type HomeZone = (typeof HOME_ZONES)[number];
export type HomeZoneAvailability = Record<HomeZone, boolean>;

/** Only VELORA's own elements are matched, so zone detection cannot touch other windows. */
export const HOME_ZONE_MEMBERS: Record<HomeZone, string> = {
  controlCenter: ".quick-settings-trigger, .home-actions",
  music: ".music-mini-player",
  dock: ".dock, .lr-dock",
  diagnostics: ".diagnostics-trigger",
};

/** Element that receives focus when a zone is entered. The dock is focused by the caller. */
/** Tried in order. The Living Room top bar remembers its last action (data-remembered); the legacy Home has one trigger. */
const HOME_ZONE_FOCUS: Record<Exclude<HomeZone, "dock">, readonly string[]> = {
  controlCenter: [".home-actions [data-remembered=\"true\"]", ".home-actions button", ".quick-settings-trigger"],
  music: [".music-mini-player button:not(:disabled)"],
  diagnostics: [".diagnostics-trigger"],
};

/**
 * The next available zone in `delta` direction (-1 up, +1 down). Returns null when
 * there is none, so the caller can fall back to its own behavior. Never wraps.
 */
export function nextHomeZone(
  current: HomeZone,
  delta: -1 | 1,
  available: HomeZoneAvailability,
): HomeZone | null {
  for (
    let index = HOME_ZONES.indexOf(current) + delta;
    index >= 0 && index < HOME_ZONES.length;
    index += delta
  ) {
    const zone = HOME_ZONES[index];
    if (zone !== undefined && available[zone]) return zone;
  }
  return null;
}

/** Zone that contains `element`, or null when it is outside every zone. */
export function homeZoneOfElement(element: Element | null): HomeZone | null {
  if (!element || typeof element.closest !== "function") return null;
  for (const zone of HOME_ZONES) {
    if (element.closest(HOME_ZONE_MEMBERS[zone]) !== null) return zone;
  }
  return null;
}

/** Availability read from the live DOM. The dock and Control Center are always present. */
export function homeZoneAvailability(root: ParentNode): HomeZoneAvailability {
  return {
    controlCenter: root.querySelector(HOME_ZONE_MEMBERS.controlCenter) !== null,
    music: root.querySelector(HOME_ZONE_MEMBERS.music) !== null,
    dock: root.querySelector(HOME_ZONE_MEMBERS.dock) !== null,
    diagnostics: root.querySelector(HOME_ZONE_MEMBERS.diagnostics) !== null,
  };
}

/** Focuses the first control of a non-dock zone. Returns false when it is missing. */
export function focusHomeZone(root: ParentNode, zone: Exclude<HomeZone, "dock">): boolean {
  let target: HTMLElement | null = null;
  for (const selector of HOME_ZONE_FOCUS[zone]) {
    target = root.querySelector<HTMLElement>(selector);
    if (target) break;
  }
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}
