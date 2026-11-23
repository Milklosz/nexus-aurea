import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("../services/controllerHomePreflight", () => ({
  ensureControllerHomeForExternalLaunch: vi.fn(async () => {}),
}));

import {
  browserGameProcessState,
  browserSteamLibrarySnapshot,
  getGameProcessState,
  launchSteamGame,
  playniteGuidFromGameId,
  readSteamLibrary,
  steamAppIdFromGameId,
  steamGameId,
} from "../services/steamLibrary";

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(true);
});

const AVAILABLE = {
  windows: true,
  source: "registry",
  available: true,
  reason: null,
  games: [
    { appid: "440", name: "Team Fortress 2", library: "C:\\Steam" },
    { appid: "730", name: "Counter-Strike 2", library: "D:\\SteamLibrary" },
  ],
};

describe("Steam library adapter boundary (read-only)", () => {
  it("keeps the browser preview on a safe fallback and never calls invoke", async () => {
    mocks.isTauri.mockReturnValue(false);
    const snapshot = await readSteamLibrary();
    expect(snapshot).toEqual(browserSteamLibrarySnapshot);
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("maps a native snapshot and keeps only valid appid entries", async () => {
    mocks.invoke.mockResolvedValueOnce({
      ...AVAILABLE,
      games: [
        ...AVAILABLE.games,
        { appid: "steam://run/440", name: "Bad", library: "x" },
        { appid: "0", name: "Zero", library: "x" },
        { appid: "440", name: "Duplicate", library: "y" },
        { name: "No appid", library: "x" },
      ],
    });
    const snapshot = await readSteamLibrary();
    expect(mocks.invoke).toHaveBeenCalledWith("get_steam_library");
    expect(snapshot.available).toBe(true);
    expect(snapshot.source).toBe("registry");
    expect(snapshot.games).toEqual(AVAILABLE.games);
  });

  it("maps ANY invoke failure or malformed response to an honest empty snapshot", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("komenda niedostępna"));
    let snapshot = await readSteamLibrary();
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);
    expect(snapshot.reason).toMatch(/Nie udało się odczytać biblioteki Steam/);

    mocks.invoke.mockResolvedValueOnce({ windows: true, source: "weird", available: true, games: [{}] });
    snapshot = await readSteamLibrary();
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);

    mocks.invoke.mockResolvedValueOnce(null);
    snapshot = await readSteamLibrary();
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);
  });

  it("never returns games when the native library is unavailable", async () => {
    mocks.invoke.mockResolvedValueOnce({
      windows: true,
      source: "unavailable",
      available: false,
      reason: "Nie wykryto instalacji Steam.",
      games: [{ appid: "440", name: "Invented", library: "x" }],
    });
    const snapshot = await readSteamLibrary();
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);
    expect(snapshot.reason).toBe("Nie wykryto instalacji Steam.");
  });
});

describe("Steam game launch (steam://run/<appid> only)", () => {
  it("rejects arbitrary identifiers before invoke", async () => {
    for (const bad of ["steam://run/440", "0", "44x", "4294967296", "", "-applaunch"]) {
      await expect(launchSteamGame(bad)).rejects.toThrow("Nieprawidłowy identyfikator gry Steam.");
    }
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("stays unavailable in the browser preview without invoke", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(launchSteamGame("440")).rejects.toThrow("natywnej aplikacji Windows");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invokes launch_steam_game with only the numeric appid and validates the receipt", async () => {
    mocks.invoke.mockResolvedValueOnce({ appid: "440", launched: true });
    await expect(launchSteamGame("440")).resolves.toEqual({ appid: "440", launched: true });
    expect(mocks.invoke).toHaveBeenCalledWith("launch_steam_game", { appid: "440" });

    mocks.invoke.mockResolvedValueOnce({ appid: "440", launched: false });
    await expect(launchSteamGame("440")).rejects.toThrow("Steam nie potwierdził uruchomienia gry.");

    mocks.invoke.mockResolvedValueOnce({ appid: "730", launched: true });
    await expect(launchSteamGame("440")).rejects.toThrow("Steam nie potwierdził uruchomienia gry.");
  });
});

describe("Game process state (read-only observation)", () => {
  it("returns a safe fallback in the browser preview without invoke", async () => {
    mocks.isTauri.mockReturnValue(false);
    const state = await getGameProcessState("steam:440");
    expect(state).toEqual(browserGameProcessState("steam:440"));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("normalizes the native read-only state and drops malformed fields", async () => {
    mocks.invoke.mockResolvedValueOnce({
      windows: true,
      id: "steam:440",
      tracked: true,
      running: true,
      phase: "sessionActive",
      crashed: false,
      pidReuseDetected: false,
      error: null,
      attention: null,
      processIds: [123, 456, -1, "x"],
    });
    const state = await getGameProcessState("steam:440");
    expect(mocks.invoke).toHaveBeenCalledWith("get_game_process_state", { id: "steam:440" });
    expect(state).toMatchObject({ tracked: true, running: true, phase: "sessionActive", crashed: false });
    expect(state.processIds).toEqual([123, 456]);

    mocks.invoke.mockResolvedValueOnce({ tracked: "yes" });
    const fallback = await getGameProcessState("steam:440");
    expect(fallback.tracked).toBe(false);
    expect(fallback.error).toMatch(/Nie udało się odczytać stanu procesu gry/);

    mocks.invoke.mockRejectedValueOnce(new Error("odmowa"));
    const failed = await getGameProcessState("440");
    expect(failed.running).toBe(false);
    expect(failed.error).toMatch(/Nie udało się odczytać stanu procesu gry/);
  });
});

describe("Game id helpers", () => {
  it("round-trips steam:<appid> and rejects other shapes", () => {
    expect(steamGameId("440")).toBe("steam:440");
    expect(steamGameId("bad")).toBeNull();
    expect(steamAppIdFromGameId("steam:440")).toBe("440");
    expect(steamAppIdFromGameId("440")).toBe("440");
    expect(steamAppIdFromGameId("playnite:abc")).toBeNull();
    expect(playniteGuidFromGameId("playnite:64f78cd1-0b00-4271-a9e1-89abc55f66cc")).toBe("64f78cd1-0b00-4271-a9e1-89abc55f66cc");
    expect(playniteGuidFromGameId("playnite:not-a-guid")).toBeNull();
    expect(playniteGuidFromGameId("440")).toBeNull();
  });
});
