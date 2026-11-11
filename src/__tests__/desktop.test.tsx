// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GamepadDiagnostics } from "../components/GamepadDiagnostics";
import { useNavigation } from "../hooks/useNavigation";
import { useFocusRestoreOnClose } from "../hooks/useFocusRestoreOnClose";
import { useGamepad } from "../hooks/useGamepad";
import { gamepadSnapshot } from "../services/gamepadSnapshot";
import { minimizeWindowToDesktop, windowMode } from "../services/windowMode";
import { readFileSync } from "node:fs";

const native = vi.hoisted(() => ({
  setFullscreen: vi.fn(),
  setDecorations: vi.fn(),
  isFullscreen: vi.fn(),
  minimize: vi.fn(),
  invoke: vi.fn(() => new Promise(() => {})),
  controlStatus: { windows: false, running: false, gameMode: false, controllerCount: 0, playstationControllerCount: 0, foregroundProcess: null, returnHotkeyRegistered: false, lastError: null },
  getControlStatus: vi.fn(() => Promise.resolve(native.controlStatus)),
  startControlService: vi.fn(() => Promise.resolve(native.controlStatus)),
  setControlGameMode: vi.fn(() => Promise.resolve(native.controlStatus)),
  stopControlService: vi.fn(() => Promise.resolve(native.controlStatus)),
}));
const musicStatus = {
  windows: false,
  bridgeAvailable: false,
  appleSessionFound: false,
  title: null,
  artist: null,
  album: null,
  playbackState: null,
  positionSeconds: null,
  durationSeconds: null,
  canTogglePlayPause: false,
  canNext: false,
  canPrevious: false,
  artworkSupported: false,
  audioDeviceName: null,
  bluetoothLatencyMs: null,
  message: "not available",
} as const;
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
vi.mock("../services/controlService", () => ({
  disabledControlServiceStatus: native.controlStatus,
  getControlServiceStatus: native.getControlStatus,
  startControlService: native.startControlService,
  setControlGameMode: native.setControlGameMode,
  stopControlService: native.stopControlService,
  listenForControlServiceStatus: vi.fn(async () => () => {}),
  listenForControlServiceStop: vi.fn(async () => () => {}),
  listenForNexusControlReturn: vi.fn(async () => () => {}),
}));
vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [] },
  getAppManagerStatus: vi.fn(async () => ({ windows: false, foregroundProcess: null, apps: [] })),
  launchManagedApp: vi.fn(async () => ({ id: "chrome", alreadyRunning: false, focusRestoreSupported: false })),
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const pad = { connected: true, index: 0, id: "Wireless Controller", mapping: "standard", buttons: [{ pressed: true, value: 1 }], axes: [-0.75, 0.3] } as unknown as Gamepad;

describe("desktop recovery", () => {
  it("restores native decorations before leaving fullscreen", async () => {
    await windowMode(false);
    expect(native.setDecorations).toHaveBeenCalledWith(true);
    expect(native.setFullscreen).toHaveBeenCalledWith(false);
    expect(native.setDecorations.mock.invocationCallOrder[0]).toBeLessThan(native.setFullscreen.mock.invocationCallOrder[0]);
  });
  it("minimizes VELORA when showing the Windows desktop", async () => {
    await minimizeWindowToDesktop();
    expect(native.minimize).toHaveBeenCalledOnce();
  });
  it("uses one app version and starts fullscreen", () => {
    const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
    const pkg = json("package.json");
    const config = json("src-tauri/tauri.conf.json");
    expect(config.version).toBe("../package.json");
    expect(readFileSync("src-tauri/Cargo.toml", "utf8")).toContain('version = "' + pkg.version + '"');
    expect(config.app.windows[0]).toMatchObject({ fullscreen: true, decorations: false });
  });
});

describe("gamepad without hardware", () => {
  it("handles sparse disconnected devices and preserves analog values", () => {
    expect(gamepadSnapshot([null, { ...pad, connected: false }, pad])).toEqual([
      { index: 0, id: pad.id, mapping: "standard", buttons: [{ pressed: true, value: 1 }], axes: [-0.75, 0.3] },
    ]);
  });
  it("shows disconnected state and live buttons/axes without activating services", () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.setAttribute("open", ""); }) });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
    vi.stubGlobal("navigator", { getGamepads: () => [null, pad] });
    const close = vi.fn();
    render(<GamepadDiagnostics profile="auto" onProfileChange={vi.fn()} cinemaProfile="cinema" onCinemaProfileChange={vi.fn()} onShowDesktop={vi.fn()} musicStatus={musicStatus} musicBackgroundMode={false} onMusicBackgroundModeChange={vi.fn()} onMusicRefresh={vi.fn(async () => {})} onMusicControl={vi.fn(async () => {})} onSystemVolume={vi.fn(async () => {})} onOpenAppleMusic={vi.fn(async () => {})} onClose={close} />);
    expect(screen.getByText(/Połączone: 1/)).toBeTruthy();
    expect(screen.getByText(/B0: 1.00/).getAttribute("data-pressed")).toBe("true");
    expect(screen.getByText(/A0: -0.750/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Zamknij/ }));
    expect(close).toHaveBeenCalledOnce();
  });
  it("reports unsupported API without failing", () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.setAttribute("open", ""); }) });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
    vi.stubGlobal("navigator", {});
    render(<GamepadDiagnostics profile="auto" onProfileChange={vi.fn()} cinemaProfile="cinema" onCinemaProfileChange={vi.fn()} onShowDesktop={vi.fn()} musicStatus={musicStatus} musicBackgroundMode={false} onMusicBackgroundModeChange={vi.fn()} onMusicRefresh={vi.fn(async () => {})} onMusicControl={vi.fn(async () => {})} onSystemVolume={vi.fn(async () => {})} onOpenAppleMusic={vi.fn(async () => {})} onClose={() => {}} />);
    expect(screen.getByText(/Gamepad API niedostępne/)).toBeTruthy();
  });
  it("moves relative to selection and wraps", () => {
    const { result } = renderHook(() => useNavigation(5, vi.fn(), vi.fn()));
    act(() => result.current.focusApp(0));
    const visited = [];
    for (let i = 0; i < 5; i += 1) {
      act(() => result.current.moveApp(1));
      visited.push(result.current.activeIndex);
    }
    expect(visited).toEqual([1, 2, 3, 4, 0]);
    for (let i = 0; i < 5; i += 1) act(() => result.current.moveApp(-1));
    expect(result.current.activeIndex).toBe(0);
  });
  it("traverses every dock item from keyboard input in both directions", () => {
    const { result } = renderHook(() => useNavigation(5, vi.fn(), vi.fn()));
    const visited: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      act(() => fireEvent.keyDown(window, { key: "ArrowRight" }));
      visited.push(result.current.activeIndex);
    }
    expect(visited).toEqual([1, 2, 3, 4, 0]);
    act(() => fireEvent.keyDown(window, { key: "ArrowLeft" }));
    expect(result.current.activeIndex).toBe(4);
  });
  it("restores focus after the modal diagnostics node is removed", async () => {
    function FocusHarness() {
      const [open, setOpen] = useState(false);
      const target = useRef<HTMLButtonElement>(null);
      const restore = useCallback(() => target.current?.focus(), []);
      useFocusRestoreOnClose(open, restore);
      return <>
        <button ref={target}>Selected dock item</button>
        <button onClick={() => setOpen(true)}>Open diagnostics</button>
        {open && <dialog open><button onClick={() => setOpen(false)}>Close diagnostics</button></dialog>}
      </>;
    }
    render(<FocusHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "Close diagnostics" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Selected dock item"));
  });
  it("does not restore home focus while handing off to another modal", () => {
    const restore = vi.fn();
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    function FocusHandoffHarness() {
      const [controlCenterOpen, setControlCenterOpen] = useState(false);
      const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
      useFocusRestoreOnClose(controlCenterOpen, restore, !diagnosticsOpen);
      return <>
        <button onClick={() => setControlCenterOpen(true)}>Open Control Center</button>
        {controlCenterOpen && <button onClick={() => { setControlCenterOpen(false); setDiagnosticsOpen(true); }}>Open diagnostics</button>}
        {diagnosticsOpen && <div role="dialog"><button>Diagnostic action</button></div>}
      </>;
    }
    render(<FocusHandoffHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open Control Center" }));
    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    expect(screen.getByRole("button", { name: "Diagnostic action" })).toBeTruthy();
    expect(restore).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });
  it("does not poll while diagnostics disable navigation", () => {
    const getGamepads = vi.fn(() => [pad]);
    vi.stubGlobal("navigator", { getGamepads });
    renderHook(() => useGamepad({
      move: vi.fn(),
      confirm: vi.fn(),
      back: vi.fn(),
      options: vi.fn(),
    }, false));
    expect(getGamepads).not.toHaveBeenCalled();
  });
  it("pauses and resets controller state while input is suspended", () => {
    let suspended = false;
    let now = 0;
    let currentPad = { ...pad, buttons: [], axes: [0] } as unknown as Gamepad;
    let scheduledFrame: FrameRequestCallback | undefined;
    const getGamepads = vi.fn(() => [currentPad]);
    const actions = { move: vi.fn(), confirm: vi.fn(), back: vi.fn(), options: vi.fn() };
    vi.stubGlobal("navigator", { getGamepads });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const poll = () => {
      const callback = scheduledFrame;
      scheduledFrame = undefined;
      act(() => callback?.(now));
    };

    const { rerender } = renderHook(
      ({ shouldSuspend }) => useGamepad(actions, true, "standard", () => shouldSuspend),
      { initialProps: { shouldSuspend: false } },
    );

    poll();
    currentPad = { ...currentPad, axes: [-0.75] };
    now = 41;
    poll();
    now = 82;
    poll();
    expect(actions.move).toHaveBeenCalledTimes(1);

    suspended = true;
    rerender({ shouldSuspend: suspended });
    now = 500;
    poll();
    expect(getGamepads).toHaveBeenCalledTimes(3);

    suspended = false;
    rerender({ shouldSuspend: suspended });
    now = 1000;
    poll();
    expect(actions.move).toHaveBeenCalledTimes(1);

    currentPad = { ...currentPad, axes: [0] };
    now = 1010;
    poll();
    currentPad = { ...currentPad, axes: [-0.75] };
    now = 1020;
    poll();
    now = 1061;
    poll();
    expect(actions.move).toHaveBeenCalledTimes(2);
  });
});

