import { describe, expect, it } from "vitest";
import {
  AMBIENT_IDLE_OPTIONS,
  DEFAULT_AMBIENT_SETTINGS,
  idleDeadlineReached,
  nextAmbientDelay,
  readAmbientSettings,
  saveAmbientSettings,
} from "../services/ambient";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("AUREA Ambient idle settings", () => {
  it("starts opt-in with a five minute idle delay", () => {
    expect(readAmbientSettings({ getItem: () => null, setItem: () => {} })).toEqual(DEFAULT_AMBIENT_SETTINGS);
  });

  it("stores supported delays and rejects invalid values safely", () => {
    const storage = memoryStorage();
    saveAmbientSettings({ enabled: true, idleSeconds: 600 }, storage);
    expect(readAmbientSettings(storage)).toEqual({ enabled: true, idleSeconds: 600 });
    storage.setItem("nexus.ambientSettings", JSON.stringify({ enabled: true, idleSeconds: 2 }));
    expect(readAmbientSettings(storage)).toEqual({ enabled: true, idleSeconds: 300 });
    expect(AMBIENT_IDLE_OPTIONS).toEqual([60, 300, 600, 900, 1800]);
  });

  it("only enters Ambient after the full idle interval", () => {
    expect(idleDeadlineReached(1000, 60999, 60)).toBe(false);
    expect(idleDeadlineReached(1000, 61000, 60)).toBe(true);
    expect(idleDeadlineReached(2000, 1000, 60)).toBe(false);
  });

  it("cycles idle choices without escaping the supported set", () => {
    expect(nextAmbientDelay(300)).toBe(600);
    expect(nextAmbientDelay(1800)).toBe(60);
  });
});