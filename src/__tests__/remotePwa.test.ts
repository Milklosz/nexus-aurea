import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("NEXUS iPhone Remote PWA shell", () => {
  const html = readFileSync("public/remote/index.html", "utf8");
  const script = readFileSync("public/remote/app.js", "utf8");

  it("contains accessible directional, select, back, home, volume, profile, and Control Center controls", () => {
    for (const label of ["Góra", "Dół", "Lewo", "Prawo", "Wybierz", "Wstecz", "Home", "Głośniej", "Ciszej", "Cinema", "Gaming", "Desktop", "Control Center"]) {
      expect(html).toContain('aria-label="' + label + '"');
    }
  });

  it("keeps actions disabled while no secure endpoint or pairing exists", () => {
    expect(html).toContain("endpoint niedostępny");
    const buttons = [...html.matchAll(/<button\\b[^>]*>/g)].map(([tag]) => tag);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((tag) => /\\bdisabled\\b/.test(tag))).toBe(true);
    expect(script).toContain("endpointAvailable: false");
    expect(script).not.toMatch(/WebSocket|EventSource|XMLHttpRequest|fetch\s*\(/);
  });

  it("declares a standalone PWA manifest and an offline local shell", () => {
    const manifest = JSON.parse(readFileSync("public/remote/manifest.webmanifest", "utf8"));
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("./");
    expect(readFileSync("public/remote/sw.js", "utf8")).toContain("nexus-aurea-remote-v0.9");
  });
});