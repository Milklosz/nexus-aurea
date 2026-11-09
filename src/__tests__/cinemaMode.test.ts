import { describe, expect, it } from "vitest";
import { readCinemaProfile, saveCinemaProfile, type CinemaProfile } from "../services/cinemaMode";

function storage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set("nexus.cinemaProfile", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("Cinema profile persistence", () => {
  it("defaults safely to Cinema and only accepts known profiles", () => {
    expect(readCinemaProfile(storage())).toBe("cinema");
    expect(readCinemaProfile(storage("unexpected"))).toBe("cinema");
    expect(readCinemaProfile(storage("gaming"))).toBe("gaming");
  });

  it.each(["cinema", "gaming", "desktop"] as CinemaProfile[])("remembers the %s profile", profile => {
    const store = storage();
    saveCinemaProfile(profile, store);
    expect(readCinemaProfile(store)).toBe(profile);
  });
});
