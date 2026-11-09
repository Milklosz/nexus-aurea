// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GamepadDiagnostics } from "../components/GamepadDiagnostics";
import { useNavigation } from "../hooks/useNavigation";
import { useGamepad } from "../hooks/useGamepad";
import { gamepadSnapshot } from "../services/gamepadSnapshot";
import { windowMode } from "../services/windowMode";
import { readFileSync } from "node:fs";

const native = vi.hoisted(() => ({ setFullscreen: vi.fn(), setDecorations: vi.fn(), isFullscreen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const pad = { connected: true, index: 0, id: "Wireless Controller", mapping: "standard", buttons: [{ pressed: true, value: 1 }], axes: [-0.75, 0.3] } as unknown as Gamepad;

describe("desktop recovery", () => {
  it("restores native decorations before leaving fullscreen", async () => {
    await windowMode(false);
    expect(native.setDecorations).toHaveBeenCalledWith(true);
    expect(native.setFullscreen).toHaveBeenCalledWith(false);
    expect(native.setDecorations.mock.invocationCallOrder[0]).toBeLessThan(native.setFullscreen.mock.invocationCallOrder[0]);
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
    render(<GamepadDiagnostics onClose={close} />);
    expect(screen.getByText(/Połączone: 1/)).toBeTruthy();
    expect(screen.getByText(/B0: 1.00/).getAttribute("data-pressed")).toBe("true");
    expect(screen.getByText(/A0: -0.750/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(close).toHaveBeenCalledOnce();
  });
  it("reports unsupported API without failing", () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.setAttribute("open", ""); }) });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
    vi.stubGlobal("navigator", {});
    render(<GamepadDiagnostics onClose={() => {}} />);
    expect(screen.getByText(/Gamepad API niedostępne/)).toBeTruthy();
  });
  it("moves relative to selection and wraps", () => {
    const { result } = renderHook(() => useNavigation(5, vi.fn(), vi.fn()));
    act(() => result.current.focusApp(2));
    act(() => result.current.moveApp(1));
    expect(result.current.activeIndex).toBe(3);
    act(() => result.current.moveApp(2));
    expect(result.current.activeIndex).toBe(0);
  });
  it("does not poll while diagnostics disable navigation", () => {
    const getGamepads = vi.fn(() => [pad]);
    vi.stubGlobal("navigator", { getGamepads });
    renderHook(() => useGamepad(vi.fn(), vi.fn(), vi.fn(), false));
    expect(getGamepads).not.toHaveBeenCalled();
  });
});

