// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GamingHub } from "../components/GamingHub";

const mocks = vi.hoisted(() => ({
  snapshot: null as any,
  getStatus: vi.fn(async () => mocks.snapshot),
  launchApp: vi.fn(async (id: string) => ({ id, alreadyRunning: false, focusRestoreSupported: false })),
  launchGame: vi.fn(async (id: string) => ({ id, launched: true })),
  openPlayniteDownload: vi.fn(async () => {}),
}));

vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null },
  getAppManagerStatus: mocks.getStatus,
  launchManagedApp: mocks.launchApp,
  launchManagedGame: mocks.launchGame,
  managedAppErrorMessage: (cause: unknown) => cause instanceof Error ? cause.message : "App Manager error",
}));
vi.mock("../services/playniteSupport", () => ({
  PLAYNITE_DOWNLOAD_URL: "https://playnite.link/download.html",
  openOfficialPlayniteDownload: mocks.openPlayniteDownload,
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

  it("routes an already-running Playnite instance to Fullscreen", async () => {
    mocks.snapshot = windowsSnapshot([]);
    mocks.snapshot.apps[1].installed = true;
    mocks.snapshot.apps[1].runningInstances = 1;
    mocks.launchApp.mockResolvedValueOnce({ id: "playniteFullscreen", alreadyRunning: true, focusRestoreSupported: true });
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Fullscreen" }));

    expect(await screen.findByText("Wysłano do działającego Playnite żądanie przejścia do trybu Fullscreen.")).toBeTruthy();
    expect(mocks.launchApp).toHaveBeenCalledWith("playniteFullscreen");
  });

  it("offers the official Playnite download and explains the GOG handoff without inventing game status", async () => {
    mocks.snapshot = windowsSnapshot([]);
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    expect(await screen.findByText(/Playnite nie jest wykryty/)).toBeTruthy();
    expect(screen.getAllByText(/Cyberpunk 2077/).length).toBeGreaterThan(0);
    expect(screen.getByText(/VELORA nie zgaduje, czy Cyberpunk 2077/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Graj" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Oficjalna strona Playnite" }));
    await waitFor(() => expect(mocks.openPlayniteDownload).toHaveBeenCalledOnce());
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

  it("keeps retry focus when App Manager recovery restores the Windows library panel", async () => {
    mocks.snapshot = { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null };
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    const retryButton = await screen.findByRole("button", { name: "Spróbuj ponownie" });
    retryButton.focus();

    let resolveStatus!: (snapshot: any) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    fireEvent.click(retryButton);
    expect(await screen.findByRole("button", { name: "Odczytuję…" })).toBe(retryButton);
    expect(document.activeElement).toBe(retryButton);

    resolveStatus(windowsSnapshot([{ id: "730", name: "Counter-Strike 2", launcher: "Steam" }]));

    const restoredButton = await screen.findByRole("button", { name: "Odśwież biblioteki" });
    expect(await screen.findByText("Counter-Strike 2")).toBeTruthy();
    expect(restoredButton).toBe(retryButton);
    expect(document.activeElement).toBe(retryButton);
    expect(retryButton.getAttribute("aria-busy")).toBe("false");
  });

  it("ignores repeated fallback retry activations while a status read is pending", async () => {
    mocks.snapshot = { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null };
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    const retryButton = await screen.findByRole("button", { name: "Spróbuj ponownie" });
    retryButton.focus();
    expect(document.activeElement).toBe(retryButton);
    const callsAfterInitialRead = mocks.getStatus.mock.calls.length;

    let resolveStatus!: (snapshot: any) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });

    const pendingButton = await screen.findByRole("button", { name: "Odczytuję…" });
    expect(pendingButton).toBe(retryButton);
    expect(mocks.getStatus).toHaveBeenCalledTimes(callsAfterInitialRead + 1);
    expect(document.activeElement).toBe(retryButton);
    expect(retryButton.getAttribute("aria-busy")).toBe("true");

    resolveStatus({ windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null });

    const restoredButton = await screen.findByRole("button", { name: "Spróbuj ponownie" });
    expect(restoredButton).toBe(retryButton);
    expect(document.activeElement).toBe(retryButton);
    expect(retryButton.getAttribute("aria-busy")).toBe("false");
    expect(mocks.getStatus).toHaveBeenCalledTimes(callsAfterInitialRead + 1);
  });

  it("keeps the Windows library refresh control focused while status is pending", async () => {
    mocks.snapshot = windowsSnapshot();
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    const refreshButton = await screen.findByRole("button", { name: "Odśwież biblioteki" });

    refreshButton.focus();
    expect(document.activeElement).toBe(refreshButton);

    let resolveStatus!: (snapshot: any) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    fireEvent.click(refreshButton);

    const pendingButton = await screen.findByRole("button", { name: "Odświeżanie…" });
    expect(pendingButton).toBe(refreshButton);
    expect(document.activeElement).toBe(refreshButton);
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("Odświeżam biblioteki gier");

    resolveStatus(windowsSnapshot([{ id: "730", name: "Counter-Strike 2", launcher: "Steam" }]));

    const restoredButton = await screen.findByRole("button", { name: "Odśwież biblioteki" });
    expect(await screen.findByText("Counter-Strike 2")).toBeTruthy();
    expect(restoredButton).toBe(refreshButton);
    expect(document.activeElement).toBe(refreshButton);
    expect(refreshButton.getAttribute("aria-busy")).toBe("false");
  });

  it("keeps the retry control focused when a Windows status refresh fails", async () => {
    mocks.snapshot = windowsSnapshot();
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    const refreshButton = await screen.findByRole("button", { name: "Odśwież biblioteki" });

    refreshButton.focus();
    let rejectStatus!: (cause: Error) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStatus = reject; }));
    fireEvent.click(refreshButton);

    expect(await screen.findByRole("button", { name: "Odświeżanie…" })).toBe(refreshButton);
    expect(document.activeElement).toBe(refreshButton);

    rejectStatus(new Error("App Manager jest chwilowo niedostępny."));

    const retryButton = await screen.findByRole("button", { name: "Odśwież biblioteki" });
    expect(screen.getByRole("alert").textContent).toContain("App Manager jest chwilowo niedostępny.");
    expect(await screen.findByText("Team Fortress 2")).toBeTruthy();
    expect(retryButton).toBe(refreshButton);
    expect(document.activeElement).toBe(refreshButton);
    expect(refreshButton.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("button", { name: "Big Picture" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Uruchom" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(refreshButton);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: "Big Picture" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Uruchom" }).hasAttribute("disabled")).toBe(false);
  });

  it("ignores repeated refresh activations while a status request is pending", async () => {
    mocks.snapshot = windowsSnapshot();
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);
    const refreshButton = await screen.findByRole("button", { name: "Odśwież biblioteki" });
    refreshButton.focus();
    expect(document.activeElement).toBe(refreshButton);
    const callsAfterInitialRead = mocks.getStatus.mock.calls.length;

    let resolveStatus!: (snapshot: any) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    fireEvent.click(refreshButton);
    expect(await screen.findByRole("button", { name: "Odświeżanie…" })).toBe(refreshButton);

    fireEvent.click(refreshButton);

    expect(mocks.getStatus).toHaveBeenCalledTimes(callsAfterInitialRead + 1);
    expect(document.activeElement).toBe(refreshButton);
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");

    resolveStatus(windowsSnapshot([{ id: "730", name: "Counter-Strike 2", launcher: "Steam" }]));

    await screen.findByText("Counter-Strike 2");
    await waitFor(() => expect(refreshButton.getAttribute("aria-busy")).toBe("false"));
    expect(document.activeElement).toBe(refreshButton);
    expect(mocks.getStatus).toHaveBeenCalledTimes(callsAfterInitialRead + 1);
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

  it("does not announce a Steam launch when App Manager returns an unlaunched receipt", async () => {
    mocks.snapshot = windowsSnapshot();
    mocks.launchGame.mockResolvedValueOnce({ id: "440", launched: false });
    render(<GamingHub onActivateGaming={vi.fn(async () => true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Uruchom" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Steam nie potwierdził uruchomienia gry.");
    expect(screen.queryByText("Wysłano żądanie uruchomienia Team Fortress 2 przez Steam.")).toBeNull();
  });
});
