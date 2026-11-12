// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAmbient } from "../hooks/useAmbient";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function prepareBrowser() {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("navigator", { getGamepads: () => [] });
}

describe("VELORA Ambient activity and wake", () => {
  it("enters after the configured delay and wakes on keyboard input", () => {
    vi.useFakeTimers();
    prepareBrowser();
    const { result } = renderHook(() => useAmbient({ enabled: true, idleSeconds: 60 }, false));
    act(() => vi.advanceTimersByTime(59999));
    expect(result.current.active).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.active).toBe(true);
    act(() => fireEvent.keyDown(window, { key: "Enter" }));
    expect(result.current.active).toBe(false);
  });

  it("wakes on mouse movement and suppresses the input that dismisses Ambient", () => {
    vi.useFakeTimers();
    prepareBrowser();
    const { result } = renderHook(() => useAmbient({ enabled: true, idleSeconds: 60 }, false));
    act(() => vi.advanceTimersByTime(60000));
    expect(result.current.active).toBe(true);
    const event = new MouseEvent("pointermove", { bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(event));
    expect(result.current.active).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it("wakes on controller input and waits for release before resuming navigation", () => {
    vi.useFakeTimers();
    let pressed = false;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.stubGlobal("navigator", {
      getGamepads: () => pressed
        ? [{ connected: true, index: 0, id: "Pad", buttons: [{ pressed: true, value: 1 }], axes: [] }]
        : [],
    });
    const { result } = renderHook(() => useAmbient({ enabled: true, idleSeconds: 60 }, false));
    act(() => vi.advanceTimersByTime(60000));
    expect(result.current.active).toBe(true);
    pressed = true;
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.active).toBe(false);
    expect(result.current.controllerSuppressed).toBe(true);
    pressed = false;
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.controllerSuppressed).toBe(false);
  });

  it("does not activate while a known SMTC media session is playing", () => {
    vi.useFakeTimers();
    prepareBrowser();
    const { result } = renderHook(() => useAmbient({ enabled: true, idleSeconds: 60 }, true));
    act(() => vi.advanceTimersByTime(61000));
    expect(result.current.active).toBe(false);
  });

  it("uses keyboard and pointer wake when the Gamepad API is unavailable", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useAmbient({ enabled: true, idleSeconds: 60 }, false));
    act(() => vi.advanceTimersByTime(60000));
    expect(result.current.active).toBe(true);
    act(() => fireEvent.keyDown(window, { key: " " }));
    expect(result.current.active).toBe(false);
  });
});