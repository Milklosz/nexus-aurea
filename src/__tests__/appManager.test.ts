import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn(), listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { emptyAppManagerSnapshot, getAppManagerStatus, launchManagedApp, listenForManagedAppExit, managedAppErrorMessage } from "../services/appManager";

afterEach(() => vi.clearAllMocks());

describe("App Manager bridge", () => {
  it("preserves useful native launch error messages", () => {
    expect(managedAppErrorMessage("Windows nie uruchomił Google Chrome: błąd systemu.")).toBe("Windows nie uruchomił Google Chrome: błąd systemu.");
    expect(managedAppErrorMessage(new Error("Uruchomienie zostało odrzucone."))).toBe("Uruchomienie zostało odrzucone.");
    expect(managedAppErrorMessage({ message: "Aplikacja już działa." })).toBe("Aplikacja już działa.");
    expect(managedAppErrorMessage({})).toBe("Uruchomienie aplikacji nie powiodło się.");
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

  it("forwards only the managed app exit identifier", async () => {
    mocks.isTauri.mockReturnValue(true);
    const callback = vi.fn();
    await listenForManagedAppExit(callback);
    expect(mocks.listen).toHaveBeenCalledWith("managed-app-exited", expect.any(Function));
  });
});
