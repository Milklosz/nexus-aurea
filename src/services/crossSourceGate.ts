import type { ControllerAction, ControllerSample } from "./controllerEngine";

export type ControllerSourceName = "native" | "gamepad-api";

/**
 * Last line of defence against double input. Source arbitration already picks one
 * source, but there is a short window while a pad hands over from the browser path to
 * the native path (or back) in which both could see the same physical press.
 *
 * An action is dropped only when the SAME action type was just accepted from a
 * DIFFERENT source. The same source is never throttled here: its own repeat logic owns
 * its timing. A human cannot press the same button twice within `windowMs`.
 *
 * Native priority: while the native pad is being used (reported through
 * `noteNativeActivity`) the browser path is secondary and its actions are dropped. This
 * covers a virtual pad created from the same physical DualShock 4 (DS4Windows, ViGEm, a
 * Steam virtual XInput pad), whose id the browser path cannot tell apart from a real Xbox
 * pad. Repeats of a held direction would otherwise run on two independent timelines.
 */
export class CrossSourceGate {
  private last = new Map<string, { source: ControllerSourceName; at: number }>();
  private nativeActiveAt = Number.NEGATIVE_INFINITY;
  private nativeActions = new Map<string, number>();

  constructor(private readonly windowMs = 90, private readonly nativePriorityMs = 400) {}

  /** The native pad currently holds an input (non-neutral state). */
  noteNativeActivity(now: number, sample?: ControllerSample | null): void {
    if (sample === undefined) { this.nativeActiveAt = now; return; }
    if (!sample) return;
    for (const key of ["confirm", "back", "options"] as const) {
      if (sample[key] || (key === "options" && sample.guide)) this.nativeActions.set(key, now);
    }
    if (sample.dpadLeft || sample.axisX < -0.35) this.nativeActions.set("move:-1", now);
    if (sample.dpadRight || sample.axisX > 0.35) this.nativeActions.set("move:1", now);
    if (sample.dpadUp || (sample.axisY ?? 0) < -0.35) this.nativeActions.set("vertical:-1", now);
    if (sample.dpadDown || (sample.axisY ?? 0) > 0.35) this.nativeActions.set("vertical:1", now);
  }

  accept(source: ControllerSourceName, action: ControllerAction, now: number): boolean {
    if (source === "gamepad-api" && now - this.nativeActiveAt < this.nativePriorityMs) return false;
    const key = action.type === "move" || action.type === "vertical"
      ? `${action.type}:${action.delta}`
      : action.type;
    if (source === "gamepad-api" && now - (this.nativeActions.get(key) ?? -Infinity) < this.nativePriorityMs) return false;
    const previous = this.last.get(key);
    if (previous && previous.source !== source && now - previous.at < this.windowMs) return false;
    this.last.set(key, { source, at: now });
    return true;
  }

  reset(): void {
    this.last.clear();
    this.nativeActions.clear();
    this.nativeActiveAt = Number.NEGATIVE_INFINITY;
  }
}

/** Shared by every controller hook in the app so the gate sees both sources. */
export const crossSourceGate = new CrossSourceGate();
