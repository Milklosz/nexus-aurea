import type { ManagedGame } from "./appManager";

const KEY = "velora.gaming-collections.v1";
const MAX_ITEMS = 64;
export type GamingCollections = { version: 1; favorites: string[]; recent: string[] };
export const emptyGamingCollections = (): GamingCollections => ({ version: 1, favorites: [], recent: [] });

/** Local Steam manifest identities only. Never use persisted names, executable paths or URLs. */
export function validSteamGameId(id: unknown): id is string {
  return typeof id === "string" && /^[1-9][0-9]{0,9}$/.test(id) && Number(id) <= 4294967295;
}
function ids(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(validSteamGameId))].slice(0, MAX_ITEMS) : [];
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
  if (!validSteamGameId(id)) return value;
  return { ...value, favorites: value.favorites.includes(id) ? value.favorites.filter(item => item !== id) : ids([...value.favorites, id]) };
}
export function recordGameLaunch(value: GamingCollections, id: string): GamingCollections {
  if (!validSteamGameId(id)) return value;
  return { ...value, recent: ids([id, ...value.recent.filter(item => item !== id)]) };
}
export function gameCollection(games: readonly ManagedGame[], order: readonly string[]): ManagedGame[] {
  const installed = new Map(games.filter(game => validSteamGameId(game.id)).slice(0, 4096).map(game => [game.id, game]));
  return ids(order).flatMap(id => { const game = installed.get(id); return game ? [game] : []; });
}
