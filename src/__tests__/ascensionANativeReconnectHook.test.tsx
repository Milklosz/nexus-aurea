// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeController } from "../hooks/useNativeController";
import type { ControllerActions } from "../hooks/useGamepad";
import { crossSourceGate } from "../services/crossSourceGate";
import {
  disabledNativeControllerStatus,
  nativeControllerOwnsGamepadApi,
  type Ds4ButtonName,
  type NativeControllerEvent,
} from "../services/nativeController";
import { nativeControllerStore } from "../services/nativeControllerStore";

/**
 * Ascension A, Phase 1, Deliverable 2 (hook level): synthetic DS4
 * disconnect/reconnect and window focus sequences against the real
 * useNativeController hook. Fake timers + injected performance.now() keep every
 * step deterministic; no wall clock is involved.
 */

const mocks = vi.hoisted(() => ({
  emit: null as ((event: NativeControllerEvent) => void) | null,
  listen: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../services/nativeController", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/nativeController")>();
  return {
    ...original,
    listenForNativeController: mocks.listen,
    getNativeControllerStatus: mocks.status,
  };
});

let now = 0;
let focused = true;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
function advance(ms: number) {
  act(() => {
    for (let elapsed = 0; elapsed < ms; elapsed += 8) {
      now += 8;
      vi.advanceTimersByTime(8);
    }
  });
}

const connected = (device = "pad-a"): NativeControllerEvent => ({ kind: "connected", device, revision: "v2", transport: "bluetooth" });
const disconnected = (device = "pad-a"): NativeControllerEvent => ({ kind: "disconnected", device });
function state(buttons: Ds4ButtonName[] = [], device = "pad-a"): NativeControllerEvent {
  return {
    kind: "state", device, revision: "v2", transport: "bluetooth",
    dpad: { up: false, down: false, left: false, right: false }, leftX: 0, leftY: 0, buttons,
  };
}
const emit = (event: NativeControllerEvent) => act(() => { mocks.emit?.(event); });
const focusWindow = () => act(() => { focused = true; window.dispatchEvent(new Event("focus")); });
const blurWindow = () => act(() => { focused = false; window.dispatchEvent(new Event("blur")); });

function makeActions() {
  return {
    move: vi.fn<(delta: -1 | 1) => void>(),
    vertical: vi.fn<(delta: -1 | 1) => void>(),
    confirm: vi.fn<() => void>(),
    back: vi.fn<() => void>(),
    options: vi.fn<() => void>(),
    section: vi.fn<(delta: -1 | 1) => void>(),
  } satisfies ControllerActions;
}

function statusWithPads(pads: string[]) {
  return {
    ...disabledNativeControllerStatus,
    supported: true,
    running: true,
    pads: pads.map((device) => ({ device, revision: "v2" as const, transport: "bluetooth" as const })),
  };
}

beforeEach(() => {
  now = 1_000;
  focused = true;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  mocks.emit = null;
  mocks.listen.mockReset();
  mocks.listen.mockImplementation(async (callback: (event: NativeControllerEvent) => void) => {
    mocks.emit = callback;
    return () => { if (mocks.emit === callback) mocks.emit = null; };
  });
  mocks.status.mockReset();
  mocks.status.mockResolvedValue(statusWithPads([]));
  crossSourceGate.reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(actions = makeActions()) {
  const view = renderHook(({ a }) => useNativeController(a, true), { initialProps: { a: actions } });
  await flush();
  return { actions, ...view };
}

describe("ascension A: useNativeController reconnect resync", () => {
  it("disconnect mid-press releases everything: no stuck action, ownership falls back to Gamepad API", async () => {
    const { actions } = await mount();
    emit(connected());
    advance(50);
    emit(state(["cross"]));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
    const epochBefore = nativeControllerStore.getModel().epoch;
    emit(disconnected());
    advance(100);
    const model = nativeControllerStore.getModel();
    expect(model.epoch).toBe(epochBefore + 1);
    expect(model.activeDevice).toBeNull();
    expect(model.snapshot).toBeNull();
    expect(nativeControllerOwnsGamepadApi(model)).toBe(false);
    // Further ticks produce nothing: no stuck confirm, no repeat.
    advance(500);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("reconnect with the button still held primes instead of firing; a fresh press fires exactly once", async () => {
    const { actions } = await mount();
    emit(connected());
    advance(50);
    emit(state(["cross"]));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
    // Bluetooth drop + auto-reconnect while Cross is still held. The Rust side
    // emits Connected + State(held) in one batch, so the frontend applies both
    // before the next 16 ms tick: the engine primes on the HELD state and never fires.
    emit(disconnected());
    advance(50);
    emit(connected());
    emit(state(["cross"])); // same batch as the reconnect: still held
    advance(300);
    expect(actions.confirm).toHaveBeenCalledTimes(1); // held across reconnect: primed, never fired
    emit(state([])); // release
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1); // release does not fire confirm
    emit(state(["cross"])); // fresh deliberate press
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(2); // exactly once
  });

  it("a PS+Options chord that straddles a reconnect never opens a panel on release", async () => {
    const { actions } = await mount();
    emit(connected());
    advance(50);
    emit(state(["ps"]));
    advance(60);
    emit(state(["ps", "options"]));
    advance(100);
    emit(disconnected());
    advance(50);
    emit(connected());
    advance(50);
    emit(state(["ps", "options"])); // still held after reconnect
    advance(100);
    emit(state([])); // release of the chord
    advance(200);
    expect(actions.options).not.toHaveBeenCalled();
    expect(actions.confirm).not.toHaveBeenCalled();
    // A plain Options press after the reconnect still works (once, on release).
    emit(state(["options"]));
    advance(100);
    emit(state([]));
    advance(100);
    expect(actions.options).toHaveBeenCalledTimes(1);
  });

  it("when the active pad drops, the remaining pad takes over neutral and its press fires exactly once", async () => {
    const { actions } = await mount();
    emit(connected("pad-a"));
    emit(connected("pad-b"));
    advance(50);
    emit(state(["cross"], "pad-a"));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
    const epochBefore = nativeControllerStore.getModel().epoch;
    emit(disconnected("pad-a"));
    advance(50);
    const model = nativeControllerStore.getModel();
    expect(model.epoch).toBe(epochBefore + 1);
    expect(model.activeDevice).toBe("pad-b");
    expect(nativeControllerOwnsGamepadApi(model)).toBe(true);
    emit(state(["cross"], "pad-b"));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(2); // exactly one more — not zero, not duplicated
  });

  it("a double window-focus recovery still dispatches one press exactly once", async () => {
    const { actions } = await mount();
    emit(connected());
    advance(50);
    mocks.status.mockResolvedValue(statusWithPads(["pad-a"])); // focus reconcile keeps the pad
    const gateEpochBefore = crossSourceGate.currentEpoch;
    focusWindow();
    focusWindow(); // duplicate recovery event
    await flush();
    advance(20);
    expect(crossSourceGate.currentEpoch).toBeGreaterThan(gateEpochBefore); // resync boundary opened
    emit(state(["cross"]));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
    advance(200);
    expect(actions.confirm).toHaveBeenCalledTimes(1); // no double activation
  });

  it("a press that starts while blurred never fires late after focus returns", async () => {
    const { actions } = await mount();
    emit(connected());
    advance(50);
    mocks.status.mockResolvedValue(statusWithPads(["pad-a"]));
    emit(state(["cross"]));
    advance(20); // inside the 40 ms debounce
    blurWindow();
    advance(200); // engine reset while unfocused
    focusWindow();
    await flush();
    advance(300); // still held, but re-primed on focus: must not fire
    expect(actions.confirm).toHaveBeenCalledTimes(0);
    emit(state([]));
    advance(50);
    emit(state(["cross"]));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });
});
