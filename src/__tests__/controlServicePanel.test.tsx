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
    foregroundProcess: "nexus-aurea.exe",
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
    await waitFor(() => expect(screen.getByText(/^Stan:/).textContent).toContain("wyłączony"));
    expect(mocks.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Włącz monitoring sesji" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Wyłącz usługę" })).toBeTruthy());
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(screen.getByText(/Ctrl\+Alt\+F12/)).toBeTruthy();
  });

  it("announces a pending Control Service action and marks controls busy", async () => {
    let resolveStart!: (nextStatus: ControlServiceStatus) => void;
    mocks.start.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    render(<ControlServicePanel />);
    const startButton = await screen.findByRole("button", { name: "Włącz monitoring sesji" });

    fireEvent.click(startButton);

    await waitFor(() => expect(screen.getByText("Aktualizuję Control Service…")).toBeTruthy());
    expect(startButton.getAttribute("aria-busy")).toBe("true");
    expect(startButton.hasAttribute("disabled")).toBe(true);

    resolveStart(status({ running: true, returnHotkeyRegistered: true }));

    await waitFor(() => expect(screen.getByText("Control Service jest aktywny.")).toBeTruthy());
    expect(startButton.getAttribute("aria-busy")).toBe("false");
  });

  it("clears the pending announcement after a Control Service action fails", async () => {
    mocks.start.mockRejectedValueOnce(new Error("Control Service odmówił uruchomienia."));
    render(<ControlServicePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Włącz monitoring sesji" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Control Service odmówił uruchomienia.");
    expect(document.querySelector(".control-service-notice")?.textContent).toBe("");
  });

  it("keeps the emergency stop state when an in-flight action resolves late", async () => {
    let resolveStoppedStart!: (nextStatus: ControlServiceStatus) => void;
    let resolveRestart!: (nextStatus: ControlServiceStatus) => void;
    mocks.start
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStoppedStart = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRestart = resolve; }));
    render(<ControlServicePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Włącz monitoring sesji" }));

    await waitFor(() => expect(screen.getByText("Aktualizuję Control Service…")).toBeTruthy());
    act(() => mocks.onStop?.("keyboard-emergency"));
    expect(await screen.findByText("Usługa wyłączona skrótem awaryjnym.")).toBeTruthy();
    const startButton = await screen.findByRole("button", { name: "Włącz monitoring sesji" });
    expect(startButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(startButton);
    await waitFor(() => expect(screen.getByText("Aktualizuję Control Service…")).toBeTruthy());

    await act(async () => {
      resolveStoppedStart(status({ running: true, returnHotkeyRegistered: true }));
    });

    const restartingButton = screen.getAllByRole("button", { name: "Aktualizuję…" })[0];
    expect(restartingButton.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText(/^Stan:/).textContent).toContain("wyłączony");
    expect(screen.getByText("Aktualizuję Control Service…")).toBeTruthy();

    await act(async () => {
      resolveRestart(status({ running: true, returnHotkeyRegistered: true }));
    });
    expect(await screen.findByText("Control Service jest aktywny.")).toBeTruthy();
  });

  it("does not revive the service from a late initial status read after an emergency stop", async () => {
    let resolveInitialStatus!: (nextStatus: ControlServiceStatus) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveInitialStatus = resolve; }));
    render(<ControlServicePanel />);

    await waitFor(() => {
      expect(mocks.onStatus).toBeTruthy();
      expect(mocks.onStop).toBeTruthy();
    });
    act(() => mocks.onStatus?.(status({ running: true, returnHotkeyRegistered: true })));
    act(() => mocks.onStop?.("keyboard-emergency"));
    expect(await screen.findByText("Usługa wyłączona skrótem awaryjnym.")).toBeTruthy();

    await act(async () => {
      resolveInitialStatus(status({ running: true, returnHotkeyRegistered: true }));
    });

    expect(screen.getByText(/^Stan:/).textContent).toContain("wyłączony");
    expect(screen.getByRole("button", { name: "Włącz monitoring sesji" })).toBeTruthy();
    expect(screen.getByText("Usługa wyłączona skrótem awaryjnym.")).toBeTruthy();
  });

  it("unregisters the return shortcut in game mode", async () => {
    mocks.status = status({ running: true, returnHotkeyRegistered: true });
    render(<ControlServicePanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Włącz tryb gry" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Włącz tryb gry" }));
    await waitFor(() => expect(screen.getByText(/^Stan:/).textContent).toContain("tryb gry"));
    expect(mocks.setGameMode).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Wyłącz tryb gry" })).toBeTruthy();
  });

  it("labels Steam foreground as advisory and does not claim controller ownership", async () => {
    mocks.status = status({ running: true, foregroundProcess: "steam.exe" });
    render(<ControlServicePanel />);
    expect(await screen.findByText("Sygnał aktywnego okna: proces Steam na pierwszym planie")).toBeTruthy();
    expect(screen.getByText(/nie potwierdza, że Steam Input przejął kontroler/)).toBeTruthy();
    expect(screen.getByText(/Globalne mapowanie przycisków.*wyłączone/)).toBeTruthy();
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
