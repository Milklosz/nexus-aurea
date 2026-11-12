// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

import {
  EDGE_CINEMA_NOTES,
  EDGE_CINEMA_PROFILE_NAME,
  edgeCinemaErrorMessage,
  getEdgeCinemaStatus,
  launchEdgeCinema,
} from "../services/edgeCinema";

afterEach(() => {
  vi.restoreAllMocks();
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockReset();
});

describe("Edge Cinema bridge", () => {
  it("exports the stable dedicated profile name", () => {
    expect(EDGE_CINEMA_PROFILE_NAME).toBe("VELORA-EdgeCinema");
  });

  it("returns the native status shape from get_edge_cinema_status", async () => {
    const status = {
      windows: true,
      edgeDetected: true,
      profileDir: "C:/Users/tester/AppData/Local/VELORA/VELORA-EdgeCinema",
      notes: ["notatka"],
    };
    mocks.invoke.mockResolvedValue(status);

    await expect(getEdgeCinemaStatus()).resolves.toEqual(status);
    expect(mocks.invoke).toHaveBeenCalledWith("get_edge_cinema_status");
  });

  it("launches with the exact verified URL and returns the receipt shape", async () => {
    const receipt = {
      launched: true,
      mode: "app-fullscreen",
      profileDir: "C:/Users/tester/AppData/Local/VELORA/VELORA-EdgeCinema",
    };
    mocks.invoke.mockResolvedValue(receipt);

    await expect(launchEdgeCinema("https://www.netflix.com/pl/")).resolves.toEqual(receipt);
    expect(mocks.invoke).toHaveBeenCalledWith("launch_edge_cinema", { url: "https://www.netflix.com/pl/" });
  });

  it("returns a disabled status with notes in web preview", async () => {
    mocks.isTauri.mockReturnValue(false);

    const status = await getEdgeCinemaStatus();

    expect(status).toMatchObject({ windows: false, edgeDetected: false, profileDir: null });
    expect(status.notes.length).toBeGreaterThan(0);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("throws a clear Polish error in web preview and never opens a window", async () => {
    mocks.isTauri.mockReturnValue(false);
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    await expect(launchEdgeCinema("https://www.youtube.com/")).rejects.toThrow(/natywnej aplikacji Windows/);

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("documents DRM/4K/HDR non-guarantees and login persistence", () => {
    const notes = EDGE_CINEMA_NOTES.join(" ");
    expect(notes).toMatch(/DRM/);
    expect(notes).toMatch(/4K/);
    expect(notes).toMatch(/HDR/);
    expect(notes).toMatch(/logowania/i);
  });

  it("maps native Edge errors to clear Polish guidance and preserves unknowns", () => {
    expect(edgeCinemaErrorMessage(
      "Nie wykryto przeglądarki Microsoft Edge. Zainstaluj Edge, aby uruchomić Edge Cinema.",
    )).toMatch(/Zainstaluj Edge/);
    expect(edgeCinemaErrorMessage("Nie udało się przygotować katalogu profilu Edge Cinema."))
      .toMatch(/profilu/);
    expect(edgeCinemaErrorMessage("Windows nie uruchomił okna Edge Cinema."))
      .toMatch(/Sprawdź instalację Edge/);
    expect(edgeCinemaErrorMessage(new Error("Widevine 4K HDR HDCP problem"))).toMatch(/4K/);
    expect(edgeCinemaErrorMessage(new Error("Adres usługi nie znajduje się na liście zaufanych stron.")))
      .toBe("Adres usługi nie znajduje się na liście zaufanych stron.");
    expect(edgeCinemaErrorMessage({}, "Własny komunikat")).toBe("Własny komunikat");
    expect(edgeCinemaErrorMessage("webview2 failed with code 5")).toBe("Nie udało się uruchomić Edge Cinema. Spróbuj ponownie.");
  });
});
