import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  buildPairingBootstrapUrl,
  encodeQrMatrix,
  formatPairingCountdown,
  pairingRemainingSeconds,
  parsePairingBootstrapUrl,
} from "../services/remoteAccess";

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

  it("provides explicit reconnect feedback and a safe-area thumb dock", () => {
    const styles = readFileSync("public/remote/style.css", "utf8");
    expect(html).toContain('id="retry-button"');
    expect(html).toContain('<nav class="remote-dock"');
    expect(styles).toContain("env(safe-area-inset-bottom)");
    expect(styles).toContain("position: fixed");
    expect(script).toContain('state.hasConnected ? "ponowne łączenie…"');
    expect(script).toContain('retryButton?.addEventListener("click", () => void refreshStatus())');
    expect(script).toContain("!state.statusInFlight");
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
    expect(script).toContain("new AbortController()");
    expect(script).toContain("fetchWithTimeout");
    expect(script).toContain("confirmedByServer === true");
  });

  it("declares an iPhone-capable standalone app and updates its offline shell version", () => {
    const manifest = JSON.parse(readFileSync("public/remote/manifest.webmanifest", "utf8"));
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("./");
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    const serviceWorker = readFileSync("public/remote/sw.js", "utf8");
    expect(serviceWorker).toContain("nexus-aurea-remote-v0.10.0-velora-offline-command-9");
    expect(serviceWorker).toContain('key.startsWith("nexus-aurea-remote-")');
    expect(serviceWorker).toContain("self.skipWaiting()");
    expect(serviceWorker).toContain('event.request.method !== "GET"');
    expect(serviceWorker).toContain('/\\/api(?:\\/|$)/.test(requestUrl.pathname)');
  });

  it("requires pairing again after rejected authorization and never retries an uncertain command", () => {
    expect(script).toContain("if (response.status === 401)");
    expect(script).toContain("state.authorizationRejected = true");
    expect(script).toContain("await rejectStoredRecord(record)");
    expect(script).toContain("confirmed && !state.authorizationRejected");
    expect(script).toContain("if (response.status === 409)");
    expect(script).toContain("Sprawdź stan urządzenia przed ręcznym ponowieniem.");
    expect(script).toContain("Polecenie nie zostało automatycznie ponowione.");
    expect(script).not.toMatch(/queueCommand|pendingCommands|resendCommand/i);
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
      setTimeout: () => 0,
      clearTimeout: () => {},
      AbortController,
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

  it("does not claim pairing when the server does not confirm before the timeout", async () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
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
      ["pairing-code", element({ value: "123456" })],
      ["device-name", element({ value: "iPhone" })],
    ]);
    const commandButton = element({ disabled: true });
    commandButton.dataset.command = "home";
    const put = vi.fn();
    const indexedDB = {
      open: vi.fn(() => {
        const request: { result?: unknown; onsuccess?: () => void } = {};
        const database = {
          objectStoreNames: { contains: () => true },
          close: vi.fn(),
          transaction: () => {
            const transaction: {
              oncomplete?: () => void;
              objectStore: () => { get: () => { result?: unknown; onsuccess?: () => void }; put: (value: unknown) => void };
            } = {
              objectStore: () => ({
                get: () => {
                  const getRequest: { result?: unknown; onsuccess?: () => void } = {};
                  queueMicrotask(() => {
                    getRequest.onsuccess?.();
                    transaction.oncomplete?.();
                  });
                  return getRequest;
                },
                put: (value: unknown) => {
                  put(value);
                  queueMicrotask(() => transaction.oncomplete?.());
                },
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
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let pairStatus = 0;
    const schedule = vi.fn((callback: () => void) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    });
    const cancel = vi.fn((id: number) => { timers.delete(id); });
    const fetch = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (url === "./api/status") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ enabled: true, pairedDeviceCount: 0 }),
        });
      }
      if (pairStatus === 201) return Promise.resolve({ status: 201 });
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const window = {
      isSecureContext: true,
      location: { protocol: "https:" },
      crypto: { subtle: { importKey: async () => ({}) } },
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
      crypto: {
        getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
        subtle: { importKey: async () => ({}) },
      },
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
      setTimeout: schedule,
      clearTimeout: cancel,
      AbortController,
      queueMicrotask,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.get("pairing-form")?.hidden).toBe(false);
    listeners.get("submit")?.({ preventDefault: () => {} });
    await new Promise((resolve) => setImmediate(resolve));

    const pairCall = fetch.mock.calls.find(([url]) => url === "./api/pair");
    expect(pairCall?.[1]?.signal).toBeDefined();

    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      callback();
    }
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(put).not.toHaveBeenCalled();
    expect(elements.get("pairing-form")?.hidden).toBe(false);
    expect(elements.get("pairing-state")?.textContent).toBe("parowanie niepotwierdzone");
    expect(elements.get("remote-message")?.textContent).toContain("nie potwierdziła parowania");
    expect(elements.get("paired-count")?.textContent).toBe("0");
    expect(commandButton.disabled).toBe(true);

    pairStatus = 201;
    put.mockClear();
    listeners.get("submit")?.({ preventDefault: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0]).toMatchObject({ confirmedByServer: true });
    expect(elements.get("pairing-form")?.hidden).toBe(true);
    expect(elements.get("pairing-state")?.textContent).toBe("sparowane");
    expect(elements.get("paired-count")?.textContent).toBe("1");
    expect(commandButton.disabled).toBe(false);
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
    const record = { deviceId: "iphone", key: {}, sequence: 0, confirmedByServer: true };
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
    let resolveLateCommand!: (response: { ok: boolean; status: number }) => void;
    const lateCommand = new Promise<{ ok: boolean; status: number }>((resolve) => { resolveLateCommand = resolve; });
    let commandRequestCount = 0;
    const navigatorState = { onLine: true, serviceWorker: { register: async () => {} } };
    const windowListeners = new Map<string, () => void>();
    const fetch = vi.fn((url: string) => url === "./api/status"
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ enabled: true, pairedDeviceCount: 1 }) })
      : (++commandRequestCount === 1 ? pendingCommand : lateCommand));
    const window = {
      isSecureContext: true,
      location: { protocol: "https:" },
      crypto: { subtle: { sign: async () => new Uint8Array([1]).buffer } },
      indexedDB,
      addEventListener: vi.fn((type: string, listener: () => void) => windowListeners.set(type, listener)),
    };

    runInNewContext(script, {
      window,
      document: {
        visibilityState: "visible",
        getElementById: (id: string) => elements.get(id),
        querySelectorAll: () => [commandButton],
        addEventListener: vi.fn(),
      },
      navigator: navigatorState,
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
      setTimeout: () => 0,
      clearTimeout: () => {},
      AbortController,
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

    listeners.get("click")?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledTimes(3);
    navigatorState.onLine = false;
    windowListeners.get("offline")?.();
    expect(elements.get("remote-message")?.textContent).toContain("iPhone jest offline");
    resolveLateCommand({ ok: true, status: 200 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.get("remote-message")?.textContent).toContain("iPhone jest offline");
    expect(commandButton.disabled).toBe(true);

    const commandRequestsBeforeReconnect = fetch.mock.calls.filter(([url]) => url === "./api/command").length;
    navigatorState.onLine = true;
    windowListeners.get("online")?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetch.mock.calls.filter(([url]) => url === "./api/command")).toHaveLength(commandRequestsBeforeReconnect);
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
      setTimeout: () => 0,
      clearTimeout: () => {},
      AbortController,
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

  it("puts ONLY the one-time code, host and short expiry in the QR bootstrap", () => {
    const origin = "https://192.168.1.4:47862";
    const url = buildPairingBootstrapUrl(origin, "123456", 1_700_000_000_000 + 60_000);
    expect(url).toBe(`${origin}/#pair=123456&exp=1700000060`);
    expect(parsePairingBootstrapUrl(url)).toEqual({ origin, code: "123456", exp: 1_700_000_060 });
    const lowered = url.toLowerCase();
    for (const forbidden of ["token", "secret", "credential", "ca-key", "signature", "deviceid", "fingerprint"]) {
      expect(lowered).not.toContain(forbidden);
    }
    // The code lives in the fragment only: no query string reaches the server.
    expect(url.split("#")[0]).toBe(origin + "/");
    // A strict parser rejects an extra secret parameter.
    expect(parsePairingBootstrapUrl(`${url}&token=abc`)).toBeNull();

    const matrix = encodeQrMatrix(url);
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    expect(matrix.some((row) => row.some(Boolean))).toBe(true);
    expect(matrix.some((row) => row.some((cell) => !cell))).toBe(true);
    // Same input -> same matrix; a different code -> a different matrix.
    expect(encodeQrMatrix(url)).toEqual(matrix);
    expect(encodeQrMatrix(buildPairingBootstrapUrl(origin, "654321", 1_700_000_000_000 + 60_000))).not.toEqual(matrix);
  });

  it("formats a bounded live countdown", () => {
    expect(pairingRemainingSeconds(1_700_000_060_000, 1_700_000_055_000)).toBe(5);
    expect(pairingRemainingSeconds(1_700_000_055_000, 1_700_000_060_000)).toBe(0);
    expect(pairingRemainingSeconds(0, 0)).toBe(0);
    expect(pairingRemainingSeconds(Number.NaN, 0)).toBe(0);
    expect(formatPairingCountdown(5)).toBe("5s");
    expect(formatPairingCountdown(-2)).toBe("0s");
  });

  it("prefills a short-lived fragment code, clears it and keeps manual entry working", async () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
    const element = (initial: Partial<{ hidden: boolean; disabled: boolean; textContent: string; value: string }> = {}) => ({
      hidden: initial.hidden ?? false,
      disabled: initial.disabled ?? false,
      textContent: initial.textContent ?? "",
      value: initial.value ?? "",
      dataset: {} as Record<string, string>,
      addEventListener: vi.fn((type: string, listener: (event: { preventDefault: () => void }) => void) => listeners.set(type, listener)),
    });
    const elements = new Map<string, ReturnType<typeof element>>([
      ["connection-state", element()],
      ["server-state", element()],
      ["origin-state", element()],
      ["pairing-state", element()],
      ["paired-count", element({ textContent: "0" })],
      ["remote-message", element()],
      ["pairing-form", element({ hidden: true })],
      ["pair-button", element({ disabled: true })],
      ["pairing-code", element()],
      ["device-name", element({ value: "iPhone" })],
      ["pairing-fragment-note", element({ hidden: true })],
    ]);
    const commandButton = element({ disabled: true });
    commandButton.dataset.command = "home";

    // Minimal IndexedDB record store so pairing can complete server-confirmed.
    let stored: Record<string, unknown> | null = null;
    const indexedDB = {
      open: vi.fn(() => {
        const request: { result?: unknown; onsuccess?: () => void } = {};
        const database = {
          objectStoreNames: { contains: () => true },
          close: () => {},
          transaction: () => {
            const transaction: { oncomplete?: () => void; objectStore: () => unknown } = {
              objectStore: () => ({
                get: () => {
                  const getRequest: { result?: unknown; onsuccess?: () => void } = {};
                  queueMicrotask(() => {
                    getRequest.result = stored ?? undefined;
                    getRequest.onsuccess?.();
                    queueMicrotask(() => transaction.oncomplete?.());
                  });
                  return getRequest;
                },
                put: (value: Record<string, unknown>) => {
                  stored = value;
                  queueMicrotask(() => transaction.oncomplete?.());
                },
                delete: () => {
                  stored = null;
                  queueMicrotask(() => transaction.oncomplete?.());
                },
              }),
            };
            return transaction;
          },
        };
        queueMicrotask(() => { request.result = database; request.onsuccess?.(); });
        return request;
      }),
    };
    const replaceState = vi.fn();
    const fetch = vi.fn(async (url: string, _init?: { body?: string }) => url === "./api/status"
      ? { ok: true, status: 200, json: async () => ({ enabled: true, pairedDeviceCount: 0 }) }
      : { status: 201 });
    const window = {
      isSecureContext: true,
      location: { protocol: "https:", hash: "#pair=123456&exp=4102444800", pathname: "/", search: "" },
      crypto: { subtle: { importKey: async () => ({}) } },
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
      history: { replaceState },
      crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7), subtle: { importKey: async () => ({}) } },
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
      setTimeout: () => 0,
      clearTimeout: () => {},
      AbortController,
      queueMicrotask,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.get("pairing-code")?.value).toBe("123456");
    expect(elements.get("pairing-fragment-note")?.hidden).toBe(false);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(script).toContain("readPairingFragment");
    expect(html).toContain("Jednorazowy kod z Control Center");
    expect(html).toContain("Kod jest jednorazowy, ważny tylko przez 60 sekund");

    // Manual fallback: clear the prefilled value and type a different code.
    elements.get("pairing-code")!.value = "654321";
    listeners.get("submit")?.({ preventDefault: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const pairBody = fetch.mock.calls.find(([url]) => url === "./api/pair")?.[1]?.body;
    expect(pairBody).toContain('"code":"654321"');
    expect(stored).toMatchObject({ confirmedByServer: true });
    expect(JSON.stringify(stored)).not.toContain("pairCode");
    expect(JSON.stringify(stored)).not.toContain("code");
    // The short-lived code is not persisted beyond the pairing form.
    expect(elements.get("pairing-code")?.value).toBe("");
  });

  it("does not prefill an expired pairing fragment", async () => {
    const element = (initial: Partial<{ hidden: boolean; disabled: boolean; textContent: string; value: string }> = {}) => ({
      hidden: initial.hidden ?? false,
      disabled: initial.disabled ?? false,
      textContent: initial.textContent ?? "",
      value: initial.value ?? "",
      dataset: {} as Record<string, string>,
      addEventListener: vi.fn(),
    });
    const elements = new Map<string, ReturnType<typeof element>>([
      ["connection-state", element()], ["server-state", element()], ["origin-state", element()],
      ["pairing-state", element()], ["paired-count", element()], ["remote-message", element()],
      ["pairing-form", element({ hidden: true })], ["pair-button", element({ disabled: true })],
      ["pairing-code", element()], ["device-name", element()], ["pairing-fragment-note", element({ hidden: true })],
    ]);
    const replaceState = vi.fn();
    const indexedDB = { open: vi.fn(() => { const r: { onsuccess?: () => void } = {}; queueMicrotask(() => r.onsuccess?.()); return r; }) };
    const window = {
      isSecureContext: false,
      location: { protocol: "https:", hash: "#pair=123456&exp=1", pathname: "/", search: "" },
      crypto: { subtle: {} }, indexedDB, addEventListener: vi.fn(),
    };
    runInNewContext(script, {
      window,
      document: { visibilityState: "visible", getElementById: (id: string) => elements.get(id), querySelectorAll: () => [], addEventListener: vi.fn() },
      navigator: { onLine: true, serviceWorker: { register: async () => {} } },
      indexedDB, fetch: vi.fn(), history: { replaceState },
      crypto: { getRandomValues: vi.fn() }, Uint8Array, Promise, Error, String, Number, Boolean, JSON, Math,
      btoa: (value: string) => value, setTimeout: () => 0, clearTimeout: () => {}, AbortController, queueMicrotask,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.get("pairing-code")?.value).toBe("");
    expect(elements.get("pairing-fragment-note")?.hidden).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("bumps the offline shell and cleans old caches on update", async () => {
    const serviceWorker = readFileSync("public/remote/sw.js", "utf8");
    const handlers = new Map<string, (event: { waitUntil: (promise: Promise<unknown>) => void }) => void>();
    const oldCache = "nexus-aurea-remote-v0.10.0-velora-offline-command-8";
    const newCache = "nexus-aurea-remote-v0.10.0-velora-offline-command-9";
    const keys = new Set([oldCache, newCache]);
    const deleted = vi.fn(async (key: string) => { keys.delete(key); return true; });
    const added = vi.fn(async () => {});
    const opened = vi.fn(async () => ({ addAll: added }));
    const worker = {
      addEventListener: vi.fn((type: string, callback: (event: { waitUntil: (promise: Promise<unknown>) => void }) => void) => handlers.set(type, callback)),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
      location: { href: "https://192.168.1.4:47862/sw.js" },
    };
    runInNewContext(serviceWorker, {
      self: worker,
      caches: { keys: async () => [...keys], delete: deleted, open: opened },
      Promise,
    });

    const installDone = vi.fn();
    handlers.get("install")?.({ waitUntil: installDone });
    await installDone.mock.calls[0][0];
    expect(opened).toHaveBeenCalledWith(newCache);
    expect(added).toHaveBeenCalledWith(["./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest", "./icon.svg"]);
    expect(worker.skipWaiting).toHaveBeenCalled();

    const activateDone = vi.fn();
    handlers.get("activate")?.({ waitUntil: activateDone });
    await activateDone.mock.calls[0][0];
    expect(deleted).toHaveBeenCalledWith(oldCache);
    expect(deleted).not.toHaveBeenCalledWith(newCache);
    expect(worker.clients.claim).toHaveBeenCalled();
    expect([...keys]).toEqual([newCache]);
  });
});
