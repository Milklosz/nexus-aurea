import { invoke, isTauri } from "@tauri-apps/api/core";
import { playniteLaunchRef } from "../contracts";

/**
 * Granica adaptera biblioteki Playnite (VELORA 1.0).
 *
 * Bezpiecznym źródłem danych jest wyłącznie jawny manifest JSON wygenerowany
 * przez rozszerzenie Playnite. VELORA nigdy nie otwiera bazy SQLite Playnite,
 * nie odczytuje nieudokumentowanych plików biblioteki, nie zgaduje ich układu
 * i nie zapisuje niczego w danych Playnite. Brak manifestu kończy się jawnym
 * snapshotem `unavailable` — bez wymyślonych gier.
 */

/** Metadane gry. TYLKO DO ODCZYTU — pochodzą wyłącznie z potwierdzonego źródła. */
export type PlayniteGame = {
  id: string;
  name: string;
  cover: string | null;
  source: string;
  lastPlayed: string | null;
};

export type PlayniteLibrarySnapshot = {
  /** `playnite-api` = udokumentowane API, `playnite-detected` = tylko wykrycie pliku exe, `unavailable` = brak danych. */
  source: "playnite-api" | "playnite-detected" | "unavailable";
  /** Czy VELORA ma dostęp do potwierdzonych metadanych gier (samo wykrycie Playnite to `false`). */
  available: boolean;
  reason: string | null;
  games: PlayniteGame[];
  /** VELORA nigdy nie modyfikuje metadanych Playnite. Wymuszane niezależnie od odpowiedzi adaptera. */
  readOnly: true;
};

export interface PlayniteLibraryAdapter {
  read(): Promise<PlayniteLibrarySnapshot>;
}

/* ------------------------------------------------------------------------- *
 * v1-ecosystem: bogatszy, typowany widok manifestu (ADDITIVE).
 * Kształt zgodny z `playnite_manifest::PlayniteManifestView` (camelCase).
 * ------------------------------------------------------------------------- */

export type PlayniteManifestLaunch = {
  kind: string;
  uri: string;
};

export type PlayniteManifestGame = {
  id: string;
  name: string;
  cover: string | null;
  source: string;
  lastPlayed: string | null;
  favorite: boolean;
  installed: boolean;
  playCount: number;
  playtimeSeconds: number;
  launch: PlayniteManifestLaunch | null;
};

export type PlayniteManifestView = {
  schemaVersion: number;
  generatedAt: string;
  source: string;
  readOnly: boolean;
  gameCount: number;
  games: PlayniteManifestGame[];
  diagnostics: string[];
};

const FALLBACK_REASON =
  "Brak bezpiecznego, udokumentowanego API Playnite. VELORA nie odczytuje plików bazy danych Playnite ani nie zgaduje jej struktury.";

const READ_FAILURE_REASON =
  "Nie udało się odczytać biblioteki Playnite przez bezpieczne API. VELORA nie wyświetla danych gier bez potwierdzonego źródła.";

const MAX_COVER_SOURCE_LENGTH = 2_000_000;

function unavailableSnapshot(reason: string): PlayniteLibrarySnapshot {
  return { source: "unavailable", available: false, reason, games: [], readOnly: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeGame(value: unknown): PlayniteGame | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.name !== "string" || value.name.length === 0) return null;
  return {
    id: value.id,
    name: value.name,
    cover: typeof value.cover === "string" ? sanitizeCoverSource(value.cover) : null,
    source: typeof value.source === "string" ? value.source : "",
    lastPlayed: typeof value.lastPlayed === "string" ? value.lastPlayed : null,
  };
}

/**
 * Odrzuca każdą odpowiedź, której nie potwierdza bezpieczne źródło.
 * Tylko `playnite-api` może nieść listę gier; `playnite-detected` i `unavailable`
 * z definicji nie zawierają metadanych. Rzut -> `unavailable` (żadnych wymyślonych danych).
 */
function normalizeSnapshot(value: unknown): PlayniteLibrarySnapshot {
  if (!isRecord(value)) throw new Error("Nieprawidłowa odpowiedź biblioteki Playnite.");
  const source = value.source;
  if (source !== "playnite-api" && source !== "playnite-detected" && source !== "unavailable") {
    throw new Error("Nieznane źródło biblioteki Playnite.");
  }
  if (typeof value.available !== "boolean") throw new Error("Niepotwierdzona dostępność biblioteki Playnite.");
  if (value.reason !== null && typeof value.reason !== "string") throw new Error("Nieprawidłowy powód niedostępności.");
  if (!Array.isArray(value.games)) throw new Error("Brak listy gier w odpowiedzi biblioteki Playnite.");
  if (value.readOnly !== true) throw new Error("Biblioteka Playnite musi pozostać tylko do odczytu.");

  const games = source === "playnite-api"
    ? value.games.map(normalizeGame).filter((game): game is PlayniteGame => game !== null)
    : [];

  return {
    source,
    available: value.available,
    reason: value.reason as string | null,
    games,
    readOnly: true,
  };
}

/** Adapter natywny: wyłącznie `invoke("get_playnite_library")`, bez jakiegokolwiek zapisu. */
export function createTauriPlayniteAdapter(): PlayniteLibraryAdapter {
  const fallback = createFallbackPlayniteAdapter();
  return {
    async read() {
      // Podgląd webowy (poza Tauri) korzysta z fallbacku i NIGDY nie woła invoke.
      if (!isTauri()) return fallback.read();
      try {
        return normalizeSnapshot(await invoke<unknown>("get_playnite_library"));
      } catch {
        // AWARIA = jawny brak danych. Nigdy nie generujemy przykładowych gier.
        return unavailableSnapshot(READ_FAILURE_REASON);
      }
    },
  };
}

/** Fallback używany w podglądzie webowym i zawsze wtedy, gdy brak bezpiecznego API. */
export function createFallbackPlayniteAdapter(): PlayniteLibraryAdapter {
  return { read: async () => unavailableSnapshot(FALLBACK_REASON) };
}

/** Jedyny punkt wejścia UI do danych biblioteki. Każdy błąd adaptera = `unavailable`. */
export async function readPlayniteLibrary(
  adapter: PlayniteLibraryAdapter = createTauriPlayniteAdapter(),
): Promise<PlayniteLibrarySnapshot> {
  try {
    return await adapter.read();
  } catch {
    return unavailableSnapshot(READ_FAILURE_REASON);
  }
}

export type PlayniteLaunchReceipt = {
  gameId: string;
  launched: boolean;
  playniteLaunchId: string | null;
};

const LAUNCH_UNAVAILABLE =
  "Uruchamianie gier Playnite jest dostępne tylko w natywnej aplikacji Windows.";
const LAUNCH_FAILURE =
  "Nie udało się uruchomić gry przez Playnite. Sprawdź instalację i spróbuj ponownie.";

function safeLaunchMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (!raw || raw.length > 240 || /[\u0000-\u001f\u007f]/.test(raw)) return LAUNCH_FAILURE;
  if (/\\|\/|os error|Error:|0x[0-9a-f]/i.test(raw)) return LAUNCH_FAILURE;
  return raw;
}

/**
 * Uruchomienie gry WYŁĄCZNIE przez zweryfikowany identyfikator GUID. Backend
 * ponownie sprawdza manifest i buduje kanoniczne `playnite://playnite/start/...`.
 */
export async function launchPlayniteGame(gameId: string): Promise<PlayniteLaunchReceipt> {
  if (!isTauri()) throw new Error(LAUNCH_UNAVAILABLE);
  const ref = playniteLaunchRef(gameId);
  if (ref === null || ref.kind !== "playnite-uri") {
    throw new Error("Nieprawidłowy identyfikator gry Playnite.");
  }
  try {
    const raw = await invoke<unknown>("launch_playnite_game", { gameId });
    if (!isRecord(raw) || raw.gameId !== gameId || raw.launched !== true) {
      throw new Error(LAUNCH_FAILURE);
    }
    const launchId = typeof raw.playniteLaunchId === "string" ? raw.playniteLaunchId : null;
    return { gameId, launched: true, playniteLaunchId: launchId };
  } catch (cause) {
    throw new Error(safeLaunchMessage(cause));
  }
}

/** Czysty, bezpieczny komunikat dla panelu biblioteki. */
export function playniteLaunchErrorMessage(cause: unknown): string {
  return safeLaunchMessage(cause);
}

/**
 * Przepuszcza WYŁĄCZNIE bezpieczne źródła okładek:
 *  - `data:image/(png|jpeg|webp|gif);base64,...`
 *  - `asset:` (protokół assetów Tauri)
 *  - `http://asset.localhost/` (protokół assetów Tauri)
 *
 * Odrzuca `javascript:`, `file:`, dowolne zdalne hosty http(s), cudzysłowy,
 * białe znaki i znaki sterujące. Nigdy nie buduje ścieżki do bazy Playnite.
 */
export function sanitizeCoverSource(value: string | null): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_COVER_SOURCE_LENGTH) return null;
  // Cudzysłowy, białe znaki, znaki sterujące (ASCII + C1) — zawsze odrzucane.
  if (/["'\s\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  if (value.startsWith("asset:") && value.length > "asset:".length) return value;
  if (value.startsWith("http://asset.localhost/")) return value;
  return null;
}

/* ------------------------------------------------------------------------- *
 * STAN LOKALNY VELORA — NIE JEST TO METADANA PLAYNITE.
 *
 * Ulubione i „ostatnio grane" żyją wyłącznie w localStorage WebView VELORA
 * (klucze `velora.v1.*`). Nie odpytujemy, nie modyfikujemy i nie zapisujemy
 * niczego w bazie ani plikach Playnite. Są to preferencje/historia wyborów
 * w interfejsie VELORA, a nie historia rozgrywek z Playnite.
 * ------------------------------------------------------------------------- */

const FAVORITES_KEY = "velora.v1.playnite.favorites";
const RECENTS_KEY = "velora.v1.playnite.recentlyPlayed";
const MAX_RECENTS = 12;

function readIds(key: string, storage: Pick<Storage, "getItem">): string[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, MAX_RECENTS);
  } catch {
    // Storage zablokowany lub uszkodzony JSON — zwracamy pustą listę, bez zgadywania.
    return [];
  }
}

function writeIds(key: string, ids: string[], storage: Pick<Storage, "getItem" | "setItem">): string[] {
  try {
    storage.setItem(key, JSON.stringify(ids));
  } catch {
    // Stan pozostaje widoczny w tej sesji, nawet gdy zapis jest niemożliwy.
  }
  return ids;
}

export function readFavorites(storage: Pick<Storage, "getItem"> = localStorage): string[] {
  return readIds(FAVORITES_KEY, storage);
}

export function toggleFavorite(id: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): string[] {
  const current = readFavorites(storage);
  if (typeof id !== "string" || id.length === 0) return current;
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
  return writeIds(FAVORITES_KEY, next, storage);
}

export function readRecentlyPlayed(storage: Pick<Storage, "getItem"> = localStorage): string[] {
  return readIds(RECENTS_KEY, storage);
}

/** Zapamiętuje wybór gry w VELORA (max 12, najnowsze pierwsze, bez duplikatów). */
export function noteRecentlyPlayed(id: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): string[] {
  const current = readRecentlyPlayed(storage);
  if (typeof id !== "string" || id.length === 0) return current;
  const next = [id, ...current.filter((entry) => entry !== id)].slice(0, MAX_RECENTS);
  return writeIds(RECENTS_KEY, next, storage);
}

/**
 * Czysty helper 2D nawigacji po siatce okładek (indeks liniowy, `columns` kolumn).
 *
 *  - ArrowLeft  : index - 1
 *  - ArrowRight : index + 1
 *  - ArrowUp    : index - columns
 *  - ArrowDown  : index + columns
 *
 * Wynik jest zawsze docinany do [0, count - 1] (brak zawijania wierszy).
 * Nieznane klawisze zwracają `index` bez zmian. Dla pustej siatki, nieprawidłowych
 * `columns`/`count` lub nieskończonego indeksu zwracany jest `index` bez zmian.
 */
export function moveGridFocus(index: number, key: string, columns: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isInteger(count) || count < 1) return index;
  if (!Number.isFinite(columns) || columns < 1) return index;

  const step = Math.floor(columns);
  const current = Math.min(Math.max(index, 0), count - 1);
  let next: number;
  switch (key) {
    case "ArrowLeft": next = current - 1; break;
    case "ArrowRight": next = current + 1; break;
    case "ArrowUp": next = current - step; break;
    case "ArrowDown": next = current + step; break;
    default: return index;
  }
  return Math.min(Math.max(next, 0), count - 1);
}

/* ------------------------------------------------------------------------- *
 * v1-ecosystem: typowany widok manifestu + NOWY adapter (ADDITIVE).
 * `readPlayniteLibrary` i jego domyślny parametr pozostają BEZ ZMIAN.
 * ------------------------------------------------------------------------- */

const EXPECTED_MANIFEST_KIND = "velora.playnite.library-manifest";
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

/** Jedyna bezpieczna postać uruchomienia: uri wyprowadzone z `id` gry. */
function isLaunchRef(value: unknown, gameId: string): value is PlayniteManifestLaunch {
  if (!isRecord(value)) return false;
  if (value.kind !== "playnite-uri") return false;
  if (typeof value.uri !== "string") return false;
  const ref = playniteLaunchRef(gameId);
  return ref !== null && ref.kind === "playnite-uri" && value.uri === ref.target;
}

function isManifestGame(value: unknown): value is PlayniteManifestGame {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  // Id musi być Guid — `playniteLaunchRef` zwraca null dla każdego innego kształtu.
  if (playniteLaunchRef(value.id) === null) return false;
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 512) return false;
  if (value.cover !== null && typeof value.cover !== "string") return false;
  if (typeof value.cover === "string" && sanitizeCoverSource(value.cover) === null) return false;
  if (typeof value.source !== "string" || value.source.length > 128) return false;
  if (value.lastPlayed !== null && typeof value.lastPlayed !== "string") return false;
  if (typeof value.lastPlayed === "string" && (value.lastPlayed.length > 64 || !ISO_UTC.test(value.lastPlayed))) return false;
  if (typeof value.favorite !== "boolean") return false;
  if (typeof value.installed !== "boolean") return false;
  if (!isCounter(value.playCount) || !isCounter(value.playtimeSeconds)) return false;
  if (value.launch !== null && !isLaunchRef(value.launch, value.id)) return false;
  return true;
}

/**
 * Ścisła walidacja odpowiedzi `get_playnite_manifest`. Widok natywny nie niesie
 * pola `kind` (jest zbudowany z już-zwalidowanego manifestu); jeśli `kind`
 * występuje, musi być poprawne. Każde odchylenie → `null`, bez rzucania błędu.
 */
function validateManifestView(value: unknown): PlayniteManifestView | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (value.source !== "playnite-api") return null;
  if (value.readOnly !== true) return null;
  if (value.kind !== undefined && value.kind !== EXPECTED_MANIFEST_KIND) return null;
  const generatedAt: unknown = value.generatedAt;
  if (typeof generatedAt !== "string" || generatedAt.length > 64 || !ISO_UTC.test(generatedAt)) return null;
  if (!Array.isArray(value.games)) return null;
  const gameCount: unknown = value.gameCount;
  if (!isCounter(gameCount)) return null;
  if (!Array.isArray(value.diagnostics)) return null;
  const diagnostics: string[] = [];
  for (const entry of value.diagnostics as unknown[]) {
    if (typeof entry !== "string") return null;
    diagnostics.push(entry);
  }

  const seen = new Set<string>();
  const games: PlayniteManifestGame[] = [];
  for (const game of value.games) {
    if (!isManifestGame(game)) return null;
    if (seen.has(game.id)) return null;
    seen.add(game.id);
    games.push(game);
  }
  if (games.length !== gameCount) return null;

  return {
    schemaVersion: 1,
    generatedAt,
    source: "playnite-api",
    readOnly: true,
    gameCount: games.length,
    games,
    diagnostics,
  };
}

/**
 * Nowa komenda `get_playnite_manifest` — typowany widok manifestu.
 * W podglądzie webowym NIE woła `invoke`. Dowolna awaria (odrzucenie, zły
 * kształt, duplikat, niebezpieczna okładka, wstrzyknięte uri) → `null`.
 */
export async function readPlayniteManifest(): Promise<PlayniteManifestView | null> {
  try {
    if (!isTauri()) return null;
    const raw: unknown = await invoke<unknown>("get_playnite_manifest");
    return validateManifestView(raw);
  } catch {
    return null;
  }
}

/**
 * Czysty helper: bezpieczna referencja uruchomienia wyprowadzona z `id`
 * i ponownie zweryfikowana względem `launch.uri`. `null` przy rozbieżności.
 */
export function playniteLaunchRefFor(game: PlayniteManifestGame): PlayniteManifestLaunch | null {
  const ref = playniteLaunchRef(game.id);
  if (ref === null || ref.kind !== "playnite-uri") return null;
  const launch = game.launch;
  if (launch === null || launch.kind !== "playnite-uri" || launch.uri !== ref.target) return null;
  return { kind: "playnite-uri", uri: launch.uri };
}

/**
 * NOWY adapter (opt-in): mapuje zwalidowany widok na ISTNIEJĄCY kształt
 * `PlayniteLibrarySnapshot` przez `normalizeSnapshot` (okładki zsanityzowane).
 * Nie zmienia domyślnego adaptera `readPlayniteLibrary()`.
 */
export function createManifestPlayniteAdapter(): PlayniteLibraryAdapter {
  return {
    async read() {
      const view = await readPlayniteManifest();
      if (view === null) return unavailableSnapshot(READ_FAILURE_REASON);
      try {
        return normalizeSnapshot({
          source: "playnite-api",
          available: true,
          reason: null,
          games: view.games.map((game) => ({
            id: game.id,
            name: game.name,
            cover: game.cover,
            source: game.source,
            lastPlayed: game.lastPlayed,
          })),
          readOnly: true,
        });
      } catch {
        return unavailableSnapshot(READ_FAILURE_REASON);
      }
    },
  };
}
