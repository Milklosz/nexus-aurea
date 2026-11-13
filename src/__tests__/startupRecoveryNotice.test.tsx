// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useStartupRecoveryNotice } from "../hooks/useStartupRecoveryNotice";
import { startupRecoveryNotice } from "../services/sessionRecovery";
import type { SessionRecovery } from "../services/sessionOrchestrator";

const recovery: SessionRecovery = {
  recoveredAtMs: 1_000,
  previousSession: "game",
  previousRevision: 4,
  reason: "unexpectedExit",
  message: "Poprzednie uruchomienie VELORA zakończyło się nieoczekiwanie. Sesja wróciła do ekranu głównego.",
};

describe("startupRecoveryNotice", () => {
  it("returns the recovery message", () => {
    expect(startupRecoveryNotice(recovery)).toBe(recovery.message);
  });

  it("returns null when there is no recovery", () => {
    expect(startupRecoveryNotice(null)).toBeNull();
    expect(startupRecoveryNotice(undefined)).toBeNull();
  });

  it("returns null for a blank message", () => {
    expect(startupRecoveryNotice({ ...recovery, message: "   " })).toBeNull();
  });
});

describe("useStartupRecoveryNotice", () => {
  it("shows the recovery notice once after mount", async () => {
    const notify = vi.fn();
    const readSnapshot = vi.fn(async () => ({ recovery }));
    renderHook(() => useStartupRecoveryNotice(readSnapshot, notify));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(recovery.message);
  });

  it("stays silent when the snapshot has no recovery", async () => {
    const notify = vi.fn();
    const readSnapshot = vi.fn(async () => ({ recovery: null }));
    renderHook(() => useStartupRecoveryNotice(readSnapshot, notify));
    await waitFor(() => expect(readSnapshot).toHaveBeenCalled());
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays silent when the snapshot read fails", async () => {
    const notify = vi.fn();
    const readSnapshot = vi.fn(() => Promise.reject(new Error("no tauri")));
    renderHook(() => useStartupRecoveryNotice(readSnapshot, notify));
    await waitFor(() => expect(readSnapshot).toHaveBeenCalled());
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify when the component unmounts before the read finishes", async () => {
    const notify = vi.fn();
    let resolve!: (value: { recovery: SessionRecovery }) => void;
    const readSnapshot = vi.fn(() => new Promise<{ recovery: SessionRecovery }>((r) => { resolve = r; }));
    const { unmount } = renderHook(() => useStartupRecoveryNotice(readSnapshot, notify));
    unmount();
    resolve({ recovery });
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });
});
