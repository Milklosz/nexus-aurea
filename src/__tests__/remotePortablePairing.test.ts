/**
 * Deterministic portable-pairing behaviour checks.
 *
 * The PWA is executed in node:vm with injected fetch / WebCrypto / IndexedDB
 * doubles (the same harness style as remotePwa.test.ts). No network, no real
 * clock, no real device — these tests can NEVER claim hardware validation.
 * The assertions cover the state-machine guarantees that matter for the
 * portable validation build: fragment-only QR, 201-gated storage, 401
 * revocation, Wi-Fi interruption without auto-replay and fail-closed reconnect.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  buildPairingBootstrapUrl,
  parsePairingBootstrapUrl,
  reduceRemoteState,
  safePairingReset,
  shouldReplayOnReconnect,
  verifyReconnect,
  verifySignedHello,
} from "../services/remoteReliability";

const script = readFileSync("public/remote/app.js", "utf8");

type Response = { ok: boolean; status: number; json: () => Promise<unknown> };

function bootApp(fetchImpl: (url: string, init?: unknown) => Promise<Response>) {
  const records = new Map<string, unknown>();
  const writes: unknown[] = [];
  const deletes: string[] = [];
  const handlers = new Map<string, Set<(event: { preventDefault: () => void }) => void>>();
  const trackedStore = {
    get: (key: string) => {
      const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
      const value = records.get(key);
      queueMicrotask(() => { request.result = value; request.onsuccess?.(); });
      return request;
    },
    put: (value: unknown, key: string) => { records.set(key, value); writes.push(value); },
    delete: (key: string) => { records.delete(key); deletes.push(key); },
  };
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    close: () => {},
    transaction: () => {
      const transaction: { objectStore: () => typeof trackedStore; oncomplete?: () => void } = {
        objectStore: () => trackedStore,
      };
      // Two microtask turns: all get handlers run before the transaction closes.
      queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.()));
      return transaction;
    },
  };
  const indexedDB = {
    open: () => {
      const request: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        request.result = database;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  const element = (initial: Partial<{ hidden: boolean; disabled: boolean; textContent: string; value: string }> = {}) => ({
    hidden: initial.hidden ?? false,
    disabled: initial.disabled ?? false,
    textContent: initial.textContent ?? "",
    value: initial.value ?? "",
    dataset: {} as Record<string, string>,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    focus: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: { preventDefault: () => void }) => void) => {
      let bucket = handlers.get(type);
      if (!bucket) {
        bucket = new Set();
        handlers.set(type, bucket);
      }
      bucket.add(listener);
    }),
  });
  const elements = new Map<string, ReturnType<typeof element>>();
  const getElement = (id: string) => {
    let item = elements.get(id);
    if (!item) {
      item = element();
      elements.set(id, item);
    }
    return item;
  };
  for (const id of ["connection-state", "server-state", "origin-state", "pairing-state", "paired-count", "remote-message"]) getElement(id);
  const pairingForm = getElement("pairing-form");
  pairingForm.hidden = true;
  const pairButton = getElement("pair-button");
  pairButton.disabled = true;
  getElement("pairing-code").value = "123456";
  getElement("device-name").value = "Test iPhone";

  const commandButtons = [element({ disabled: true })];
  commandButtons[0].dataset.command = "home";
  const windowListeners = new Map<string, () => void>();
  const fetch = vi.fn(fetchImpl);
  let randomByte = 1;
  const crypto = {
    getRandomValues: (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (randomByte++ % 250) + 1;
      return bytes;
    },
    subtle: {
      importKey: async () => ({}),
      sign: async () => new Uint8Array([7, 7, 7, 7]).buffer,
    },
  };
  const navigatorState = { onLine: true, serviceWorker: { register: async () => {} } };
  const window = {
    isSecureContext: true,
    location: { protocol: "https:", hash: "", pathname: "/", search: "" },
    crypto,
    indexedDB,
    addEventListener: vi.fn((type: string, listener: () => void) => windowListeners.set(type, listener)),
  };

  runInNewContext(script, {
    window,
    document: {
      visibilityState: "visible",
      getElementById: getElement,
      querySelectorAll: () => commandButtons,
      querySelector: () => null,
      addEventListener: vi.fn(),
    },
    navigator: navigatorState,
    indexedDB,
    fetch,
    crypto,
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
    atob: (value: string) => value,
    setTimeout: () => 0,
    clearTimeout: () => {},
    AbortController,
    queueMicrotask,
  });

  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const submitPairing = async () => {
    const onSubmit = handlers.get("submit")?.values().next().value;
    expect(onSubmit).toBeTypeOf("function");
    await onSubmit?.({ preventDefault: () => {} });
    await settle();
  };
  const fireCommandClick = () => {
    for (const listener of handlers.get("click") ?? []) listener({ preventDefault: () => {} });
  };

  return { elements, getElement, pairingForm, pairButton, commandButtons, windowListeners, navigator: navigatorState, fetch, records, writes, deletes, settle, submitPairing, fireCommandClick };
}

const statusResponse = (pairedDeviceCount: number): Response => ({
  ok: true,
  status: 200,
  json: async () => ({ enabled: true, pairedDeviceCount }),
});

describe("portable iPhone pairing state machine (deterministic, NOT hardware validated)", () => {
  it("puts only the code, host and short expiry in the QR fragment", () => {
    const origin = "https://192.168.1.4:47862";
    const url = buildPairingBootstrapUrl(origin, "123456", 1_700_000_060_000);
    expect(url).toBe(`${origin}/#pair=123456&exp=1700000060`);
    expect(parsePairingBootstrapUrl(url)).toEqual({ origin, code: "123456", exp: 1_700_000_060 });
    expect(url.split("#")[0]).toBe(origin + "/");
    for (const forbidden of ["token", "secret", "signature", "deviceid", "fingerprint", "mobileconfig"]) {
      expect(url.toLowerCase()).not.toContain(forbidden);
    }
    expect(parsePairingBootstrapUrl(`${url}&token=abc`)).toBeNull();
  });

  it("stores the pairing key ONLY after 201 and stays closed on 401", async () => {
    const app = bootApp((url) => Promise.resolve(url === "./api/status" ? statusResponse(0) : ({
      ok: false, status: 401, json: async () => ({}),
    })));
    await app.settle();
    expect(app.pairButton.disabled).toBe(false);
    await app.submitPairing();
    expect(app.writes).toHaveLength(0);
    expect(app.pairingForm.hidden).toBe(false);
    expect(app.getElement("remote-message").textContent).toMatch(/kod wygasł|nieprawidłowy/);

    const accepted = bootApp((url) => Promise.resolve(url === "./api/status" ? statusResponse(0) : ({
      ok: true, status: 201, json: async () => ({}),
    })));
    await accepted.settle();
    await accepted.submitPairing();
    expect(accepted.writes).toHaveLength(1);
    expect(accepted.pairingForm.hidden).toBe(true);
    expect(accepted.getElement("paired-count").textContent).toBe("1");
    expect(accepted.commandButtons[0].disabled).toBe(false);
  });

  it("revoked device: 401 clears state, removes the stored record and requires fresh pairing", async () => {
    const app = bootApp((url) => {
      if (url === "./api/status") return Promise.resolve(statusResponse(0));
      if (url === "./api/pair") return Promise.resolve({ ok: true, status: 201, json: async () => ({}) });
      return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
    });
    await app.settle();
    await app.submitPairing();
    expect(app.writes).toHaveLength(1);
    expect(app.commandButtons[0].disabled).toBe(false);

    // The real app registers the click handler via addEventListener in the vm.
    app.fireCommandClick();
    await app.settle();

    expect(app.getElement("pairing-state").textContent).toBe("wymagane ponowne parowanie");
    expect(app.pairingForm.hidden).toBe(false);
    expect(app.commandButtons[0].disabled).toBe(true);
    expect(app.getElement("remote-message").textContent).toContain("Sparuj go ponownie");
    expect(app.deletes.length).toBeGreaterThan(0);
    expect(safePairingReset()).toEqual({ clearStoredRecord: true, requireReverify: true });
  });

  it("Wi-Fi interruption suspends controls and reconnection never auto-replays a command", async () => {
    const app = bootApp((url) => {
      if (url === "./api/status") return Promise.resolve(statusResponse(0));
      return Promise.resolve({ ok: true, status: 201, json: async () => ({}) });
    });
    await app.settle();
    await app.submitPairing();
    app.fireCommandClick();
    await app.settle();
    const commandsBefore = app.fetch.mock.calls.filter(([url]) => url === "./api/command").length;
    expect(commandsBefore).toBe(1);

    app.navigator.onLine = false;
    app.windowListeners.get("offline")?.();
    app.fireCommandClick();
    await app.settle();
    expect(app.getElement("connection-state").textContent).toBe("offline");
    expect(app.commandButtons[0].disabled).toBe(true);
    expect(app.fetch.mock.calls.filter(([url]) => url === "./api/command")).toHaveLength(commandsBefore);

    app.navigator.onLine = true;
    app.windowListeners.get("online")?.();
    await app.settle();
    // A fresh status verification happens; no queued side effect is replayed.
    expect(app.fetch.mock.calls.filter(([url]) => url === "./api/command")).toHaveLength(commandsBefore);
    expect(shouldReplayOnReconnect("offline")).toBe(false);
    expect(reduceRemoteState("paired", "wifi-lost")).toBe("offline");
    expect(reduceRemoteState("offline", "wifi-restored")).toBe("reconnecting");
  });

  it("reconnect does a fresh signed hello and fails closed at 401", async () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const macBytes = new Uint8Array(32).fill(1);
    const mac = async () => macBytes;
    const signature = Buffer.from(macBytes).toString("base64url");
    const tampered = new Uint8Array(macBytes);
    tampered[0] = 2;
    expect(await verifySignedHello({
      deviceId: "device-1", nonce, status: {
        nonce, serverEpoch: 7, pairedDeviceCount: 1, signature,
      }, computeMac: mac,
    })).toBe(true);
    expect(await verifySignedHello({
      deviceId: "device-1", nonce, status: {
        nonce, serverEpoch: 7, pairedDeviceCount: 1,
        signature: Buffer.from(tampered).toString("base64url"),
      }, computeMac: mac,
    })).toBe(false);

    let helloCalls = 0;
    const failed = await verifyReconnect({
      maxAttempts: 2,
      fetchStatus: async () => ({ ok: false, status: 401, json: async () => ({ enabled: false, pairedDeviceCount: 0 }) }),
      verifyPaired: async () => { helloCalls += 1; return true; },
      delayMs: () => 0,
      wait: async () => {},
    });
    expect(failed).toEqual({ statusVerified: false, pairedVerified: false, attempts: 1 });
    expect(helloCalls).toBe(0); // 401 fails closed before any hello is trusted.

    const recovered = await verifyReconnect({
      maxAttempts: 2,
      fetchStatus: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, pairedDeviceCount: 1 }) }),
      verifyPaired: async () => { helloCalls += 1; return true; },
      delayMs: () => 0,
      wait: async () => {},
    });
    expect(recovered).toEqual({ statusVerified: true, pairedVerified: true, attempts: 1 });
    expect(helloCalls).toBe(1); // one fresh signed verification, not a replay.
  });
});
