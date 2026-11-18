// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionControllerControls } from "../components/ControlCenter";
import { canRemoteSelect } from "../services/remotePermissions";
import { getDialogNavigationControls } from "../services/dialogNavigation";
import { disabledFallbackHomeStatus, disabledStreamingControlStatus } from "../services/livingRoom";

const service = vi.hoisted(() => ({
  getStreaming: vi.fn(), getFallback: vi.fn(), setStreaming: vi.fn(), setFallback: vi.fn(),
}));
vi.mock("../services/livingRoom", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/livingRoom")>();
  return { ...actual, getStreamingControlStatus: service.getStreaming,
    getControllerFallbackStatus: service.getFallback, configureStreamingControl: service.setStreaming,
    configureControllerFallback: service.setFallback };
});

beforeEach(() => {
  service.getStreaming.mockResolvedValue({ ...disabledStreamingControlStatus, windows: true });
  service.getFallback.mockResolvedValue(disabledFallbackHomeStatus);
  service.setStreaming.mockResolvedValue({ ...disabledStreamingControlStatus, windows: true, enabled: true });
  service.setFallback.mockResolvedValue({ ...disabledFallbackHomeStatus, enabled: true, gesture: "l1R1Options" });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("couch-only session controls", () => {
  it("requires Home before opting into fallback or synthesized streaming navigation", async () => {
    render(<SessionControllerControls homeEnabled={false} nativeRunning />);
    await screen.findByText("Najpierw włącz powrót Home na tę sesję.");
    await waitFor(() => expect((screen.getByRole("button", { name: "Włącz gest zastępczy Home" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Włącz sterowanie streamingiem" }) as HTMLButtonElement).disabled).toBe(true);
    expect(service.setFallback).not.toHaveBeenCalled();
    expect(service.setStreaming).not.toHaveBeenCalled();
  });

  it("makes settings local-only and indicates physically unverified fallback", async () => {
    const { container } = render(<SessionControllerControls homeEnabled nativeRunning />);
    const enable = screen.getByRole("button", { name: "Włącz gest zastępczy Home" }) as HTMLButtonElement;
    await waitFor(() => expect(enable.disabled).toBe(false));
    expect(canRemoteSelect(enable)).toBe(false);
    expect(screen.getByText(/wymaga jeszcze potwierdzenia na fizycznym padzie/)).toBeTruthy();
    fireEvent.click(enable);
    await waitFor(() => expect(service.setFallback).toHaveBeenCalledWith({ enabled: true, gesture: "l1R1Options", holdMs: 2000 }));
    expect(await screen.findByRole("button", { name: "Wyłącz gest zastępczy Home" })).toBeTruthy();
    const diagnostics = screen.getByRole("button", { name: "Wynik sterowania i gestu Home" });
    expect(getDialogNavigationControls(container)).toContain(diagnostics);
    fireEvent.click(diagnostics);
    expect(diagnostics.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/wysłane\/odrzucone akcje/)).toBeTruthy();
  });

  it("blocks duplicate mutation while a native response is pending", async () => {
    let resolve!: (status: typeof disabledStreamingControlStatus) => void;
    service.setStreaming.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<SessionControllerControls homeEnabled nativeRunning />);
    const enable = screen.getByRole("button", { name: "Włącz sterowanie streamingiem" }) as HTMLButtonElement;
    await waitFor(() => expect(enable.disabled).toBe(false));
    fireEvent.click(enable); fireEvent.click(enable);
    expect(service.setStreaming).toHaveBeenCalledTimes(1);
    expect(service.setStreaming).toHaveBeenCalledWith(true, false);
    resolve({ ...disabledStreamingControlStatus, windows: true, enabled: true, pointerMode: true });
    expect(await screen.findByText(/wskaźnik: AKTYWNY/)).toBeTruthy();
  });

  it("keeps disable actions reachable if Home was turned off after streaming was enabled", async () => {
    service.getStreaming.mockResolvedValue({ ...disabledStreamingControlStatus, windows: true, enabled: true });
    render(<SessionControllerControls homeEnabled={false} nativeRunning />);
    const disable = await screen.findByRole("button", { name: "Wyłącz sterowanie streamingiem" }) as HTMLButtonElement;
    await waitFor(() => expect(disable.disabled).toBe(false));
    fireEvent.click(disable);
    await waitFor(() => expect(service.setStreaming).toHaveBeenCalledWith(false, false));
  });

  it("retries after a timeout but does not stack reads while a retry is still pending", async () => {
    vi.useFakeTimers();
    service.getStreaming.mockRejectedValueOnce(new Error("unavailable"));
    let finishFallback!: (status: typeof disabledFallbackHomeStatus) => void;
    service.getFallback.mockImplementationOnce(() => new Promise(resolve => { finishFallback = resolve; }));
    render(<SessionControllerControls homeEnabled nativeRunning />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_001); });
    expect(screen.getByText(/Stan sterowania z kanapy jest niedostępny/)).toBeTruthy();

    // A timed-out read no longer holds the reservation: the retry really re-reads.
    fireEvent.click(screen.getByRole("button", { name: "Odśwież stan sterowania" }));
    expect(service.getStreaming).toHaveBeenCalledTimes(2);
    expect(service.getFallback).toHaveBeenCalledTimes(2);
    // The stale first IPC settling late must not clobber the newer, successful read.
    await act(async () => { finishFallback(disabledFallbackHomeStatus); await Promise.resolve(); });
    expect(screen.queryByText(/Stan sterowania z kanapy jest niedostępny/)).toBeNull();

    // While a retry is pending, further clicks are ignored instead of stacking requests.
    let finishRetryFallback!: (status: typeof disabledFallbackHomeStatus) => void;
    service.getFallback.mockImplementationOnce(() => new Promise(resolve => { finishRetryFallback = resolve; }));
    const refresh = screen.getByRole("button", { name: "Odśwież stan sterowania" });
    fireEvent.click(refresh); fireEvent.click(refresh);
    expect(service.getStreaming).toHaveBeenCalledTimes(3);
    expect(service.getFallback).toHaveBeenCalledTimes(3);
    await act(async () => { finishRetryFallback(disabledFallbackHomeStatus); await Promise.resolve(); });
  });
});
