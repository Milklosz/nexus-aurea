// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGamepad } from "../hooks/useGamepad";
import { useControllerOwnershipSuspension } from "../hooks/useControllerOwnershipSuspension";
import type { ControlServiceStatus } from "../services/controlService";

const mocks = vi.hoisted(() => ({
  status: null as ControlServiceStatus | null,
  getStatus: vi.fn(async () => mocks.status!),
  onStatus: null as ((status: ControlServiceStatus) => void) | null,
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
  getFallbackHotkeyOptions: vi.fn(async () => []),
  setFallbackHotkey: vi.fn(async () => ({} as never)),
  listenForControlServiceStatus: vi.fn(async (callback: (status: ControlServiceStatus) => void) => {
    mocks.onStatus = callback;
    return () => { mocks.onStatus = null; };
  }),
}));

function status(overrides: Partial<ControlServiceStatus> = {}): ControlServiceStatus {
  return {
    windows: true,
    running: true,
    gameMode: false,
    controllerCount: 1,
    playstationControllerCount: 1,
    foregroundProcess: "nexus-aurea.exe",
    returnHotkeyRegistered: true,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.status = status();
  mocks.getStatus.mockImplementation(async () => mocks.status!);
});

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.onStatus = null; });

describe("controller ownership suspension", () => {
  it("suspends until the native service status is known", async () => {
    mocks.status = status();
    mocks.getStatus.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useControllerOwnershipSuspension());
    expect(result.current()).toBe(true);
    await waitFor(() => expect(mocks.onStatus).toBeTruthy());
    act(() => mocks.onStatus?.(status()));
    expect(result.current()).toBe(false);
  });

  it("suspends on an external foreground event and resumes when VELORA returns", async () => {
    mocks.status = status();
    const { result } = renderHook(() => useControllerOwnershipSuspension());
    await waitFor(() => expect(result.current()).toBe(false));

    act(() => mocks.onStatus?.(status({ foregroundProcess: "steam.exe" })));
    expect(result.current()).toBe(true);

    act(() => mocks.onStatus?.(status({ foregroundProcess: "nexus-aurea.exe" })));
    expect(result.current()).toBe(false);
  });

  it("connects the read-only foreground signal to local Gamepad polling", async () => {
    mocks.getStatus.mockImplementation(() => new Promise(() => {}));
    const getGamepads = vi.fn(() => [{
      connected: true,
      index: 0,
      id: "Wireless Controller",
      mapping: "standard",
      buttons: [],
      axes: [0],
    } as unknown as Gamepad]);
    const actions = { move: vi.fn(), confirm: vi.fn(), back: vi.fn(), options: vi.fn() };
    let scheduledFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("navigator", { getGamepads });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const poll = () => {
      const callback = scheduledFrame;
      scheduledFrame = undefined;
      act(() => callback?.(0));
    };

    renderHook(() => {
      const shouldSuspend = useControllerOwnershipSuspension();
      useGamepad(actions, true, "standard", shouldSuspend);
    });
    await waitFor(() => expect(mocks.onStatus).toBeTruthy());

    poll();
    expect(getGamepads).not.toHaveBeenCalled();

    act(() => mocks.onStatus?.(status({ foregroundProcess: "nexus-aurea.exe" })));
    poll();
    expect(getGamepads).toHaveBeenCalledTimes(1);

    act(() => mocks.onStatus?.(status({ foregroundProcess: "steam.exe" })));
    poll();
    expect(getGamepads).toHaveBeenCalledTimes(1);
  });
});
