// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  focusHomeZone,
  homeZoneAvailability,
  homeZoneOfElement,
  nextHomeZone,
  type HomeZoneAvailability,
} from "../services/homeZones";

const all: HomeZoneAvailability = { controlCenter: true, music: true, dock: true, diagnostics: true };

describe("nextHomeZone", () => {
  it("moves down through the zones in visual order", () => {
    expect(nextHomeZone("controlCenter", 1, all)).toBe("music");
    expect(nextHomeZone("music", 1, all)).toBe("dock");
    expect(nextHomeZone("dock", 1, all)).toBe("diagnostics");
  });

  it("moves up through the zones in visual order", () => {
    expect(nextHomeZone("diagnostics", -1, all)).toBe("dock");
    expect(nextHomeZone("dock", -1, all)).toBe("music");
    expect(nextHomeZone("music", -1, all)).toBe("controlCenter");
  });

  it("skips zones that are not on screen", () => {
    const noMusic = { ...all, music: false };
    expect(nextHomeZone("dock", -1, noMusic)).toBe("controlCenter");
    expect(nextHomeZone("controlCenter", 1, noMusic)).toBe("dock");
  });

  it("returns null at the edges instead of wrapping", () => {
    expect(nextHomeZone("controlCenter", -1, all)).toBeNull();
    expect(nextHomeZone("diagnostics", 1, all)).toBeNull();
  });

  it("returns null when no zone lies in that direction", () => {
    const onlyDock = { controlCenter: false, music: false, dock: true, diagnostics: false };
    expect(nextHomeZone("dock", 1, onlyDock)).toBeNull();
    expect(nextHomeZone("dock", -1, onlyDock)).toBeNull();
  });
});

describe("homeZoneOfElement, availability and focus (DOM)", () => {
  function homeScreen(withMusic: boolean): HTMLElement {
    const root = document.createElement("main");
    const music = withMusic ? '<aside class="music-mini-player"><button>Play</button></aside>' : "";
    root.innerHTML = [
      '<button class="quick-settings-trigger">CC</button>',
      music,
      '<nav class="dock"><button class="app">App 1</button></nav>',
      '<button class="diagnostics-trigger">Pad</button>',
    ].join("");
    document.body.append(root);
    return root;
  }

  it("identifies the zone of each home control", () => {
    const root = homeScreen(true);
    expect(homeZoneOfElement(root.querySelector(".quick-settings-trigger"))).toBe("controlCenter");
    expect(homeZoneOfElement(root.querySelector(".music-mini-player button"))).toBe("music");
    expect(homeZoneOfElement(root.querySelector(".dock .app"))).toBe("dock");
    expect(homeZoneOfElement(root.querySelector(".diagnostics-trigger"))).toBe("diagnostics");
    root.remove();
  });

  it("returns null for elements outside every zone and for null", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    expect(homeZoneOfElement(outside)).toBeNull();
    expect(homeZoneOfElement(null)).toBeNull();
    outside.remove();
  });

  it("reports the music zone only while its player is rendered", () => {
    const withMusic = homeScreen(true);
    expect(homeZoneAvailability(document).music).toBe(true);
    withMusic.remove();
    const withoutMusic = homeScreen(false);
    expect(homeZoneAvailability(document)).toEqual({
      controlCenter: true,
      music: false,
      dock: true,
      diagnostics: true,
    });
    withoutMusic.remove();
  });

  it("focuses a non-dock zone and reports a missing control", () => {
    const root = homeScreen(true);
    expect(focusHomeZone(root, "diagnostics")).toBe(true);
    expect(document.activeElement).toBe(root.querySelector(".diagnostics-trigger"));
    expect(focusHomeZone(root, "music")).toBe(true);
    expect(document.activeElement).toBe(root.querySelector(".music-mini-player button"));
    root.querySelector(".music-mini-player")?.remove();
    expect(focusHomeZone(root, "music")).toBe(false);
    root.remove();
  });
});
