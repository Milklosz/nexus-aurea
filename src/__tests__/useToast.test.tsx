// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToast } from "../hooks/useToast";

describe("useToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the message after 2.4 s", () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.showToast("Zapisano"));
    expect(result.current.message).toBe("Zapisano");
    act(() => { vi.advanceTimersByTime(2_400); });
    expect(result.current.message).toBe("");
  });

  it("still clears the message after an unrelated re-render", () => {
    const { result, rerender } = renderHook(() => useToast());
    act(() => result.current.showToast("Zapisano"));
    rerender();
    act(() => { vi.advanceTimersByTime(2_400); });
    expect(result.current.message).toBe("");
  });

  it("restarts the timer when a second message arrives", () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.showToast("Pierwsza"));
    act(() => { vi.advanceTimersByTime(2_000); });
    act(() => result.current.showToast("Druga"));
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(result.current.message).toBe("Druga");
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.message).toBe("");
  });

  it("clears the pending timer on unmount", () => {
    const { result, unmount } = renderHook(() => useToast());
    act(() => result.current.showToast("Zapisano"));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
