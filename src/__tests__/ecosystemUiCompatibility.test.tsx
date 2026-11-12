// @vitest-environment jsdom
/**
 * VELORA 1.0 — Ecosystem (moduł G).
 *
 * Cross-cutting regression: dotychczasowy UI i serwisy muszą nadal działać po
 * dodaniu warstwy kontraktów (F) i modułów A–E. Importujemy WYŁĄCZNIE pliki,
 * których nie modyfikuje żaden moduł ecosystemu, dzięki czemu test potwierdza
 * kompatybilność wsteczną, a nie tylko poprawność nowego kodu.
 */
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDock } from "../components/AppDock";
import { isOfficialHttpsUrl, streamingServices } from "../data/streamingServices";
import type { WebStreamingService } from "../data/streamingServices";
import {
  EDGE_CINEMA_NOTES,
  EDGE_CINEMA_PROFILE_NAME,
  getEdgeCinemaStatus,
  launchEdgeCinema,
} from "../services/edgeCinema";
import { openStreamingService } from "../services/openStreamingService";
import * as contracts from "../contracts";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: {
    windows: false,
    foregroundProcess: null,
    apps: [],
    games: [],
    gamesError: null,
  },
  getAppManagerStatus: vi.fn(async () => ({
    windows: false,
    foregroundProcess: null,
    apps: [],
    games: [],
    gamesError: null,
  })),
}));

const webService = streamingServices.find((service) => service.kind === "web") as WebStreamingService;

beforeEach(() => {
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Ecosystem — kompatybilność z dotychczasowym UI", () => {
  it("home dock nadal renderuje siedem kafelków AUREA bez błędów", () => {
    const buttonRefs = { current: [] } as RefObject<Array<HTMLButtonElement | null>>;
    const { container } = render(
      <AppDock
        services={streamingServices}
        activeIndex={0}
        launchingIds={new Set<string>()}
        buttonRefs={buttonRefs}
        onFocus={vi.fn()}
        onActivate={vi.fn()}
        onUnavailable={vi.fn()}
      />,
    );
    expect(streamingServices).toHaveLength(7);
    expect(container.querySelectorAll("[data-aurea-item]")).toHaveLength(7);
    expect(container.querySelectorAll("button")).toHaveLength(7);
  });

  it("allowlista pięciu adresów HTTPS i walidacja hosta pozostają niezmienione", () => {
    const web = streamingServices.filter((service) => service.kind === "web");
    expect(web).toHaveLength(5);
    expect(web.map((service) => (service as WebStreamingService).href)).toEqual([
      "https://www.netflix.com/pl/",
      "https://www.disneyplus.com/pl-pl",
      "https://www.hbomax.com/pl/pl",
      "https://www.primevideo.com/-/pl_PL/?tr=pl",
      "https://www.youtube.com/",
    ]);
    expect(isOfficialHttpsUrl("https://www.netflix.com/pl/", "www.netflix.com")).toBe(true);
    expect(isOfficialHttpsUrl("http://www.netflix.com/pl/", "www.netflix.com")).toBe(false);
    expect(isOfficialHttpsUrl("https://www.netflix.com@evil.example/", "www.netflix.com")).toBe(false);
  });

  it("niezaufany adres jest odrzucany przed wywołaniem invoke", async () => {
    const untrusted: WebStreamingService = {
      ...webService,
      href: "http://evil.example/",
      allowedHost: "www.netflix.com",
    };
    await expect(openStreamingService(untrusted)).rejects.toThrow(
      "Adres usługi nie znajduje się na liście zaufanych stron.",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("ścieżka natywna nadal wywołuje launch_edge_cinema z { url }", async () => {
    mocks.invoke.mockResolvedValue({
      launched: true,
      mode: "app-fullscreen",
      profileDir: "C:\\VELORA\\profile",
    });
    await openStreamingService(webService);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("launch_edge_cinema", {
      url: webService.href,
    });
  });

  it("podgląd WWW nadal używa odizolowanego window.open", async () => {
    mocks.isTauri.mockReturnValue(false);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openStreamingService(webService);
    expect(open).toHaveBeenCalledWith(webService.href, "_blank", "noopener,noreferrer");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("eksporty Edge Cinema i nazwy komend pozostają niezmienione", async () => {
    expect(EDGE_CINEMA_PROFILE_NAME).toBe("VELORA-EdgeCinema");
    expect(EDGE_CINEMA_NOTES).toHaveLength(3);
    mocks.invoke.mockResolvedValue({
      windows: true,
      edgeDetected: true,
      profileDir: null,
      notes: EDGE_CINEMA_NOTES,
    });
    await getEdgeCinemaStatus();
    expect(mocks.invoke).toHaveBeenCalledWith("get_edge_cinema_status");
    mocks.invoke.mockResolvedValue({
      launched: true,
      mode: "app-fullscreen",
      profileDir: "C:\\VELORA\\profile",
    });
    await launchEdgeCinema("https://www.netflix.com/pl/");
    expect(mocks.invoke).toHaveBeenLastCalledWith("launch_edge_cinema", {
      url: "https://www.netflix.com/pl/",
    });
  });
});

describe("Ecosystem — stabilność kontraktów (F)", () => {
  it("kontrakty udostępniają działające helpery bez importowania UI", () => {
    expect(typeof contracts.veloraError).toBe("function");
    expect(contracts.veloraError("unavailable", "Brak danych").code).toBe("unavailable");
    expect(contracts.toVeloraError(new Error("x")).message).not.toContain("at ");
    expect(contracts.idempotencyKey(["a", 1])).toBe(contracts.idempotencyKey(["a", 1]));
    expect(contracts.idempotencyKey(["a", 1])).not.toBe(contracts.idempotencyKey(["a", 2]));

    const guid = "64f78cd1-0b00-4271-a9e1-89abc55f66cc";
    expect(contracts.playniteLaunchRef(guid)).toEqual({
      kind: "playnite-uri",
      target: `playnite://playnite/start/${guid}`,
    });
    expect(contracts.playniteLaunchRef("not-a-guid")).toBeNull();
    expect(contracts.playniteLaunchRef("../../etc/passwd")).toBeNull();

    expect(contracts.coverRefFromSource("javascript:alert(1)").kind).toBe("none");
    expect(contracts.coverRefFromSource("data:image/png;base64,AAAA").kind).toBe("data-uri");
  });

  it("rejestr IPC i zdarzenia pozostają spójne", () => {
    expect(contracts.isIpcCommandName("get_playnite_library")).toBe(true);
    expect(contracts.isIpcCommandName("launch_playnite_game")).toBe(true);
    expect(contracts.isIpcCommandName("get_display_audio_status")).toBe(true);
    expect(contracts.isIpcCommandName("request_session_transition")).toBe(true);
    expect(contracts.ipcDescriptor("launch_playnite_game")?.sideEffect).toBe("launch");
    expect(contracts.ipcDescriptor("get_display_audio_status")?.sideEffect).toBe("read-only");
    expect(contracts.ipcDescriptor("get_playnite_manifest")?.sideEffect).toBe("read-only");
    expect(contracts.ipcDescriptor("set_autostart_enabled")?.sideEffect).toBe("write");
    expect(contracts.ipcDescriptor("launch_edge_cinema")?.sideEffect).toBe("launch");
    expect(contracts.ipcDescriptor("totalnie-nieznana-komenda")).toBeNull();
    expect(Object.values(contracts.VELORA_EVENTS)).toHaveLength(8);
    expect(contracts.isVeloraEventName("velora://cinema-exited")).toBe(true);
    expect(contracts.isVeloraEventName("velora://evil")).toBe(false);
    expect(contracts.typedEvent(contracts.VELORA_EVENTS.cinemaExited, { sessionId: "s", reason: "closed" }).name).toBe(
      "velora://cinema-exited",
    );
  });

  it("statusy sesji rozróżniają okno aktywne od zamkniętego", () => {
    expect(contracts.IDLE_CINEMA_SESSION.status).toBe("idle");
    expect(contracts.HOME_APP_CONTROL_SESSION.phase).toBe("home");
    expect(contracts.isActiveSession({ ...contracts.IDLE_CINEMA_SESSION, status: "active" })).toBe(true);
    expect(contracts.isActiveSession({ ...contracts.IDLE_CINEMA_SESSION, status: "launching" })).toBe(true);
    expect(contracts.isActiveSession({ ...contracts.IDLE_CINEMA_SESSION, status: "exited" })).toBe(false);
    expect(contracts.isClosedSession({ ...contracts.IDLE_CINEMA_SESSION, status: "exited" })).toBe(true);
    expect(contracts.isClosedSession(contracts.IDLE_CINEMA_SESSION)).toBe(false);
  });

  it("warstwa kontraktów nie importuje React ani stylów (brak redesignu)", () => {
    const files = [
      "errors.ts",
      "domain.ts",
      "display.ts",
      "session.ts",
      "actions.ts",
      "events.ts",
      "adapters.ts",
      "ipc.ts",
      "index.ts",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), "src/contracts", file), "utf8");
      expect(source).not.toMatch(/from ["']react["']/);
      expect(source).not.toMatch(/styles\.css/);
      expect(source).not.toMatch(/AppDock|useGamepad/);
    }
  });
});
