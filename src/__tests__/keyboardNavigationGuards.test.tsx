// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNavigation } from "../hooks/useNavigation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup() {
  const onActivate = vi.fn();
  const onMenu = vi.fn();
  const hook = renderHook(() => useNavigation(3, onActivate, onMenu));
  return { onActivate, onMenu, hook };
}

describe("keyboard navigation guards", () => {
  it("activates on a plain x press", () => {
    const { onActivate } = setup();
    act(() => { fireEvent.keyDown(window, { key: "x" }); });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("does not activate on Ctrl+X, Alt+X or Meta+X", () => {
    const { onActivate } = setup();
    act(() => {
      fireEvent.keyDown(window, { key: "x", ctrlKey: true });
      fireEvent.keyDown(window, { key: "x", altKey: true });
      fireEvent.keyDown(window, { key: "x", metaKey: true });
    });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("does not re-activate while the x key auto-repeats", () => {
    const { onActivate } = setup();
    act(() => {
      fireEvent.keyDown(window, { key: "x" });
      fireEvent.keyDown(window, { key: "x", repeat: true });
      fireEvent.keyDown(window, { key: "x", repeat: true });
    });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("opens the menu once for F2 and not on auto-repeat", () => {
    const { onMenu } = setup();
    act(() => {
      fireEvent.keyDown(window, { key: "F2" });
      fireEvent.keyDown(window, { key: "F2", repeat: true });
    });
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it("keeps arrow navigation working, including auto-repeat", () => {
    const { hook } = setup();
    act(() => { fireEvent.keyDown(window, { key: "ArrowRight" }); });
    expect(hook.result.current.activeIndex).toBe(1);
    act(() => { fireEvent.keyDown(window, { key: "ArrowRight", repeat: true }); });
    expect(hook.result.current.activeIndex).toBe(2);
  });

  it("leaves Alt+ArrowLeft to the platform and does not move focus", () => {
    const { hook } = setup();
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(hook.result.current.activeIndex).toBe(0);
  });
});
