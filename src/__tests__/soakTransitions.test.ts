import { describe, expect, it } from "vitest";
import { CrossSourceGate, type ControllerSourceName } from "../services/crossSourceGate";
import type { ControllerAction, ControllerSample } from "../services/controllerEngine";

/**
 * Bounded high-iteration controller transition soak (S2.8).
 *
 * This is a deterministic soak of the REAL CrossSourceGate state machine, not a
 * wall-clock test and not a hardware test. It drives thousands of mixed-source
 * transitions with adversarial timing and asserts the documented invariants on
 * every step: native priority, cross-source dedupe and full reset semantics.
 */

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const ACTIONS: ControllerAction[] = [
  { type: "move", delta: 1 },
  { type: "move", delta: -1 },
  { type: "vertical", delta: 1 },
  { type: "vertical", delta: -1 },
  { type: "confirm" },
  { type: "back" },
  { type: "options" },
];

function actionKey(action: ControllerAction): string {
  return action.type === "move" || action.type === "vertical"
    ? `${action.type}:${action.delta}`
    : action.type;
}

function heldRightSample(): ControllerSample {
  return {
    connected: true,
    dpadLeft: false,
    dpadRight: true,
    axisX: 0.8,
    confirm: false,
    back: false,
    options: false,
  };
}

describe("long-running controller transition soak", () => {
  it("preserves cross-source and native-priority invariants over 3000 deterministic transitions", () => {
    const windowMs = 90;
    const nativePriorityMs = 400;
    const gate = new CrossSourceGate(windowMs, nativePriorityMs);
    const random = seededRandom(0x5eed_1234);

    let now = 1_000;
    let nativeActivityAt = Number.NEGATIVE_INFINITY;
    const nativeActionAt = new Map<string, number>();
    const lastAccepted = new Map<string, { source: ControllerSourceName; at: number }>();
    let accepted = 0;
    let rejected = 0;

    for (let step = 0; step < 3000; step += 1) {
      now += 1 + Math.floor(random() * 60);
      const roll = random();

      if (roll < 0.1) {
        // Native activity with no sample: raises the browser-input priority barrier.
        gate.noteNativeActivity(now);
        nativeActivityAt = now;
        continue;
      }
      if (roll < 0.25) {
        // A held native direction: raises the per-action priority barrier.
        gate.noteNativeActivity(now, heldRightSample());
        nativeActionAt.set("move:1", now);
        continue;
      }
      if (roll < 0.33) {
        // Session/ownership boundary: a full reset must clear all arbitration.
        gate.reset();
        nativeActivityAt = Number.NEGATIVE_INFINITY;
        nativeActionAt.clear();
        lastAccepted.clear();
        continue;
      }

      const source: ControllerSourceName = random() < 0.5 ? "native" : "gamepad-api";
      const action = ACTIONS[Math.floor(random() * ACTIONS.length)];
      const key = actionKey(action);
      const result = gate.accept(source, action, now);

      if (result && source === "gamepad-api") {
        // An ACCEPTED browser-path action may only occur after both priority
        // windows have fully elapsed, never while a native pad is active or
        // just moved. Rejected attempts may of course land inside them.
        expect(now - nativeActivityAt).toBeGreaterThanOrEqual(nativePriorityMs);
        expect(now - (nativeActionAt.get(key) ?? Number.NEGATIVE_INFINITY)).toBeGreaterThanOrEqual(
          nativePriorityMs,
        );
      }

      if (result) {
        const previous = lastAccepted.get(key);
        if (previous && previous.source !== source) {
          // The same action from a different source is deduped within the window.
          expect(now - previous.at).toBeGreaterThanOrEqual(windowMs);
        }
        lastAccepted.set(key, { source, at: now });
        accepted += 1;
      } else {
        rejected += 1;
      }
    }

    // The soak must actually exercise both outcomes rather than trivially pass.
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
    expect(accepted + rejected).toBeLessThanOrEqual(3000);
  });

  it("native priority decays so browser input recovers after a long idle, without replaying input", () => {
    const gate = new CrossSourceGate(90, 400);
    const confirm: ControllerAction = { type: "confirm" };
    gate.noteNativeActivity(1_000);

    // Still inside the priority window: dropped, not queued for later.
    expect(gate.accept("gamepad-api", confirm, 1_399)).toBe(false);
    // After the window: a fresh browser action is accepted.
    expect(gate.accept("gamepad-api", confirm, 1_401)).toBe(true);
    // No deferred action was replayed in between.
    expect(gate.accept("gamepad-api", { type: "back" }, 1_402)).toBe(true);
  });

  it("a reset boundary allows immediate re-arbitration after native activity", () => {
    const gate = new CrossSourceGate(90, 400);
    gate.noteNativeActivity(5_000);
    expect(gate.accept("gamepad-api", { type: "confirm" }, 5_001)).toBe(false);

    gate.reset();
    expect(gate.accept("gamepad-api", { type: "confirm" }, 5_002)).toBe(true);
  });
});
