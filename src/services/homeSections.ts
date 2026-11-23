import { useEffect, useMemo, useState } from "react";
import type { StreamingService } from "../data/streamingServices";
import { getSmartHomeSnapshot, subscribeSmartHome } from "./smartHome";
import {
  getSessionState,
  listenForSessionChange,
  type SessionChangedEvent,
  type SessionContext,
  type SessionId,
  type SessionSnapshot,
} from "./sessionOrchestrator";
import { listenForLaunchEvent, type LaunchEventPayload } from "./appManager";

/**
 * Context-aware Home sections (VELORA 3.0, workstream S3.1). Everything here is
 * built ONLY from local, authorized data:
 *
 *  - "Ostatnio używane" reads the existing read-only local recents store
 *    (`velora.smartHome`, written by recordSmartHomeLaunch / launch events in
 *    App.tsx and SessionsPanel). This module never writes it.
 *  - "Kontynuuj" appears ONLY where the session state is actually known through
 *    getSessionState / listenForSessionChange (sessionOrchestrator) and
 *    listenForLaunchEvent (appManager). Both are used read-only.
 *
 * No streaming playback progress is ever fabricated: PLAYBACK_STATE_READ_SUPPORTED
 * stays false and no tile carries a timestamp, percentage or progress bar.
 */

export type HomeSectionId = "continue" | "recents";

export type HomeSectionTile = {
  service: StreamingService;
  /** Index of the service in the dock array, so activating a tile reuses the dock launch path. */
  serviceIndex: number;
  /** True only when a live session for this service is actually known. */
  continuing: boolean;
  launching: boolean;
};

export type HomeSection = {
  id: HomeSectionId;
  title: string;
  tiles: HomeSectionTile[];
};

export type HomeSectionsStatus = "loading" | "ready" | "error";

/** Same cap the local recents store enforces (smartHome.ts MAX_RECENTS). */
export const HOME_SECTIONS_RECENTS_CAP = 8;

export const HOME_SECTION_TITLES: Record<HomeSectionId, string> = {
  continue: "Kontynuuj",
  recents: "Ostatnio używane",
};

/* ---------- focus memory (localStorage, read/write of two small integers) ---------- */

export const HOME_FOCUS_DOCK_KEY = "velora.home.focus.dockIndex";
export const HOME_FOCUS_SECTION_KEY = "velora.home.focus.sectionIndex";

export interface HomeFocusMemory {
  dockIndex: number | null;
  sectionIndex: number | null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Parses a small non-negative integer; anything else is "no memory". */
export function parseFocusIndex(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 999 ? value : null;
}

export function readHomeFocusMemory(storage: StorageLike | null = defaultStorage()): HomeFocusMemory {
  let dockIndex: number | null = null;
  let sectionIndex: number | null = null;
  try {
    dockIndex = storage ? parseFocusIndex(storage.getItem(HOME_FOCUS_DOCK_KEY)) : null;
    sectionIndex = storage ? parseFocusIndex(storage.getItem(HOME_FOCUS_SECTION_KEY)) : null;
  } catch {
    // Restricted WebView: no memory, the defaults apply.
  }
  return { dockIndex, sectionIndex };
}

export function saveHomeDockFocus(index: number, storage: StorageLike | null = defaultStorage()): void {
  if (!Number.isSafeInteger(index) || index < 0) return;
  try {
    storage?.setItem(HOME_FOCUS_DOCK_KEY, String(index));
  } catch {
    // The choice stays active until the app restarts.
  }
}

export function saveHomeSectionFocus(index: number, storage: StorageLike | null = defaultStorage()): void {
  if (!Number.isSafeInteger(index) || index < 0) return;
  try {
    storage?.setItem(HOME_FOCUS_SECTION_KEY, String(index));
  } catch {
    // The choice stays active until the app restarts.
  }
}

/* ---------- recents (read-only view of the local smart-home store) ---------- */

export function readHomeRecents(): string[] {
  try {
    return [...getSmartHomeSnapshot().recents];
  } catch {
    return [];
  }
}

/* ---------- session attribution: never guess, only map what is known ---------- */

const EDGE_CINEMA_PREFIX = "edge-cinema:";

/** Maps a native session/launch appId to a dock service, or null when unknown. */
export function serviceForSessionAppId(
  appId: string | null | undefined,
  services: readonly StreamingService[],
): StreamingService | null {
  if (!appId) return null;
  if (appId.startsWith(EDGE_CINEMA_PREFIX)) {
    const id = appId.slice(EDGE_CINEMA_PREFIX.length);
    return services.find((service) => service.kind === "web" && service.id === id) ?? null;
  }
  return services.find((service) => service.kind === "managed" && service.managedAppId === appId) ?? null;
}

/**
 * Services with an actually-known live session. "veloraHome" means none; a
 * generic session without an appId (e.g. "game") is attributed to no service,
 * so no tile ever claims a continue state the backend did not report.
 */
export function continuingServices(
  current: SessionId,
  context: SessionContext | null,
  services: readonly StreamingService[],
): StreamingService[] {
  if (current === "veloraHome") return [];
  const found = new Map<string, StreamingService>();
  const fromContext = serviceForSessionAppId(context?.appId, services);
  if (fromContext) found.set(fromContext.id, fromContext);
  if (current === "playnite") {
    const playnite = services.find((service) => service.id === "playnite");
    if (playnite) found.set(playnite.id, playnite);
  }
  return [...found.values()];
}

export function continuingServicesFromSnapshot(
  snapshot: SessionSnapshot,
  services: readonly StreamingService[],
): StreamingService[] {
  return continuingServices(snapshot.current, snapshot.context, services);
}

export function continuingServicesFromEvent(
  event: Pick<SessionChangedEvent, "to" | "context">,
  services: readonly StreamingService[],
): StreamingService[] {
  return continuingServices(event.to, event.context, services);
}

/** Native LaunchRegistry phases that prove a window/session exists (same phases App.tsx records on). */
const ACTIVE_LAUNCH_PHASES: ReadonlySet<string> = new Set(["windowAppeared", "sessionActive"]);
const ENDED_LAUNCH_PHASES: ReadonlySet<string> = new Set(["exited", "failed", "closed", "notRunning"]);

export function isActiveLaunchPhase(phase: string): boolean {
  return ACTIVE_LAUNCH_PHASES.has(phase);
}

export function isEndedLaunchPhase(phase: string): boolean {
  return ENDED_LAUNCH_PHASES.has(phase);
}

export function serviceFromLaunchEvent(
  event: LaunchEventPayload,
  services: readonly StreamingService[],
): StreamingService | null {
  return serviceForSessionAppId(event?.session?.appId, services);
}

/* ---------- pure section building (unit-testable, no DOM) ---------- */

export function buildHomeSections(input: {
  recents: readonly string[];
  services: readonly StreamingService[];
  continuingIds: ReadonlySet<string>;
  launchingIds: ReadonlySet<string>;
  cap?: number;
}): { sections: HomeSection[]; empty: boolean } {
  const cap = input.cap ?? HOME_SECTIONS_RECENTS_CAP;
  const byId = new Map<string, { service: StreamingService; serviceIndex: number }>(
    input.services.map((service, index) => [service.id, { service, serviceIndex: index }]),
  );

  // Recents keep the store order (most recent first), deduped and capped.
  const seen = new Set<string>();
  const recentTiles: HomeSectionTile[] = [];
  for (const id of input.recents) {
    if (seen.has(id)) continue;
    const entry = byId.get(id);
    if (!entry) continue;
    seen.add(id);
    recentTiles.push({
      service: entry.service,
      serviceIndex: entry.serviceIndex,
      continuing: input.continuingIds.has(id),
      launching: input.launchingIds.has(id),
    });
    if (recentTiles.length >= cap) break;
  }

  // A known live session for a service that is not in recents gets its own leading section.
  const continueTiles: HomeSectionTile[] = [];
  input.services.forEach((service, serviceIndex) => {
    if (!input.continuingIds.has(service.id) || seen.has(service.id)) return;
    continueTiles.push({
      service,
      serviceIndex,
      continuing: true,
      launching: input.launchingIds.has(service.id),
    });
  });

  const sections: HomeSection[] = [];
  if (continueTiles.length > 0) sections.push({ id: "continue", title: HOME_SECTION_TITLES.continue, tiles: continueTiles });
  if (recentTiles.length > 0) sections.push({ id: "recents", title: HOME_SECTION_TITLES.recents, tiles: recentTiles });
  return { sections, empty: sections.length === 0 };
}

/* ---------- React hook: live sections from the local store + read-only session signals ---------- */

export function useHomeSections(options: {
  services: readonly StreamingService[];
  launchingIds: ReadonlySet<string>;
}): { status: HomeSectionsStatus; sections: HomeSection[]; empty: boolean; retry: () => void } {
  const { services, launchingIds } = options;
  const [recents, setRecents] = useState<readonly string[]>(() => readHomeRecents());
  const [continuingIds, setContinuingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<HomeSectionsStatus>("loading");
  const [reloadCounter, setReloadCounter] = useState(0);

  // Recents: local store only, kept live through its own subscription.
  useEffect(() => {
    setRecents(readHomeRecents());
    try {
      return subscribeSmartHome(() => setRecents(readHomeRecents()));
    } catch {
      return undefined;
    }
  }, []);

  // Session knowledge: initial read + live events, all read-only.
  useEffect(() => {
    let active = true;
    const apply = (next: ReadonlySet<string>) => {
      if (active) setContinuingIds(next);
    };
    const load = async () => {
      try {
        const snapshot = await getSessionState();
        if (!active) return;
        apply(new Set(continuingServicesFromSnapshot(snapshot, services).map((service) => service.id)));
        setStatus("ready");
      } catch {
        if (active) setStatus("error");
      }
    };
    void load();
    try {
      void listenForSessionChange((event) => {
        apply(new Set(continuingServicesFromEvent(event, services).map((service) => service.id)));
      }).then((unlisten) => {
        if (active) return () => unlisten();
        unlisten();
        return undefined;
      }).catch(() => {});
    } catch {
      // A missing listener must not break the row; the initial read still applies.
    }
    try {
      void listenForLaunchEvent((event) => {
        if (!active) return;
        const service = serviceFromLaunchEvent(event, services);
        if (!service) return;
        setContinuingIds((current) => {
          const next = new Set(current);
          if (isActiveLaunchPhase(event.session.phase)) next.add(service.id);
          else if (isEndedLaunchPhase(event.session.phase)) next.delete(service.id);
          return next;
        });
      }).then((unlisten) => {
        if (active) return () => unlisten();
        unlisten();
        return undefined;
      }).catch(() => {});
    } catch {
      // Same as above: best effort only.
    }
    return () => {
      active = false;
    };
  }, [services, reloadCounter]);

  const { sections, empty } = useMemo(
    () => buildHomeSections({ recents, services, continuingIds, launchingIds }),
    [recents, services, continuingIds, launchingIds],
  );

  const retry = () => {
    setStatus("loading");
    setReloadCounter((counter) => counter + 1);
  };

  return { status, sections, empty, retry };
}
