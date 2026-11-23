// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GamingHub } from "../components/GamingHub";

const mocks = vi.hoisted(() => ({
  snapshot: null as any,
  steamLibrary: null as any,
  getStatus: vi.fn(async () => mocks.snapshot),
  readSteamLibrary: vi.fn(async () => mocks.steamLibrary),
  getDiagnostics: vi.fn(async () => ({
    windows: true,
    playniteDetected: false,
    gogGalaxyDetected: false,
    gogGalaxyRunningInstances: 0,
    gogGalaxyProcessError: null,
    cyberpunkInstallDetected: false,
    diskSpace: [],
    diskSpaceError: null,
  })),
  launchApp: vi.fn(async (id: string) => ({ id, alreadyRunning: false, focusRestoreSupported: false })),
  launchGame: vi.fn(async (id: string) => ({ id, launched: true })),
  launchSteamGame: vi.fn(async (appid: string) => ({ appid, launched: true })),
  launchPlayniteGame: vi.fn(async (gameId: string) => ({ gameId, launched: true, playniteLaunchId: null })),
  getGameProcessState: vi.fn(async (id: string) => ({
    windows: true, id, tracked: true, running: true, phase: "sessionActive",
    crashed: false, pidReuseDetected: false, error: null, attention: null, processIds: [4242],
  })),
  openPlayniteDownload: vi.fn(async () => {}),
  returnVeloraHome: vi.fn(async () => ({})),
  launchEventCallback: null as null | ((event: any) => void),
  listenForLaunchEvent: vi.fn(async (callback: (event: any) => void) => {
    mocks.launchEventCallback = callback;
    return vi.fn();
  }),
}));

vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null },
  getAppManagerStatus: mocks.getStatus,
  getGamingDiagnostics: mocks.getDiagnostics,
  launchManagedApp: mocks.launchApp,
  launchManagedGame: mocks.launchGame,
  managedAppErrorMessage: (cause: unknown) => cause instanceof Error ? cause.message : "App Manager error",
  listenForLaunchEvent: mocks.listenForLaunchEvent,
}));
vi.mock("../services/steamLibrary", () => ({
  readSteamLibrary: mocks.readSteamLibrary,
  launchSteamGame: mocks.launchSteamGame,
  getGameProcessState: mocks.getGameProcessState,
  steamAppIdFromGameId: (id: string) => {
    if (typeof id !== "string") return null;
    const rest = id.startsWith("steam:") ? id.slice(6) : id;
    return /^[1-9][0-9]{0,9}$/.test(rest) && Number(rest) <= 4294967295 ? rest : null;
  },
  playniteGuidFromGameId: (id: string) => {
    if (typeof id !== "string" || !id.startsWith("playnite:")) return null;
    const guid = id.slice(9);
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(guid) ? guid : null;
  },
}));
vi.mock("../services/playniteLibrary", () => ({
  launchPlayniteGame: mocks.launchPlayniteGame,
}));
vi.mock("../services/sessionOrchestrator", () => ({
  returnVeloraHome: mocks.returnVeloraHome,
}));
vi.mock("../services/playniteSupport", () => ({
  PLAYNITE_DOWNLOAD_URL: "https://playnite.link/download.html",
  openOfficialPlayniteDownload: mocks.openPlayniteDownload,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.launchEventCallback = null; });

const PLAYNITE_GUID = "64f78cd1-0b00-4271-a9e1-89abc55f66cc";

function windowsSnapshot(games: any[] = []) {
  return {
    windows: true,
    foregroundProcess: "nexus-aurea.exe",
    games,
    gamesError: null,
    apps: [
      { id: "steamBigPicture", name: "Steam Big Picture", processName: "steam.exe", installed: true, runningInstances: 0, focusRestoreSupported: false, lastError: null },
      { id: "playniteFullscreen", name: "Playnite Fullscreen", processName: "Playnite.FullscreenApp.exe", installed: true, runningInstances: 0, focusRestoreSupported: false, lastError: null },
    ],
  };
}

const availableSteamLibrary = {
  windows: true,
  source: "registry",
  available: true,
  reason: null,
  games: [{ appid: "440", name: "Team Fortress 2", library: "C:\\Steam" }],
};

describe("Gaming Hub 3.0 — merged Steam/Playnite library", () => {
  it("renders Steam games from the adapter with a Steam launcher badge and dedups against the snapshot", async () => {
    mocks.snapshot = windowsSnapshot([{ id: "steam:730", name: "Counter-Strike 2", launcher: "steam" }]);
    mocks.steamLibrary = availableSteamLibrary;
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    expect(await screen.findByText("Team Fortress 2")).toBeTruthy();
    expect(screen.getByText("Counter-Strike 2")).toBeTruthy();
    const badges = screen.getAllByText("Steam", { selector: ".gaming-launcher-badge" });
    expect(badges).toHaveLength(2);
    expect(badges[0].getAttribute("data-launcher")).toBe("steam");
    expect(screen.getByText("Steam · App ID 440")).toBeTruthy();
  });

  it("renders Playnite games with a Playnite badge and never fabricates covers for Steam", async () => {
    mocks.snapshot = windowsSnapshot([
      { id: "steam:440", name: "Team Fortress 2", launcher: "steam" },
      { id: `playnite:${PLAYNITE_GUID}`, name: "Example Game", launcher: "playnite" },
    ]);
    mocks.steamLibrary = { windows: true, source: "unavailable", available: false, reason: "Brak", games: [] };
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    expect(await screen.findByText("Example Game")).toBeTruthy();
    const playniteBadge = screen.getByText("Playnite", { selector: ".gaming-launcher-badge" });
    expect(playniteBadge.getAttribute("data-launcher")).toBe("playnite");
    expect(document.querySelector(".gaming-game-list img")).toBeNull();
  });

  it("launches a steam:<appid> game through onActivateGaming + launch_steam_game (steam://run)", async () => {
    mocks.snapshot = windowsSnapshot([{ id: "steam:440", name: "Team Fortress 2", launcher: "steam" }]);
    mocks.steamLibrary = availableSteamLibrary;
    const activateGaming = vi.fn(async () => true);
    render(<GamingHub onActivateGaming={activateGaming} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await waitFor(() => expect(activateGaming).toHaveBeenCalledOnce());
    expect(mocks.launchSteamGame).toHaveBeenCalledWith("440");
    expect(mocks.launchGame).not.toHaveBeenCalled();
    expect(await screen.findByText("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam.")).toBeTruthy();
  });

  it("launches a playnite:<guid> game through the playnite:// path", async () => {
    mocks.snapshot = windowsSnapshot([{ id: `playnite:${PLAYNITE_GUID}`, name: "Example Game", launcher: "playnite" }]);
    mocks.steamLibrary = { windows: true, source: "unavailable", available: false, reason: "Brak", games: [] };
    const activateGaming = vi.fn(async () => true);
    render(<GamingHub onActivateGaming={activateGaming} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await waitFor(() => expect(activateGaming).toHaveBeenCalledOnce());
    expect(mocks.launchPlayniteGame).toHaveBeenCalledWith(PLAYNITE_GUID);
    expect(mocks.launchSteamGame).not.toHaveBeenCalled();
    expect(await screen.findByText("Wysłano żądanie uruchomienia Example Game przez Playnite.")).toBeTruthy();
  });

  it("keeps Home stable and shows a truthful alert when the steam:// launch fails", async () => {
    mocks.snapshot = windowsSnapshot([{ id: "steam:440", name: "Team Fortress 2", launcher: "steam" }]);
    mocks.steamLibrary = availableSteamLibrary;
    mocks.launchSteamGame.mockRejectedValueOnce(new Error("Steam odmówił uruchomienia."));
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Steam odmówił uruchomienia.");
    expect(screen.queryByRole("button", { name: "Wróć do Home" })).toBeNull();
    expect(screen.getByRole("button", { name: "Odśwież biblioteki" })).toBeTruthy();
  });

  it("shows a truthful exit notice with Return-to-Home when the game session ends", async () => {
    mocks.snapshot = windowsSnapshot([{ id: "steam:440", name: "Team Fortress 2", launcher: "steam" }]);
    mocks.steamLibrary = availableSteamLibrary;
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await screen.findByText("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam.");
    await waitFor(() => expect(mocks.listenForLaunchEvent).toHaveBeenCalledOnce());

    act(() => {
      mocks.launchEventCallback?.({
        previousPhase: "sessionActive",
        atMs: 10,
        session: {
          id: "game-1", kind: "game", displayName: "Team Fortress 2", appId: "steam:440",
          phase: "ended", error: null, attention: null,
        },
      });
    });

    expect(await screen.findByText(/Team Fortress 2 zakończył grę/)).toBeTruthy();
    const homeButton = screen.getByRole("button", { name: "Wróć do Home" });
    fireEvent.click(homeButton);
    await waitFor(() => expect(mocks.returnVeloraHome).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Wróć do Home" })).toBeNull());
  });

  it("labels an unexpected (crash-like) game exit truthfully and never claims a clean close", async () => {
    mocks.snapshot = windowsSnapshot([{ id: "steam:440", name: "Team Fortress 2", launcher: "steam" }]);
    mocks.steamLibrary = availableSteamLibrary;
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await screen.findByText("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam.");

    act(() => {
      mocks.launchEventCallback?.({
        previousPhase: "sessionActive",
        atMs: 11,
        session: {
          id: "game-1", kind: "game", displayName: "Team Fortress 2", appId: "steam:440",
          phase: "failed", error: "Proces nie wystartował w ciągu 60 sekund.", attention: null,
        },
      });
    });

    expect(await screen.findByText(/zakończyła się nieoczekiwanie/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wróć do Home" })).toBeTruthy();
  });

  it("ignores launch events of other sessions and other kinds", async () => {
    mocks.snapshot = windowsSnapshot([{ id: "steam:440", name: "Team Fortress 2", launcher: "steam" }]);
    mocks.steamLibrary = availableSteamLibrary;
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await screen.findByText("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam.");

    act(() => {
      mocks.launchEventCallback?.({
        previousPhase: "sessionActive", atMs: 1,
        session: { id: "cinema-1", kind: "cinema", displayName: "Netflix", appId: "edge-cinema:netflix", phase: "ended", error: null, attention: null },
      });
      mocks.launchEventCallback?.({
        previousPhase: "sessionActive", atMs: 2,
        session: { id: "game-9", kind: "game", displayName: "Other Game", appId: "steam:730", phase: "ended", error: null, attention: null },
      });
    });

    expect(screen.queryByRole("button", { name: "Wróć do Home" })).toBeNull();
  });

  it("detects exit via the read-only process-table state when no event arrives", async () => {
    mocks.snapshot = windowsSnapshot([{ id: "steam:440", name: "Team Fortress 2", launcher: "steam" }]);
    mocks.steamLibrary = availableSteamLibrary;
    mocks.getGameProcessState.mockResolvedValueOnce({
      windows: true, id: "steam:440", tracked: true, running: false, phase: "ended",
      crashed: false, pidReuseDetected: false, error: null, attention: null, processIds: [],
    });
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await screen.findByText("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam.");
    expect(await screen.findByText(/Gra zakończyła działanie/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wróć do Home" })).toBeTruthy();
  });

  it("keeps legacy numeric Steam ids on the verified launch_managed_game path", async () => {
    mocks.snapshot = windowsSnapshot([{ id: "440", name: "Team Fortress 2", launcher: "Steam" }]);
    mocks.steamLibrary = { windows: true, source: "unavailable", available: false, reason: "Brak", games: [] };
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await waitFor(() => expect(mocks.launchGame).toHaveBeenCalledWith("440"));
    expect(mocks.launchSteamGame).not.toHaveBeenCalled();
  });
});
