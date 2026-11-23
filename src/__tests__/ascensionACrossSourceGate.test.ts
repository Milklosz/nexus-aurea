import { describe, expect, it } from "vitest";
import { CrossSourceGate, type ControllerSourceName } from "../services/crossSourceGate";
import type { ControllerAction, ControllerSample } from "../services/controllerEngine";

/**
 * Ascension A, Phase 1, Deliverable 1: cross-source double-input suppression.
 *
 * Deterministic by construction: every test drives the gate with explicit `now`
 * values. No timers, no wall clock, no randomness (except one seeded PRNG whose
 * output is fully determined by the seed).
 *
 * Sources covered: native (Rust pad_hub), gamepad-api (browser), keyboard
 * (a DS4 button that also surfaces as a key), remote (LAN remoteCommand).
 */

const SOURCES: readonly ControllerSourceName[] = ["native", "gamepad-api", "keyboard", "remote"];
const ACTIONS: readonly ControllerAction[] = [
  { type: "move", delta: 1 },
  { type: "move", delta: -1 },
  { type: "vertical", delta: 1 },
  { type: "vertical", delta: -1 },
  { type: "confirm" },
  { type: "back" },
  { type: "options" },
];

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

function optionsSample(guide = false): ControllerSample {
  return {
    connected: true,
    dpadLeft: false,
    dpadRight: false,
    axisX: 0,
    confirm: false,
    back: false,
    options: true,
    guide,
  };
}

describe("ascension A: cross-source double-input suppression", () => {
  it("one physical press surfacing on all four sources fires exactly one action (same tick)", () => {
    const gate = new CrossSourceGate(90, 400);
    const confirm: ControllerAction = { type: "confirm" };
    const results = SOURCES.map((source) => gate.accept(source, confirm, 1_000));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true); // native first wins; the rest are same-tick duplicates
    for (const source of SOURCES.slice(1)) {
      expect(gate.accept(source, confirm, 1_000)).toBe(false);
    }
  });

  it("a DS4 button that also surfaces as keyboard fires once within the suppression window", () => {
    const gate = new CrossSourceGate(90, 400);
    const options: ControllerAction = { type: "options" };
    // Native source sees the Options press first.
    expect(gate.accept("native", options, 5_000)).toBe(true);
    // The same physical press arriving as a keyboard event 30 ms later is dropped.
    expect(gate.accept("keyboard", options, 5_030)).toBe(false);
    // A LAN remote echo of the same press is dropped too.
    expect(gate.accept("remote", options, 5_060)).toBe(false);
    // After the explicit suppression window a genuinely new press is accepted.
    expect(gate.accept("keyboard", options, 5_000 + 91)).toBe(true);
  });

  it("pad and remote racing on a direction: exactly one move fires per press", () => {
    const gate = new CrossSourceGate(90, 400);
    const move: ControllerAction = { type: "move", delta: 1 };
    expect(gate.accept("remote", move, 2_000)).toBe(true);
    expect(gate.accept("gamepad-api", move, 2_005)).toBe(false);
    expect(gate.accept("native", move, 2_010)).toBe(false);
    expect(gate.accept("keyboard", move, 2_089)).toBe(false);
    expect(gate.accept("native", move, 2_091)).toBe(true);
  });

  it("the same source is never throttled by the gate (its own repeat logic owns timing)", () => {
    const gate = new CrossSourceGate(90, 400);
    expect(gate.accept("native", { type: "confirm" }, 100)).toBe(true);
    expect(gate.accept("native", { type: "confirm" }, 110)).toBe(true); // same source, inside window
    expect(gate.accept("gamepad-api", { type: "confirm" }, 110)).toBe(false); // cross-source duplicate
  });

  it("native priority suppresses keyboard, remote and gamepad-api alike", () => {
    const gate = new CrossSourceGate(90, 400);
    gate.noteNativeActivity(1_000); // native pad holds input (no sample: global barrier)
    // The native source itself is never blocked by its own priority.
    expect(gate.accept("native", { type: "confirm" }, 1_000)).toBe(true);
    const probes: Array<[ControllerSourceName, ControllerAction]> = [
      ["gamepad-api", { type: "back" }],
      ["keyboard", { type: "move", delta: -1 }],
      ["remote", { type: "options" }],
    ];
    for (const [source, action] of probes) {
      expect(gate.accept(source, action, 1_399)).toBe(false);
      // After the priority window the source recovers — nothing is queued or replayed.
      expect(gate.accept(source, action, 1_401)).toBe(true);
    }
  });

  it("per-action native priority blocks the same action on other sources only", () => {
    const gate = new CrossSourceGate(90, 400);
    gate.noteNativeActivity(1_000, heldRightSample()); // native holds right
    expect(gate.accept("gamepad-api", { type: "move", delta: 1 }, 1_100)).toBe(false);
    expect(gate.accept("keyboard", { type: "move", delta: 1 }, 1_100)).toBe(false);
    expect(gate.accept("remote", { type: "move", delta: 1 }, 1_100)).toBe(false);
    // A different direction is not the same physical press.
    expect(gate.accept("remote", { type: "move", delta: -1 }, 1_100)).toBe(true);
    // The PS (guide) button counts as native options-chord activity.
    gate.noteNativeActivity(2_000, optionsSample(true));
    expect(gate.accept("keyboard", { type: "options" }, 2_100)).toBe(false);
    expect(gate.accept("keyboard", { type: "options" }, 2_401)).toBe(true);
  });

  it("epoch check drops replayed events even after every time window has elapsed", () => {
    const gate = new CrossSourceGate(90, 400);
    const tag = gate.currentEpoch;
    const confirm: ControllerAction = { type: "confirm" };
    expect(gate.accept("native", confirm, 1_000, tag)).toBe(true);
    // A deterministic resync boundary (pad reconnect / focus regain):
    const next = gate.advanceEpoch();
    expect(next).toBe(tag + 1);
    // Replay of the pre-boundary event: same source, long after the window, stale tag.
    expect(gate.accept("native", confirm, 999_000, tag)).toBe(false);
    expect(gate.accept("remote", confirm, 999_000, tag)).toBe(false);
    // A fresh event tagged with the current epoch is accepted.
    expect(gate.accept("native", confirm, 999_000)).toBe(true);
    expect(gate.accept("remote", { type: "back" }, 999_001, gate.currentEpoch)).toBe(true);
  });

  it("reset clears the timing windows but never rewinds the epoch (stale tags stay stale)", () => {
    const gate = new CrossSourceGate(90, 400);
    gate.advanceEpoch(); // epoch is now 1
    const staleTag = 0;
    gate.noteNativeActivity(5_000);
    expect(gate.accept("gamepad-api", { type: "confirm" }, 5_001)).toBe(false);
    gate.reset();
    // Immediate re-arbitration after a session reset still works for fresh input...
    expect(gate.accept("gamepad-api", { type: "confirm" }, 5_002)).toBe(true);
    // ...but a replayed pre-reset tag is still rejected.
    expect(gate.accept("keyboard", { type: "back" }, 5_003, staleTag)).toBe(false);
    gate.advanceEpoch();
    expect(gate.accept("keyboard", { type: "back" }, 5_004, staleTag)).toBe(false);
    expect(gate.accept("keyboard", { type: "back" }, 5_004)).toBe(true);
  });

  it("suppression key distinguishes directions and buttons", () => {
    expect(CrossSourceGate.keyOf({ type: "move", delta: 1 })).toBe("move:1");
    expect(CrossSourceGate.keyOf({ type: "move", delta: -1 })).toBe("move:-1");
    expect(CrossSourceGate.keyOf({ type: "vertical", delta: 1 })).toBe("vertical:1");
    expect(CrossSourceGate.keyOf({ type: "confirm" })).toBe("confirm");
    const gate = new CrossSourceGate(90, 400);
    expect(gate.accept("native", { type: "move", delta: 1 }, 0)).toBe(true);
    expect(gate.accept("remote", { type: "move", delta: -1 }, 1)).toBe(true); // different key
    expect(gate.accept("remote", { type: "vertical", delta: 1 }, 1)).toBe(true); // different key
    expect(gate.accept("remote", { type: "move", delta: 1 }, 1)).toBe(false); // same key
  });

  it("seeded four-source soak: at most one source is accepted per key inside the suppression window", () => {
    let state = 0xa5c3_0001 >>> 0;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const windowMs = 90;
    const gate = new CrossSourceGate(windowMs, 400);
    const acceptedPerKey = new Map<string, Array<{ source: ControllerSourceName; at: number }>>();
    let now = 1_000;
    let accepted = 0;
    let rejected = 0;
    let replays = 0;
    for (let step = 0; step < 2_000; step += 1) {
      now += 1 + Math.floor(random() * 40);
      const roll = random();
      if (roll < 0.05) {
        gate.advanceEpoch(); // resync boundary: all outstanding tags die (windows stay)
        continue;
      }
      if (roll < 0.15) {
        gate.noteNativeActivity(now, random() < 0.5 ? heldRightSample() : optionsSample(random() < 0.5));
        continue;
      }
      if (roll < 0.2) {
        gate.reset(); // session boundary: timing state cleared, epoch monotonic
        acceptedPerKey.clear();
        continue;
      }
      const source = SOURCES[Math.floor(random() * SOURCES.length)];
      const action = ACTIONS[Math.floor(random() * ACTIONS.length)];
      const key = CrossSourceGate.keyOf(action);
      // Every fourth accept attempt carries a deliberately stale tag (replayed event).
      const tag = step % 4 === 3 ? Math.max(0, gate.currentEpoch - 1) : gate.currentEpoch;
      const ok = gate.accept(source, action, now, tag);
      if (tag !== gate.currentEpoch) {
        expect(ok).toBe(false);
        replays += 1;
        continue;
      }
      if (ok) {
        const list = acceptedPerKey.get(key) ?? [];
        for (const prior of list) {
          if (prior.source !== source) {
            expect(now - prior.at).toBeGreaterThanOrEqual(windowMs);
          }
        }
        list.push({ source, at: now });
        acceptedPerKey.set(key, list);
        accepted += 1;
      } else {
        rejected += 1;
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(50);
    expect(replays).toBeGreaterThan(100);
  });
});
