import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

import {
  createFallbackPlayniteAdapter,
  createTauriPlayniteAdapter,
  moveGridFocus,
  noteRecentlyPlayed,
  readFavorites,
  readPlayniteLibrary,
  readRecentlyPlayed,
  sanitizeCoverSource,
  toggleFavorite,
} from "../services/playniteLibrary";

const FALLBACK_REASON =
  "Brak bezpiecznego, udokumentowanego API Playnite. VELORA nie odczytuje plików bazy danych Playnite ani nie zgaduje jej struktury.";

function storage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    values,
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(true);
});

describe("Playnite adapter boundary", () => {
  it("fallback returns an explicit, read-only, empty unavailable snapshot", async () => {
    const snapshot = await readPlayniteLibrary(createFallbackPlayniteAdapter());
    expect(snapshot).toEqual({
      source: "unavailable",
      available: false,
      reason: FALLBACK_REASON,
      games: [],
      readOnly: true,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("web preview (non-Tauri) uses the fallback and never calls invoke", async () => {
    mocks.isTauri.mockReturnValue(false);
    const snapshot = await readPlayniteLibrary();
    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);
    expect(snapshot.readOnly).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("maps ANY invoke failure to an honest unavailable snapshot, never fake games", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("komenda niedostępna"));
    const snapshot = await readPlayniteLibrary(createTauriPlayniteAdapter());
    expect(mocks.invoke).toHaveBeenCalledWith("get_playnite_library");
    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.reason).toMatch(/Nie udało się odczytać biblioteki Playnite/);
  });

  it("rejects a malformed native response instead of showing invented data", async () => {
    mocks.invoke.mockResolvedValueOnce({ source: "unknown-source", available: true, reason: null, games: [{}], readOnly: false });
    const snapshot = await readPlayniteLibrary();
    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);
    expect(snapshot.readOnly).toBe(true);
  });

  it("passes through a documented read-only snapshot and sanitizes its covers", async () => {
    mocks.invoke.mockResolvedValueOnce({
      source: "playnite-api",
      available: true,
      reason: null,
      games: [
        { id: "g1", name: "Gra", cover: "data:image/png;base64,AAAA", source: "Playnite", lastPlayed: null },
        { id: "g2", name: "Zła okładka", cover: "javascript:alert(1)", source: "Playnite", lastPlayed: "2026-05-01T12:00:00Z" },
      ],
      readOnly: true,
    });
    const snapshot = await readPlayniteLibrary();
    expect(snapshot.source).toBe("playnite-api");
    expect(snapshot.available).toBe(true);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.games).toHaveLength(2);
    expect(snapshot.games[0].cover).toBe("data:image/png;base64,AAAA");
    expect(snapshot.games[1].cover).toBeNull();
  });

  it("never allows a detected-only or unavailable source to carry games", async () => {
    mocks.invoke.mockResolvedValueOnce({
      source: "playnite-detected",
      available: false,
      reason: "tylko wykrycie",
      games: [{ id: "fake", name: "Wymyślona gra", cover: null, source: "Playnite", lastPlayed: null }],
      readOnly: true,
    });
    const snapshot = await readPlayniteLibrary();
    expect(snapshot.source).toBe("playnite-detected");
    expect(snapshot.games).toEqual([]);
    expect(snapshot.readOnly).toBe(true);
  });

  it("always advertises readOnly: true even when the adapter throws", async () => {
    const throwing = { read: () => Promise.reject(new Error("boom")) };
    const snapshot = await readPlayniteLibrary(throwing);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.games).toEqual([]);
  });
});

describe("sanitizeCoverSource", () => {
  it.each([
    "javascript:alert(1)",
    "file:///C:/games/cover.png",
    "https://cdn.example.com/cover.png",
    "http://example.com/cover.png",
    "http://asset.localhost.evil.com/cover.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,AAAA",
    "data:image/png;base64,AAAA with space",
    "asset://localhost/cover.png\" onerror=\"alert(1)",
    "http://asset.localhost/cover.png\n",
    "",
  ])("rejects %j", (value) => {
    expect(sanitizeCoverSource(value)).toBeNull();
  });

  it("rejects null and non-string input", () => {
    expect(sanitizeCoverSource(null)).toBeNull();
    expect(sanitizeCoverSource(undefined as unknown as string | null)).toBeNull();
  });

  it.each([
    "data:image/png;base64,AAAA",
    "data:image/jpeg;base64,/9j/4AA=",
    "data:image/webp;base64,UklGRg==",
    "data:image/gif;base64,R0lGODlh",
    "asset://localhost/covers/g1.png",
    "http://asset.localhost/covers/g1.png",
  ])("accepts %j", (value) => {
    expect(sanitizeCoverSource(value)).toBe(value);
  });
});

describe("VELORA-local favorites and recently played", () => {
  it("persists favorites with injected storage under a velora.v1. key", () => {
    const store = storage();
    expect(readFavorites(store)).toEqual([]);
    expect(toggleFavorite("g1", store)).toEqual(["g1"]);
    expect(toggleFavorite("g2", store)).toEqual(["g1", "g2"]);
    expect(readFavorites(store)).toEqual(["g1", "g2"]);
    expect(toggleFavorite("g1", store)).toEqual(["g2"]);
    expect(store.values.get("velora.v1.playnite.favorites")).toBe('["g2"]');
  });

  it("bounds recents to 12, newest first, and de-duplicates", () => {
    const store = storage();
    let last: string[] = [];
    for (let index = 0; index < 20; index += 1) last = noteRecentlyPlayed(`g${index}`, store);
    expect(last).toHaveLength(12);
    expect(last[0]).toBe("g19");
    expect(readRecentlyPlayed(store)).toEqual(last);

    const small = storage();
    noteRecentlyPlayed("g1", small);
    noteRecentlyPlayed("g2", small);
    noteRecentlyPlayed("g1", small);
    expect(readRecentlyPlayed(small)).toEqual(["g1", "g2"]);
  });

  it("parses corrupted or non-array JSON safely", () => {
    const store = storage({
      "velora.v1.playnite.favorites": "{nie jest json",
      "velora.v1.playnite.recentlyPlayed": '{"games":[]}',
    });
    expect(readFavorites(store)).toEqual([]);
    expect(readRecentlyPlayed(store)).toEqual([]);
  });

  it("tolerates unavailable/blocked storage without throwing", () => {
    const blocked: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(readFavorites(blocked)).toEqual([]);
    expect(readRecentlyPlayed(blocked)).toEqual([]);
    expect(() => toggleFavorite("g1", blocked)).not.toThrow();
    expect(() => noteRecentlyPlayed("g1", blocked)).not.toThrow();
  });
});

describe("moveGridFocus", () => {
  it("moves in two dimensions (columns = 3, count = 7)", () => {
    expect(moveGridFocus(4, "ArrowUp", 3, 7)).toBe(1);
    expect(moveGridFocus(4, "ArrowDown", 3, 7)).toBe(6);
    expect(moveGridFocus(4, "ArrowLeft", 3, 7)).toBe(3);
    expect(moveGridFocus(4, "ArrowRight", 3, 7)).toBe(5);
  });

  it("clamps to [0, count) without wrapping", () => {
    expect(moveGridFocus(0, "ArrowUp", 3, 7)).toBe(0);
    expect(moveGridFocus(0, "ArrowLeft", 3, 7)).toBe(0);
    expect(moveGridFocus(6, "ArrowDown", 3, 7)).toBe(6);
    expect(moveGridFocus(6, "ArrowRight", 3, 7)).toBe(6);
  });

  it("returns the index unchanged for unknown keys", () => {
    expect(moveGridFocus(2, "Enter", 3, 7)).toBe(2);
    expect(moveGridFocus(2, "Home", 3, 7)).toBe(2);
    expect(moveGridFocus(2, "a", 3, 7)).toBe(2);
  });

  it("handles empty grids and out-of-range indices", () => {
    expect(moveGridFocus(0, "ArrowRight", 3, 0)).toBe(0);
    expect(moveGridFocus(99, "ArrowRight", 3, 4)).toBe(3);
    expect(moveGridFocus(2, "ArrowDown", 0, 4)).toBe(2);
  });
});
