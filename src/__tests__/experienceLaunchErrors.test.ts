// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamingServices } from "../data/streamingServices";
import {
  getEdgeCinemaStatus,
  launchEdgeCinema,
} from "../services/edgeCinema";
import {
  openStreamingService,
  streamingServiceErrorMessage,
} from "../services/openStreamingService";
import { readPlayniteLibrary } from "../services/playniteLibrary";
import {
  autostartErrorMessage,
  getStartupMode,
  SAFE_MODE_FLAG,
  setAutostartEnabled,
} from "../services/autostart";

// Cross-cutting launch / error paths. Only the Tauri bridge is mocked; the
// real services (validation, adapters, error mappers) are exercised end-to-end.
// No Rust is imported or executed.
const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

function webService(id: string) {
  const service = streamingServices.find((candidate) => candidate.id === id);
  if (!service || service.kind !== "web") throw new Error(`Brak usługi web: ${id}`);
  return service;
}

beforeEach(() => {
  mocks.isTauri.mockReset();
  mocks.invoke.mockReset();
  mocks.isTauri.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Experience launch errors — untrusted addresses are rejected first", () => {
  it("rejects an untrusted streaming URL with the exact message BEFORE any invoke", async () => {
    mocks.isTauri.mockReturnValue(true);
    const netflix = webService("netflix");

    await expect(openStreamingService({ ...netflix, href: "https://evil.example.com/" }))
      .rejects.toThrow(/^Adres usługi nie znajduje się na liście zaufanych stron\.$/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("Experience launch errors — Edge Cinema", () => {
  it("maps a launch_edge_cinema rejection (missing Edge / spawn) to clear Polish guidance", async () => {
    const max = webService("max");

    mocks.invoke.mockRejectedValueOnce(
      new Error("Nie wykryto przeglądarki Microsoft Edge. Zainstaluj Edge, aby uruchomić Edge Cinema."),
    );
    let missingEdge: unknown;
    try {
      await openStreamingService(max);
    } catch (cause) {
      missingEdge = cause;
    }
    expect(missingEdge).toBeInstanceOf(Error);
    expect(streamingServiceErrorMessage(missingEdge, "HBO Max"))
      .toBe("Nie znaleziono przeglądarki Microsoft Edge. Zainstaluj Edge i spróbuj ponownie.");

    mocks.invoke.mockRejectedValueOnce(new Error("Windows nie uruchomił okna Edge Cinema."));
    let spawnFailure: unknown;
    try {
      await openStreamingService(max);
    } catch (cause) {
      spawnFailure = cause;
    }
    expect(spawnFailure).toBeInstanceOf(Error);
    expect(streamingServiceErrorMessage(spawnFailure, "HBO Max"))
      .toBe("Nie udało się uruchomić okna Edge Cinema. Sprawdź instalację Edge i spróbuj ponownie.");
  });

  it("does not let a getEdgeCinemaStatus failure silently succeed", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("status read failed"));
    await expect(getEdgeCinemaStatus()).rejects.toThrow("status read failed");
    expect(mocks.invoke).toHaveBeenCalledWith("get_edge_cinema_status");
  });

  it("does not let the launchEdgeCinema web-preview path silently succeed", async () => {
    mocks.isTauri.mockReturnValue(false);
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    await expect(launchEdgeCinema("https://www.youtube.com/"))
      .rejects.toThrow(/natywnej aplikacji Windows/);

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe("Experience launch errors — Playnite", () => {
  it("never produces fake games when get_playnite_library invoke fails", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("komenda niedostępna"));

    const snapshot = await readPlayniteLibrary();

    expect(mocks.invoke).toHaveBeenCalledWith("get_playnite_library");
    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.available).toBe(false);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.games).toEqual([]);
    expect(snapshot.reason).toMatch(/Nie udało się odczytać biblioteki Playnite/);
  });
});

describe("Experience launch errors — Autostart", () => {
  it("maps a set_autostart_enabled rejection through autostartErrorMessage without leaking raw errors", async () => {
    mocks.invoke.mockRejectedValueOnce({}); // nieznany/techniczny powód bez komunikatu

    let cause: unknown;
    try {
      await setAutostartEnabled(false, true);
    } catch (error) {
      cause = error;
    }

    expect(cause).toBeDefined();
    const message = autostartErrorMessage(cause, "Nie udało się zmienić ustawień autostartu.");
    expect(message).toBe("Nie udało się zmienić ustawień autostartu.");
    expect(message).not.toMatch(/Error:| at |0x|reg\.exe|os error|undefined|\[object Object\]/i);
    expect(mocks.invoke).toHaveBeenCalledWith("set_autostart_enabled", {
      enabled: false,
      windowed: true,
    });
  });

  it("keeps a web-preview setAutostartEnabled rejection user-facing and free of a stack trace", async () => {
    mocks.isTauri.mockReturnValue(false);

    let cause: unknown;
    try {
      await setAutostartEnabled(true, false);
    } catch (error) {
      cause = error;
    }

    expect(mocks.invoke).not.toHaveBeenCalled();
    const message = autostartErrorMessage(cause, "Nie udało się zmienić ustawień autostartu.");
    expect(message).toBe("Autostart jest dostępny tylko w natywnej aplikacji Windows.");
    expect(message).not.toMatch(/Error:| at |0x|reg\.exe/i);
  });

  it("keeps SAFE_MODE_FLAG === --windowed and carries the windowed boolean through both calls", async () => {
    expect(SAFE_MODE_FLAG).toBe("--windowed");

    mocks.invoke.mockResolvedValueOnce({
      windows: true,
      supported: true,
      enabled: false,
      windowed: true,
      lastError: null,
    });
    await setAutostartEnabled(false, true);
    expect(mocks.invoke).toHaveBeenCalledWith("set_autostart_enabled", {
      enabled: false,
      windowed: true,
    });

    mocks.invoke.mockResolvedValueOnce({ windowed: true, autostartEnabled: false });
    await expect(getStartupMode()).resolves.toEqual({ windowed: true, autostartEnabled: false });
    expect(mocks.invoke).toHaveBeenCalledWith("get_startup_mode");
  });
});
