// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGamepad, type ControllerActions } from "../hooks/useGamepad";

/**
 * Simulated controller: a standard-mapping pad fed frame by frame through the
 * real useGamepad hook. No hardware is involved; the hook's own requestAnimationFrame
 * loop is driven manually and time is controlled through performance.now.
 */

type Pad = { connected: boolean; id: string; index: number; mapping: string; buttons: { pressed: boolean; value: number }[]; axes: number[] };

function makePad(pressedIndexes: number[] = [], axisX = 0): Pad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressedIndexes.includes(i),
    value: pressedIndexes.includes(i) ? 1 : 0,
  }));
  return { connected: true, id: "Xbox-style test pad", index: 0, mapping: "standard", buttons, axes: [axisX, 0] };
}

let pads: Array<Pad | null> = [];
let now = 0;
let frames: Array<() => void> = [];

function step(ms: number) {
  now += ms;
  const queue = frames;
  frames = [];
  for (const callback of queue) callback();
}

function frame(ms = 16) {
  act(() => { step(ms); });
}

function setPad(pad: Pad | null) {
  pads = [pad];
}

function makeActions(): ControllerActions {
  return { move: vi.fn(), confirm: vi.fn(), back: vi.fn(), options: vi.fn() };
}

beforeEach(() => {
  now = 0;
  frames = [];
  pads = [makePad()];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(() => callback(now));
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("navigator", { getGamepads: () => pads });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useGamepad with a simulated controller", () => {
  it("fires one move on a D-pad press after the debounce, then repeats while held", () => {
    const actions = makeActions();
    renderHook(() => useGamepad(actions, true, "standard"));
    frame(); // prime with the neutral pad

    setPad(makePad([15])); // D-pad right
    frame(100); // direction starts
    expect(actions.move).not.toHaveBeenCalled();
    frame(60); // past the 40 ms debounce
    expect(actions.move).toHaveBeenCalledTimes(1);
    expect(actions.move).toHaveBeenLastCalledWith(1);

    frame(200); // still inside the initial repeat delay
    expect(actions.move).toHaveBeenCalledTimes(1);
    frame(300); // initial repeat delay passed
    expect(actions.move).toHaveBeenCalledTimes(2);
  });

  it("maps the A button (standard index 0) to confirm once per press", () => {
    const actions = makeActions();
    renderHook(() => useGamepad(actions, true, "standard"));
    frame();
    setPad(makePad([0]));
    frame(100);
    frame(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("maps the B button (standard index 1) to back and Options (index 9) to options", () => {
    const actions = makeActions();
    renderHook(() => useGamepad(actions, true, "standard"));
    frame();
    setPad(makePad([1]));
    frame(100);
    frame(100);
    setPad(makePad());
    frame(100);
    setPad(makePad([9]));
    frame(100);
    frame(100);
    expect(actions.back).toHaveBeenCalledTimes(1);
    expect(actions.options).toHaveBeenCalledTimes(1);
  });

  it("sends nothing after the pad disconnects, and resumes after it reconnects", () => {
    const actions = makeActions();
    renderHook(() => useGamepad(actions, true, "standard"));
    frame();
    setPad(null); // unplugged
    frame(100);
    setPad(makePad([0]));
    frame(100);
    expect(actions.confirm).not.toHaveBeenCalled();

    setPad(makePad());
    frame(100);
    frame(100); // second neutral frame commits the release (40 ms debounce)
    setPad(makePad([0]));
    frame(100);
    frame(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("ignores input while the document is hidden", () => {
    const actions = makeActions();
    renderHook(() => useGamepad(actions, true, "standard"));
    frame();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    setPad(makePad([0]));
    frame(100);
    frame(100);
    expect(actions.confirm).not.toHaveBeenCalled();
  });

  it("ignores input while the suspend predicate is true, for example a foreground app owns the controller", () => {
    const actions = makeActions();
    let suspended = true;
    renderHook(() => useGamepad(actions, true, "standard", () => suspended));
    frame();
    setPad(makePad([0]));
    frame(100);
    frame(100);
    expect(actions.confirm).not.toHaveBeenCalled();

    suspended = false;
    setPad(makePad());
    frame(100);
    setPad(makePad([0]));
    frame(100);
    frame(100);
    expect(actions.confirm).toHaveBeenCalledTimes(1);
  });

  it("does not fire a button that is already held when the hook starts", () => {
    setPad(makePad([0]));
    const actions = makeActions();
    renderHook(() => useGamepad(actions, true, "standard"));
    frame();
    frame(100);
    frame(100);
    expect(actions.confirm).not.toHaveBeenCalled();
  });
});
