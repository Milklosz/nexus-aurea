import { streamingServices, type StreamingService } from "../data/streamingServices";

export type SmartHomeAppId = StreamingService["id"];
export const SMART_HOME_STORAGE_KEY = "velora.smartHome";
export const DEFAULT_FAVORITES: readonly SmartHomeAppId[] = ["netflix", "disney", "max", "prime", "youtube"];
const allowedIds = new Set<string>(streamingServices.map((service) => service.id));
const MAX_RECENTS = 8;
const MAX_STORAGE_BYTES = 16_384;

export interface SmartHomeState {
  readonly version: 1;
  readonly favorites: readonly SmartHomeAppId[];
  readonly recents: readonly SmartHomeAppId[];
}

export interface SmartHomeSnapshot extends SmartHomeState {
  readonly persistence: "saved" | "unavailable" | "newerVersion";
}

export interface SmartHomeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function identities(value: unknown, limit = allowedIds.size): SmartHomeAppId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is SmartHomeAppId => typeof id === "string" && allowedIds.has(id)))].slice(0, limit);
}

function defaults(): SmartHomeState {
  return { version: 1, favorites: [...DEFAULT_FAVORITES], recents: [] };
}

/** Migration only accepts app IDs. URLs, window titles and account information never enter storage. */
export function parseSmartHomeState(raw: string | null): SmartHomeSnapshot {
  const fallback = defaults();
  if (raw === null) return { ...fallback, persistence: "saved" };
  if (raw.length > MAX_STORAGE_BYTES) return { ...fallback, persistence: "unavailable" };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return { ...fallback, persistence: "unavailable" };
    const state = value as Record<string, unknown>;
    if (typeof state.version === "number" && state.version > 1) return { ...fallback, persistence: "newerVersion" };
    if (state.version !== 1 && state.version !== 0) return { ...fallback, persistence: "unavailable" };
    return {
      version: 1,
      favorites: Array.isArray(state.favorites) ? identities(state.favorites) : [...DEFAULT_FAVORITES],
      recents: identities(state.version === 0 ? state.recentApps : state.recents, MAX_RECENTS),
      persistence: "saved",
    };
  } catch {
    return { ...fallback, persistence: "unavailable" };
  }
}

/** Single local store; native Session/LaunchRegistry remain the authority for live sessions. */
export function createSmartHomeStore(storage: SmartHomeStorage | null) {
  let snapshot: SmartHomeSnapshot;
  try {
    snapshot = storage ? parseSmartHomeState(storage.getItem(SMART_HOME_STORAGE_KEY)) : { ...defaults(), persistence: "unavailable" };
  } catch {
    snapshot = { ...defaults(), persistence: "unavailable" };
  }
  const listeners = new Set<() => void>();
  let protectNewerVersion = snapshot.persistence === "newerVersion";
  const notify = () => { for (const listener of listeners) listener(); };
  const update = (next: SmartHomeState) => {
    let persistence: SmartHomeSnapshot["persistence"] = protectNewerVersion ? "newerVersion" : "unavailable";
    if (storage && !protectNewerVersion) {
      try {
        storage.setItem(SMART_HOME_STORAGE_KEY, JSON.stringify(next));
        persistence = "saved";
      } catch {
        // Keep the current session usable and tell the user that the change was not saved.
      }
    }
    snapshot = { ...next, persistence };
    notify();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    acceptStorageValue(raw: string | null) {
      snapshot = parseSmartHomeState(raw);
      protectNewerVersion = snapshot.persistence === "newerVersion";
      notify();
    },
    recordLaunch(id: string) {
      if (!allowedIds.has(id)) return;
      update({ version: 1, favorites: snapshot.favorites, recents: identities([id, ...snapshot.recents], MAX_RECENTS) });
    },
    setFavorite(id: string, pinned: boolean) {
      if (!allowedIds.has(id)) return;
      const favorites = pinned ? identities([...snapshot.favorites, id]) : snapshot.favorites.filter((entry) => entry !== id);
      update({ version: 1, favorites, recents: snapshot.recents });
    },
    moveFavorite(id: string, delta: -1 | 1) {
      const favorites = [...snapshot.favorites];
      const index = favorites.findIndex((entry) => entry === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= favorites.length) return;
      [favorites[index], favorites[target]] = [favorites[target], favorites[index]];
      update({ version: 1, favorites, recents: snapshot.recents });
    },
    restoreFavorites() {
      update({ version: 1, favorites: [...DEFAULT_FAVORITES], recents: snapshot.recents });
    },
  };
}

let store: ReturnType<typeof createSmartHomeStore> | undefined;
function smartHomeStore() {
  if (!store) {
    let storage: SmartHomeStorage | null = null;
    try { storage = typeof window === "undefined" ? null : window.localStorage; } catch { /* Restricted WebView. */ }
    store = createSmartHomeStore(storage);
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (event) => {
        if ((event.key === SMART_HOME_STORAGE_KEY || event.key === null) && event.storageArea === storage) {
          store?.acceptStorageValue(event.newValue);
        }
      });
    }
  }
  return store;
}

export const getSmartHomeSnapshot = () => smartHomeStore().getSnapshot();
export const subscribeSmartHome = (listener: () => void) => smartHomeStore().subscribe(listener);
/** Call after a successful VELORA launch or resume, never on focus or an attempted launch. */
export const recordSmartHomeLaunch = (id: string) => smartHomeStore().recordLaunch(id);
export const setSmartHomeFavorite = (id: string, pinned: boolean) => smartHomeStore().setFavorite(id, pinned);
export const moveSmartHomeFavorite = (id: string, delta: -1 | 1) => smartHomeStore().moveFavorite(id, delta);
export const restoreSmartHomeFavorites = () => smartHomeStore().restoreFavorites();
