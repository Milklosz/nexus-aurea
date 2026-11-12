// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOCK_ZONE,
  availableHomeZones,
  homeZoneOf,
  homeZoneTarget,
  nextHomeZone,
  stepMiniPlayer,
} from "../services/homeZones";

const HOME_MARKUP = `
  <button class="quick-settings-trigger" type="button">Control Center</button>
  <aside class="music-mini-player">
    <button type="button" id="mini-prev">Poprzedni</button>
    <button type="button" id="mini-play">Odtwórz</button>
    <button type="button" id="mini-next" disabled>Następny</button>
    <button type="button" id="mini-last">Ostatni</button>
  </aside>
  <div class="dock">
    <button class="app" type="button" id="app-0">Netflix</button>
    <button class="app" type="button" id="app-1">Steam</button>
  </div>
  <button class="diagnostics-trigger" type="button">Diagnostyka pada</button>
`;

const byId = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = HOME_MARKUP;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("home-screen zones", () => {
  it("recognises which zone an element belongs to", () => {
    expect(homeZoneOf(document.querySelector(".quick-settings-trigger"))).toBe(0);
    expect(homeZoneOf(byId("mini-play"))).toBe(1);
    expect(homeZoneOf(byId("app-1"))).toBe(DOCK_ZONE);
    expect(homeZoneOf(document.querySelector(".diagnostics-trigger"))).toBe(3);
    expect(homeZoneOf(document.body)).toBe(-1);
    expect(homeZoneOf(null)).toBe(-1);
  });

  it("lists only the zones that have something to focus", () => {
    expect(availableHomeZones(document)).toEqual([0, 1, 2, 3]);
    document.querySelector(".music-mini-player")?.remove();
    expect(availableHomeZones(document)).toEqual([0, 2, 3]);
    document.querySelector(".diagnostics-trigger")?.remove();
    expect(availableHomeZones(document)).toEqual([0, 2]);
  });

  it("moves up and down through the zones without wrapping", () => {
    const all = [0, 1, 2, 3];
    expect(nextHomeZone(0, all, 1)).toBe(1);
    expect(nextHomeZone(1, all, 1)).toBe(2);
    expect(nextHomeZone(3, all, -1)).toBe(2);
    expect(nextHomeZone(0, all, -1)).toBe(0);
    expect(nextHomeZone(3, all, 1)).toBe(3);
  });

  it("skips zones that are not on screen", () => {
    expect(nextHomeZone(0, [0, 2, 3], 1)).toBe(2);
    expect(nextHomeZone(2, [0, 2, 3], -1)).toBe(0);
  });

  it("starts from the dock when the focused element is outside every zone", () => {
    expect(nextHomeZone(-1, [0, 1, 2, 3], -1)).toBe(1);
    expect(nextHomeZone(-1, [0, 1, 2, 3], 1)).toBe(3);
  });

  it("returns the element to focus for each zone, and null for the dock", () => {
    expect(homeZoneTarget(0)).toBe(document.querySelector(".quick-settings-trigger"));
    expect(homeZoneTarget(1)).toBe(byId("mini-prev"));
    expect(homeZoneTarget(DOCK_ZONE)).toBeNull();
    expect(homeZoneTarget(3)).toBe(document.querySelector(".diagnostics-trigger"));
  });

  it("Left and Right walk the Background Mode buttons and skip disabled ones", () => {
    byId("mini-prev").focus();
    expect(stepMiniPlayer(1, document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(byId("mini-play"));
    expect(stepMiniPlayer(1, document.activeElement)).toBe(true);
    // #mini-next is disabled, so the next enabled button is #mini-last.
    expect(document.activeElement).toBe(byId("mini-last"));
    expect(stepMiniPlayer(1, document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(byId("mini-last"));
  });

  it("does not claim focus that is outside the Background Mode player", () => {
    byId("app-0").focus();
    expect(stepMiniPlayer(1, document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(byId("app-0"));
  });
});
