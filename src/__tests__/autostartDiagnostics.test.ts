import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

import {
  autostartDiagnosticsSummary,
  autostartRecoveryMessage,
  disabledAutostartDiagnostics,
  disabledAutostartRecovery,
  getAutostartDiagnostics,
  getAutostartRecovery,
  getAutostartStatus,
  getStartupMode,
  setAutostartEnabled,
  type AutostartDiagnostics,
  type AutostartRecoveryReport,
} from "../services/autostart";

beforeEach(() => {
  mocks.isTauri.mockReset();
  mocks.invoke.mockReset();
  mocks.isTauri.mockReturnValue(true);
});

afterEach(() => vi.clearAllMocks());

const validDiagnostics: AutostartDiagnostics = {
  windows: true,
  supported: true,
  healthy: true,
  pathValid: true,
  commandValid: true,
  issues: [],
  lastError: null,
  checkedAt: "1730000000",
};

const validRecovery: AutostartRecoveryReport = {
  windows: true,
  supported: true,
  stale: false,
  recommendedAction: "Wpis autostartu VELORA jest poprawny. Nie są potrzebne żadne działania.",
  issues: [],
  safeMode: false,
};

describe("Autostart diagnostics bridge (read-only)", () => {
  it("invokes exactly get_autostart_diagnostics and returns a valid-shaped object", async () => {
    mocks.invoke.mockResolvedValue(validDiagnostics);
    const result = await getAutostartDiagnostics();
    expect(mocks.invoke).toHaveBeenCalledWith("get_autostart_diagnostics");
    expect(result).toEqual(validDiagnostics);
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("keeps only clean issue codes from a valid native response", async () => {
    mocks.invoke.mockResolvedValue({
      ...validDiagnostics,
      healthy: false,
      issues: ["wrongExecutable", "malformedCommand"],
    });
    const result = await getAutostartDiagnostics();
    expect(result.issues).toEqual(["wrongExecutable", "malformedCommand"]);
    expect(result.healthy).toBe(false);
  });

  it("falls back safely on any malformed native response (never throws)", async () => {
    const malformed: unknown[] = [
      null,
      42,
      "garbage",
      { windows: "yes" },
      { ...validDiagnostics, issues: "nope" },
      { ...validDiagnostics, issues: ["C:\\raw\\path.exe"] },
      { ...validDiagnostics, issues: [123] },
      { ...validDiagnostics, lastError: 7 },
    ];
    for (const value of malformed) {
      mocks.invoke.mockResolvedValueOnce(value);
      const result = await getAutostartDiagnostics();
      expect(result).toEqual(disabledAutostartDiagnostics);
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result.issues.every((item) => typeof item === "string")).toBe(true);
    }
  });

  it("returns disabledAutostartDiagnostics in web preview and never invokes", async () => {
    mocks.isTauri.mockReturnValue(false);
    const result = await getAutostartDiagnostics();
    expect(result).toEqual(disabledAutostartDiagnostics);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("falls back safely when the diagnostics invoke rejects", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("C:\\secret os error 0x5"));
    await expect(getAutostartDiagnostics()).resolves.toEqual(disabledAutostartDiagnostics);
  });

  it("invokes exactly get_autostart_recovery and returns a valid-shaped object", async () => {
    mocks.invoke.mockResolvedValue(validRecovery);
    const result = await getAutostartRecovery();
    expect(mocks.invoke).toHaveBeenCalledWith("get_autostart_recovery");
    expect(result).toEqual(validRecovery);
  });

  it("returns disabledAutostartRecovery in web preview and never invokes", async () => {
    mocks.isTauri.mockReturnValue(false);
    const result = await getAutostartRecovery();
    expect(result).toEqual(disabledAutostartRecovery);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("falls back safely when the recovery invoke rejects", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(getAutostartRecovery()).resolves.toEqual(disabledAutostartRecovery);
  });
});

describe("Autostart user-facing formatters (no raw leaks)", () => {
  it("stale report: message contains refresh guidance and NO raw os error / path / Error:", () => {
    const staleWithLeak: AutostartRecoveryReport = {
      windows: true,
      supported: true,
      stale: true,
      recommendedAction: "C:\\Program Files\\VELORA\\velora.exe os error 0x5 Error: failed",
      issues: ["wrongExecutable"],
      safeMode: false,
    };
    const message = autostartRecoveryMessage(staleWithLeak);
    expect(message).toMatch(/odświeżyć|Wyłącz i włącz/);
    expect(message).not.toMatch(/os error|0x|Error:|\\|\/|C:/i);

    const staleClean: AutostartRecoveryReport = {
      ...staleWithLeak,
      recommendedAction:
        "Wpis autostartu wskazuje na inną wersję VELORA. Wyłącz i włącz autostart ponownie, aby go odświeżyć.",
    };
    expect(autostartRecoveryMessage(staleClean)).toMatch(/odświeżyć/);
    expect(autostartRecoveryMessage(staleClean)).not.toMatch(/os error|0x|Error:/i);
  });

  it("healthy report: clean Polish message", () => {
    const message = autostartRecoveryMessage({ ...validRecovery, stale: false });
    expect(message).toMatch(/poprawny/);
    expect(message).not.toMatch(/os error|0x|Error:/i);
  });

  it("unsupported report: the standard Windows-only reason", () => {
    expect(autostartRecoveryMessage({ ...validRecovery, supported: false })).toMatch(/Windows/);
  });

  it("autostartDiagnosticsSummary: healthy vs N issues", () => {
    expect(autostartDiagnosticsSummary(validDiagnostics)).toBe("Autostart: poprawny");
    const withIssues: AutostartDiagnostics = {
      ...validDiagnostics,
      healthy: false,
      issues: ["wrongExecutable", "malformedCommand"],
    };
    expect(autostartDiagnosticsSummary(withIssues)).toBe("Autostart: wykryto 2 problemów");
  });
});

describe("Autostart bridge COMPAT (unchanged existing invokes)", () => {
  it("keeps get_autostart_status / set_autostart_enabled / get_startup_mode intact", async () => {
    mocks.invoke.mockResolvedValue({
      windows: true,
      supported: true,
      enabled: true,
      windowed: false,
      lastError: null,
    });
    await getAutostartStatus();
    expect(mocks.invoke).toHaveBeenCalledWith("get_autostart_status");

    await setAutostartEnabled(true, true);
    expect(mocks.invoke).toHaveBeenCalledWith("set_autostart_enabled", {
      enabled: true,
      windowed: true,
    });

    mocks.invoke.mockResolvedValue({ windowed: true, autostartEnabled: false });
    await getStartupMode();
    expect(mocks.invoke).toHaveBeenCalledWith("get_startup_mode");
  });
});
