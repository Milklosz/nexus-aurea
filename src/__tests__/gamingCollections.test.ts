// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyGamingCollections, favoriteGame, gameCollection, parseGamingCollections, readGamingCollections, recordGameLaunch, saveGamingCollections, validSteamGameId } from "../services/gamingCollections";

beforeEach(() => {
  const entries = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }),
    clear: vi.fn(() => entries.clear()),
  } });
});
afterEach(() => { vi.restoreAllMocks(); });
describe("local gaming collections", () => {
  it("ignores malformed, unsupported and oversized storage without using executable metadata", () => {
    expect(parseGamingCollections("{" )).toEqual(emptyGamingCollections());
    expect(parseGamingCollections(JSON.stringify({ version: 2, favorites: ["440"] }))).toEqual(emptyGamingCollections());
    expect(parseGamingCollections(" ".repeat(16_385))).toEqual(emptyGamingCollections());
    expect(parseGamingCollections(JSON.stringify({ version: 1, favorites: ["440", "440", "cmd.exe", "0", "4294967296"], recent: ["570"] }))).toEqual({ version: 1, favorites: ["440"], recent: ["570"] });
  });
  it("bounds lists and persists identities only", () => {
    const value = parseGamingCollections(JSON.stringify({ version: 1, favorites: Array.from({ length: 100 }, (_, i) => String(i + 1)), recent: [] }));
    expect(value.favorites).toHaveLength(64);
    expect(saveGamingCollections(value)).toBe(true);
    expect(readGamingCollections()).toEqual(value);
  });
  it("orders unique launch requests newest first and toggles pinned games", () => {
    let value = recordGameLaunch(recordGameLaunch(emptyGamingCollections(), "440"), "570");
    value = recordGameLaunch(value, "440");
    expect(value.recent).toEqual(["440", "570"]);
    expect(favoriteGame(favoriteGame(value, "440"), "440").favorites).toEqual([]);
    expect(recordGameLaunch(value, "steam://bad")).toBe(value);
  });
  it("resolves collection IDs only against the current installed library", () => {
    const installed = [{ id: "570", name: "Local game", launcher: "Steam" }];
    expect(gameCollection(installed, ["440", "570", "570"])).toEqual(installed);
    expect(gameCollection([], ["570"])).toEqual([]);
  });
  it("handles unavailable storage without blocking game actions", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw Error("denied"); });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw Error("quota"); });
    expect(readGamingCollections()).toEqual(emptyGamingCollections());
    expect(saveGamingCollections(emptyGamingCollections())).toBe(false);
  });
  it("accepts only canonical unsigned nonzero Steam app IDs", () => {
    for (const value of ["0", "01", "-1", "1.2", "4294967296", {}, 440]) expect(validSteamGameId(value)).toBe(false);
    expect(validSteamGameId("4294967295")).toBe(true);
  });
  it("preserves future and unsupported storage across session-only edits", () => {
    for (const raw of [
      JSON.stringify({ version: 2, favorites: ["440"], futureMetadata: { keep: true } }),
      JSON.stringify({ version: "1", favorites: ["570"] }),
      JSON.stringify({ favorites: ["440"] }),
      "{",
      " ".repeat(16_385),
    ]) {
      window.localStorage.setItem("velora.gaming-collections.v1", raw);
      const sessionState = favoriteGame(readGamingCollections(), "570");
      expect(sessionState.favorites).toEqual(["570"]);
      expect(saveGamingCollections(sessionState)).toBe(false);
      expect(window.localStorage.getItem("velora.gaming-collections.v1")).toBe(raw);
    }
  });
  it("checks the current stored version again immediately before saving", () => {
    const sessionState = readGamingCollections();
    const future = JSON.stringify({ version: 3, recent: ["440"] });
    window.localStorage.setItem("velora.gaming-collections.v1", future);
    expect(saveGamingCollections(recordGameLaunch(sessionState, "570"))).toBe(false);
    expect(window.localStorage.getItem("velora.gaming-collections.v1")).toBe(future);
  });
});
