import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureControllerFallback, configureStreamingControl,
  disabledFallbackHomeStatus, disabledStreamingControlStatus,
  getControllerFallbackStatus, getStreamingControlStatus,
  parseFallbackHomeStatus, parseStreamingControlStatus,
} from "../services/livingRoom";

const native = vi.hoisted(() => ({ enabled: true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled, invoke: native.invoke }));
beforeEach(() => { native.enabled = true; native.invoke.mockReset(); });

describe("session-only living room IPC", () => {
  it("uses exact native command argument names and rejects malformed native responses", async () => {
    native.invoke.mockResolvedValue(disabledStreamingControlStatus);
    await configureStreamingControl(true, false);
    expect(native.invoke).toHaveBeenCalledWith("configure_streaming_control", { enabled: true, pointerMode: false });
    native.invoke.mockResolvedValue({ enabled: true });
    await expect(getStreamingControlStatus()).rejects.toThrow("Nieprawidłowy stan");
  });

  it("sends only the selected fallback gesture and hold duration", async () => {
    native.invoke.mockResolvedValue(disabledFallbackHomeStatus);
    const config = { enabled: true, gesture: "l1R1Options" as const, holdMs: 2000 as const };
    await configureControllerFallback(config);
    expect(native.invoke).toHaveBeenCalledWith("configure_controller_fallback", { config });
  });

  it("keeps browser previews inert without native IPC", async () => {
    native.enabled = false;
    expect(await getControllerFallbackStatus()).toEqual(disabledFallbackHomeStatus);
    expect(await getStreamingControlStatus()).toEqual(disabledStreamingControlStatus);
    await expect(configureStreamingControl(true, true)).rejects.toThrow("natywnej");
    await expect(configureControllerFallback(disabledFallbackHomeStatus)).rejects.toThrow("natywnej");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it.each([-1, Infinity, Number.NaN, "1", null])("refuses corrupt counters (%s)", value => {
    expect(() => parseStreamingControlStatus({ ...disabledStreamingControlStatus, acceptedActions: value })).toThrow();
  });

  it.each([0, 100, 1000, 5000, "2000"])("refuses unsupported fallback duration (%s)", holdMs => {
    expect(() => parseFallbackHomeStatus({ ...disabledFallbackHomeStatus, holdMs })).toThrow();
  });

  it("refuses unsupported gesture IDs and missing validation provenance", () => {
    expect(() => parseFallbackHomeStatus({ ...disabledFallbackHomeStatus, gesture: "cross" })).toThrow();
    expect(() => parseFallbackHomeStatus({ ...disabledFallbackHomeStatus, physicalMappingValidated: undefined })).toThrow();
  });
});
