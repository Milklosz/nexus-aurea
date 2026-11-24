// S3.11 (iPhone Remote 5.0, Agent E) — deterministic regression tests for the
// shipped PWA (`public/remote/app.js`), run in a node:vm sandbox with injected
// fetch / WebCrypto / IndexedDB doubles and a manual timer queue (no sleeps,
// no waits on real time).
//
// Covered:
//   E-1  an ambiguous outcome (409, or a Wi-Fi cut during the bounded
//        never-reached backoff) is marked "unknown" and never auto-retried:
//        only explicit re-confirmation re-sends the identical signed bytes,
//        exactly once;
//   E-2  a re-pairing drops every outbound entry signed with the OLD
//        credential, so the fresh pairing can never be unpaired (or its
//        record tombstoned) by a ghost re-send of stale bytes;
//   E-3  an offline cut between sequence reservation and send queues the
//        never-sent intent with a visible message; the verified reconnect
//        sends it once with a fresh sequence.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const appScript = readFileSync(resolve(process.cwd(), "public/remote/app.js"), "utf8");

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

interface FakeElement {
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  value: string;
  dataset: Record<string, string>;
  handlers: Map<string, Array<(event: { preventDefault: () => void }) => void>>;
  setAttribute: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  fire(type: string, event?: { preventDefault: () => void }): void;
  addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void): void;
}

const HELLO_ACK_SIGNATURE = "BwcHBw"; // base64url of the harness's fixed HMAC output [7,7,7,7]
const seededRecord = { deviceId: "device-e1", key: {}, sequence: 0, confirmedByServer: true };

function statusOk(pairedDeviceCount: number): FakeResponse {
  return { ok: true, status: 200, json: async () => ({ enabled: true, pairedDeviceCount }) };
}

function helloAck(init?: { body?: string }): FakeResponse {
  const request = JSON.parse(init?.body ?? "{}") as { nonce?: string };
  return {
    ok: true,
    status: 200,
    json: async () => ({ nonce: request.nonce, serverEpoch: 1_700_000_000, pairedDeviceCount: 1, signature: HELLO_ACK_SIGNATURE }),
  };
}

function boot(fetchImpl: (url: string, init?: { body?: string }) => Promise<FakeResponse>, seed: Record<string, unknown> = { ...seededRecord }) {
  const records = new Map<string, unknown>();
  records.set("active", { ...seed });
  const writes: unknown[] = [];
  const windowListeners = new Map<string, Array<() => void>>();
  const documentListeners = new Map<string, Array<() => void>>();
  const elements = new Map<string, FakeElement>();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  const getElement = (id: string): FakeElement => {
    let item = elements.get(id);
    if (!item) {
      const handlers = new Map<string, Array<(event: { preventDefault: () => void }) => void>>();
      item = {
        hidden: false,
        disabled: false,
        textContent: "",
        value: "",
        dataset: {},
        handlers,
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        fire(type: string, event = { preventDefault: () => {} }) {
          for (const listener of handlers.get(type) ?? []) listener(event);
        },
        addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void) {
          const bucket = handlers.get(type) ?? [];
          bucket.push(listener);
          handlers.set(type, bucket);
        },
      } as unknown as FakeElement;
      elements.set(id, item);
    }
    return item;
  };
  for (const id of [
    "connection-state", "server-state", "origin-state", "pairing-state", "paired-count",
    "remote-message", "pairing-form", "pair-button", "retry-button", "pairing-code",
    "device-name", "unknown-panel", "unknown-note", "unknown-confirm", "device-id",
    "qr-onboarding-state", "navigation-touchpad", "pad-mode", "touch-mode",
  ]) {
    getElement(id);
  }
  getElement("pairing-form").hidden = true;
  getElement("pair-button").disabled = true;
  (getElement("pairing-code") as FakeElement).value = "123456";
  (getElement("device-name") as FakeElement).value = "Test iPhone";
  const commandButton = getElement("command-button-home");
  (commandButton as FakeElement).dataset.command = "home";

  const navigatorState = { onLine: true, serviceWorker: { register: async () => {} } };
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

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const flushTimers = async (): Promise<void> => {
    for (let guard = 0; guard < 64 && timers.size > 0; guard += 1) {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
      await settles(2);
    }
  };
  const settles = async (rounds = 2): Promise<void> => {
    for (let i = 0; i < rounds * 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const commandBodies = () =>
    (fetch as unknown as { mock: { calls: Array<[string, { body?: string } | undefined]> } }).mock.calls
      .filter(([url]) => url === "./api/command")
      .map(([, init]) => init?.body ?? "");

  const trackedStore = {
    get: (key: string) => {
      const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
      const value = records.get(key);
      queueMicrotask(() => { request.result = value; request.onsuccess?.(); });
      return request;
    },
    put: (value: unknown, key: string) => { records.set(key, value); writes.push(value); },
    delete: (key: string) => { records.delete(key); },
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

  runInNewContext(appScript, {
    window: {
      isSecureContext: true,
      location: { protocol: "https:", hash: "", pathname: "/", search: "" },
      history: { replaceState: vi.fn() },
      crypto,
      indexedDB,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        const bucket = windowListeners.get(type) ?? [];
        bucket.push(listener);
        windowListeners.set(type, bucket);
      }),
    },
    document: {
      visibilityState: "visible",
      getElementById: getElement,
      querySelectorAll: (selector: string) => (selector === "[data-command]" ? [commandButton] : []),
      querySelector: () => null,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        const bucket = documentListeners.get(type) ?? [];
        bucket.push(listener);
        documentListeners.set(type, bucket);
      }),
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
    setTimeout: (callback: () => void) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    AbortController,
    queueMicrotask,
  });

  return {
    fetch,
    records,
    writes,
    elements,
    getElement,
    navigator: navigatorState,
    commandButton,
    windowListeners,
    settle,
    flushTimers,
    commandBodies,
    helloCalls: () => fetch.mock.calls.filter(([url]) => url === "./api/hello").length,
    commandCalls: () => fetch.mock.calls.filter(([url]) => url === "./api/command").length,
    submitPairing: async () => {
      const form = getElement("pairing-form");
      for (const listener of form.handlers.get("submit") ?? []) listener({ preventDefault: () => {} });
      await settle();
    },
    tapCommand() {
      for (const listener of (commandButton as unknown as FakeElement).handlers.get("click") ?? []) listener({ preventDefault: () => {} });
    },
    tapUnknownConfirm() {
      for (const listener of (getElement("unknown-confirm") as unknown as FakeElement).handlers.get("click") ?? []) listener({ preventDefault: () => {} });
    },
    fireVisibility: async () => {
      for (const listener of documentListeners.get("visibilitychange") ?? []) listener();
      await settles(2);
    },
  };
}

describe("s3.11 PWA fail-closed recovery (deterministic, seeded)", () => {
  it("keeps the fail-closed wiring readable in the shipped source (text guards)", () => {
    // Exactly one command send site in the entire PWA.
    expect(appScript.match(/fetchWithTimeout\("\.\/api\/command"/g)).toHaveLength(1);
    // Bounded never-reached retry exists and is gated on the attempt counter.
    expect(appScript).toContain("const OUTBOUND_MAX_AUTO_RETRIES = 3;");
    expect(appScript).toContain("if (neverReached && entry.attempts < OUTBOUND_MAX_AUTO_RETRIES)");
    // An interrupted backoff is ambiguous, marked unknown, never silently kept queued.
    expect(appScript).toContain("markEntryUnknown(entry)");
    // Re-confirmation re-sends the stored signed bytes verbatim.
    expect(appScript).toContain("signature: entry.signature,");
    expect(appScript).toContain("sequence: entry.sequence,");
    // Re-confirmation and pairing are credential-guarded: stale credentials
    // are dropped at pairing time and blocked in re-confirm.
    expect(appScript).toContain("matchesCredential(entry, state.record)");
    expect(appScript.match(/dropOutboundEntriesForOtherCredentials\(\);/g)).toHaveLength(1);
    expect(appScript.match(/function matchesCredential\(entry, record\)/g)).toHaveLength(1);
    // The offline cut between reserve and send queues the never-sent intent.
    expect(appScript).toContain("pendingIntents.push(command);");
  });

  it("E-1: a 409 outcome is marked unknown, re-confirms with identical signed bytes exactly once, and never double-sends", async () => {
    let commandCalls = 0;
    const app = boot(async (url, init) => {
      if (url === "./api/status") return statusOk(1);
      if (url === "./api/hello") return helloAck(init);
      commandCalls += 1;
      return commandCalls === 1
        ? { ok: false, status: 409, json: async () => ({}) }
        : { ok: true, status: 204, json: async () => ({}) };
    });
    await app.settle();
    await app.settle();
    await app.fireVisibility();
    await app.settle();
    await app.settle();
    expect(app.helloCalls()).toBeGreaterThanOrEqual(1);

    // The 409 = sequence reserved but no receipt: outcome unknown, marked so.
    app.tapCommand();
    await app.settle();
    await app.settle();
    expect(app.commandBodies()).toHaveLength(1);
    expect((app.getElement("unknown-panel") as FakeElement).hidden).toBe(false);

    // Tapping the SAME command is an EXPLICIT re-confirmation: the identical
    // signed bytes (same sequence, same signature, never re-signed) go out
    // exactly once.
    app.tapCommand();
    await app.settle();
    await app.settle();
    const bodies = app.commandBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect((app.getElement("unknown-panel") as FakeElement).hidden).toBe(true);

    // The entry is settled: another verified reconnect cannot re-send it.
    await app.fireVisibility();
    await app.settle();
    await app.settle();
    expect(app.commandBodies()).toHaveLength(2);
  });

  it("E-2: re-pairing drops stale-credential entries; the fresh pairing stays usable and never receives the old bytes", async () => {
    let pairCalls = 0;
    const app = boot(async (url, init) => {
      if (url === "./api/status") return statusOk(1);
      if (url === "./api/hello") return helloAck(init);
      if (url === "./api/pair") {
        pairCalls += 1;
        return { ok: true, status: 201, json: async () => ({}) };
      }
      return { ok: false, status: 409, json: async () => ({}) };
    });
    await app.settle();
    await app.settle();
    await app.fireVisibility();
    await app.settle();
    await app.settle();

    // A 409 leaves an unknown entry signed with the CURRENT (old) credential.
    app.tapCommand();
    await app.settle();
    await app.settle();
    expect(app.commandBodies()).toHaveLength(1);
    expect((app.getElement("unknown-panel") as FakeElement).hidden).toBe(false);

    // Desktop-side revocation: the reconnect un-pairs this page and unlocks
    // the pairing form.
    app.records.delete("active");
    for (const listener of app.windowListeners.get("offline") ?? []) listener();
    await app.settle();
    await app.settle();
    app.navigator.onLine = true;
    for (const listener of app.windowListeners.get("online") ?? []) listener();
    await app.settle();
    await app.settle();
    expect((app.getElement("pairing-form") as FakeElement).hidden).toBe(false);

    // Fresh 201 pairing stores a NEW credential generation.
    app.submitPairing();
    await app.settle();
    await app.settle();
    expect(pairCalls).toBe(1);
    const fresh = app.writes.at(-1) as { deviceId: string; confirmedByServer: boolean };
    expect(fresh.confirmedByServer).toBe(true);
    expect(fresh.deviceId).not.toBe("device-e1");

    // The stale unknown entry was dropped at pairing time: tapping the SAME
    // command now sends a NEW command under the NEW identity (never the old
    // signed bytes, which could only 401 and tombstone the fresh pairing).
    app.tapCommand();
    await app.settle();
    await app.settle();
    const bodies = app.commandBodies();
    expect(bodies).toHaveLength(2);
    const newest = JSON.parse(bodies[1]) as { deviceId: string; sequence: number; command: string };
    expect(newest).toMatchObject({ deviceId: fresh.deviceId, command: "home" });
    expect(newest.sequence).toBeGreaterThanOrEqual(1);
  });

  it("E-3: an offline cut between sequence reservation and send queues the never-sent intent and reconnect sends it once", async () => {
    const app = boot(async (url, init) => {
      if (url === "./api/status") return statusOk(1);
      if (url === "./api/hello") return helloAck(init);
      return { ok: true, status: 204, json: async () => ({}) };
    });
    await app.settle();
    await app.settle();
    await app.fireVisibility();
    await app.settle();
    await app.settle();

    // Tap while offline: queued, announced, nothing on the wire.
    app.navigator.onLine = false;
    for (const listener of app.windowListeners.get("offline") ?? []) listener();
    await app.settle();
    await app.settle();
    app.tapCommand();
    await app.settle();
    await app.settle();
    await app.flushTimers();
    expect(app.commandBodies()).toHaveLength(0);
    expect((app.getElement("remote-message") as FakeElement).textContent).toContain("zapisane w kolejce");

    // Verified reconnect: the queued intent is sent exactly once, with a
    // fresh sequence; the pendingIntents queue drains empty.
    app.navigator.onLine = true;
    for (const listener of app.windowListeners.get("online") ?? []) listener();
    await app.settle();
    await app.settle();
    await app.flushTimers();
    const sentBodies = app.commandBodies();
    expect(sentBodies).toHaveLength(1);
    const sent = JSON.parse(sentBodies[0]) as { deviceId: string; sequence: number; command: string };
    expect(sent).toMatchObject({ deviceId: "device-e1", command: "home" });
    expect(sent.sequence).toBeGreaterThanOrEqual(1);
    // A second verified reconnect drains nothing further.
    for (const listener of app.windowListeners.get("online") ?? []) listener();
    await app.settle();
    await app.settle();
    await app.flushTimers();
    expect(app.commandBodies()).toHaveLength(1);
  });
});
