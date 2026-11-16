import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSystemAudio, setSystemAudioMute, setSystemAudioVolume } from "../services/audioControl";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => mocks);

beforeEach(() => { vi.clearAllMocks(); mocks.isTauri.mockReturnValue(true); });

describe("Core Audio controls", () => {
  it("reads current default output without issuing a write", async () => {
    const output = { id: "0123456789abcdef", volumePercent: 45, muted: false };
    mocks.invoke.mockResolvedValueOnce(output);
    await expect(getSystemAudio()).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("get_system_audio");
  });

  it("sends absolute writes with the output identity the user saw", async () => {
    await setSystemAudioVolume(25, "0123456789abcdef");
    expect(mocks.invoke).toHaveBeenCalledWith("set_system_audio_volume", { percent: 25, expectedEndpointId: "0123456789abcdef" });
    await setSystemAudioMute(true, "0123456789abcdef");
    expect(mocks.invoke).toHaveBeenCalledWith("set_system_audio_mute", { muted: true, expectedEndpointId: "0123456789abcdef" });
  });

  it("rejects invalid volume before IPC", async () => {
    for (const percent of [NaN, Infinity, -Infinity, -1, 101]) {
      await expect(setSystemAudioVolume(percent, "0123456789abcdef")).rejects.toThrow("0–100%");
    }
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not simulate hardware success in browser preview", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(getSystemAudio()).rejects.toThrow("Windows");
    await expect(setSystemAudioVolume(25, "0123456789abcdef")).rejects.toThrow("Windows");
    await expect(setSystemAudioMute(false, "0123456789abcdef")).rejects.toThrow("Windows");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("surfaces native stale endpoint and denied writes", async () => {
    mocks.invoke.mockRejectedValueOnce("Wyjście audio zmieniło się.");
    await expect(setSystemAudioVolume(25, "0123456789abcdef")).rejects.toBe("Wyjście audio zmieniło się.");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
