// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  buildOverviewItems,
  describeDisplay,
  SystemOverviewCard,
  type OverviewInput,
} from "../components/SystemOverviewCard";
import { disabledDisplayAudioStatus, type DisplayAudioSnapshot } from "../services/displayAudio";
import { disabledNativeControllerStatus, type NativeControllerStatus } from "../services/nativeController";

const mocks = vi.hoisted(() => ({
  getDisplay: vi.fn(),
  listenDisplay: vi.fn(async () => () => {}),
  getAudio: vi.fn(),
  listenAudio: vi.fn(async () => () => {}),
  getController: vi.fn(),
  getSession: vi.fn(),
  listenSession: vi.fn(async () => () => {}),
  getRemote: vi.fn(),
  listenRemote: vi.fn(async () => () => {}),
  controllerStatus: {
    supported: false, running: false, lastError: null, pads: [], ignoredReports: 0,
    droppedRawReports: 0, homeEnabled: false, homeOverride: null, receivedReports: 0,
    validReports: 0, backgroundReports: 0, lastReportAtMs: null, lastHomeButtons: null,
    psRisingCount: 0, lastPsRisingAtMs: null, optionsRisingCount: 0, lastOptionsRisingAtMs: null,
    lastChord: null, lastRestore: null, queueRejected: 0, lastTrace: null,
  } as NativeControllerStatus,
  controllerKnown: false,
  controllerListeners: new Set<() => void>(),
}));

vi.mock("../services/displayAudio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/displayAudio")>();
  return {
    ...actual,
    getDisplayAudioStatus: mocks.getDisplay,
    listenForDisplayChange: mocks.listenDisplay,
  };
});

vi.mock("../services/audioControl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/audioControl")>();
  return {
    ...actual,
    getSystemAudio: mocks.getAudio,
    listenForSystemAudioChange: mocks.listenAudio,
  };
});

vi.mock("../services/nativeController", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/nativeController")>();
  return {
    ...actual,
    getNativeControllerStatus: mocks.getController,
  };
});

vi.mock("../services/sessionOrchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/sessionOrchestrator")>();
  return {
    ...actual,
    getSessionState: mocks.getSession,
    listenForSessionChange: mocks.listenSession,
  };
});

vi.mock("../services/remoteAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remoteAccess")>();
  return {
    ...actual,
    getRemoteAccessStatus: mocks.getRemote,
    listenForRemoteAccessStatus: mocks.listenRemote,
  };
});

vi.mock("../services/nativeControllerStore", () => ({
  nativeControllerStore: {
    subscribe: (callback: () => void) => {
      mocks.controllerListeners.add(callback);
      return () => { mocks.controllerListeners.delete(callback); };
    },
    getStatusSnapshot: () => mocks.controllerStatus,
    getStatusKnown: () => mocks.controllerKnown,
    getModel: () => ({}),
    acquire: () => () => {},
    reconcile: async () => {},
    getStatusReadInFlight: () => false,
    invalidateStatusRead: () => {},
    setHomeEnabled: async () => mocks.controllerStatus,
    listenerCount: 0,
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.controllerListeners.clear();
  mocks.controllerKnown = false;
  mocks.controllerStatus = disabledNativeControllerStatus;
});

function displaySnapshot(overrides: Partial<DisplayAudioSnapshot> = {}): DisplayAudioSnapshot {
  return {
    ...disabledDisplayAudioStatus,
    windows: true,
    supported: true,
    capturedAtMs: 1,
    displays: [{
      id: "tv-1",
      name: "Panasonic TX-49EX610E",
      width: 3840,
      height: 2160,
      refreshHz: 60,
      bitsPerPixel: 32,
      primary: true,
      hdr: true,
      hdrError: null,
      diagnostics: {
        x: 0,
        y: 0,
        desktopWidth: 3840,
        desktopHeight: 2160,
        scalePercent: 150,
        effectiveDpiX: 144,
        effectiveDpiY: 144,
        dpiProvenance: "getDpiForMonitorPerMonitorProcess",
        refreshMillihz: 59_940,
        connectionType: "HDMI",
        adapterName: "RTX 3070",
        edidManufacturerId: 1,
        edidProductCodeId: 2,
        identitySource: "displayConfig",
      },
    }],
    audio: [],
    ...overrides,
  };
}

function readyMocks() {
  mocks.getDisplay.mockResolvedValue(displaySnapshot());
  mocks.getAudio.mockResolvedValue({ id: "a1", name: "Głośniki (Realtek)", state: "active", defaultDevice: true, volumePercent: 40, muted: false });
  mocks.getController.mockResolvedValue({
    ...disabledNativeControllerStatus,
    supported: true,
    running: true,
    homeEnabled: true,
    pads: [{ device: "ds4-1", revision: "v2", transport: "bluetooth" }],
  });
  mocks.getSession.mockResolvedValue({ current: "game", previous: "veloraHome", revision: 3, transitionedAtMs: 1, context: null, allowedTargets: [] });
  mocks.getRemote.mockResolvedValue({ enabled: true, secureOriginAvailable: true, pairingAvailable: false, pairedDeviceCount: 2, pairedDevices: [], origin: "https://x", caFingerprint: null, trustProfilePath: null, pairingCode: null, pairingExpiresInSeconds: 0 });
  mocks.controllerKnown = true;
  mocks.controllerStatus = {
    ...disabledNativeControllerStatus,
    supported: true,
    running: true,
    homeEnabled: true,
    pads: [{ device: "ds4-1", revision: "v2", transport: "bluetooth" }],
  };
}

describe("genesis C — SystemOverviewCard rendering", () => {
  it("shows an explicit loading state per source before any read settles", () => {
    mocks.getDisplay.mockReturnValue(new Promise(() => {}));
    mocks.getAudio.mockReturnValue(new Promise(() => {}));
    mocks.getController.mockReturnValue(new Promise(() => {}));
    mocks.getSession.mockReturnValue(new Promise(() => {}));
    mocks.getRemote.mockReturnValue(new Promise(() => {}));
    render(<SystemOverviewCard />);
    expect(screen.getByRole("region", { name: "Przegląd systemu" })).toBeTruthy();
    const items = screen.getByRole("list", { name: "Stan źródeł systemowych" }).querySelectorAll("li");
    expect(items).toHaveLength(5);
    for (const item of Array.from(items)) {
      expect(item.getAttribute("data-overview-state")).toBe("loading");
      expect(item.textContent).toContain("wczytywanie…");
    }
  });

  it("renders ready summaries from every read-only source without fabricating values", async () => {
    readyMocks();
    render(<SystemOverviewCard />);
    await waitFor(() => {
      expect(screen.getByText(/Panasonic TX-49EX610E · 3840×2160 @ 60 Hz · skala 150%/)).toBeTruthy();
    });
    expect(screen.getByText(/Głośniki \(Realtek\) · 40%/)).toBeTruthy();
    expect(screen.getByText("game · rewizja 3")).toBeTruthy();
    expect(screen.getByText(/serwer LAN włączony · HTTPS gotowe · urządzenia: 2/)).toBeTruthy();
    expect(screen.getByText(/1 pad\(y\) podłączone · powrót Home: włączony/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Odśwież przegląd systemu" })).toBeTruthy();
    // display details are surfaced read-only
    expect(screen.getByText("Wyświetlacze (1) — tylko odczyt")).toBeTruthy();
    const states = Array.from(screen.getByRole("list", { name: "Stan źródeł systemowych" }).querySelectorAll("li"))
      .map((item) => item.getAttribute("data-overview-state"));
    expect(states).toEqual(["ready", "ready", "ready", "ready", "ready"]);
  });

  it("marks only the failed sources as unknown and keeps the others ready", async () => {
    readyMocks();
    mocks.getAudio.mockRejectedValue(new Error("wymaga natywnej aplikacji"));
    mocks.getRemote.mockRejectedValue(new Error("timeout"));
    render(<SystemOverviewCard />);
    const list = screen.getByRole("list", { name: "Stan źródeł systemowych" });
    await waitFor(() => {
      expect(Array.from(list.querySelectorAll("li")).some((li) => li.textContent?.includes("Panasonic TX-49EX610E"))).toBe(true);
    });
    const items = Array.from(list.querySelectorAll("li"));
    const byLabel = new Map(items.map((item) => [item.querySelector(".cc-overview-label")?.textContent ?? "", item.getAttribute("data-overview-state")]));
    expect(byLabel.get("Wyjście audio")).toBe("unknown");
    expect(byLabel.get("Sieć i pilot")).toBe("unknown");
    expect(byLabel.get("Wyświetlacz")).toBe("ready");
    expect(byLabel.get("Aktywna sesja")).toBe("ready");
    expect(byLabel.get("Kontroler")).toBe("ready");
    const unknownTexts = items.filter((item) => item.getAttribute("data-overview-state") === "unknown");
    expect(unknownTexts.every((item) => item.textContent?.includes("stan nieznany"))).toBe(true);
  });

  it("reports the browser preview truthfully instead of pretending hardware data", async () => {
    mocks.getDisplay.mockResolvedValue(disabledDisplayAudioStatus);
    mocks.getAudio.mockRejectedValue(new Error("Sterowanie dźwiękiem wymaga natywnej aplikacji Windows."));
    mocks.getController.mockResolvedValue(disabledNativeControllerStatus);
    mocks.getSession.mockResolvedValue({ current: "veloraHome", previous: null, revision: 0, transitionedAtMs: 0, context: null, allowedTargets: [] });
    mocks.getRemote.mockResolvedValue({ enabled: false, secureOriginAvailable: false, pairingAvailable: false, pairedDeviceCount: 0, pairedDevices: [], origin: null, caFingerprint: null, trustProfilePath: null, pairingCode: null, pairingExpiresInSeconds: 0 });
    mocks.controllerKnown = true;
    render(<SystemOverviewCard />);
    await waitFor(() => expect(screen.getByText(/podgląd przeglądarki — dane sprzętowe niedostępne/)).toBeTruthy());
    expect(screen.getByText("veloraHome · rewizja 0")).toBeTruthy();
    expect(screen.getByText(/serwer LAN wyłączony/)).toBeTruthy();
    expect(screen.getByText(/odczyt natywny niedostępny na tej platformie/)).toBeTruthy();
  });
});

describe("genesis C — buildOverviewItems / describeDisplay (pure)", () => {
  const baseInput: OverviewInput = {
    display: { state: "loading", value: null },
    audio: { state: "loading", value: null },
    controller: { state: "loading", value: null },
    liveController: { known: false, status: disabledNativeControllerStatus },
    session: { state: "loading", value: null },
    remote: { state: "loading", value: null },
  };

  it("maps every source to loading/ready/unknown with stable labels", () => {
    const loading = buildOverviewItems(baseInput);
    expect(loading.map((item) => item.state)).toEqual(["loading", "loading", "loading", "loading", "loading"]);
    expect(loading.every((item) => item.summary === "wczytywanie…")).toBe(true);

    const mixed = buildOverviewItems({
      ...baseInput,
      display: { state: "ready", value: displaySnapshot() },
      audio: { state: "unknown", value: null },
      controller: { state: "unknown", value: null },
      liveController: {
        known: true,
        status: { ...disabledNativeControllerStatus, supported: true, running: false },
      },
      session: { state: "ready", value: { current: "cinema", previous: null, revision: 7, transitionedAtMs: 0, context: null, allowedTargets: [] } },
      remote: { state: "unknown", value: null },
    });
    const byId = new Map(mixed.map((item) => [item.id, item]));
    expect(byId.get("display")?.state).toBe("ready");
    expect(byId.get("display")?.summary).toContain("3840×2160");
    expect(byId.get("audio")?.state).toBe("unknown");
    expect(byId.get("audio")?.summary).toBe("stan nieznany");
    // live store snapshot wins over the card's own read once confirmed
    expect(byId.get("controller")?.state).toBe("ready");
    expect(byId.get("controller")?.summary).toContain("zatrzymany");
    expect(byId.get("session")?.summary).toBe("cinema · rewizja 7");
    expect(byId.get("remote")?.state).toBe("unknown");
    expect(byId.get("remote")?.summary).toBe("stan nieznany");
  });

  it("never fabricates: malformed payloads become unknown, not guessed values", () => {
    const items = buildOverviewItems({
      display: { state: "ready", value: null },
      audio: { state: "ready", value: {} as never },
      controller: { state: "ready", value: null },
      liveController: { known: false, status: disabledNativeControllerStatus },
      session: { state: "ready", value: {} as never },
      remote: { state: "ready", value: null },
    });
    for (const item of items) expect(item.state).toBe("unknown");
    expect(items.every((item) => item.summary === "stan nieznany")).toBe(true);
  });

  it("describeDisplay renders name, resolution, refresh, scale and connection", () => {
    const line = describeDisplay(displaySnapshot().displays[0]);
    expect(line).toContain("Panasonic TX-49EX610E");
    expect(line).toContain("3840×2160");
    expect(line).toContain("@ 60 Hz");
    expect(line).toContain("skala 150%");
    expect(line).toContain("HDMI");
    expect(line).toContain("główny");
  });
});
