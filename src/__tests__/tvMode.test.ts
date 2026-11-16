import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTvMode, getTvModeStatus, unsupportedTvMode } from "../services/tvMode";
const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => mocks);
afterEach(() => { vi.clearAllMocks(); mocks.isTauri.mockReturnValue(true); });
describe("TV mode native boundary", () => {
  it("does not invent displays in browser preview", async () => {
    mocks.isTauri.mockReturnValue(false);
    expect(await getTvModeStatus()).toEqual(unsupportedTvMode);
    await expect(applyTvMode("display", true)).rejects.toThrow("natywnej");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("sends only an opaque selected identity and window mode", async () => {
    mocks.invoke.mockResolvedValueOnce({ supported: true });
    await applyTvMode("a".repeat(64), true);
    expect(mocks.invoke).toHaveBeenCalledWith("set_tv_mode", { displayId: "a".repeat(64), fullscreen: true });
  });
  it("rejects malformed IDs before native invocation", async () => {
    for (const id of ["", "x".repeat(513), "screen\ncmd"]) await expect(applyTvMode(id, true)).rejects.toThrow("Nieprawidłowy");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("supports a windowed escape without selecting a display", async () => {
    await applyTvMode(null, false);
    expect(mocks.invoke).toHaveBeenCalledWith("set_tv_mode", { displayId: null, fullscreen: false });
  });
});
