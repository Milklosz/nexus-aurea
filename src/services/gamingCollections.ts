import type { ManagedGame } from "./appManager";

const KEY = "velora.gaming-collections.v1";
const MAX_ITEMS = 64;
export type GamingCollections = { version: 1; favorites: string[]; recent: string[] };
export const emptyGamingCollections = (): GamingCollections => ({ version: 1, favorites: [], recent: [] });

/** Local Steam manifest identities only. Never use persisted names, executable paths or URLs. */
export function validSteamGameId(id: unknown): id is string {
  return typeof id === "string" && /^[1-9][0-9]{0,9}$/.test(id) && Number(id) <= 4294967295;
}

const STEAM_KEY_PATTERN = /^steam:([1-9][0-9]{0,9})$/;
const PLAYNITE_KEY_PATTERN = /^playnite:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Klucz kolekcji gry (S3.2): numeryczny appid Steam (jak dotąd), kanoniczny
 * `steam:<appid>` albo `playnite:<guid>`. To NADZBIór `validSteamGameId` —
 * wszystkie dotychczasowe identyfikatory zachowują ważność.
 */
export function gameCollectionKey(id: unknown): string | null {
  if (typeof id !== "string") return null;
  // Same rule as validSteamGameId, inlined to avoid type-guard narrowing.
  const text = id as string;
  if (/^[1-9][0-9]{0,9}$/.test(text) && Number(text) <= 4294967295) return text;
  const steam = STEAM_KEY_PATTERN.exec(text);
  if (steam && Number(steam[1]) <= 4294967295) return text;
  if (PLAYNITE_KEY_PATTERN.test(text)) return text.toLowerCase();
  return null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(gameCollectionKey).filter((key): key is string => key !== null))].slice(0, MAX_ITEMS) : [];
}
export function parseGamingCollections(raw: string | null): GamingCollections {
  if (!raw || raw.length > 16_384) return emptyGamingCollections();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return emptyGamingCollections();
    const data = value as Record<string, unknown>;
    return { version: 1, favorites: ids(data.favorites), recent: ids(data.recent) };
  } catch { return emptyGamingCollections(); }
}
export function readGamingCollections(): GamingCollections {
  try { return parseGamingCollections(window.localStorage.getItem(KEY)); } catch { return emptyGamingCollections(); }
}
export function saveGamingCollections(value: GamingCollections): boolean {
  try {
    // Re-read at the write boundary: another build/tab may have upgraded storage
    // after this component loaded. Preserve anything this version cannot read.
    const existing = window.localStorage.getItem(KEY);
    if (existing !== null) {
      if (existing.length > 16_384) return false;
      const stored: unknown = JSON.parse(existing);
      if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1) return false;
    }
    window.localStorage.setItem(KEY, JSON.stringify({ version: 1, favorites: ids(value.favorites), recent: ids(value.recent) }));
    return true;
  }
  catch { return false; }
}
export function favoriteGame(value: GamingCollections, id: string): GamingCollections {
  const key = gameCollectionKey(id);
  if (key === null) return value;
  return { ...value, favorites: value.favorites.includes(key) ? value.favorites.filter(item => item !== key) : ids([...value.favorites, key]) };
}
export function recordGameLaunch(value: GamingCollections, id: string): GamingCollections {
  const key = gameCollectionKey(id);
  if (key === null) return value;
  return { ...value, recent: ids([key, ...value.recent.filter(item => item !== key)]) };
}
export function gameCollection(games: readonly ManagedGame[], order: readonly string[]): ManagedGame[] {
  const installed = new Map(games.filter(game => gameCollectionKey(game.id) !== null).slice(0, 4096).map(game => [gameCollectionKey(game.id) as string, game]));
  return ids(order).flatMap(id => { const game = installed.get(id); return game ? [game] : []; });
}
