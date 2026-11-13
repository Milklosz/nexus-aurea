import { describe, expect, it } from "vitest";
import { DEFAULT_HOME_THEME, parseHomeTheme, resolveHomeTheme } from "../services/homeTheme";

describe("home theme resolution", () => {
  it("defaults to the Living Room redesign", () => {
    expect(DEFAULT_HOME_THEME).toBe("living-room");
    expect(resolveHomeTheme({})).toBe("living-room");
  });

  it("lets the old Grand Cinema Home be restored from storage or the build default", () => {
    expect(resolveHomeTheme({ stored: "grand-cinema" })).toBe("grand-cinema");
    expect(resolveHomeTheme({ buildDefault: "grand-cinema" })).toBe("grand-cinema");
  });

  it("prefers the URL over storage, and storage over the build default", () => {
    expect(resolveHomeTheme({ search: "?homeTheme=grand-cinema", stored: "living-room" })).toBe("grand-cinema");
    expect(resolveHomeTheme({ stored: "grand-cinema", buildDefault: "living-room" })).toBe("grand-cinema");
  });

  it("ignores unknown values", () => {
    expect(parseHomeTheme("neon")).toBeNull();
    expect(resolveHomeTheme({ search: "?homeTheme=neon", stored: "x", buildDefault: "" })).toBe("living-room");
  });
});
