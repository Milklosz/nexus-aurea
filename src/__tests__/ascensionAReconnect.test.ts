import { describe, expect, it, vi } from "vitest";
import { CrossSourceGate } from "../services/crossSourceGate";
import {
  NEUTRAL_SNAPSHOT,
  chooseInputSource,
  initialNativeControllerModel,
  nativeControllerOwnsGamepadApi,
  nativeLinkState,
  reduceNativeController,
  type NativeControllerEvent,
  type NativeControllerModel,
} from "../services/nativeController";
import { NativeControllerStore, type NativeControllerDeps } from "../services/nativeControllerStore";
import { disabledNativeControllerStatus, type NativeControllerStatus } from "../services/nativeController";

/**
 * Ascension A, Phase 1, Deliverable 2: deterministic DS4 disconnect/reconnect
 * resync. Every sequence is synthetic and every timestamp is injected — no timers,
 * no wall clock. Covers: ownership release/re-acquire, epoch bumps, no stuck
 * held/armed state, Gamepad API fallback during a drop, and replay rejection.
 */

const connected = (device = "pad-a"): NativeControllerEvent => ({
  kind: "connected", device, revision: "v2", transport: "bluetooth",
});
const disconnected = (device = "pad-a"): NativeControllerEvent => ({ kind: "disconnected", device });
const state = (device: string, buttons: string[]): NativeControllerEvent => ({
  kind: "state",
  device,
  revision: "v2",
  transport: "bluetooth",
  dpad: { up: false, down: false, left: false, right: false },
  leftX: 0,
  leftY: 0,
  buttons: buttons as never,
});

function run(events: Array<[NativeControllerEvent, number]>, from: NativeControllerModel = initialNativeControllerModel): NativeControllerModel {
  return events.reduce((model, [event, at]) => reduceNativeController(model, event, at), from);
}

describe("ascension A: DS4 disconnect/reconnect resync (pure reducer)", () => {
  it("active-pad disconnect releases all held state and bumps the epoch exactly once", () => {
    let model = run([[connected("a"), 1], [state("a", ["cross"]), 2], [state("a", ["cross", "options"]), 3]]);
    expect(model.activeDevice).toBe("a");
    expect(model.lastButton).toBe("options");
    expect(model.lastInputAt).toBe(3);
    const epochBefore = model.epoch;
    model = reduceNativeController(model, disconnected("a"), 4);
    expect(model.epoch).toBe(epochBefore + 1);
    expect(model.pads).toEqual([]);
    expect(model.activeDevice).toBeNull();
    expect(model.snapshot).toBeNull();
    // No stuck "armed"/held state survives the boundary.
    expect(model.lastButton).toBeNull();
    expect(model.lastInputAt).toBeNull();
    expect(nativeLinkState(model, 4)).toBe("disconnected");
  });

  it("during a Bluetooth drop the Gamepad API path takes over, and native ownership returns on reconnect", () => {
    let model = run([[connected("a"), 1], [state("a", ["cross"]), 2]]);
    expect(chooseInputSource(model, 1)).toBe("native");
    expect(nativeControllerOwnsGamepadApi(model)).toBe(true);
    model = reduceNativeController(model, disconnected("a"), 3);
    // Drop: no native pad -> the browser path is the fallback again.
    expect(chooseInputSource(model, 1)).toBe("gamepad-api");
    expect(nativeControllerOwnsGamepadApi(model)).toBe(false);
    expect(chooseInputSource(model, 0)).toBe("none");
    // Reconnect of the SAME device label: a new epoch, ownership back to native,
    // and a NEUTRAL snapshot so the engine primes instead of firing a held release.
    const epochBefore = model.epoch;
    model = reduceNativeController(model, connected("a"), 4);
    expect(model.epoch).toBe(epochBefore + 1);
    expect(model.activeDevice).toBe("a");
    expect(model.snapshot).toEqual(NEUTRAL_SNAPSHOT);
    expect(chooseInputSource(model, 1)).toBe("native");
    expect(nativeControllerOwnsGamepadApi(model)).toBe(true);
    // Input after the reconnect is interpreted normally.
    model = reduceNativeController(model, state("a", ["cross"]), 5);
    expect(model.snapshot?.buttons).toEqual(["cross"]);
    expect(model.lastButton).toBe("cross");
  });

  it("a held button across a disconnect/reconnect does not fire on the new epoch", () => {
    // The gate is what rejects the replayed action: the model epoch moved, so the
    // hook advances the gate epoch and any pre-boundary tag is stale.
    const gate = new CrossSourceGate(90, 400);
    let model = run([[connected("a"), 1], [state("a", ["cross"]), 2]]);
    const preBoundaryTag = gate.currentEpoch; // 0
    expect(gate.accept("native", { type: "confirm" }, 2, preBoundaryTag)).toBe(true);
    // Disconnect + reconnect (same label) = two epoch bumps.
    model = reduceNativeController(model, disconnected("a"), 3);
    model = reduceNativeController(model, connected("a"), 4);
    expect(model.epoch).toBe(3); // 0 -> 1 (connect) -> 2 (disconnect) -> 3 (reconnect)
    // Hook logic: model epoch changed -> advance the gate epoch.
    gate.advanceEpoch();
    const tag = gate.currentEpoch;
    expect(tag).toBe(preBoundaryTag + 1);
    // Replayed pre-reconnect event (stale tag) is dropped even far in the future...
    expect(gate.accept("native", { type: "confirm" }, 100_000, preBoundaryTag)).toBe(false);
    // ...while a fresh press on the new epoch is accepted.
    expect(gate.accept("native", { type: "confirm" }, 100_000, tag)).toBe(true);
  });

  it("disconnecting a non-active pad keeps the active pad's input but still bumps the epoch", () => {
    let model = run([[connected("a"), 1], [connected("b"), 2], [state("a", ["cross"]), 3]]);
    const epochBefore = model.epoch;
    model = reduceNativeController(model, disconnected("b"), 4);
    expect(model.epoch).toBe(epochBefore + 1);
    expect(model.activeDevice).toBe("a");
    expect(model.snapshot?.buttons).toEqual(["cross"]);
    expect(model.lastButton).toBe("cross");
    expect(model.lastInputAt).toBe(3);
  });

  it("when the active pad drops and another remains, the survivor takes over neutral and primed", () => {
    let model = run([
      [connected("a"), 1],
      [connected("b"), 2],
      [state("a", ["cross"], ), 3],
    ]);
    model = reduceNativeController(model, disconnected("a"), 4);
    expect(model.activeDevice).toBe("b");
    expect(model.snapshot).toEqual(NEUTRAL_SNAPSHOT);
    expect(model.lastButton).toBeNull();
    expect(model.lastInputAt).toBeNull();
    expect(nativeControllerOwnsGamepadApi(model)).toBe(true);
    // The survivor must produce input before it is active (not just present).
    expect(nativeLinkState(model, 5)).toBe("connected");
    model = reduceNativeController(model, state("b", ["circle"]), 6);
    expect(model.activeDevice).toBe("b");
    expect(nativeLinkState(model, 6)).toBe("active");
  });

  it("a duplicate (replayed) connect event never creates a second pad", () => {
    const model = run([[connected("a"), 1], [connected("a"), 2], [connected("a"), 3]]);
    expect(model.pads).toHaveLength(1);
    expect(model.epoch).toBe(3); // every replayed boundary is still a visible epoch bump
  });

  it("unavailable is a full reset with a fresh epoch; the Gamepad API path runs", () => {
    let model = run([[connected("a"), 1], [state("a", ["cross"]), 2]]);
    model = reduceNativeController(model, { kind: "unavailable", reason: "sink failed" }, 3);
    expect(model.unavailableReason).toBe("sink failed");
    expect(model.pads).toEqual([]);
    expect(model.epoch).toBe(2); // 0 -> 1 (connect) -> 2 (unavailable)
    expect(chooseInputSource(model, 1)).toBe("gamepad-api");
    expect(nativeLinkState(model, 3)).toBe("unsupported");
  });

  it("a full synthetic BT drop sequence is deterministic end to end", () => {
    const seq: Array<[NativeControllerEvent, number]> = [
      [connected("ds4"), 100],
      [state("ds4", ["options"]), 200], // user presses Options
      [state("ds4", ["options"]), 300], // held
      [disconnected("ds4"), 1_000],     // Bluetooth drop (stale prune on the Rust side)
      [connected("ds4"), 2_500],        // auto-reconnect, same label
      [state("ds4", ["options"]), 2_600], // STILL held after reconnect (stuck report)
      [state("ds4", []), 2_700],        // release
      [state("ds4", ["cross"]), 3_000], // a fresh deliberate press
    ];
    let model = initialNativeControllerModel;
    const epochs: number[] = [];
    for (const [event, at] of seq) {
      model = reduceNativeController(model, event, at);
      epochs.push(model.epoch);
    }
    // Exactly deterministic: state events do not move the epoch, boundaries do.
    expect(epochs).toEqual([1, 1, 1, 2, 3, 3, 3, 3]);
    // Final state: reconnected, fresh press visible, link active.
    expect(model.activeDevice).toBe("ds4");
    expect(model.snapshot?.buttons).toEqual(["cross"]);
    expect(nativeLinkState(model, 3_000)).toBe("active");
    expect(chooseInputSource(model, 0)).toBe("native");
  });
});

describe("ascension A: NativeControllerStore epoch monotonicity across stop/start", () => {
  function harness() {
    let emit: ((event: NativeControllerEvent) => void) | null = null;
    let status: NativeControllerStatus = { ...disabledNativeControllerStatus, supported: true, running: true };
    const deps: NativeControllerDeps = {
      listen: vi.fn(async (callback: (event: NativeControllerEvent) => void) => {
        emit = callback;
        return () => { if (emit === callback) emit = null; };
      }),
      getStatus: vi.fn(async () => status),
      setHomeEnabled: vi.fn(async (enabled: boolean) => {
        status = { ...status, homeEnabled: enabled, homeOverride: enabled };
        return status;
      }),
      now: () => 1_000,
    };
    return {
      store: new NativeControllerStore(deps),
      fire: (event: NativeControllerEvent) => emit?.(event),
    };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("stop() keeps the connection epoch monotonic (no replay across a restart)", async () => {
    const h = harness();
    const release = h.store.acquire();
    await flush();
    h.fire(connected("a"));
    h.fire(state("a", ["cross"]));
    const epochBeforeStop = h.store.getModel().epoch;
    expect(epochBeforeStop).toBeGreaterThan(0);
    release();
    expect(h.store.getModel().epoch).toBe(epochBeforeStop); // not rewound to 0
    // Re-acquire and reconnect: the epoch continues upward, never repeats a value.
    const release2 = h.store.acquire();
    await flush();
    h.fire(connected("a"));
    expect(h.store.getModel().epoch).toBe(epochBeforeStop + 1);
    release2();
  });

  it("a status snapshot showing no pads emits disconnects with a fresh epoch", async () => {
    const h = harness();
    const release = h.store.acquire();
    await flush();
    h.fire(connected("a"));
    const before = h.store.getModel().epoch;
    await h.store.reconcile(); // status still lists no pads? it lists status.pads — empty by default
    // applyStatus with running=true and pads=[] disconnects pad "a" via an event.
    expect(h.store.getModel().pads).toEqual([]);
    expect(h.store.getModel().epoch).toBeGreaterThan(before);
    release();
  });
});
