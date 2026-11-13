import type { StreamingService } from "../data/streamingServices";

/**
 * Native VELORA search. Pure logic, no DOM. Entries come from providers, so new
 * sources (Steam and Playnite games, for example) add a provider and nothing else
 * changes in the search itself.
 */

export interface SearchEntry {
  /** Unique across providers. Games should use a prefix such as "game:". */
  id: string;
  title: string;
  /** Shown as a small label next to the title, e.g. "Streaming" or "Gra". */
  group: string;
  /** Extra words that match a query but are not shown in the title. */
  keywords: readonly string[];
}

export type SearchEntryProvider = () => readonly SearchEntry[];

/** Lower case, no diacritics, single spaces. Makes "hbo", "Disney+" and "zolty" behave as users expect. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "l")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Filters entries. Every query word must match the title or a keyword. Titles that
 * start with the first word rank first, then other title matches, then keyword-only
 * matches. Equal ranks keep the provider order. An empty query returns every entry.
 */
export function searchEntries(entries: readonly SearchEntry[], query: string): SearchEntry[] {
  const words = normalizeSearchText(query).split(" ").filter(Boolean);
  if (words.length === 0) return [...entries];

  const ranked: Array<{ entry: SearchEntry; rank: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const title = normalizeSearchText(entry.title);
    const keywords = entry.keywords.map(normalizeSearchText);
    const everyWordMatches = words.every((word) =>
      title.includes(word) || keywords.some((keyword) => keyword.includes(word)));
    if (!everyWordMatches) return;
    const rank = title.startsWith(words[0]) ? 0 : words.every((word) => title.includes(word)) ? 1 : 2;
    ranked.push({ entry, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((item) => item.entry);
}

/** Merges providers in order. The first entry with a given id wins; later duplicates are dropped. */
export function collectSearchEntries(providers: readonly SearchEntryProvider[]): SearchEntry[] {
  const seen = new Set<string>();
  const result: SearchEntry[] = [];
  for (const provider of providers) {
    for (const entry of provider()) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      result.push(entry);
    }
  }
  return result;
}

/** The home-screen tiles: streaming services and managed apps. */
export function tileSearchEntries(services: readonly StreamingService[]): SearchEntry[] {
  return services.map((service) => ({
    id: `tile:${service.id}`,
    title: service.name,
    group: service.kind === "web" ? "Streaming" : "Aplikacja",
    keywords: [service.label, service.kind === "web" ? "wideo film serial" : "muzyka aplikacja"],
  }));
}
