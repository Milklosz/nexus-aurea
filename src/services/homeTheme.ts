/**
 * Which Home look is shown. "living-room" is the VELORA 2.0 redesign; "grand-cinema"
 * is the previous AUREA Grand Cinema Home, kept as a fallback. The old components and
 * styles are untouched, so switching back is a settings change, not a code change.
 *
 * Resolution order: `?homeTheme=` in the URL (dev / support) -> localStorage
 * `velora.homeTheme` (persisted choice) -> build-time `VITE_VELORA_HOME_THEME` -> "living-room".
 */
export type HomeTheme = "living-room" | "grand-cinema";

export const HOME_THEME_STORAGE_KEY = "velora.homeTheme";
export const DEFAULT_HOME_THEME: HomeTheme = "living-room";

export function parseHomeTheme(value: unknown): HomeTheme | null {
  return value === "living-room" || value === "grand-cinema" ? value : null;
}

export function resolveHomeTheme(sources: {
  search?: string | null;
  stored?: string | null;
  buildDefault?: string | null;
}): HomeTheme {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(sources.search ?? "").get("homeTheme");
  } catch {
    // A malformed query string never blocks the Home screen.
  }
  return parseHomeTheme(fromUrl)
    ?? parseHomeTheme(sources.stored)
    ?? parseHomeTheme(sources.buildDefault)
    ?? DEFAULT_HOME_THEME;
}

export function readHomeTheme(): HomeTheme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(HOME_THEME_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted webviews; the default theme applies.
  }
  let search: string | null = null;
  try {
    search = window.location.search;
  } catch {
    // No location (tests, restricted contexts).
  }
  const buildDefault = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_VELORA_HOME_THEME ?? null;
  return resolveHomeTheme({ search, stored, buildDefault });
}

export function saveHomeTheme(theme: HomeTheme): void {
  try {
    localStorage.setItem(HOME_THEME_STORAGE_KEY, theme);
  } catch {
    // The choice stays active until the app restarts.
  }
}
