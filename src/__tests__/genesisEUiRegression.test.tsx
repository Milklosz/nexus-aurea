// @vitest-environment jsdom
/**
 * Workstream S3.5 (Agent E, genesis) — UI REGRESSION SMOKE.
 *
 * Renders the four key panels (ControlCenter, LivingRoomHome, GamingHub,
 * PlayniteLibrary) with @testing-library/react in jsdom and asserts the key
 * landmarks/labels render — structure smoke only, no behavior changes. All
 * native-backed services are mocked exactly like the existing per-component
 * test files do; browser-preview fallbacks are exercised where applicable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { ControlCenter } from "../components/ControlCenter";
import { LivingRoomHome } from "../components/living-room/LivingRoomHome";
import { GamingHub } from "../components/GamingHub";
import { PlayniteLibrary } from "../components/PlayniteLibrary";
import { streamingServices } from "../data/streamingServices";

const mocks = vi.hoisted(() => ({
  controlStatus: { windows: true, running: false, gameMode: false, controllerCount: 0, playstationControllerCount: 0, foregroundProcess: null, returnHotkeyRegistered: false, lastError: null },
  getControlStatus: vi.fn(async () => mocks.controlStatus),
  listenControlStatus: vi.fn(async () => () => {}),
  remoteStatus: { enabled: false, secureOriginAvailable: false, pairingAvailable: false, pairedDeviceCount: 0, pairedDevices: [], origin: null, caFingerprint: null, trustProfilePath: null, pairingCode: null, pairingExpiresInSeconds: 0 },
  getRemoteStatus: vi.fn(async () => mocks.remoteStatus),
  listenRemoteStatus: vi.fn(async () => () => {}),
  appManagerSnapshot: { windows: true, foregroundProcess: "nexus-aurea.exe", apps: [] as unknown[], games: [] as unknown[], gamesError: null as string | null },
  getAppManagerStatus: vi.fn(async () => mocks.appManagerSnapshot),
  getGamingDiagnostics: vi.fn(async () => ({
    windows: true, playniteDetected: true, gogGalaxyDetected: false, gogGalaxyRunningInstances: 0,
    gogGalaxyProcessError: null, cyberpunkInstallDetected: false,
    diskSpace: [{ drive: "C:", availableBytes: 50 * 1024 ** 3, totalBytes: 512 * 1024 ** 3, error: null }],
    diskSpaceError: null,
  })),
  launchApp: vi.fn(async (id: string) => ({ id, alreadyRunning: false, focusRestoreSupported: false })),
  launchGame: vi.fn(async (id: string) => ({ id, launched: true })),
  playniteSnapshot: null as unknown,
  readLibrary: vi.fn(async () => mocks.playniteSnapshot),
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));

vi.mock("../services/controlService", () => ({
  disabledControlServiceStatus: { ...mocks.controlStatus, windows: false },
  getControlServiceStatus: mocks.getControlStatus,
  listenForControlServiceStatus: mocks.listenControlStatus,
  getFallbackHotkeyOptions: vi.fn(async () => []),
  setFallbackHotkey: vi.fn(async () => ({})),
}));

vi.mock("../services/remoteAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remoteAccess")>();
  return {
    ...actual,
    disabledRemoteAccessStatus: mocks.remoteStatus,
    getRemoteAccessStatus: mocks.getRemoteStatus,
    listenForRemoteAccessStatus: mocks.listenRemoteStatus,
    prepareRemoteTrustProfile: vi.fn(async () => mocks.remoteStatus),
    startRemoteAccess: vi.fn(async () => mocks.remoteStatus),
    beginRemotePairing: vi.fn(async () => mocks.remoteStatus),
    stopRemoteAccess: vi.fn(async () => mocks.remoteStatus),
    revokeAllRemoteDevices: vi.fn(async () => mocks.remoteStatus),
    revokeRemoteDevice: vi.fn(async () => mocks.remoteStatus),
    inspectRemoteRecovery: vi.fn(async () => ({ storeState: "healthy", message: null, recoveryRequired: false, options: [], confirmation: "", confirmationExpiresInSeconds: 0 })),
    runRemoteRecovery: vi.fn(async () => mocks.remoteStatus),
  };
});

vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null },
  getAppManagerStatus: mocks.getAppManagerStatus,
  getGamingDiagnostics: mocks.getGamingDiagnostics,
  launchManagedApp: mocks.launchApp,
  launchManagedGame: mocks.launchGame,
  managedAppErrorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : "App Manager error"),
}));

vi.mock("../services/playniteSupport", () => ({
  PLAYNITE_DOWNLOAD_URL: "https://playnite.link/download.html",
  openOfficialPlayniteDownload: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

vi.mock("../services/playniteLibrary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/playniteLibrary")>();
  return {
    ...actual,
    readPlayniteLibrary: mocks.readLibrary,
    readFavorites: vi.fn(() => [] as string[]),
    toggleFavorite: vi.fn((_id: string) => [] as string[]),
    readRecentlyPlayed: vi.fn(() => [] as string[]),
    noteRecentlyPlayed: vi.fn((_id: string) => [] as string[]),
    launchPlayniteGame: vi.fn(async (gameId: string) => ({ gameId, launched: true, playniteLaunchId: null })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.controlStatus = { ...mocks.controlStatus, windows: true };
  mocks.appManagerSnapshot = {
    windows: true,
    foregroundProcess: "nexus-aurea.exe",
    apps: [
      { id: "steamBigPicture", name: "Steam Big Picture", processName: "steam.exe", installed: true, runningInstances: 0, focusRestoreSupported: false, lastError: null },
      { id: "playniteFullscreen", name: "Playnite Fullscreen", processName: "Playnite.FullscreenApp.exe", installed: true, runningInstances: 0, focusRestoreSupported: false, lastError: null },
    ],
    games: [{ id: "440", name: "Team Fortress 2", launcher: "Steam" }],
    gamesError: null,
  };
  mocks.playniteSnapshot = {
    source: "playnite-api",
    available: true,
    reason: null,
    games: [
      { id: "g1", name: "Cyberpunk 2077", cover: null, source: "Playnite", lastPlayed: null },
      { id: "g2", name: "Hollow Knight", cover: null, source: "Playnite", lastPlayed: "2026-05-01T12:00:00Z" },
    ],
    readOnly: true,
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setupDialog() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
}

describe("genesis E: UI regression — ControlCenter landmarks", () => {
  it("renders the dialog, title, tablist and key cards with accessible names", async () => {
    setupDialog();
    render(<ControlCenter
      profile="cinema"
      onProfileChange={vi.fn(async () => true)}
      onShowDesktop={vi.fn()}
      onSystemVolume={vi.fn(async () => {})}
      ambientSettings={{ enabled: false, idleSeconds: 300 }}
      onAmbientSettingsChange={vi.fn()}
      mediaPlaying={false}
      onOpenDiagnostics={vi.fn()}
      onReturnToNexus={vi.fn()}
      onClose={vi.fn()}
    />);
    const dialog = screen.getByRole("dialog", { name: "Control Center" });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zamknij Control Center" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Sekcje Control Center" })).toBeTruthy();
    for (const tab of ["Cinema", "Gaming", "iPhone Remote", "Sesje"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeTruthy();
    }
    // Key cards render with their accessible names.
    expect(screen.getByRole("region", { name: "Profil kina" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Dźwięk systemu" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Stan systemu" })).toBeTruthy();
    // Windows backend available → volume controls are real buttons.
    await waitFor(() => expect(screen.getByRole("button", { name: "Głośność +" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Głośność −" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Backend Windows: dostępny/)).toBeTruthy());
  });

  it("uses the living-room Ustawienia variant without breaking landmarks", async () => {
    setupDialog();
    render(<ControlCenter
      profile="cinema"
      onProfileChange={vi.fn(async () => true)}
      onShowDesktop={vi.fn()}
      onSystemVolume={vi.fn(async () => {})}
      ambientSettings={{ enabled: false, idleSeconds: 300 }}
      onAmbientSettingsChange={vi.fn()}
      mediaPlaying={false}
      onOpenDiagnostics={vi.fn()}
      onReturnToNexus={vi.fn()}
      onClose={vi.fn()}
      livingRoom
    />);
    expect(screen.getByRole("dialog", { name: "Ustawienia" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zamknij ustawienia" })).toBeTruthy();
  });
});

describe("genesis E: UI regression — LivingRoomHome landmarks", () => {
  function renderHome(activeIndex = 0) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    return render(<LivingRoomHome
      services={streamingServices}
      activeIndex={activeIndex}
      launchingIds={new Set<string>()}
      buttonRefs={{ current: [] } as RefObject<Array<HTMLButtonElement | null>>}
      weather={{ temperatureText: "2°", condition: "Częściowe zachmurzenie", title: "Bieżąca pogoda dla Zabrza.", stale: false }}
      onFocus={vi.fn()}
      onActivate={vi.fn()}
      onUnavailable={vi.fn()}
      onSearch={vi.fn()}
      onRemote={vi.fn()}
      onSettings={vi.fn()}
    />);
  }

  it("renders the hero heading, the eight dock tiles and the top-bar actions", async () => {
    renderHome(4); // YouTube
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("YouTube");
    const dockNames = screen.getAllByRole("button")
      .filter((button) => button.hasAttribute("data-aurea-item"))
      .map((button) => button.getAttribute("aria-label"));
    expect(dockNames).toEqual([
      "Otwórz Netflix", "Otwórz Disney+", "Otwórz HBO Max", "Otwórz Prime Video",
      "Otwórz YouTube", "Otwórz Steam", "Otwórz Playnite", "Otwórz Apple Music",
    ]);
    expect(screen.getByRole("button", { name: "Szukaj aplikacji" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pilot iPhone" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Otwórz ustawienia" })).toBeTruthy();
  });
});

describe("genesis E: UI regression — GamingHub landmarks", () => {
  it("renders the hub region, the Steam game row and the launch control", async () => {
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    expect(await screen.findByRole("region", { name: "VELORA Gaming Hub" })).toBeTruthy();
    expect(await screen.findByText("Team Fortress 2")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Kolekcja gier" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Uruchom" })).toBeTruthy();
    // Launching through the hub calls the native-backed launcher mock.
    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await waitFor(() => expect(mocks.launchGame).toHaveBeenCalledWith("440"));
  });
});

describe("genesis E: UI regression — PlayniteLibrary landmarks", () => {
  it("renders the library region, live status, local sections and game tiles", async () => {
    render(<PlayniteLibrary />);
    expect(await screen.findByRole("region", { name: "Biblioteka Playnite" })).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("heading", { name: "Ulubione" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ostatnio grane" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Cyberpunk 2077" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hollow Knight" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Siatka okładek gier" })).toBeTruthy();
    // Data is read-only by contract.
    expect(screen.getByText(/Dane gier są tylko do odczytu/)).toBeTruthy();
  });

  it("renders the truthful unavailable state in browser preview without inventing a library", async () => {
    mocks.playniteSnapshot = {
      source: "unavailable",
      available: false,
      reason: "Brak bezpiecznego, udokumentowanego API Playnite.",
      games: [],
      readOnly: true,
    };
    render(<PlayniteLibrary />);
    expect(await screen.findByRole("region", { name: "Biblioteka Playnite" })).toBeTruthy();
    expect(await screen.findByText(/Brak bezpiecznego, udokumentowanego API Playnite/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Siatka okładek gier" })).toBeNull();
  });
});
