import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

import {
  adjustSystemVolume,
  controlAppleMusic,
  getAppleMusicStatus,
  readMusicBackgroundMode,
  saveMusicBackgroundMode,
  unavailableAppleMusicStatus,
} from "../services/musicBridge";

afterEach(() => vi.clearAllMocks());

describe("VELORA Music native bridge", () => {
  it("reports browser preview without inventing Apple Music metadata", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(getAppleMusicStatus()).resolves.toEqual(unavailableAppleMusicStatus);
    expect((await getAppleMusicStatus()).title).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("sends Apple-specific transport commands and system volume actions", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue(undefined);
    await controlAppleMusic("toggle");
    await controlAppleMusic("next");
    await controlAppleMusic("previous");
    await adjustSystemVolume("up");
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "control_apple_music", { action: "toggle" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "adjust_system_volume", { action: "up" });
  });

  it("persists Background Mode only when the user enables it", () => {
    const values = new Map<string, string>();
    const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readMusicBackgroundMode(store)).toBe(false);
    saveMusicBackgroundMode(true, store);
    expect(readMusicBackgroundMode(store)).toBe(true);
  });
});
