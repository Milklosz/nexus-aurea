// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_STATUS_POLL_MS, useMusicStatusPolling } from "../hooks/useMusicStatusPolling";
import { getAppleMusicStatus, unavailableAppleMusicStatus } from "../services/musicBridge";

vi.mock("../services/musicBridge", async importOriginal => {
  const original = await importOriginal<typeof import("../services/musicBridge")>();
  return { ...original, getAppleMusicStatus: vi.fn() };
});

const getStatus = vi.mocked(getAppleMusicStatus);

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  getStatus.mockReset();
  getStatus.mockResolvedValue({ ...unavailableAppleMusicStatus, windows: true });
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useMusicStatusPolling", () => {
  it("does nothing while disabled", async () => {
    renderHook(() => useMusicStatusPolling(false, vi.fn()));
    await act(async () => { vi.advanceTimersByTime(MUSIC_STATUS_POLL_MS * 4); });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("polls on mount and on each interval while visible", async () => {
    renderHook(() => useMusicStatusPolling(true, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(getStatus).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(MUSIC_STATUS_POLL_MS * 2); });
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it("skips polling while the document is hidden", async () => {
    renderHook(() => useMusicStatusPolling(true, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    setVisibility("hidden");
    getStatus.mockClear();
    await act(async () => { vi.advanceTimersByTime(MUSIC_STATUS_POLL_MS * 4); });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("refreshes immediately when the window becomes visible again", async () => {
    renderHook(() => useMusicStatusPolling(true, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    setVisibility("hidden");
    getStatus.mockClear();
    setVisibility("visible");
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable status when the bridge call fails", async () => {
    getStatus.mockRejectedValue(new Error("bridge down"));
    const onStatus = vi.fn();
    renderHook(() => useMusicStatusPolling(true, onStatus));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
      windows: true,
      message: "Nie udało się odczytać sesji Windows SMTC.",
    }));
  });
});
