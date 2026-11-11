// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

import { openOfficialPlayniteDownload, PLAYNITE_DOWNLOAD_URL } from "../services/playniteSupport";

afterEach(() => vi.clearAllMocks());

describe("official Playnite download link", () => {
  it("opens only the official Playnite download page in the native app", async () => {
    await openOfficialPlayniteDownload();

    expect(mocks.openUrl).toHaveBeenCalledOnce();
    expect(mocks.openUrl).toHaveBeenCalledWith("https://playnite.link/download.html");
    expect(PLAYNITE_DOWNLOAD_URL).toBe("https://playnite.link/download.html");
  });

  it("uses a new isolated browser tab in web preview", async () => {
    mocks.isTauri.mockReturnValue(false);
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await openOfficialPlayniteDownload();

    expect(open).toHaveBeenCalledWith(PLAYNITE_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
    expect(mocks.openUrl).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
