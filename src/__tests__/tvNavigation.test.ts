import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureTvNavigation, getTvNavigationStatus, navigationEvidenceJson, simulateTvNavigationAction, type TvNavigationReceipt } from "../services/tvNavigation";
const mocks = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.tauri, invoke: mocks.invoke }));
beforeEach(() => { mocks.tauri = false; vi.clearAllMocks(); });
describe("TV navigation contract", () => {
  it("never invokes native input from a browser preview", async () => {
    expect((await getTvNavigationStatus()).simulatorAvailable).toBe(false);
    await expect(configureTvNavigation(true, "keyboard")).rejects.toThrow(/diagnostycznej/);
    await expect(simulateTvNavigationAction({ action: "home", sequence: 1, generation: 0, targetSession: null })).rejects.toThrow(/diagnostycznej/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("passes a single normalized flat action and current generation to the native command", async () => {
    mocks.tauri = true;
    const input = { action: "down" as const, sequence: 1, generation: 7, targetSession: "owned" };
    await simulateTvNavigationAction(input);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("simulate_tv_navigation_action", input);
  });
  it("bounds export and strips identifiers, errors and arbitrary text while retaining unverified effects", () => {
    const receipt: TvNavigationReceipt = { action: "playPause", sequence: 1, generation: 7, targetSession: "private-session",
      accepted: true, mode: "keyboard", activeStrategy: "https://private.example", ownership: "verified", effect: "unverified", lastResult: "password=secret" };
    const raw = navigationEvidenceJson(Array.from({ length: 100 }, () => receipt));
    const exported = JSON.parse(raw);
    expect(exported.actions).toHaveLength(64);
    expect(exported.physicalHardwareVerified).toBe(false);
    expect(exported.actions[0].effect).toBe("unverified");
    expect(raw).not.toContain("private-session"); expect(raw).not.toContain("private.example"); expect(raw).not.toContain("secret");
    expect(exported.actions[0].strategy).toBe("redacted");
  });
});
