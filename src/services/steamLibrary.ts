import { invoke, isTauri } from "@tauri-apps/api/core";
import { ensureControllerHomeForExternalLaunch } from "./controllerHomePreflight";
import { validSteamGameId } from "./gamingCollections";

/**
 * Adapter biblioteki Steam (VELORA 3.0, S3.2) — GRANICA TYLKO DO ODCZYTU.
 *
 * Dane pochodzą wyłącznie z natywnej komendy `get_steam_library`, która czyta
 * tylko `libraryfolders.vdf` i `appmanifest_*.acf`. W podglądzie webowym
 * (isTauri() === false) zwracamy jawny, pusty fallback — nigdy nie wywołujemy
 * invoke i nigdy nie wymyślamy gier.
 */

export const STEAM_GAME_ID_PREFIX = "steam:";

export type SteamGameEntry = {
  appid: string;
  name: string;
  library: string;
};

export type SteamLibrarySnapshot = {
  windows: boolean;
  /** `registry` | `default-paths` | `unavailable` (lub `browser-preview`). */
  source: string;
  available: boolean;
  reason: string | null;
  games: SteamGameEntry[];
};

export type SteamLaunchReceipt = { appid: string; launched: boolean };

export type GameProcessState = {
  windows: boolean;
  id: string;
  tracked: boolean;
  running: boolean;
  phase: string | null;
  crashed: boolean;
  pidReuseDetected: boolean;
  error: string | null;
  attention: string | null;
  processIds: number[];
};

const READ_FAILURE_REASON =
  "Nie udało się odczytać biblioteki Steam. VELORA nie wyświetla gier bez potwierdzonego źródła.";

const PROCESS_FAILURE_REASON = "Nie udało się odczytać stanu procesu gry.";

/** Bezpieczny fallback podglądu webowego — pusta, jawna biblioteka. */
export const browserSteamLibrarySnapshot: SteamLibrarySnapshot = {
  windows: false,
  source: "browser-preview",
  available: false,
  reason: "Biblioteka Steam wymaga natywnej aplikacji Windows; podgląd webowy pozostaje tylko do odczytu.",
  games: [],
};

export function browserGameProcessState(id: string): GameProcessState {
  return {
    windows: false,
    id,
    tracked: false,
    running: false,
    phase: null,
    crashed: false,
    pidReuseDetected: false,
    error: null,
    attention: null,
    processIds: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Kanoniczny identyfikator gry Steam w bibliotece VELORA: `steam:<appid>`. */
export function steamGameId(appid: string): string | null {
  return validSteamGameId(appid) ? `${STEAM_GAME_ID_PREFIX}${appid}` : null;
}

/** Appid Steam dla `steam:<appid>` oraz dla legacycznego numerycznego id. */
export function steamAppIdFromGameId(id: string): string | null {
  if (typeof id !== "string") return null;
  const rest = id.startsWith(STEAM_GAME_ID_PREFIX) ? id.slice(STEAM_GAME_ID_PREFIX.length) : id;
  return validSteamGameId(rest) ? rest : null;
}

/** Identyfikator gry Playnite dla `playnite:<guid>` (reszta odrzucona). */
export function playniteGuidFromGameId(id: string): string | null {
  if (typeof id !== "string") return null;
  if (!id.startsWith("playnite:")) return null;
  const guid = id.slice("playnite:".length);
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(guid)
    ? guid
    : null;
}

function normalizeGame(value: unknown): SteamGameEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.appid !== "string" || !validSteamGameId(value.appid)) return null;
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 512) return null;
  if (typeof value.library !== "string" || value.library.length > 1024) return null;
  return { appid: value.appid, name: value.name, library: value.library };
}

/**
 * Walidacja odpowiedzi `get_steam_library`. Gry są zwracane tylko, gdy
 * biblioteka jest dostępna; każde odchylenie kształtu → `null` (bez danych).
 */
function normalizeSnapshot(value: unknown): SteamLibrarySnapshot | null {
  if (!isRecord(value)) return null;
  if (typeof value.windows !== "boolean") return null;
  if (typeof value.source !== "string" || value.source.length === 0 || value.source.length > 64) return null;
  if (typeof value.available !== "boolean") return null;
  if (value.reason !== null && typeof value.reason !== "string") return null;
  if (!Array.isArray(value.games)) return null;
  if (!value.available) {
    return {
      windows: value.windows,
      source: value.source,
      available: false,
      reason: typeof value.reason === "string" ? value.reason : READ_FAILURE_REASON,
      games: [],
    };
  }
  const games: SteamGameEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value.games) {
    const game = normalizeGame(entry);
    if (game === null || seen.has(game.appid)) continue;
    seen.add(game.appid);
    games.push(game);
  }
  return {
    windows: value.windows,
    source: value.source,
    available: true,
    reason: null,
    games,
  };
}

function unavailableSnapshot(reason: string): SteamLibrarySnapshot {
  return { ...browserSteamLibrarySnapshot, windows: true, source: "unavailable", reason, games: [] };
}

/** Jedyny punkt wejścia UI do biblioteki Steam; błąd = jawny brak danych. */
export async function readSteamLibrary(): Promise<SteamLibrarySnapshot> {
  if (!isTauri()) return browserSteamLibrarySnapshot;
  try {
    const snapshot = normalizeSnapshot(await invoke<unknown>("get_steam_library"));
    return snapshot ?? unavailableSnapshot(READ_FAILURE_REASON);
  } catch {
    return unavailableSnapshot(READ_FAILURE_REASON);
  }
}

/**
 * Uruchamia grę Steam przez natywny `steam://run/<appid>` (komenda
 * `launch_steam_game`). Tylko potwierdzony, numeryczny appid; żadnych innych
 * identyfikatorów. W podglądzie webowym — jawny błąd, bez invoke.
 */
export async function launchSteamGame(appid: string): Promise<SteamLaunchReceipt> {
  if (typeof appid !== "string" || !validSteamGameId(appid)) {
    throw new Error("Nieprawidłowy identyfikator gry Steam.");
  }
  if (!isTauri()) throw new Error("Uruchamianie gier Steam wymaga natywnej aplikacji Windows.");
  await ensureControllerHomeForExternalLaunch();
  const raw: unknown = await invoke<unknown>("launch_steam_game", { appid });
  if (!isRecord(raw) || raw.appid !== appid || raw.launched !== true) {
    throw new Error("Steam nie potwierdził uruchomienia gry.");
  }
  return { appid, launched: true };
}

function normalizeProcessState(value: unknown, id: string): GameProcessState | null {
  if (!isRecord(value)) return null;
  if (typeof value.windows !== "boolean") return null;
  if (typeof value.tracked !== "boolean") return null;
  if (typeof value.running !== "boolean") return null;
  if (typeof value.crashed !== "boolean") return null;
  if (typeof value.pidReuseDetected !== "boolean") return null;
  if (value.phase !== null && typeof value.phase !== "string") return null;
  if (value.error !== null && typeof value.error !== "string") return null;
  if (value.attention !== null && typeof value.attention !== "string") return null;
  if (!Array.isArray(value.processIds)) return null;
  const processIds = value.processIds.filter(
    (entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry > 0,
  );
  return {
    windows: value.windows,
    id: typeof value.id === "string" ? value.id : id,
    tracked: value.tracked,
    running: value.running,
    phase: value.phase as string | null,
    crashed: value.crashed,
    pidReuseDetected: value.pidReuseDetected,
    error: value.error as string | null,
    attention: value.attention as string | null,
    processIds,
  };
}

/**
 * Read-only stan procesu gry (launch_registry + process_table po stronie
 * natywnej). Proces gry nigdy nie jest kończony. Błąd odczytu = fallback
 * z `error`, nigdy wymyślony stan.
 */
export async function getGameProcessState(id: string): Promise<GameProcessState> {
  const fallback = browserGameProcessState(id);
  if (!isTauri()) return fallback;
  try {
    const state = normalizeProcessState(await invoke<unknown>("get_game_process_state", { id }), id);
    return state ?? { ...fallback, windows: true, error: PROCESS_FAILURE_REASON };
  } catch {
    return { ...fallback, windows: true, error: PROCESS_FAILURE_REASON };
  }
}
