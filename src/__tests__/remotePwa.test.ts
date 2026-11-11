import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

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
    expect(serviceWorker).toContain("nexus-aurea-remote-v0.9.2-velora-command-feedback-3");
    expect(serviceWorker).toContain('key.startsWith("nexus-aurea-remote-")');
    expect(serviceWorker).toContain("self.skipWaiting()");
  });

  it("keeps pairing and commands disabled when secure key storage cannot be read", async () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
    const documentListeners = new Map<string, () => void>();
    const documentState = { visibilityState: "hidden" };
    const element = (initial: Partial<{ hidden: boolean; disabled: boolean; textContent: string; value: string }> = {}) => ({
      hidden: initial.hidden ?? false,
      disabled: initial.disabled ?? false,
      textContent: initial.textContent ?? "",
      value: initial.value ?? "",
      dataset: {} as Record<string, string>,
      addEventListener: vi.fn((type: string, listener: (event: { preventDefault: () => void }) => void) => listeners.set(type, listener)),
    });
    const elements = new Map([
      ["connection-state", element()],
      ["server-state", element()],
      ["origin-state", element()],
      ["pairing-state", element()],
      ["paired-count", element({ textContent: "0" })],
      ["remote-message", element()],
      ["pairing-form", element({ hidden: true })],
      ["pair-button", element({ disabled: true })],
      ["pairing-code", element()],
      ["device-name", element()],
    ]);
    const commandButtons = [element({ disabled: true })];
    const indexedDB = {
      open: vi.fn(() => {
        const request: { onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
        queueMicrotask(() => request.onerror?.());
        return request;
      }),
    };
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ enabled: true, pairedDeviceCount: 0 }),
    }));
    const window = {
      isSecureContext: true,
      location: { protocol: "https:" },
      crypto: { subtle: {} },
      indexedDB,
      addEventListener: vi.fn(),
    };

    runInNewContext(script, {
      window,
      document: {
        get visibilityState() { return documentState.visibilityState; },
        getElementById: (id: string) => elements.get(id),
        querySelectorAll: () => commandButtons,
        addEventListener: vi.fn((type: string, listener: () => void) => documentListeners.set(type, listener)),
      },
      navigator: { onLine: true, serviceWorker: { register: async () => {} } },
      indexedDB,
      fetch,
      crypto: { getRandomValues: vi.fn() },
      Uint8Array,
      Promise,
      Error,
      String,
      Number,
      Boolean,
      JSON,
      Math,
      btoa: (value: string) => value,
      queueMicrotask,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.get("pairing-form")?.hidden).toBe(true);
    expect(elements.get("pair-button")?.disabled).toBe(true);
    expect(commandButtons[0].disabled).toBe(true);
    expect(elements.get("pairing-state")?.textContent).toContain("pamięć klucza niedostępna");
    expect(elements.get("remote-message")?.textContent).toContain("Parowanie i polecenia pozostają wyłączone");
    expect(fetch).toHaveBeenCalledTimes(1);

    documentState.visibilityState = "hidden";
    documentListeners.get("visibilitychange")?.();
    expect(fetch).toHaveBeenCalledTimes(1);
    documentState.visibilityState = "visible";
    documentListeners.get("visibilitychange")?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(elements.get("pairing-form")?.hidden).toBe(true);
    expect(commandButtons[0].disabled).toBe(true);
  });

  it("announces a pending command while the remote controls are disabled", async () => {
    const listeners = new Map<string, (event?: { preventDefault: () => void }) => void>();
    const element = (initial: Partial<{ hidden: boolean; disabled: boolean; textContent: string; value: string }> = {}) => ({
      hidden: initial.hidden ?? false,
      disabled: initial.disabled ?? false,
      textContent: initial.textContent ?? "",
      value: initial.value ?? "",
      dataset: {} as Record<string, string>,
      addEventListener: vi.fn((type: string, listener: (event?: { preventDefault: () => void }) => void) => listeners.set(type, listener)),
    });
    const elements = new Map([
      ["connection-state", element()],
      ["server-state", element()],
      ["origin-state", element()],
      ["pairing-state", element()],
      ["paired-count", element({ textContent: "1" })],
      ["remote-message", element()],
      ["pairing-form", element({ hidden: true })],
      ["pair-button", element({ disabled: true })],
      ["pairing-code", element()],
      ["device-name", element()],
    ]);
    const commandButton = element({ disabled: true });
    commandButton.dataset.command = "home";
    const record = { deviceId: "iphone", key: {}, sequence: 0 };
    const indexedDB = {
      open: vi.fn(() => {
        const request: { result?: unknown; onsuccess?: () => void } = {};
        const database = {
          objectStoreNames: { contains: () => true },
          close: vi.fn(),
          transaction: () => {
            const transaction: {
              oncomplete?: () => void;
              objectStore: () => { get: () => { result?: unknown; onsuccess?: () => void }; put: () => void };
            } = {
              objectStore: () => ({
                get: () => {
                  const getRequest: { result?: unknown; onsuccess?: () => void } = {};
                  queueMicrotask(() => {
                    getRequest.result = record;
                    getRequest.onsuccess?.();
                    transaction.oncomplete?.();
                  });
                  return getRequest;
                },
                put: () => queueMicrotask(() => transaction.oncomplete?.()),
              }),
            };
            return transaction;
          },
        };
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess?.();
        });
        return request;
      }),
    };
    let resolveCommand!: (response: { ok: boolean; status: number }) => void;
    const pendingCommand = new Promise<{ ok: boolean; status: number }>((resolve) => { resolveCommand = resolve; });
    const fetch = vi.fn((url: string) => url === "./api/status"
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ enabled: true, pairedDeviceCount: 1 }) })
      : pendingCommand);
    const window = {
      isSecureContext: true,
      location: { protocol: "https:" },
      crypto: { subtle: { sign: async () => new Uint8Array([1]).buffer } },
      indexedDB,
      addEventListener: vi.fn(),
    };

    runInNewContext(script, {
      window,
      document: {
        visibilityState: "visible",
        getElementById: (id: string) => elements.get(id),
        querySelectorAll: () => [commandButton],
        addEventListener: vi.fn(),
      },
      navigator: { onLine: true, serviceWorker: { register: async () => {} } },
      indexedDB,
      fetch,
      crypto: { getRandomValues: vi.fn(), subtle: { sign: async () => new Uint8Array([1]).buffer } },
      TextEncoder,
      Uint8Array,
      Promise,
      Error,
      String,
      Number,
      Boolean,
      JSON,
      Math,
      btoa: (value: string) => value,
      queueMicrotask,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(commandButton.disabled).toBe(false);
    listeners.get("click")?.();
    expect(elements.get("remote-message")?.textContent).toBe("Wysyłam: Home…");
    expect(commandButton.disabled).toBe(true);

    resolveCommand({ ok: true, status: 200 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.get("remote-message")?.textContent).toBe("Wysłano: Home.");
    expect(commandButton.disabled).toBe(false);
  });

  it("does not let a pending status check overwrite the offline state", async () => {
    const listeners = new Map<string, () => void>();
    const element = (initial: Partial<{ hidden: boolean; disabled: boolean; textContent: string }> = {}) => ({
      hidden: initial.hidden ?? false,
      disabled: initial.disabled ?? false,
      textContent: initial.textContent ?? "",
      dataset: {} as Record<string, string>,
      addEventListener: vi.fn(),
    });
    const elements = new Map([
      ["connection-state", element()],
      ["server-state", element()],
      ["origin-state", element()],
      ["pairing-state", element()],
      ["paired-count", element()],
      ["remote-message", element()],
      ["pairing-form", element({ hidden: true })],
      ["pair-button", element({ disabled: true })],
    ]);
    const commandButtons = [element({ disabled: true })];
    const navigatorState = { onLine: true, serviceWorker: { register: async () => {} } };
    let resolveStatus!: (response: { ok: boolean; json: () => Promise<{ enabled: boolean; pairedDeviceCount: number }> }) => void;
    const pendingStatus = new Promise<{ ok: boolean; json: () => Promise<{ enabled: boolean; pairedDeviceCount: number }> }>((resolve) => {
      resolveStatus = resolve;
    });
    const window = {
      isSecureContext: true,
      location: { protocol: "https:" },
      crypto: { subtle: {} },
      indexedDB: { open: vi.fn() },
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    };

    const fetch = vi.fn(() => pendingStatus);
    runInNewContext(script, {
      window,
      document: {
        visibilityState: "visible",
        getElementById: (id: string) => elements.get(id),
        querySelectorAll: () => commandButtons,
        addEventListener: vi.fn(),
      },
      navigator: navigatorState,
      indexedDB: window.indexedDB,
      fetch,
      crypto: { getRandomValues: vi.fn() },
      Uint8Array,
      Promise,
      Error,
      String,
      Number,
      Boolean,
      JSON,
      Math,
      btoa: (value: string) => value,
      queueMicrotask,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    navigatorState.onLine = false;
    listeners.get("offline")?.();
    expect(elements.get("connection-state")?.textContent).toBe("offline");
    expect(elements.get("pair-button")?.disabled).toBe(true);
    expect(commandButtons[0].disabled).toBe(true);

    resolveStatus({ ok: true, json: async () => ({ enabled: true, pairedDeviceCount: 1 }) });
    await new Promise((resolve) => setImmediate(resolve));

    expect(elements.get("connection-state")?.textContent).toBe("offline");
    expect(elements.get("remote-message")?.textContent).toContain("iPhone jest offline");
    expect(elements.get("pairing-form")?.hidden).toBe(true);
    expect(elements.get("pair-button")?.disabled).toBe(true);
    expect(commandButtons[0].disabled).toBe(true);
    expect(window.indexedDB.open).not.toHaveBeenCalled();
  });
});
