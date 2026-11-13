// @vitest-environment jsdom
import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNavigation } from "../hooks/useNavigation";

describe("useNavigation vertical zone handler", () => {
  it("passes ArrowUp and ArrowDown to the zone handler as -1 and +1", () => {
    const onVerticalZone = vi.fn(() => true);
    renderHook(() => useNavigation(3, () => {}, () => {}, { onVerticalZone }));
    act(() => { fireEvent.keyDown(window, { key: "ArrowUp" }); });
    act(() => { fireEvent.keyDown(window, { key: "ArrowDown" }); });
    expect(onVerticalZone.mock.calls).toEqual([[-1], [1]]);
  });

  it("prevents the default key action when the zone handler moved focus", () => {
    const onVerticalZone = vi.fn(() => true);
    renderHook(() => useNavigation(3, () => {}, () => {}, { onVerticalZone }));
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  });

  it("falls back to the legacy Control Center shortcut when the zone handler declines", () => {
    const quick = document.createElement("button");
    quick.className = "quick-settings-trigger";
    document.body.append(quick);
    const onVerticalZone = vi.fn(() => false);
    const { unmount } = renderHook(() => useNavigation(3, () => {}, () => {}, { onVerticalZone }));
    act(() => { fireEvent.keyDown(window, { key: "ArrowUp" }); });
    expect(onVerticalZone).toHaveBeenCalledWith(-1);
    expect(document.activeElement).toBe(quick);
    unmount();
    quick.remove();
  });

  it("keeps the 2D grid behavior and does not call the zone handler in grid mode", () => {
    const onVerticalZone = vi.fn(() => true);
    renderHook(() => useNavigation(6, () => {}, () => {}, { columns: 3, onVerticalZone }));
    act(() => { fireEvent.keyDown(window, { key: "ArrowDown" }); });
    expect(onVerticalZone).not.toHaveBeenCalled();
  });
});
