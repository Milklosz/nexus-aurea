// @vitest-environment jsdom
import { cleanup, renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { returnHomeFocusTarget, useReturnHomeListener } from "../hooks/useReturnHomeFocus";
import type { ReturnHomeEvent } from "../services/sessionOrchestrator";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("returnHomeFocusTarget", () => {
  it("keeps the tile the user launched from", () => {
    expect(returnHomeFocusTarget(3, 5)).toBe(3);
    expect(returnHomeFocusTarget(4, 5)).toBe(4);
  });

  it("falls back to the first tile for out-of-range or invalid selections", () => {
    expect(returnHomeFocusTarget(5, 5)).toBe(0);
    expect(returnHomeFocusTarget(-1, 5)).toBe(0);
    expect(returnHomeFocusTarget(1.5, 5)).toBe(0);
    expect(returnHomeFocusTarget(Number.NaN, 5)).toBe(0);
    expect(returnHomeFocusTarget(0, 0)).toBe(0);
  });
});

function fakeEvent(restored = true): ReturnHomeEvent {
  return { restore: { restored, outcome: restored ? "focused" : "blocked", message: "" } } as unknown as ReturnHomeEvent;
}

describe("useReturnHomeListener", () => {
  it("delivers return-home events to the latest handler", () => {
    let emit: (event: ReturnHomeEvent) => void = () => {};
    const listen = vi.fn((callback: (event: ReturnHomeEvent) => void) => {
      emit = callback;
      return Promise.resolve(() => {});
    });
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useReturnHomeListener(handler, listen), {
      initialProps: { handler: first },
    });
    rerender({ handler: second });
    act(() => { emit(fakeEvent()); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("removes the listener on unmount", async () => {
    const unlisten = vi.fn();
    const listen = vi.fn(() => Promise.resolve(unlisten));
    const { unmount } = renderHook(() => useReturnHomeListener(vi.fn(), listen));
    await act(async () => { await Promise.resolve(); });
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("removes a subscription that resolves after unmount", async () => {
    const unlisten = vi.fn();
    let resolveListen: (stop: () => void) => void = () => {};
    const listen = vi.fn(() => new Promise<() => void>((resolve) => { resolveListen = resolve; }));
    const { unmount } = renderHook(() => useReturnHomeListener(vi.fn(), listen));
    unmount();
    await act(async () => { resolveListen(unlisten); await Promise.resolve(); });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("ignores events that arrive after unmount", async () => {
    let emit: (event: ReturnHomeEvent) => void = () => {};
    const handler = vi.fn();
    const listen = vi.fn((callback: (event: ReturnHomeEvent) => void) => {
      emit = callback;
      return Promise.resolve(() => {});
    });
    const { unmount } = renderHook(() => useReturnHomeListener(handler, listen));
    await act(async () => { await Promise.resolve(); });
    unmount();
    emit(fakeEvent());
    expect(handler).not.toHaveBeenCalled();
  });
});
