import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disabledControlServiceStatus,
  getControlServiceStatus,
  listenForNexusControlReturn,
  listenForControlServiceStatus,
  setControlGameMode,
  startControlService,
  stopControlService,
  type ControlServiceStatus,
} from "../services/controlService";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

afterEach(() => vi.clearAllMocks());
beforeEach(() => mocks.isTauri.mockReturnValue(true));

const activeStatus: ControlServiceStatus = {
  windows: true,
  running: true,
  gameMode: false,
  controllerCount: 1,
  playstationControllerCount: 1,
  foregroundProcess: "steam.exe",
  returnHotkeyRegistered: true,
  lastError: null,
};

describe("Control Service native bridge", () => {
  it("reports the native state and uses explicit activation commands", async () => {
    mocks.invoke.mockResolvedValueOnce(activeStatus);
    await expect(getControlServiceStatus()).resolves.toEqual(activeStatus);
    expect(mocks.invoke).toHaveBeenCalledWith("get_control_service_status");

    mocks.invoke.mockResolvedValueOnce(activeStatus);
    await startControlService();
    expect(mocks.invoke).toHaveBeenLastCalledWith("start_control_service");

    mocks.invoke.mockResolvedValueOnce({ ...activeStatus, gameMode: true, returnHotkeyRegistered: false });
    await setControlGameMode(true);
    expect(mocks.invoke).toHaveBeenLastCalledWith("set_control_game_mode", { enabled: true });

    mocks.invoke.mockResolvedValueOnce({ ...activeStatus, running: false, returnHotkeyRegistered: false });
    await stopControlService();
    expect(mocks.invoke).toHaveBeenLastCalledWith("stop_control_service");
  });

  it("keeps the service disabled in browser preview", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(getControlServiceStatus()).resolves.toEqual(disabledControlServiceStatus);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("forwards native status events to the diagnostics panel", async () => {
    const callback = vi.fn();
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValueOnce(unlisten);
    const stopListening = await listenForControlServiceStatus(callback);
    expect(typeof stopListening).toBe("function");
    expect(mocks.listen.mock.calls[0][0]).toBe("control-service-status");
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: ControlServiceStatus }) => void;
    handler({ payload: activeStatus });
    expect(callback).toHaveBeenCalledWith(activeStatus);
  });

  it("forwards the user-triggered return shortcut to NEXUS", async () => {
    const callback = vi.fn();
    await listenForNexusControlReturn(callback);
    expect(mocks.listen.mock.calls[0][0]).toBe("nexus-control-return");
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => void;
    handler({ payload: null });
    expect(callback).toHaveBeenCalledOnce();
  });
});
