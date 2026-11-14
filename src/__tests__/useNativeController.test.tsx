// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGamepad, type ControllerActions } from "../hooks/useGamepad";
import { NATIVE_STALE_MS, useNativeController } from "../hooks/useNativeController";
import { crossSourceGate } from "../services/crossSourceGate";
import { isDualShock4GamepadId, type Ds4ButtonName, type NativeControllerEvent } from "../services/nativeController";
import { nativeControllerStore } from "../services/nativeControllerStore";

const mocks = vi.hoisted(() => ({
  emit: null as ((event: NativeControllerEvent) => void) | null,
  listen: vi.fn(),
  stop: vi.fn(),
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
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
function advance(ms: number) {
  act(() => {
    for (let elapsed = 0; elapsed < ms; elapsed += 8) {
      now += 8;
      vi.advanceTimersByTime(8);
    }
  });
}

const connected = (device = "pad-a"): NativeControllerEvent => ({ kind: "connected", device, revision: "v2", transport: "usb" });
function state(buttons: Ds4ButtonName[] = [], dpad: Partial<Record<"up" | "down" | "left" | "right", boolean>> = {}, device = "pad-a", leftX = 0): NativeControllerEvent {
  return {
    kind: "state", device, revision: "v2", transport: "usb",
    dpad: { up: false, down: false, left: false, right: false, ...dpad }, leftX, leftY: 0, buttons,
  };
}
const emit = (event: NativeControllerEvent) => act(() => { mocks.emit?.(event); });

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

beforeEach(() => {
  now = 1000;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  mocks.emit = null;
  mocks.stop.mockReset();
  mocks.listen.mockReset();
  mocks.listen.mockImplementation(async (callback: (event: NativeControllerEvent) => void) => {
    mocks.emit = callback;
    return () => { mocks.emit = null; mocks.stop(); };
  });
  mocks.status.mockReset();
  mocks.status.mockResolvedValue({ supported: true, running: true, lastError: null, pads: [], ignoredReports: 0 });
  crossSourceGate.reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(actions = makeActions(), suspend?: () => boolean) {
  const view = renderHook(({ a }) => useNativeController(a, true, suspend), { initialProps: { a: actions } });
  await flush();
  return { actions, ...view };
}

describe("useNativeController", () => {
  it("one Cross press is one confirm, and holding does not repeat it", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit(state(["cross"]));
    advance(400);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
    await emit(state([]));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
    await emit(state(["cross"]));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(2);
  });

  it("Circle goes back", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit(state(["circle"]));
    advance(100);
    expect(actions.back).toHaveBeenCalledTimes(1);
    expect(actions.confirm).not.toHaveBeenCalled();
  });

  it("Options opens on release, and PS + Options is the Home chord, not a panel", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit(state(["options"]));
    advance(100);
    expect(actions.options).not.toHaveBeenCalled();
    await emit(state([]));
    advance(100);
    expect(actions.options).toHaveBeenCalledTimes(1);

    await emit(state(["ps"]));
    advance(60);
    await emit(state(["ps", "options"]));
    advance(100);
    await emit(state([]));
    advance(200);
    expect(actions.options).toHaveBeenCalledTimes(1);
  });

  it("Share and a bare PS press do nothing in the launcher", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit(state(["share"]));
    advance(100);
    await emit(state(["ps"]));
    advance(100);
    await emit(state([]));
    advance(100);
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });

  it("a short D-pad tap moves once; holding repeats at a bounded rate", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit(state([], { right: true }));
    advance(120);
    await emit(state([]));
    advance(100);
    expect(actions.move).toHaveBeenCalledTimes(1);
    expect(actions.move).toHaveBeenLastCalledWith(1);

    await emit(state([], { left: true }));
    for (let beat = 0; beat < 4; beat += 1) {
      advance(250);
      await emit(state([], { left: true })); // the native heartbeat
    }
    await emit(state([]));
    // 1 initial step, then repeats after 420 ms at 135 ms: about 1 + 4 over one second.
    const leftMoves = actions.move.mock.calls.filter(([delta]) => delta === -1).length;
    expect(leftMoves).toBeGreaterThanOrEqual(4);
    expect(leftMoves).toBeLessThanOrEqual(7);
  });

  it("a stick diagonal moves along one axis only", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit({ ...state(["cross"], {}, "pad-a", 0.9), leftY: 0.7, buttons: [] } as NativeControllerEvent);
    advance(100);
    expect(actions.move).toHaveBeenCalledTimes(1);
    expect(actions.vertical).not.toHaveBeenCalled();
  });

  it("a lost release never leaves a direction stuck: silence is treated as released", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit(state([], { right: true }));
    advance(NATIVE_STALE_MS + 100); // no heartbeat, no release
    const moves = actions.move.mock.calls.length;
    advance(2000);
    expect(actions.move.mock.calls.length).toBe(moves);
    expect(moves).toBeLessThanOrEqual(3);
  });

  it("disconnecting mid-hold stops navigation at once; reconnecting works", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit(state([], { right: true }));
    advance(100);
    const moves = actions.move.mock.calls.length;
    await emit({ kind: "disconnected", device: "pad-a" });
    advance(1500);
    expect(actions.move.mock.calls.length).toBe(moves);

    await emit(connected("pad-a"));
    advance(50);
    await emit(state(["cross"]));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("a button held while VELORA was in the background does not fire when focus returns", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    advance(50);
    await emit(state(["cross"]));
    advance(200);
    expect(actions.confirm).not.toHaveBeenCalled();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    advance(200);
    expect(actions.confirm).not.toHaveBeenCalled(); // primed as held, waits for a fresh press
    await emit(state([]));
    advance(100);
    await emit(state(["cross"]));
    advance(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("a suspended input source ignores the pad", async () => {
    const { actions } = await mount(makeActions(), () => true);
    await emit(connected());
    advance(50);
    await emit(state(["cross"]));
    advance(200);
    expect(actions.confirm).not.toHaveBeenCalled();
  });

  it("L1 and R1 switch sections once per press and never from a held bumper", async () => {
    const { actions } = await mount();
    await emit(connected());
    advance(50);
    await emit(state(["r1"]));
    advance(60);
    expect(actions.section).toHaveBeenCalledTimes(1);
    expect(actions.section).toHaveBeenLastCalledWith(1);
    advance(300);
    expect(actions.section).toHaveBeenCalledTimes(1);
    await emit(state(["l1"]));
    advance(60);
    expect(actions.section).toHaveBeenLastCalledWith(-1);
    expect(actions.section).toHaveBeenCalledTimes(2);
  });

  it("keeps exactly one store subscription across re-renders and removes it on unmount", async () => {
    const first = makeActions();
    const { rerender, unmount } = await mount(first);
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i += 1) {
      rerender({ a: makeActions() });
      await flush();
    }
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(nativeControllerStore.listenerCount).toBe(1);
    unmount();
    await flush();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(nativeControllerStore.listenerCount).toBe(0);
  });

  it("restarts cleanly after an interface reload (unmount then mount)", async () => {
    const one = await mount();
    await emit(connected());
    one.unmount();
    await flush();
    const two = await mount();
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    await emit(connected());
    advance(50);
    await emit(state(["cross"]));
    advance(100);
    expect(two.actions.confirm).toHaveBeenCalledTimes(1);
    expect(one.actions.confirm).not.toHaveBeenCalled();
  });

  it("works with no pad at all: no listener noise, no actions", async () => {
    const { actions } = await mount();
    advance(2000);
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });

  it("does not subscribe when disabled (ambient screen)", async () => {
    const actions = makeActions();
    renderHook(() => useNativeController(actions, false));
    await flush();
    expect(mocks.listen).not.toHaveBeenCalled();
  });
});

describe("single source of truth between native and the Gamepad API", () => {
  type Pad = { connected: boolean; id: string; index: number; mapping: string; buttons: { pressed: boolean; value: number }[]; axes: number[] };
  const makePad = (id: string, index: number, pressed: number[]): Pad => ({
    connected: true, id, index, mapping: "standard",
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
    axes: [0, 0],
  });
  const DS4_ID = "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)";
  const XBOX_ID = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)";

  let pads: Array<Pad | null> = [];
  let frames: Array<() => void> = [];
  const pump = (ms = 16) => act(() => {
    now += ms;
    const queue = frames;
    frames = [];
    for (const callback of queue) callback();
  });

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(() => callback(now)); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("navigator", { getGamepads: () => pads });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("while native owns the DualShock 4 the browser path ignores it: one press, one action", async () => {
    const actions = makeActions();
    pads = [makePad(DS4_ID, 0, [])];
    const ownsNative = (pad: Gamepad) => isDualShock4GamepadId(pad.id);
    renderHook(() => {
      useNativeController(actions, true);
      useGamepad(actions, true, "auto", undefined, ownsNative);
    });
    await flush();
    await emit(connected());
    pump(); advance(50);

    pads = [makePad(DS4_ID, 0, [0])]; // Cross on the browser side too
    pump(); pump(60);
    await emit(state(["cross"]));
    advance(100);
    pump(); pump(60);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("another pad (Xbox) still works through the browser path while native owns a DualShock 4", async () => {
    const actions = makeActions();
    pads = [makePad(DS4_ID, 0, []), makePad(XBOX_ID, 1, [])];
    renderHook(() => {
      useNativeController(actions, true);
      useGamepad(actions, true, "auto", undefined, (pad) => isDualShock4GamepadId(pad.id));
    });
    await flush();
    await emit(connected());
    pump(); advance(50);
    pads = [makePad(DS4_ID, 0, []), makePad(XBOX_ID, 1, [0])];
    pump(); pump(60);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("without a native layer the DualShock 4 falls back to the browser path", async () => {
    const actions = makeActions();
    pads = [makePad(DS4_ID, 0, [])];
    mocks.status.mockResolvedValue({ supported: false, running: false, lastError: null, pads: [], ignoredReports: 0 });
    renderHook(() => {
      useNativeController(actions, true);
      useGamepad(actions, true, "auto", undefined, () => {
        const model = nativeControllerStore.getModel();
        return !model.unavailableReason && model.pads.length > 0;
      });
    });
    await flush();
    pump();
    pads = [makePad(DS4_ID, 0, [0])];
    pump(); pump(60);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("the cross-source gate drops the second source in a hand-over window", async () => {
    const actions = makeActions();
    pads = [makePad(DS4_ID, 0, [])];
    renderHook(() => {
      useNativeController(actions, true);
      useGamepad(actions, true, "auto"); // no ignore: both sources see the same press
    });
    await flush();
    await emit(connected());
    pump(); advance(50);
    pads = [makePad(DS4_ID, 0, [0])];
    await emit(state(["cross"]));
    pump(); pump(60); advance(60);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });
});
