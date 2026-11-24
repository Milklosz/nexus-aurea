// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  gameCollectionKey,
  gameCollection,
  favoriteGame,
  recordGameLaunch,
  emptyGamingCollections,
} from "../services/gamingCollections";
import type { ManagedGame } from "../services/appManager";

const GUID = "64f78cd1-0b00-4271-a9e1-89abc55f66cc";
const UPPER_GUID = "64F78CD1-0B00-4271-A9E1-89ABC55F66CC";

/**
 * S3.8 Gaming Hub 4.0 — collection keys are the only persisted game identity.
 * They must accept exactly the shapes the merged Steam/Playnite library emits
 * (`steam:<appid>`, `playnite:<guid>`, legacy numeric appids) and normalize the
 * Playnite form so one GUID cannot split into two favorites.
 */
describe("gaming collection keys (S3.8)", () => {
  it("normalizes Playnite GUID casing and rejects malformed identifiers", () => {
    expect(gameCollectionKey(`playnite:${GUID}`)).toBe(`playnite:${GUID}`);
    expect(gameCollectionKey(`playnite:${UPPER_GUID}`)).toBe(`playnite:${GUID}`);
    // Braced, shortened, non-hex and trailing-content forms are refused.
    expect(gameCollectionKey(`playnite:{${GUID}}`)).toBeNull();
    expect(gameCollectionKey("playnite:64f78cd1")).toBeNull();
    expect(gameCollectionKey(`playnite:${GUID}x`)).toBeNull();
    expect(gameCollectionKey("playnite:")).toBeNull();
  });

  it("accepts canonical and legacy Steam identities and rejects executable-like strings", () => {
    expect(gameCollectionKey("steam:440")).toBe("steam:440");
    expect(gameCollectionKey("440")).toBe("440");
    expect(gameCollectionKey("STEAM:440")).toBeNull();
    expect(gameCollectionKey("steam:")).toBeNull();
    expect(gameCollectionKey("steam:0")).toBeNull();
    expect(gameCollectionKey("steam:4294967296")).toBeNull();
    expect(gameCollectionKey("cmd.exe")).toBeNull();
    expect(gameCollectionKey("steam://run/440")).toBeNull();
  });

  it("keeps one entry per game after GUID casing normalization", () => {
    let value = recordGameLaunch(emptyGamingCollections(), `playnite:${UPPER_GUID}`);
    value = recordGameLaunch(value, `playnite:${GUID}`);
    expect(value.recent).toEqual([`playnite:${GUID}`]);
  });

  it("resolves favorites only against installed library entries with the same key", () => {
    const steam: ManagedGame = { id: "steam:440", name: "Team Fortress 2", launcher: "steam" };
    const playnite: ManagedGame = { id: `playnite:${GUID}`, name: "GOG Classic", launcher: "playnite" };
    const installed = [steam, playnite];
    expect(gameCollection(installed, ["steam:440", `playnite:${UPPER_GUID}`])).toEqual([steam, playnite]);
    expect(gameCollection(installed, ["steam:220"])).toEqual([]);
    expect(gameCollection([], [`playnite:${GUID}`])).toEqual([]);
  });

  it("resolves legacy Steam favorites against canonical entries and toggles either alias once", () => {
    const steam: ManagedGame = { id: "steam:440", name: "Team Fortress 2", launcher: "steam" };
    const legacy = favoriteGame(emptyGamingCollections(), "440");
    expect(gameCollection([steam], ["440", "steam:440"])).toEqual([steam]);
    expect(favoriteGame(legacy, steam.id).favorites).toEqual([]);
    expect(recordGameLaunch(recordGameLaunch(legacy, "440"), steam.id).recent).toEqual([steam.id]);
  });
});
