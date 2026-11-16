import { describe, expect, it } from "vitest";
import {
  createSmartHomeStore, DEFAULT_FAVORITES, parseSmartHomeState, SMART_HOME_STORAGE_KEY,
  type SmartHomeStorage,
} from "../services/smartHome";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: SmartHomeStorage = {
    getItem: () => value,
    setItem: (key, next) => { expect(key).toBe(SMART_HOME_STORAGE_KEY); value = next; },
  };
  return { storage, read: () => value };
}

describe("Smart Home persistence", () => {
  it("records confirmed identities in MRU order and restores them across restarts", () => {
    const memory = memoryStorage();
    const first = createSmartHomeStore(memory.storage);
    first.recordLaunch("netflix"); first.recordLaunch("youtube"); first.recordLaunch("netflix");
    expect(first.getSnapshot().recents).toEqual(["netflix", "youtube"]);
    expect(createSmartHomeStore(memory.storage).getSnapshot().recents).toEqual(["netflix", "youtube"]);
    expect(JSON.parse(memory.read()!)).toEqual({ version: 1, favorites: DEFAULT_FAVORITES, recents: ["netflix", "youtube"] });
  });

  it("rejects arbitrary URLs and removed identities without storing browsing metadata", () => {
    const memory = memoryStorage();
    const store = createSmartHomeStore(memory.storage);
    store.recordLaunch("https://example.com/private"); store.recordLaunch("removed-app");
    store.setFavorite("../../secret", true);
    expect(memory.read()).toBeNull();
    expect(parseSmartHomeState(JSON.stringify({ version: 1, favorites: ["netflix", "removed", "netflix"], recents: ["youtube", { title: "private" }] })))
      .toEqual({ version: 1, favorites: ["netflix"], recents: ["youtube"], persistence: "saved" });
  });

  it("pins, reorders, removes and restores defaults while retaining recents", () => {
    const memory = memoryStorage(JSON.stringify({ version: 1, favorites: [], recents: ["youtube"] }));
    const store = createSmartHomeStore(memory.storage);
    store.setFavorite("steam", true); store.setFavorite("netflix", true); store.setFavorite("steam", true);
    store.moveFavorite("netflix", -1);
    expect(store.getSnapshot().favorites).toEqual(["netflix", "steam"]);
    store.moveFavorite("netflix", -1); store.moveFavorite("missing", 1);
    expect(store.getSnapshot().favorites).toEqual(["netflix", "steam"]);
    store.setFavorite("steam", false);
    expect(createSmartHomeStore(memory.storage).getSnapshot().favorites).toEqual(["netflix"]);
    store.restoreFavorites();
    expect(store.getSnapshot().favorites).toEqual(DEFAULT_FAVORITES);
    expect(store.getSnapshot().recents).toEqual(["youtube"]);
  });

  it("migrates the supported legacy shape and bounds untrusted stored input", () => {
    expect(parseSmartHomeState('{"version":0,"favorites":["steam"],"recentApps":["netflix","netflix"]}'))
      .toEqual({ version: 1, favorites: ["steam"], recents: ["netflix"], persistence: "saved" });
    for (const raw of ["[broken", "null", '"string"', "x".repeat(16_385)]) {
      expect(parseSmartHomeState(raw).persistence).toBe("unavailable");
      expect(parseSmartHomeState(raw).favorites).toEqual(DEFAULT_FAVORITES);
    }
  });

  it("keeps the UI usable when reads/writes are denied and reports unsaved changes", () => {
    const storage = { getItem() { throw Error("blocked"); }, setItem() { throw Error("quota"); } };
    const store = createSmartHomeStore(storage);
    store.recordLaunch("steam"); store.setFavorite("steam", true);
    expect(store.getSnapshot().recents).toEqual(["steam"]);
    expect(store.getSnapshot().favorites).toContain("steam");
    expect(store.getSnapshot().persistence).toBe("unavailable");
    expect(createSmartHomeStore(null).getSnapshot().persistence).toBe("unavailable");
  });

  it("does not overwrite settings from a newer application version", () => {
    const original = '{"version":2,"favorites":["future"]}';
    const memory = memoryStorage(original);
    const store = createSmartHomeStore(memory.storage);
    store.recordLaunch("youtube"); store.restoreFavorites();
    expect(store.getSnapshot().persistence).toBe("newerVersion");
    expect(memory.read()).toBe(original);
  });

  it("notifies subscribers once per change, accepts external storage changes and unsubscribes", () => {
    const store = createSmartHomeStore(memoryStorage().storage);
    let updates = 0;
    const unsubscribe = store.subscribe(() => { updates += 1; });
    const stable = store.getSnapshot();
    expect(store.getSnapshot()).toBe(stable);
    store.recordLaunch("youtube");
    store.acceptStorageValue('{"version":1,"favorites":[],"recents":["steam"]}');
    expect(updates).toBe(2);
    expect(store.getSnapshot().recents).toEqual(["steam"]);
    unsubscribe(); store.recordLaunch("netflix");
    expect(updates).toBe(2);
  });
});
