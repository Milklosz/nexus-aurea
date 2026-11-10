// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GamingHub } from "../components/GamingHub";

const mocks = vi.hoisted(() => ({
  snapshot: null as any,
  getStatus: vi.fn(async () => mocks.snapshot),
  launchApp: vi.fn(async (id: string) => ({ id, alreadyRunning: false, focusRestoreSupported: false })),
  launchGame: vi.fn(async (id: string) => ({ id, launched: true })),
}));

vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null },
  getAppManagerStatus: mocks.getStatus,
  launchManagedApp: mocks.launchApp,
  launchManagedGame: mocks.launchGame,
  managedAppErrorMessage: (cause: unknown) => cause instanceof Error ? cause.message : "App Manager error",
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function windowsSnapshot(games = [{ id: "440", name: "Team Fortress 2", launcher: "Steam" }]) {
  return {
    windows: true,
    foregroundProcess: "NEXUS AUREA.exe",
    games,
    gamesError: null,
    apps: [
      { id: "steamBigPicture", name: "Steam Big Picture", processName: "steam.exe", installed: true, runningInstances: 0, focusRestoreSupported: false, lastError: null },
      { id: "playniteFullscreen", name: "Playnite Fullscreen", processName: "Playnite.FullscreenApp.exe", installed: false, runningInstances: 0, focusRestoreSupported: false, lastError: null },
    ],
  };
}

describe("Gaming Hub and App Manager integration", () => {
  it("shows only games returned by the installed Steam library and reports launcher detection", async () => {
    mocks.snapshot = windowsSnapshot();
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    expect(await screen.findByText("Team Fortress 2")).toBeTruthy();
    expect(screen.getByText("Wykryto")).toBeTruthy();
    expect(screen.getByText("Nie wykryto")).toBeTruthy();
    expect(screen.queryByText("Elden Ring")).toBeNull();
  });

  it("selects Gaming and launches a manifest-verified Steam app ID", async () => {
    mocks.snapshot = windowsSnapshot();
    const activateGaming = vi.fn(async () => true);
    render(<GamingHub onActivateGaming={activateGaming} />);
    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    await waitFor(() => expect(activateGaming).toHaveBeenCalledOnce());
    expect(mocks.launchGame).toHaveBeenCalledWith("440");
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("opens detected Playnite only through the existing App Manager allowlist", async () => {
    mocks.snapshot = windowsSnapshot();
    mocks.snapshot.apps[1].installed = true;
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fullscreen" }));
    await waitFor(() => expect(mocks.launchApp).toHaveBeenCalledWith("playniteFullscreen"));
  });

  it("reports missing launchers and an unavailable Steam library without inventing games", async () => {
    mocks.snapshot = {
      ...windowsSnapshot([]),
      gamesError: "Nie można odczytać katalogów bibliotek Steam.",
      apps: windowsSnapshot([]).apps.map((app: any) => ({ ...app, installed: false })),
    };
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    expect(await screen.findAllByText("Nie wykryto")).toHaveLength(2);
    expect(screen.getByRole("alert")).toHaveTextContent("Nie można odczytać katalogów bibliotek Steam.");
    expect(screen.getByText(/Brak listy gier/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Big Picture" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Elden Ring")).toBeNull();
  });

  it("reports a managed launcher failure", async () => {
    mocks.snapshot = windowsSnapshot([]);
    mocks.snapshot.apps[1].installed = true;
    mocks.launchApp.mockRejectedValueOnce(new Error("Playnite odmówił uruchomienia."));
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fullscreen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Playnite odmówił uruchomienia.");
  });

  it("surfaces a Steam launch failure without claiming the game started", async () => {
    mocks.snapshot = windowsSnapshot();
    mocks.launchGame.mockRejectedValueOnce(new Error("Steam odmówił uruchomienia."));
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Steam odmówił uruchomienia.");
  });
});