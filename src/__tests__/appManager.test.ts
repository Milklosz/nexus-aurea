import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  listen: vi.fn(async (_event: string, _callback: (event: { payload: unknown }) => void) => vi.fn()),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { emptyAppManagerSnapshot, getAppManagerStatus, launchManagedApp, launchManagedGame, listenForLaunchEvent, listenForManagedAppExit, managedAppErrorMessage } from "../services/appManager";

afterEach(() => vi.clearAllMocks());

describe("App Manager bridge", () => {
  it("preserves useful native launch error messages", () => {
    expect(managedAppErrorMessage("Windows nie uruchomił Google Chrome: błąd systemu.")).toBe("Windows nie uruchomił Google Chrome: błąd systemu.");
    expect(managedAppErrorMessage(new Error("Uruchomienie zostało odrzucone."))).toBe("Uruchomienie zostało odrzucone.");
    expect(managedAppErrorMessage({ message: "Aplikacja już działa." })).toBe("Aplikacja już działa.");
    expect(managedAppErrorMessage({})).toBe("Uruchomienie aplikacji nie powiodło się.");
  });

  it("translates Windows spawn failures into useful installation and permission guidance", () => {
    expect(managedAppErrorMessage("Windows nie uruchomił aplikacji Steam: The system cannot find the file specified. (os error 2)"))
      .toBe("Nie znaleziono pliku aplikacji Steam. Sprawdź instalację.");
    expect(managedAppErrorMessage(new Error("Windows nie uruchomił aplikacji Steam: Access is denied. (os error 5)")))
      .toBe("Windows odmówił uruchomienia Steam. Sprawdź uprawnienia.");
    expect(managedAppErrorMessage("Windows nie uruchomił aplikacji Steam: unknown error"))
      .toBe("Nie udało się uruchomić Steam. Sprawdź instalację i spróbuj ponownie.");
  });

  it("keeps browser preview read-only and empty", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(getAppManagerStatus()).resolves.toEqual(emptyAppManagerSnapshot);
    await expect(launchManagedApp("chrome")).rejects.toThrow("natywnej aplikacji Windows");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes only an allowlisted app identifier to the native launcher", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ id: "appleMusic", alreadyRunning: false, focusRestoreSupported: false });
    await expect(launchManagedApp("appleMusic")).resolves.toMatchObject({ id: "appleMusic" });
    expect(mocks.invoke).toHaveBeenCalledWith("launch_managed_app", { id: "appleMusic" });
  });

  it("forwards the managed app exit together with the backend focus decision", async () => {
    mocks.isTauri.mockReturnValue(true);
    let handler: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementationOnce(async (_event: string, callback: (event: { payload: unknown }) => void) => {
      handler = callback;
      return vi.fn();
    });
    const callback = vi.fn();
    await listenForManagedAppExit(callback);

    handler?.({
      payload: {
        id: "playniteFullscreen",
        foregroundProcess: "chrome.exe",
        shouldFocus: false,
      },
    });

    expect(mocks.listen).toHaveBeenCalledWith("managed-app-exited", expect.any(Function));
    expect(callback).toHaveBeenCalledWith({
      id: "playniteFullscreen",
      foregroundProcess: "chrome.exe",
      shouldFocus: false,
    });
  });

  it("ignores malformed managed app exit events", async () => {
    mocks.isTauri.mockReturnValue(true);
    let handler: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementationOnce(async (_event: string, callback: (event: { payload: unknown }) => void) => {
      handler = callback;
      return vi.fn();
    });
    const callback = vi.fn();
    await listenForManagedAppExit(callback);

    handler?.({ payload: { id: "playniteFullscreen" } });
    handler?.({ payload: "playniteFullscreen" });

    expect(callback).not.toHaveBeenCalled();
  });

  it("forwards only well-formed launch events from the authoritative registry", async () => {
    mocks.isTauri.mockReturnValue(true);
    let handler: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementationOnce(async (_event: string, callback: (event: { payload: unknown }) => void) => {
      handler = callback;
      return vi.fn();
    });
    const callback = vi.fn();
    await listenForLaunchEvent(callback);

    const valid = {
      previousPhase: "requested",
      atMs: 10,
      session: {
        id: "cinema-1",
        kind: "cinema",
        displayName: "Edge Cinema",
        appId: "edge-cinema",
        phase: "failed",
        error: "Nie udało się uruchomić okna Edge Cinema.",
        attention: null,
      },
    };
    handler?.({ payload: valid });
    handler?.({ payload: { ...valid, session: { ...valid.session, id: 7 } } });
    handler?.({ payload: { ...valid, session: { ...valid.session, error: 7 } } });

    expect(mocks.listen).toHaveBeenCalledWith("velora-launch-event", expect.any(Function));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(valid);
  });

  it("keeps launch event listening read-only in browser preview", async () => {
    mocks.isTauri.mockReturnValue(false);
    const callback = vi.fn();
    const stop = await listenForLaunchEvent(callback);
    stop();
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("passes a numeric Steam app ID to the native verified launcher", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ id: "440", launched: true });
    await expect(launchManagedGame("440")).resolves.toMatchObject({ id: "440", launched: true });
    expect(mocks.invoke).toHaveBeenCalledWith("launch_managed_game", { id: "440" });
  });

  it("rejects arbitrary game identifiers before invoking the native layer", async () => {
    mocks.isTauri.mockReturnValue(true);
    await expect(launchManagedGame("steam://run/440")).rejects.toThrow("Nieprawidłowy identyfikator");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps game launching unavailable in browser preview", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(launchManagedGame("440")).rejects.toThrow("natywnego App Managera Windows");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
