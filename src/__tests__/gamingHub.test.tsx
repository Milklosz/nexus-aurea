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
    foregroundProcess: "nexus-aurea.exe",
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

  it("announces a pending game launch and marks its button busy", async () => {
    mocks.snapshot = windowsSnapshot();
    let resolveLaunch!: (receipt: { id: string; launched: boolean }) => void;
    mocks.launchGame.mockImplementationOnce(() => new Promise((resolve) => { resolveLaunch = resolve; }));
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    const button = await screen.findByRole("button", { name: "Uruchom" });

    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Uruchamiam Team Fortress 2 przez Steam"));
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);

    resolveLaunch({ id: "440", launched: true });

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam."));
    expect(button.getAttribute("aria-busy")).toBe("false");
  });

  it("opens detected Playnite only through the existing App Manager allowlist", async () => {
    mocks.snapshot = windowsSnapshot();
    mocks.snapshot.apps[1].installed = true;
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fullscreen" }));
    await waitFor(() => expect(mocks.launchApp).toHaveBeenCalledWith("playniteFullscreen"));
  });

  it("keeps a successful launcher result visible if its follow-up refresh fails", async () => {
    mocks.snapshot = windowsSnapshot([]);
    mocks.snapshot.apps[1].installed = true;
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    const launchButton = await screen.findByRole("button", { name: "Fullscreen" });

    mocks.getStatus.mockRejectedValueOnce(new Error("Nie udało się odświeżyć bibliotek."));
    fireEvent.click(launchButton);

    expect((await screen.findByRole("alert")).textContent).toContain("Nie udało się odświeżyć bibliotek.");
    expect(await screen.findByText("Wysłano żądanie uruchomienia Playnite Fullscreen.")).toBeTruthy();
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it("clears the previous launch notice when a manual library refresh fails", async () => {
    mocks.snapshot = windowsSnapshot();
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    expect(await screen.findByText("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam.")).toBeTruthy();

    mocks.getStatus.mockRejectedValueOnce(new Error("Nie można odświeżyć bibliotek."));
    fireEvent.click(screen.getByRole("button", { name: "Odśwież biblioteki" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Nie można odświeżyć bibliotek.");
    expect(screen.queryByText("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam.")).toBeNull();
  });

  it("keeps the App Manager retry control focused while a status read is pending", async () => {
    mocks.snapshot = { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null };
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    const retryButton = await screen.findByRole("button", { name: "Spróbuj ponownie" });

    retryButton.focus();
    expect(document.activeElement).toBe(retryButton);

    let resolveStatus!: (snapshot: any) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    fireEvent.click(retryButton);

    const pendingButton = await screen.findByRole("button", { name: "Odczytuję…" });
    expect(pendingButton).toBe(retryButton);
    expect(document.activeElement).toBe(retryButton);
    expect(retryButton.getAttribute("aria-busy")).toBe("true");

    resolveStatus({ windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null });

    const restoredButton = await screen.findByRole("button", { name: "Spróbuj ponownie" });
    expect(restoredButton).toBe(retryButton);
    expect(document.activeElement).toBe(retryButton);
    expect(retryButton.getAttribute("aria-busy")).toBe("false");
  });

  it("reports missing launchers and an unavailable Steam library without inventing games", async () => {
    mocks.snapshot = {
      ...windowsSnapshot([]),
      gamesError: "Nie można odczytać katalogów bibliotek Steam.",
      apps: windowsSnapshot([]).apps.map((app: any) => ({ ...app, installed: false })),
    };
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    expect(await screen.findAllByText("Nie wykryto")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toContain("Nie można odczytać katalogów bibliotek Steam.");
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
    expect((await screen.findByRole("alert")).textContent).toContain("Playnite odmówił uruchomienia.");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("surfaces a Steam launch failure without claiming the game started", async () => {
    mocks.snapshot = windowsSnapshot();
    mocks.launchGame.mockRejectedValueOnce(new Error("Steam odmówił uruchomienia."));
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Steam odmówił uruchomienia.");
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
