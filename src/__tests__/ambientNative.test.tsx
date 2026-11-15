// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAmbient } from "../hooks/useAmbient";
import type { Ds4ButtonName, NativeControllerEvent } from "../services/nativeController";

const mocks = vi.hoisted(() => ({
  emit: null as ((event: NativeControllerEvent) => void) | null,
  listen: vi.fn(),
}));

vi.mock("../services/nativeController", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/nativeController")>();
  return {
    ...original,
    listenForNativeController: mocks.listen,
    getNativeControllerStatus: vi.fn(async () => ({ supported: true, running: true, lastError: null, pads: [], ignoredReports: 0 })),
  };
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const press = (buttons: Ds4ButtonName[] = []): NativeControllerEvent => ({
  kind: "state", device: "pad", revision: "v2", transport: "usb",
  dpad: { up: false, down: false, left: false, right: true }, leftX: 0, leftY: 0, buttons,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  // The browser Gamepad API is blind to the pad, as it can be after a report-mode switch.
  vi.stubGlobal("navigator", { getGamepads: () => [] });
  mocks.emit = null;
  mocks.listen.mockReset();
  mocks.listen.mockImplementation(async (callback: (event: NativeControllerEvent) => void) => {
    mocks.emit = callback;
    return () => { mocks.emit = null; };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Ambient and native controller activity", () => {
  it("native input keeps Ambient from starting even when the Gamepad API sees nothing", async () => {
    const { result } = renderHook(() => useAmbient({ enabled: true, idleSeconds: 60 }, false));
    await flush();
    act(() => { mocks.emit?.({ kind: "connected", device: "pad", revision: "v2", transport: "usb" }); });
    for (let second = 0; second < 5; second += 1) {
      act(() => vi.advanceTimersByTime(30000));
      act(() => { mocks.emit?.(press(second % 2 ? ["cross"] : [])); });
      act(() => vi.advanceTimersByTime(250));
    }
    expect(result.current.active).toBe(false);
  });

  it("native input wakes Ambient without leaving the controller suppressed", async () => {
    const { result } = renderHook(() => useAmbient({ enabled: true, idleSeconds: 60 }, false));
    await flush();
    act(() => { mocks.emit?.({ kind: "connected", device: "pad", revision: "v2", transport: "usb" }); });
    act(() => vi.advanceTimersByTime(61000));
    expect(result.current.active).toBe(true);
    act(() => { mocks.emit?.(press()); });
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.active).toBe(false);
    expect(result.current.controllerSuppressed).toBe(false);
  });

  it("without native input Ambient still starts after the delay", async () => {
    const { result } = renderHook(() => useAmbient({ enabled: true, idleSeconds: 60 }, false));
    await flush();
    act(() => vi.advanceTimersByTime(61000));
    expect(result.current.active).toBe(true);
  });

  it("holds no native listener while Ambient is disabled", async () => {
    renderHook(() => useAmbient({ enabled: false, idleSeconds: 60 }, false));
    await flush();
    expect(mocks.listen).not.toHaveBeenCalled();
  });
});
