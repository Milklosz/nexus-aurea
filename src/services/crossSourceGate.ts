import type { ControllerAction, ControllerSample } from "./controllerEngine";

/**
 * Every source that can produce a controller action:
 *
 * - `native`      the Rust `pad_hub` Raw Input sink (DS4 HID reports, semantic events)
 * - `gamepad-api` the browser Gamepad API path (`useGamepad`)
 * - `keyboard`    keys that act as controller input (e.g. a DS4 button that also
 *                 surfaces as a keyboard event through DS4Windows/Steam Input
 *                 coexistence, or Backspace as Back)
 * - `remote`      authenticated LAN remote commands (`remoteCommand` from the iPhone)
 *
 * A single physical press can surface on more than one of them (a DS4 button that
 * also emits a keyboard event, or a pad press racing a remote command). The gate
 * arbitrates all four uniformly so exactly one action fires.
 */
export type ControllerSourceName = "native" | "gamepad-api" | "keyboard" | "remote";

/**
 * Last line of defence against double input. Source arbitration already picks one
 * source, but there is a short window while a pad hands over from the browser path to
 * the native path (or back) in which both could see the same physical press.
 *
 * An action is dropped only when the SAME action was just accepted from a
 * DIFFERENT source. The same source is never throttled here: its own repeat logic owns
 * its timing. A human cannot press the same button twice within `windowMs`, so a
 * same-key accept from another source inside that window — including the same tick —
 * is a duplicate of one physical press, not a second press.
 *
 * Native priority: while the native pad is being used (reported through
 * `noteNativeActivity`) every other source is secondary and its actions are dropped.
 * This covers a virtual pad created from the same physical DualShock 4 (DS4Windows,
 * ViGEm, a Steam virtual XInput pad), whose id the browser path cannot tell apart
 * from a real Xbox pad, and a DS4 button that also arrives as a keyboard event or a
 * LAN remote command. Repeats of a held direction would otherwise run on two
 * independent timelines.
 *
 * Epoch: `advanceEpoch()` is called at every deterministic resync boundary (native
 * pad connect/disconnect, window focus regain). `accept` may carry the epoch tag the
 * caller captured when the input was produced; a tag from before the latest boundary
 * marks a replayed event and is dropped even if every time window has elapsed.
 * `reset()` clears the timing state but never rewinds the epoch, so stale tags stay
 * stale forever.
 */
export class CrossSourceGate {
  private last = new Map<string, { source: ControllerSourceName; at: number }>();
  private nativeActiveAt = Number.NEGATIVE_INFINITY;
  private nativeActions = new Map<string, number>();
  private epoch = 0;

  constructor(private readonly windowMs = 90, private readonly nativePriorityMs = 400) {}

  /** The current arbitration epoch. Tags captured earlier compare stale against it. */
  get currentEpoch(): number {
    return this.epoch;
  }

  /** Opens a new arbitration epoch and returns it. All older tags become invalid. */
  advanceEpoch(): number {
    this.epoch += 1;
    return this.epoch;
  }

  /** The gate key of an action: directions carry their delta, buttons their name. */
  static keyOf(action: ControllerAction): string {
    return action.type === "move" || action.type === "vertical"
      ? `${action.type}:${action.delta}`
      : action.type;
  }

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

  /**
   * Decides whether `action` from `source` fires now. `epochTag` is optional: pass
   * the `currentEpoch` captured when the input was produced to make a replayed
   * (pre-boundary) event drop; omitting it means "current epoch".
   */
  accept(source: ControllerSourceName, action: ControllerAction, now: number, epochTag = this.epoch): boolean {
    if (epochTag !== this.epoch) return false;
    const key = CrossSourceGate.keyOf(action);
    if (source !== "native") {
      // Native priority applies to every non-native source, not only the browser path.
      if (now - this.nativeActiveAt < this.nativePriorityMs) return false;
      if (now - (this.nativeActions.get(key) ?? Number.NEGATIVE_INFINITY) < this.nativePriorityMs) return false;
    }
    const previous = this.last.get(key);
    if (previous && previous.source !== source && now - previous.at < this.windowMs) return false;
    this.last.set(key, { source, at: now });
    return true;
  }

  /**
   * Clears the suppression windows and native-priority state (session boundary).
   * The epoch is deliberately NOT rewound: replayed events stay rejected.
   */
  reset(): void {
    this.last.clear();
    this.nativeActions.clear();
    this.nativeActiveAt = Number.NEGATIVE_INFINITY;
  }
}

/** Shared by every controller hook in the app so the gate sees all sources. */
export const crossSourceGate = new CrossSourceGate();
