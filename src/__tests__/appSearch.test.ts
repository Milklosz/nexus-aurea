import { describe, expect, it } from "vitest";
import { streamingServices } from "../data/streamingServices";
import {
  collectSearchEntries,
  normalizeSearchText,
  searchEntries,
  tileSearchEntries,
  type SearchEntry,
} from "../services/appSearch";

const entries: SearchEntry[] = [
  { id: "a", title: "HBO Max", group: "Streaming", keywords: ["HBO MAX", "wideo"] },
  { id: "b", title: "Max Payne", group: "Gra", keywords: [] },
  { id: "c", title: "Steam", group: "Aplikacja", keywords: ["gry"] },
];

describe("normalizeSearchText", () => {
  it("drops diacritics and folds Polish ł, so queries match regardless of accents", () => {
    expect(normalizeSearchText("Żółw Łódź")).toBe("zolw lodz");
  });

  it("lower-cases, collapses spaces and trims", () => {
    expect(normalizeSearchText("  HBO    Max  ")).toBe("hbo max");
  });
});

describe("searchEntries", () => {
  it("returns every entry in order for an empty or blank query", () => {
    expect(searchEntries(entries, "").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(searchEntries(entries, "   ").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("filters by title, case and accent insensitively", () => {
    expect(searchEntries(entries, "STEAM").map((entry) => entry.id)).toEqual(["c"]);
  });

  it("matches a keyword that is not in the title", () => {
    expect(searchEntries(entries, "gry").map((entry) => entry.id)).toEqual(["c"]);
    expect(searchEntries(entries, "wideo").map((entry) => entry.id)).toEqual(["a"]);
  });

  it("requires every query word to match", () => {
    expect(searchEntries(entries, "hbo max").map((entry) => entry.id)).toEqual(["a"]);
    expect(searchEntries(entries, "hbo steam")).toEqual([]);
  });

  it("ranks titles that start with the first word above other matches", () => {
    expect(searchEntries(entries, "max").map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("returns nothing for an unknown query", () => {
    expect(searchEntries(entries, "zzz")).toEqual([]);
  });

  it("does not mutate the provider list", () => {
    const copy = [...entries];
    searchEntries(entries, "max");
    expect(entries).toEqual(copy);
  });
});

describe("collectSearchEntries", () => {
  it("merges providers in order and keeps the first entry for a duplicate id", () => {
    const first = () => [{ id: "x", title: "Pierwszy", group: "A", keywords: [] }];
    const second = () => [
      { id: "x", title: "Duplikat", group: "B", keywords: [] },
      { id: "y", title: "Drugi", group: "B", keywords: [] },
    ];
    expect(collectSearchEntries([first, second]).map((entry) => [entry.id, entry.title])).toEqual([
      ["x", "Pierwszy"],
      ["y", "Drugi"],
    ]);
  });

  it("is ready for a games provider without changing search", () => {
    const games = () => [{ id: "game:portal", title: "Portal 2", group: "Gra", keywords: ["steam"] }];
    const all = collectSearchEntries([() => tileSearchEntries(streamingServices), games]);
    expect(searchEntries(all, "portal").map((entry) => entry.id)).toEqual(["game:portal"]);
  });
});

describe("tileSearchEntries", () => {
  const tiles = tileSearchEntries(streamingServices);

  it("creates one entry per home tile, namespaced as tile:<id>", () => {
    expect(tiles).toHaveLength(streamingServices.length);
    expect(tiles.find((entry) => entry.title === "Netflix")?.id).toBe("tile:netflix");
  });

  it("finds a tile by its name and by its label", () => {
    expect(searchEntries(tiles, "disney").map((entry) => entry.id)).toEqual(["tile:disney"]);
    expect(searchEntries(tiles, "prime video").map((entry) => entry.id)).toEqual(["tile:prime"]);
  });

  it("groups web services as Streaming and managed apps as Aplikacja", () => {
    expect(tiles.find((entry) => entry.id === "tile:netflix")?.group).toBe("Streaming");
    expect(tiles.find((entry) => entry.id === "tile:steam")?.group).toBe("Aplikacja");
  });

  it("finds all streaming services for a shared keyword", () => {
    const streaming = searchEntries(tiles, "wideo").filter((entry) => entry.group === "Streaming");
    expect(streaming.length).toBe(streamingServices.filter((service) => service.kind === "web").length);
  });
});
