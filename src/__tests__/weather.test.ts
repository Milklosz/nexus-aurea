import { describe, expect, it } from "vitest";
import { describeWeatherCode } from "../services/weather";

describe("describeWeatherCode", () => {
  it.each([
    { code: 0, expected: "Pogodnie" },
    { code: 3, expected: "Pochmurno" },
    { code: 61, expected: "Deszcz" },
    { code: 71, expected: "Śnieg" },
    { code: 95, expected: "Burza" },
  ])("maps WMO code $code to Polish text", ({ code, expected }) => {
    expect(describeWeatherCode(code)).toBe(expected);
  });

  it("keeps an unknown code readable", () => {
    expect(describeWeatherCode(1234)).toBe("Warunki zmienne");
  });
});
