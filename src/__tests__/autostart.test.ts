import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

import {
  AUTOSTART_UNAVAILABLE_REASON,
  autostartErrorMessage,
  disabledAutostartStatus,
  getAutostartStatus,
  getStartupMode,
  SAFE_MODE_FLAG,
  setAutostartEnabled,
} from "../services/autostart";

afterEach(() => vi.clearAllMocks());

const nativeStatus = {
  windows: true,
  supported: true,
  enabled: true,
  windowed: false,
  lastError: null,
};

describe("Autostart bridge", () => {
  it("exposes the emergency safe-mode flag", () => {
    expect(SAFE_MODE_FLAG).toBe("--windowed");
  });

  it("reads the status through the get_autostart_status invoke", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue(nativeStatus);
    await expect(getAutostartStatus()).resolves.toEqual(nativeStatus);
    expect(mocks.invoke).toHaveBeenCalledWith("get_autostart_status");
  });

  it("passes enabled and windowed unchanged to set_autostart_enabled", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue(nativeStatus);
    await expect(setAutostartEnabled(true, true)).resolves.toEqual(nativeStatus);
    expect(mocks.invoke).toHaveBeenCalledWith("set_autostart_enabled", {
      enabled: true,
      windowed: true,
    });
    await setAutostartEnabled(false, false);
    expect(mocks.invoke).toHaveBeenLastCalledWith("set_autostart_enabled", {
      enabled: false,
      windowed: false,
    });
  });

  it("reads the startup mode through the get_startup_mode invoke", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ windowed: true, autostartEnabled: false });
    await expect(getStartupMode()).resolves.toEqual({ windowed: true, autostartEnabled: false });
    expect(mocks.invoke).toHaveBeenCalledWith("get_startup_mode");
  });

  it("maps strings, Errors, shaped objects and unknowns to Polish messages", () => {
    expect(autostartErrorMessage("Odmowa dostępu.")).toBe("Odmowa dostępu.");
    expect(autostartErrorMessage(new Error("Brak uprawnień."))).toBe("Brak uprawnień.");
    expect(autostartErrorMessage({ message: "Błąd reg.exe." })).toBe("Błąd reg.exe.");
    expect(autostartErrorMessage({})).toBe("Nie udało się zmienić ustawień autostartu.");
    expect(autostartErrorMessage(null, "Zapasowy komunikat.")).toBe("Zapasowy komunikat.");
  });
});

describe("Autostart web preview (non-Tauri)", () => {
  beforeEach(() => mocks.isTauri.mockReturnValue(false));

  it("returns a disabled, unsupported status with a Polish reason and never invokes", async () => {
    const status = await getAutostartStatus();
    expect(status).toEqual(disabledAutostartStatus);
    expect(status.windows).toBe(false);
    expect(status.supported).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.lastError).toMatch(/Windows/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("returns a safe default startup mode without invoking", async () => {
    await expect(getStartupMode()).resolves.toEqual({ windowed: false, autostartEnabled: false });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("throws a clear Polish error and never touches the system", async () => {
    await expect(setAutostartEnabled(true, false)).rejects.toThrow(AUTOSTART_UNAVAILABLE_REASON);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
