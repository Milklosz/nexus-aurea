import type { ControllerAction } from "./controllerEngine";

export type ControllerSourceName = "native" | "gamepad-api";

/**
 * Last line of defence against double input. Source arbitration already picks one
 * source, but there is a short window while a pad hands over from the browser path to
 * the native path (or back) in which both could see the same physical press.
 *
 * An action is dropped only when the SAME action type was just accepted from a
 * DIFFERENT source. The same source is never throttled here: its own repeat logic owns
 * its timing. A human cannot press the same button twice within `windowMs`.
 */
export class CrossSourceGate {
  private last = new Map<string, { source: ControllerSourceName; at: number }>();

  constructor(private readonly windowMs = 90) {}

  accept(source: ControllerSourceName, action: ControllerAction, now: number): boolean {
    const key = action.type === "move" || action.type === "vertical"
      ? `${action.type}:${action.delta}`
      : action.type;
    const previous = this.last.get(key);
    if (previous && previous.source !== source && now - previous.at < this.windowMs) return false;
    this.last.set(key, { source, at: now });
    return true;
  }

  reset(): void {
    this.last.clear();
  }
}

/** Shared by every controller hook in the app so the gate sees both sources. */
export const crossSourceGate = new CrossSourceGate();
