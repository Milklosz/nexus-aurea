import type { ControllerAction } from "./controllerEngine";
import { homeZoneOfElement } from "./homeZones";

/**
 * Who owns navigation input right now. Exactly one owner at any moment: the one
 * layer that is allowed to interpret a controller action. Layers are ordered from
 * the most to the least specific, and the first match wins.
 *
 * - `external`   VELORA is not the foreground window (a streaming app, Steam, a game,
 *                a browser). Controller input is not interpreted at all.
 * - `ambient`    The ambient screen is up; the dock is hidden.
 * - `keyboard`   The on-screen keyboard is open and claims every intent.
 * - `diagnostics`, `search`, `control-center`   Modal panels.
 * - `home-actions` / `home-dock`   The two Home zones that can hold focus.
 */
export type FocusOwner =
  | "external"
  | "ambient"
  | "keyboard"
  | "diagnostics"
  | "search"
  | "control-center"
  | "home-actions"
  | "home-dock";

export interface FocusOwnerInput {
  veloraFocused: boolean;
  ambientActive: boolean;
  keyboardOpen: boolean;
  diagnosticsOpen: boolean;
  controlCenterOpen: boolean;
  controlCenterPanel?: string;
  activeElement: Element | null;
}

export function resolveFocusOwner(input: FocusOwnerInput): FocusOwner {
  if (!input.veloraFocused) return "external";
  if (input.ambientActive) return "ambient";
  if (input.keyboardOpen) return "keyboard";
  if (input.diagnosticsOpen) return "diagnostics";
  if (input.controlCenterOpen) return input.controlCenterPanel === "search" ? "search" : "control-center";
  return homeZoneOfElement(input.activeElement) === "controlCenter" ? "home-actions" : "home-dock";
}

/** Owners whose layer interprets controller navigation. `external` and `ambient` do not. */
export function ownerAcceptsController(owner: FocusOwner): boolean {
  return owner !== "external" && owner !== "ambient";
}

function layerOf(owner: FocusOwner): FocusOwner | "home" {
  if (owner === "home-actions" || owner === "home-dock") return "home";
  // Search is a Control Center tab: switching tabs stays inside one layer.
  if (owner === "search") return "control-center";
  return owner;
}

/** A confirm that arrives this soon after the owner changed is swallowed. */
export const CONFIRM_SETTLE_MS = 180;

/**
 * Stops a confirm from acting on the wrong layer during a hand-over. When a panel
 * closes (or VELORA regains focus), the DOM focus is restored one frame later; a Cross
 * landing inside that gap would otherwise activate whatever the dock had selected,
 * launching an app while the user only meant to dismiss a panel. Move and back are
 * never delayed, so the pad still feels immediate.
 */
export class FocusOwnershipGuard {
  private owner: FocusOwner = "home-dock";
  private changedAt = Number.NEGATIVE_INFINITY;

  observe(owner: FocusOwner, now: number): void {
    if (owner === this.owner) return;
    // Moving between the two Home zones is ordinary navigation, not a hand-over.
    const sameLayer = layerOf(owner) === layerOf(this.owner);
    this.owner = owner;
    if (!sameLayer) this.changedAt = now;
  }

  get current(): FocusOwner {
    return this.owner;
  }

  allows(action: ControllerAction, now: number): boolean {
    if (!ownerAcceptsController(this.owner)) return false;
    return !(action.type === "confirm" && now - this.changedAt < CONFIRM_SETTLE_MS);
  }
}

/**
 * The element to return focus to when an overlay closes: the VELORA control that was
 * focused when it opened, provided it lives in a Home zone. Anything else (body, an
 * element inside the overlay itself, a node from another document) yields null and the
 * caller falls back to the dock.
 */
export function focusOpenerFrom(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement)) return null;
  if (active.closest("dialog")) return null;
  return homeZoneOfElement(active) === null ? null : active;
}

/** True when `opener` can still receive focus. A removed or disabled opener is not restored. */
export function canRestoreFocusTo(opener: HTMLElement | null): opener is HTMLElement {
  return Boolean(opener && opener.isConnected && !(opener as HTMLButtonElement).disabled);
}
