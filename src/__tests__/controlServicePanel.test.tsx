// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlServicePanel } from "../components/ControlServicePanel";
import type { ControlServiceStatus } from "../services/controlService";

const mocks = vi.hoisted(() => ({
  status: null as ControlServiceStatus | null,
  getStatus: vi.fn(async () => mocks.status!),
  start: vi.fn(async () => mocks.status!),
  setGameMode: vi.fn(async (_enabled: boolean) => mocks.status!),
  stop: vi.fn(async () => mocks.status!),
  onStatus: null as ((status: ControlServiceStatus) => void) | null,
  onStop: null as ((reason: string) => void) | null,
}));

vi.mock("../services/controlService", () => ({
  disabledControlServiceStatus: {
    windows: false,
    running: false,
    gameMode: false,
    controllerCount: 0,
    playstationControllerCount: 0,
    foregroundProcess: null,
    returnHotkeyRegistered: false,
    lastError: null,
  },
  getControlServiceStatus: mocks.getStatus,
  startControlService: mocks.start,
  setControlGameMode: mocks.setGameMode,
  stopControlService: mocks.stop,
  listenForControlServiceStatus: vi.fn(async (callback: (status: ControlServiceStatus) => void) => {
    mocks.onStatus = callback;
    return () => { mocks.onStatus = null; };
  }),
  listenForControlServiceStop: vi.fn(async (callback: (reason: string) => void) => {
    mocks.onStop = callback;
    return () => { mocks.onStop = null; };
  }),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function status(overrides: Partial<ControlServiceStatus> = {}): ControlServiceStatus {
  return {
    windows: true,
    running: false,
    gameMode: false,
    controllerCount: 1,
    playstationControllerCount: 1,
    foregroundProcess: "NEXUS AUREA.exe",
    returnHotkeyRegistered: false,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.status = status();
  mocks.getStatus.mockImplementation(async () => mocks.status!);
  mocks.start.mockImplementation(async () => {
    mocks.status = status({ running: true, returnHotkeyRegistered: true });
    return mocks.status;
  });
  mocks.setGameMode.mockImplementation(async (enabled: boolean) => {
    mocks.status = status({ running: true, gameMode: enabled, returnHotkeyRegistered: !enabled });
    return mocks.status;
  });
  mocks.stop.mockImplementation(async () => {
    mocks.status = status();
    return mocks.status;
  });
});

describe("Control Service diagnostics", () => {
  it("starts disabled and only arms after an explicit button press", async () => {
    render(<ControlServicePanel />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("wyłączony"));
    expect(mocks.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Włącz monitoring sesji" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Wyłącz usługę" })).toBeTruthy());
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(screen.getByText(/Ctrl\+Alt\+F12/)).toBeTruthy();
  });

  it("unregisters the return shortcut in game mode", async () => {
    mocks.status = status({ running: true, returnHotkeyRegistered: true });
    render(<ControlServicePanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Włącz tryb gry" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Włącz tryb gry" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("tryb gry"));
    expect(mocks.setGameMode).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Wyłącz tryb gry" })).toBeTruthy();
  });

  it("reflects the keyboard emergency stop event", async () => {
    mocks.status = status({ running: true, returnHotkeyRegistered: true });
    render(<ControlServicePanel />);
    await waitFor(() => expect(mocks.onStop).toBeTruthy());
    act(() => mocks.onStop?.("keyboard-emergency"));
    expect(await screen.findByText("Usługa wyłączona skrótem awaryjnym.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Włącz monitoring sesji" })).toBeTruthy();
  });
});
