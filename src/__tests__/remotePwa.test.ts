import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("VELORA iPhone Remote", () => {
  const html = readFileSync("public/remote/index.html", "utf8");
  const script = readFileSync("public/remote/app.js", "utf8");

  it("exposes only the requested navigation, home, volume, and profile commands", () => {
    for (const label of ["Góra", "Dół", "Lewo", "Prawo", "Wybierz", "Wstecz", "Home", "Głośniej", "Ciszej", "Cinema", "Gaming", "Desktop"]) {
      expect(html).toContain('aria-label="' + label + '"');
    }
    expect(html).not.toContain('data-command="control-center"');
    expect(html).not.toContain("OGLĄDAJ TERAZ");
  });

  it("keeps pairing and commands unavailable until HTTPS, server, and device pairing succeed", () => {
    const buttons = [...html.matchAll(/<button[^>]*data-command[^>]*>/g)].map(([tag]) => tag);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((tag) => /\bdisabled\b/.test(tag))).toBe(true);
    expect(html).toMatch(/<form[^>]*id="pairing-form"[^>]*hidden/);
    expect(html).toMatch(/id="pair-button"[^>]*disabled/);
    expect(script).toContain('window.location.protocol === "https:"');
    expect(script).toContain("window.isSecureContext");
    expect(script).toContain("remote.enabled === true");
    expect(script).toContain("state.paired");
  });

  it("stores a non-exportable WebCrypto key in IndexedDB and signs sequenced commands", () => {
    expect(script).toContain('indexedDB.open(databaseName, 1)');
    expect(script).toContain('name: "HMAC"');
    expect(script).toContain('false,');
    expect(script).toContain('["sign"]');
    expect(script).toContain("crypto.subtle.sign");
    expect(script).toContain("record.sequence + 1");
    expect(script).not.toMatch(/localStorage|sessionStorage/);
    expect(script).not.toMatch(/WebSocket|EventSource|XMLHttpRequest|sendBeacon/);
    expect(script).toContain('credentials: "omit"');
    expect(script).toContain('cache: "no-store"');
  });

  it("declares an iPhone-capable standalone app and updates its offline shell version", () => {
    const manifest = JSON.parse(readFileSync("public/remote/manifest.webmanifest", "utf8"));
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("./");
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    const serviceWorker = readFileSync("public/remote/sw.js", "utf8");
    expect(serviceWorker).toContain("nexus-aurea-remote-v0.9.2");
    expect(serviceWorker).toContain('key.startsWith("nexus-aurea-remote-")');
    expect(serviceWorker).toContain("self.skipWaiting()");
  });
});
