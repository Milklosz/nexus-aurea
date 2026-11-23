// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  listenForSessionChange: vi.fn(),
}));
vi.mock("../services/sessionOrchestrator", () => ({
  getSessionState: sessionMocks.getSessionState,
  listenForSessionChange: sessionMocks.listenForSessionChange,
}));

const appManagerMocks = vi.hoisted(() => ({
  listenForLaunchEvent: vi.fn(),
}));
vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null },
  getAppManagerStatus: vi.fn(async () => ({ windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null })),
  listenForLaunchEvent: appManagerMocks.listenForLaunchEvent,
}));

import {
  buildHomeSections,
  continuingServicesFromEvent,
  continuingServicesFromSnapshot,
  HOME_FOCUS_DOCK_KEY,
  HOME_FOCUS_SECTION_KEY,
  HOME_SECTIONS_RECENTS_CAP,
  isActiveLaunchPhase,
  parseFocusIndex,
  readHomeFocusMemory,
  saveHomeDockFocus,
  saveHomeSectionFocus,
  serviceForSessionAppId,
  serviceFromLaunchEvent,
} from "../services/homeSections";
import { emptyAppManagerSnapshot, type LaunchEventPayload } from "../services/appManager";
import type { SessionChangedEvent, SessionSnapshot } from "../services/sessionOrchestrator";
import { HomeSections } from "../components/living-room/HomeSections";
import { LivingRoomHome } from "../components/living-room/LivingRoomHome";
import { streamingServices } from "../data/streamingServices";
import { activateHomeAction, moveWithinHomeActions } from "../services/homeActions";
import { focusHomeZone, homeZoneAvailability, homeZoneOfElement, nextHomeZone } from "../services/homeZones";

// This jsdom build exposes no localStorage on its own; the repo convention
// (gamingCollections.test.ts) is an in-memory stub installed on window.
const memoryStorage = (() => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() { return entries.size; },
  } as Storage;
})();
Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage });
const ls = memoryStorage;

function snapshot(current: SessionSnapshot["current"], appId?: string): SessionSnapshot {
  return {
    current,
    previous: null,
    revision: 1,
    transitionedAtMs: 0,
    context: appId ? { appId } : null,
    allowedTargets: [],
  };
}

function launchEvent(appId: string, phase: string): LaunchEventPayload {
  return {
    previousPhase: "launching",
    atMs: 1,
    session: { id: "s1", kind: "edge-cinema", displayName: appId, appId, phase, error: null, attention: null },
  };
}

function seedRecents(ids: string[]) {
  const value = JSON.stringify({ version: 1, favorites: [], recents: ids });
  ls.setItem("velora.smartHome", value);
  // The smart-home store listens for "storage" events; a plain Event with the
  // StorageEvent fields defined reaches it without needing a real Storage impl.
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: "velora.smartHome" });
  Object.defineProperty(event, "newValue", { value });
  Object.defineProperty(event, "storageArea", { value: ls });
  window.dispatchEvent(event);
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  ls.clear();
  // Reset the smart-home store singleton (created lazily on first access) to empty recents.
  seedRecents([]);
  sessionMocks.getSessionState.mockReset().mockResolvedValue(snapshot("veloraHome"));
  sessionMocks.listenForSessionChange.mockReset().mockImplementation(async () => vi.fn());
  appManagerMocks.listenForLaunchEvent.mockReset().mockImplementation(async () => vi.fn());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSections(overrides: Partial<Parameters<typeof HomeSections>[0]> = {}) {
  const props = {
    services: streamingServices,
    launchingIds: new Set<string>() as ReadonlySet<string>,
    appManager: emptyAppManagerSnapshot,
    onActivate: vi.fn(),
    onUnavailable: vi.fn(),
    ...overrides,
  };
  render(<HomeSections {...props} />);
  return props;
}

const recents = (ids: string[]) => ids as string[];

describe("buildHomeSections: recents from the local store", () => {
  const continuing = new Set<string>();
  const launching = new Set<string>();

  it("keeps the store order (most recent first) and maps ids to dock indices", () => {
    const { sections, empty } = buildHomeSections({
      recents: recents(["youtube", "netflix", "steam"]),
      services: streamingServices,
      continuingIds: continuing,
      launchingIds: launching,
    });
    expect(empty).toBe(false);
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("recents");
    expect(sections[0].tiles.map((tile) => tile.service.id)).toEqual(["youtube", "netflix", "steam"]);
    expect(sections[0].tiles.map((tile) => tile.serviceIndex)).toEqual([4, 0, 5]);
    expect(sections[0].tiles.every((tile) => !tile.continuing)).toBe(true);
  });

  it("dedupes, drops unknown ids and caps the row", () => {
    const all = streamingServices.map((service) => service.id);
    const deduped = buildHomeSections({
      recents: recents(["netflix", "netflix", "bogus", "disney"]),
      services: streamingServices,
      continuingIds: continuing,
      launchingIds: launching,
    });
    expect(deduped.sections[0].tiles.map((tile) => tile.service.id)).toEqual(["netflix", "disney"]);

    const capped = buildHomeSections({
      recents: recents(all),
      services: streamingServices,
      continuingIds: continuing,
      launchingIds: launching,
      cap: 3,
    });
    expect(capped.sections[0].tiles).toHaveLength(3);
    expect(HOME_SECTIONS_RECENTS_CAP).toBe(8);
    const atCap = buildHomeSections({
      recents: recents(all),
      services: streamingServices,
      continuingIds: continuing,
      launchingIds: launching,
    });
    expect(atCap.sections[0].tiles).toHaveLength(all.length);
  });

  it("is empty when there are no recents and no known session", () => {
    const { sections, empty } = buildHomeSections({
      recents: [],
      services: streamingServices,
      continuingIds: continuing,
      launchingIds: launching,
    });
    expect(sections).toEqual([]);
    expect(empty).toBe(true);
  });

  it("marks recents tiles as continuing when a session is known, without duplicating them into the continue section", () => {
    const { sections } = buildHomeSections({
      recents: recents(["netflix", "prime"]),
      services: streamingServices,
      continuingIds: new Set(["netflix"]),
      launchingIds: launching,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("recents");
    const netflix = sections[0].tiles.find((tile) => tile.service.id === "netflix");
    expect(netflix?.continuing).toBe(true);
    expect(sections[0].tiles.find((tile) => tile.service.id === "prime")?.continuing).toBe(false);
  });

  it("gives a known-session service outside recents its own leading continue section", () => {
    const { sections } = buildHomeSections({
      recents: recents(["netflix"]),
      services: streamingServices,
      continuingIds: new Set(["netflix", "youtube"]),
      launchingIds: launching,
    });
    expect(sections.map((section) => section.id)).toEqual(["continue", "recents"]);
    expect(sections[0].tiles.map((tile) => tile.service.id)).toEqual(["youtube"]);
    expect(sections[0].tiles[0].continuing).toBe(true);
  });

  it("carries the launching flag for pending tiles", () => {
    const { sections } = buildHomeSections({
      recents: recents(["steam"]),
      services: streamingServices,
      continuingIds: continuing,
      launchingIds: new Set(["steam"]),
    });
    expect(sections[0].tiles[0].launching).toBe(true);
  });
});

describe("session attribution: continue only where actually known", () => {
  it("maps edge-cinema and managed appIds to services, nothing else", () => {
    expect(serviceForSessionAppId("edge-cinema:netflix", streamingServices)?.id).toBe("netflix");
    expect(serviceForSessionAppId("edge-cinema:youtube", streamingServices)?.id).toBe("youtube");
    expect(serviceForSessionAppId("steamBigPicture", streamingServices)?.id).toBe("steam");
    expect(serviceForSessionAppId("playniteFullscreen", streamingServices)?.id).toBe("playnite");
    expect(serviceForSessionAppId("edge-cinema:bogus", streamingServices)).toBeNull();
    expect(serviceForSessionAppId("some-game.exe", streamingServices)).toBeNull();
    expect(serviceForSessionAppId(null, streamingServices)).toBeNull();
    expect(serviceForSessionAppId(undefined, streamingServices)).toBeNull();
  });

  it("reports no continuing service on veloraHome or on a generic session without appId", () => {
    expect(continuingServicesFromSnapshot(snapshot("veloraHome"), streamingServices)).toEqual([]);
    expect(continuingServicesFromSnapshot(snapshot("game"), streamingServices)).toEqual([]);
    expect(continuingServicesFromSnapshot(snapshot("cinema"), streamingServices)).toEqual([]);
  });

  it("attributes a cinema session through its appId and a playnite session directly", () => {
    expect(continuingServicesFromSnapshot(snapshot("cinema", "edge-cinema:max"), streamingServices).map((s) => s.id)).toEqual(["max"]);
    expect(continuingServicesFromSnapshot(snapshot("game", "steamBigPicture"), streamingServices).map((s) => s.id)).toEqual(["steam"]);
    expect(continuingServicesFromSnapshot(snapshot("playnite"), streamingServices).map((s) => s.id)).toEqual(["playnite"]);
  });

  it("follows session change events the same way", () => {
    const event: SessionChangedEvent = {
      from: "veloraHome", to: "cinema", cause: "launch", context: { appId: "edge-cinema:prime" }, revision: 2, atMs: 5,
    };
    expect(continuingServicesFromEvent(event, streamingServices).map((s) => s.id)).toEqual(["prime"]);
    expect(continuingServicesFromEvent({ ...event, to: "veloraHome", context: null }, streamingServices)).toEqual([]);
  });

  it("classifies launch phases truthfully and maps launch events to services", () => {
    expect(isActiveLaunchPhase("sessionActive")).toBe(true);
    expect(isActiveLaunchPhase("windowAppeared")).toBe(true);
    expect(isActiveLaunchPhase("launching")).toBe(false);
    expect(serviceFromLaunchEvent(launchEvent("edge-cinema:disney", "sessionActive"), streamingServices)?.id).toBe("disney");
    expect(serviceFromLaunchEvent(launchEvent("appleMusic", "sessionActive"), streamingServices)?.id).toBe("appleMusic");
  });
});

describe("focus memory helpers", () => {
  it("round-trips dock and section indices through localStorage", () => {
    expect(readHomeFocusMemory()).toEqual({ dockIndex: null, sectionIndex: null });
    saveHomeDockFocus(3);
    saveHomeSectionFocus(2);
    expect(readHomeFocusMemory()).toEqual({ dockIndex: 3, sectionIndex: 2 });
    expect(ls.getItem(HOME_FOCUS_DOCK_KEY)).toBe("3");
    expect(ls.getItem(HOME_FOCUS_SECTION_KEY)).toBe("2");
  });

  it("rejects malformed values instead of trusting them", () => {
    expect(parseFocusIndex(null)).toBeNull();
    expect(parseFocusIndex("abc")).toBeNull();
    expect(parseFocusIndex("-1")).toBeNull();
    expect(parseFocusIndex("4.5")).toBeNull();
    expect(parseFocusIndex("1e3")).toBeNull();
    expect(parseFocusIndex("007")).toBe(7);
    expect(parseFocusIndex("100000")).toBeNull();
  });
});

describe("HomeSections component states", () => {
  it("shows a shimmer while the session read is pending and the row after it settles", async () => {
    let resolveSession!: (value: SessionSnapshot) => void;
    sessionMocks.getSessionState.mockImplementation(() => new Promise<SessionSnapshot>((resolve) => { resolveSession = resolve; }));
    seedRecents(["netflix"]);
    renderSections();
    expect(document.querySelectorAll(".lr-shimmer")).toHaveLength(4);
    expect(document.querySelector(".lr-sections")).toBeNull();
    await act(async () => { resolveSession(snapshot("veloraHome")); });
    await flush();
    expect(document.querySelectorAll(".lr-shimmer")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Otwórz ponownie Netflix" })).toBeTruthy();
  });

  it("shows an inline error with a working retry when the session read fails and nothing else is known", async () => {
    sessionMocks.getSessionState.mockRejectedValueOnce(new Error("ipc down"));
    renderSections();
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Nie udało się odczytać stanu sesji.");
    expect(document.querySelector(".lr-sections")).toBeNull();
    sessionMocks.getSessionState.mockResolvedValueOnce(snapshot("veloraHome"));
    fireEvent.click(screen.getByRole("button", { name: "Spróbuj ponownie" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Tutaj pojawią się ostatnio otwierane aplikacje.")).toBeTruthy();
    expect(sessionMocks.getSessionState).toHaveBeenCalledTimes(2);
  });

  it("keeps recents visible next to the error notice and clears the notice after retry", async () => {
    seedRecents(["netflix"]);
    sessionMocks.getSessionState.mockRejectedValueOnce(new Error("ipc down"));
    renderSections();
    await flush();
    expect(document.querySelector(".lr-sections")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Nie udało się odczytać stanu sesji.");
    expect(screen.getByRole("button", { name: "Otwórz ponownie Netflix" })).toBeTruthy();
    sessionMocks.getSessionState.mockResolvedValueOnce(snapshot("veloraHome"));
    fireEvent.click(screen.getByRole("button", { name: "Spróbuj ponownie" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Otwórz ponownie Netflix" })).toBeTruthy();
  });

  it("shows a subtle placeholder when ready but empty, without claiming a zone", async () => {
    renderSections();
    await flush();
    expect(screen.getByText("Tutaj pojawią się ostatnio otwierane aplikacje.")).toBeTruthy();
    expect(document.querySelector(".lr-sections")).toBeNull();
    expect(homeZoneAvailability(document).sections).toBeUndefined();
  });

  it("renders recents tiles as focusable buttons that launch through the dock path", async () => {
    seedRecents(["youtube", "netflix"]);
    const props = renderSections();
    await flush();
    const youtube = screen.getByRole("button", { name: "Otwórz ponownie YouTube" });
    const netflix = screen.getByRole("button", { name: "Otwórz ponownie Netflix" });
    expect(youtube.tagName).toBe("BUTTON");
    expect((youtube as HTMLButtonElement).disabled).toBe(false);
    expect(youtube.hasAttribute("data-aurea-item")).toBe(false);
    fireEvent.click(youtube);
    expect(props.onActivate).toHaveBeenCalledWith(4);
    fireEvent.click(netflix);
    expect(props.onActivate).toHaveBeenCalledWith(0);
  });

  it("shows Continue only for a session that is actually known, with no fabricated progress", async () => {
    sessionMocks.getSessionState.mockResolvedValue(snapshot("cinema", "edge-cinema:netflix"));
    renderSections();
    await flush();
    const tile = screen.getByRole("button", { name: "Kontynuuj Netflix" });
    expect(tile.textContent).toContain("Kontynuuj");
    expect(tile.querySelector('[role="progressbar"]')).toBeNull();
    expect(tile.querySelector("meter")).toBeNull();
    expect(tile.textContent).not.toMatch(/\d+%|\d+:\d{2}|postęp/i);
    expect(screen.queryByRole("button", { name: /Kontynuuj Disney/ })).toBeNull();
  });

  it("shows no Continue anywhere when the session is veloraHome", async () => {
    seedRecents(["netflix", "disney"]);
    renderSections();
    await flush();
    expect(document.body.textContent).not.toContain("Kontynuuj");
    expect(screen.getAllByRole("button").every((button) => !button.getAttribute("aria-label")?.startsWith("Kontynuuj"))).toBe(true);
  });

  it("adds and removes Continue from live launch events", async () => {
    let launchCallback: ((event: LaunchEventPayload) => void) | null = null;
    appManagerMocks.listenForLaunchEvent.mockImplementation(async (callback: (event: LaunchEventPayload) => void) => {
      launchCallback = callback;
      return vi.fn();
    });
    renderSections();
    await flush();
    expect(screen.queryByRole("button", { name: /Kontynuuj/ })).toBeNull();
    act(() => { launchCallback?.(launchEvent("edge-cinema:youtube", "sessionActive")); });
    expect(screen.getByRole("button", { name: "Kontynuuj YouTube" })).toBeTruthy();
    act(() => { launchCallback?.(launchEvent("edge-cinema:youtube", "exited")); });
    expect(screen.queryByRole("button", { name: /Kontynuuj/ })).toBeNull();
  });

  it("follows session change events for the Continue section", async () => {
    let sessionCallback: ((event: SessionChangedEvent) => void) | null = null;
    sessionMocks.listenForSessionChange.mockImplementation(async (callback: (event: SessionChangedEvent) => void) => {
      sessionCallback = callback;
      return vi.fn();
    });
    renderSections();
    await flush();
    act(() => {
      sessionCallback?.({
        from: "veloraHome", to: "cinema", cause: "launch",
        context: { appId: "edge-cinema:prime" }, revision: 2, atMs: 9,
      });
    });
    expect(screen.getByRole("button", { name: "Kontynuuj Prime Video" })).toBeTruthy();
    act(() => {
      sessionCallback?.({
        from: "cinema", to: "veloraHome", cause: "user", context: null, revision: 3, atMs: 10,
      });
    });
    expect(screen.queryByRole("button", { name: /Kontynuuj/ })).toBeNull();
  });

  it("keeps the pending state on section tiles while a launch is in flight", async () => {
    seedRecents(["steam"]);
    renderSections({ launchingIds: new Set(["steam"]) });
    await flush();
    const tile = screen.getByRole("button", { name: "Otwórz ponownie Steam" });
    expect(tile.getAttribute("aria-busy")).toBe("true");
    expect(tile.classList.contains("is-launching")).toBe(true);
    expect(tile.querySelector(".lr-bar")).not.toBeNull();
  });

  it("reports a missing managed app instead of launching it", async () => {
    seedRecents(["playnite"]);
    const props = renderSections({
      appManager: { ...emptyAppManagerSnapshot, windows: true, apps: [{ id: "playniteFullscreen", installed: false }] as never },
    });
    await flush();
    const tile = screen.getByRole("button", { name: "Otwórz ponownie Playnite" });
    expect(tile.classList.contains("is-missing")).toBe(true);
    fireEvent.click(tile);
    expect(props.onUnavailable).toHaveBeenCalledWith("Playnite");
    expect(props.onActivate).not.toHaveBeenCalled();
  });
});

describe("zone model: the sections row is reachable with up/down", () => {
  it("is a zone between music and the dock, available only while rendered, and remembers its tile", async () => {
    ls.setItem(HOME_FOCUS_SECTION_KEY, "1");
    seedRecents(["netflix", "disney", "youtube"]);
    const props = renderSections();
    render(<nav className="lr-dock"><button type="button">Dock tile</button></nav>);
    await flush();

    const available = homeZoneAvailability(document);
    expect(available.sections).toBe(true);
    expect(available.dock).toBe(true);
    expect(nextHomeZone("dock", -1, available)).toBe("sections");
    expect(nextHomeZone("sections", 1, available)).toBe("dock");
    expect(nextHomeZone("music", 1, { ...available, music: true })).toBe("sections");

    const tiles = Array.from(document.querySelectorAll<HTMLElement>(".lr-sections [data-lr-section-tile]"));
    expect(tiles).toHaveLength(3);
    expect(homeZoneOfElement(tiles[0])).toBe("sections");
    expect(tiles[1].getAttribute("data-remembered")).toBe("true");

    expect(focusHomeZone(document, "sections")).toBe(true);
    expect(document.activeElement).toBe(tiles[1]);

    // Left/right stay inside the row and never wrap; confirm presses the tile.
    expect(moveWithinHomeActions(document.activeElement, -1)).toBe(true);
    expect(document.activeElement).toBe(tiles[0]);
    expect(moveWithinHomeActions(document.activeElement, -1)).toBe(true);
    expect(document.activeElement).toBe(tiles[0]);
    expect(moveWithinHomeActions(document.activeElement, 1)).toBe(true);
    expect(document.activeElement).toBe(tiles[1]);
    expect(activateHomeAction(tiles[2])).toBe(true);
    expect(props.onActivate).toHaveBeenCalledWith(4);
    // The dock is not part of the row.
    const dockTile = document.querySelector(".lr-dock button");
    expect(moveWithinHomeActions(dockTile, 1)).toBe(false);
    expect(activateHomeAction(dockTile)).toBe(false);
  });

  it("is skipped when the row is not on screen (empty state)", async () => {
    render(
      <>
        <button type="button" className="quick-settings-trigger">CC</button>
        <nav className="lr-dock"><button type="button">Dock tile</button></nav>
        <HomeSections
          services={streamingServices}
          launchingIds={new Set<string>()}
          appManager={emptyAppManagerSnapshot}
          onActivate={vi.fn()}
          onUnavailable={vi.fn()}
        />
      </>,
    );
    await flush();
    const available = homeZoneAvailability(document);
    expect(available.sections).toBeUndefined();
    expect(available.dock).toBe(true);
    expect(nextHomeZone("dock", -1, available)).toBe("controlCenter");
  });

  it("persists the last-focused section tile index on focus", async () => {
    seedRecents(["netflix", "disney", "youtube"]);
    renderSections();
    await flush();
    const tiles = Array.from(document.querySelectorAll<HTMLElement>(".lr-sections [data-lr-section-tile]"));
    fireEvent.focus(tiles[2]);
    expect(ls.getItem(HOME_FOCUS_SECTION_KEY)).toBe("2");
    expect(readHomeFocusMemory().sectionIndex).toBe(2);
    expect(tiles[2].getAttribute("data-remembered")).toBe("true");
  });
});

describe("LivingRoomHome wiring", () => {
  function renderHome(overrides: Partial<Parameters<typeof LivingRoomHome>[0]> = {}) {
    const props = {
      services: streamingServices,
      activeIndex: 0,
      launchingIds: new Set<string>() as ReadonlySet<string>,
      buttonRefs: { current: [] } as RefObject<Array<HTMLButtonElement | null>>,
      weather: { temperatureText: "2°", condition: "Częściowe zachmurzenie", title: "Pogoda", stale: false },
      onFocus: vi.fn(),
      onActivate: vi.fn(),
      onUnavailable: vi.fn(),
      onSearch: vi.fn(),
      onRemote: vi.fn(),
      onSettings: vi.fn(),
      ...overrides,
    };
    render(<LivingRoomHome {...props} />);
    return props;
  }

  it("renders the sections row inside Home without disturbing the dock tiles", async () => {
    seedRecents(["netflix", "disney"]);
    renderHome();
    await flush();
    expect(document.querySelector(".lr-sections")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Otwórz ponownie Netflix" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Otwórz ponownie Disney+" })).toBeTruthy();
    const dockTiles = screen.getAllByRole("button").filter((button) => button.hasAttribute("data-aurea-item"));
    expect(dockTiles).toHaveLength(8);
    expect(screen.getAllByRole("button").filter((button) => button.hasAttribute("data-lr-section-tile"))).toHaveLength(2);
  });

  it("restores the last-focused dock index on Home mount", async () => {
    ls.setItem(HOME_FOCUS_DOCK_KEY, "2");
    const props = renderHome();
    await flush();
    expect(props.onFocus).toHaveBeenCalledWith(2);
    expect(ls.getItem(HOME_FOCUS_DOCK_KEY)).toBe("2");
  });

  it("persists dock focus through the wrapped handler", async () => {
    const props = renderHome();
    await flush();
    fireEvent.focus(screen.getByRole("button", { name: "Otwórz YouTube" }));
    expect(ls.getItem(HOME_FOCUS_DOCK_KEY)).toBe("4");
    expect(props.onFocus).toHaveBeenCalledWith(4);
  });
});
