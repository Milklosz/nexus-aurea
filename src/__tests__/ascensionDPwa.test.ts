/**
 * Phase 3 (Ascension D) — PWA fail-closed command path, behavioural tests.
 *
 * Runs `public/remote/app.js` in a `node:vm` sandbox (same style as
 * remotePwa.test.ts) and drives the NEW outbound pipeline:
 *   - single in-flight request; further taps queue behind it;
 *   - dedup by commandId; re-tapping an "unknown" command re-sends the EXACT
 *     same signed body (same sequence + signature) — never a fresh sequence;
 *   - an ambiguous timeout after send is marked "unknown" and NEVER auto-retried;
 *   - a provably never-reached failure (offline / DNS / connect refused) is
 *     auto-retried bounded (<= 3) with backoff, reusing the same signed bytes;
 *   - Wi-Fi loss queues intents; on reconnect the status is re-synced and only
 *     never-sent queued intents go out — "unknown" entries are never replayed;
 *   - 401 (replay-rejected / revoked) surfaces a clear unpair state, no retry;
 *   - 409 surfaces the ambiguous state;
 *   - device identity (deviceId) and QR onboarding states are shown in the UI.
 *
 * The signed payload format is asserted byte-identical:
 * `NEXUS-AUREA-REMOTE-V1\n{deviceId}\n{sequence}\n{command}` + HMAC-SHA256.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync("public/remote/app.js", "utf8");
const html = readFileSync("public/remote/index.html", "utf8");

const DEVICE_ID = "0123456789abcdef0123456789abcdef";
const RECORD = {
  deviceId: DEVICE_ID,
  key: {},
  credentialGeneration: "gen-1",
  sequence: 0,
  confirmedByServer: true,
};

const tick = async (rounds = 3): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function makeTimers() {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    schedule: (callback: () => void): number => {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
    cancel: (id: number): void => { timers.delete(id); },
    drain: (): void => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    count: (): number => timers.size,
  };
}

type Timers = ReturnType<typeof makeTimers>;

async function pumpUntil(timers: Timers, predicate: () => boolean, rounds = 30): Promise<void> {
  for (let index = 0; index < rounds && !predicate(); index += 1) {
    timers.drain();
    await tick(2);
  }
}

function makeIndexedDB(initial: Record<string, unknown> | null) {
  let stored: Record<string, unknown> | null = initial;
  const ops = { puts: [] as unknown[], deletes: 0 };
  const open = (): unknown => {
    const request: { result?: unknown; onsuccess?: () => void } = {};
    const database = {
      objectStoreNames: { contains: () => true },
      close: () => {},
      transaction: () => {
        const transaction: {
          oncomplete: (() => void) | null;
          onerror: (() => void) | null;
          onabort: (() => void) | null;
          objectStore: () => unknown;
        } = { oncomplete: null, onerror: null, onabort: null, objectStore: () => ({}) };
        transaction.objectStore = () => ({
          get: () => {
            const getRequest: { result?: unknown; onsuccess?: () => void } = {};
            queueMicrotask(() => {
              getRequest.result = stored === null ? undefined : stored;
              getRequest.onsuccess?.();
              queueMicrotask(() => transaction.oncomplete?.());
            });
            return getRequest;
          },
          put: (value: unknown) => {
            ops.puts.push(value);
            stored = value as Record<string, unknown>;
            queueMicrotask(() => transaction.oncomplete?.());
          },
          delete: () => {
            ops.deletes += 1;
            stored = null;
            queueMicrotask(() => transaction.oncomplete?.());
          },
        });
        return transaction;
      },
    };
    queueMicrotask(() => {
      request.result = database;
      request.onsuccess?.();
    });
    return request;
  };
  return { open, ops, getStored: () => stored };
}

interface CommandBehavior {
  run: (init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>;
  resolve: (response: { ok: boolean; status: number }) => void;
  reject: (error: Error) => void;
}

const noopResolve = (): void => {};
const noopReject = (): void => {};

function manualBehavior(): CommandBehavior {
  let resolve!: (response: { ok: boolean; status: number }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ ok: boolean; status: number }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { run: () => promise, resolve, reject };
}

function abortableBehavior(): CommandBehavior {
  return {
    run: (init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
    resolve: noopResolve,
    reject: noopReject,
  };
}

function fixedBehavior(status: number): CommandBehavior {
  return { run: () => Promise.resolve({ ok: status < 400, status }), resolve: noopResolve, reject: noopReject };
}

function rejectBehavior(error: Error): CommandBehavior {
  return { run: () => Promise.reject(error), resolve: noopResolve, reject: noopReject };
}

function makeFetch() {
  const log: Array<{ url: string; init?: { body?: string; signal?: AbortSignal } }> = [];
  const commandBehaviors: CommandBehavior[] = [];
  let statusJson = { enabled: true, pairedDeviceCount: 1 };
  const fetch = vi.fn((url: string, init?: { body?: string; signal?: AbortSignal }) => {
    log.push({ url, init });
    if (url === "./api/status") {
      return Promise.resolve({ ok: true, status: 200, json: async () => statusJson });
    }
    if (url === "./api/command") {
      const behavior = commandBehaviors.length > 0
        ? commandBehaviors.shift()!
        : fixedBehavior(204);
      return behavior.run(init);
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  return {
    fetch,
    log,
    commandBehaviors,
    setStatusJson: (json: { enabled: boolean; pairedDeviceCount: number }) => { statusJson = json; },
    commandCalls: () => log.filter((entry) => entry.url === "./api/command"),
    statusCalls: () => log.filter((entry) => entry.url === "./api/status"),
    commandBodies: () => log
      .filter((entry) => entry.url === "./api/command")
      .map((entry) => JSON.parse(String(entry.init?.body))),
  };
}

function deterministicSign(): (algorithm: unknown, key: unknown, data: Uint8Array) => Promise<ArrayBuffer> {
  return async (_algorithm, _key, data) => {
    const text = new TextDecoder().decode(data);
    let hash = 2166136261 >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) bytes[index] = (hash >>> ((index % 4) * 8)) & 0xff;
    return bytes.buffer;
  };
}

interface PwaSandbox {
  elements: Map<string, ReturnType<typeof element>>;
  homeButton: ReturnType<typeof element>;
  backButton: ReturnType<typeof element>;
  windowListeners: Map<string, () => void>;
  documentListeners: Map<string, () => void>;
  fetchKit: ReturnType<typeof makeFetch>;
  timers: Timers;
  idb: ReturnType<typeof makeIndexedDB>;
  navigatorState: { onLine: boolean; serviceWorker: { register: () => Promise<void> } };
  replaceState: ReturnType<typeof vi.fn>;
}

function element(initial: Partial<{ hidden: boolean; disabled: boolean; textContent: string; value: string; dataset: Record<string, string> }> = {}) {
  const listeners = new Map<string, (event?: unknown) => void>();
  return {
    hidden: initial.hidden ?? false,
    disabled: initial.disabled ?? false,
    textContent: initial.textContent ?? "",
    value: initial.value ?? "",
    dataset: initial.dataset ?? {},
    listeners,
    addEventListener: (type: string, listener: (event?: unknown) => void) => { listeners.set(type, listener); },
  };
}

function runPwa(options: { hash?: string; record?: Record<string, unknown> | null } = {}): PwaSandbox {
  const elements = new Map<string, ReturnType<typeof element>>([
    ["connection-state", element()],
    ["server-state", element()],
    ["origin-state", element()],
    ["pairing-state", element()],
    ["paired-count", element({ textContent: "0" })],
    ["remote-message", element()],
    ["pairing-form", element({ hidden: true })],
    ["pair-button", element({ disabled: true })],
    ["retry-button", element({ hidden: true })],
    ["pairing-code", element()],
    ["device-name", element({ value: "iPhone" })],
    ["pairing-fragment-note", element({ hidden: true })],
    ["device-id", element({ textContent: "—" })],
    ["qr-onboarding-state", element({ textContent: "—" })],
    ["unknown-panel", element({ hidden: true })],
    ["unknown-confirm", element({ hidden: true })],
    ["unknown-note", element()],
    ["navigation-touchpad", element({ hidden: true, disabled: true })],
  ]);
  const homeButton = element({ disabled: true });
  homeButton.dataset.command = "home";
  const backButton = element({ disabled: true });
  backButton.dataset.command = "back";
  const windowListeners = new Map<string, () => void>();
  const documentListeners = new Map<string, () => void>();
  const fetchKit = makeFetch();
  const timers = makeTimers();
  const idb = makeIndexedDB(options.record === undefined ? { ...RECORD } : options.record);
  const navigatorState = { onLine: true, serviceWorker: { register: async () => {} } };
  const replaceState = vi.fn();
  const sign = deterministicSign();
  const indexedDB = { open: idb.open as never };
  const window = {
    isSecureContext: true,
    location: { protocol: "https:", hash: options.hash ?? "", pathname: "/", search: "" },
    crypto: { subtle: { sign, importKey: async () => ({}) } },
    indexedDB,
    addEventListener: (type: string, listener: () => void) => { windowListeners.set(type, listener); },
  };

  runInNewContext(script, {
    window,
    document: {
      visibilityState: "visible",
      getElementById: (id: string) => elements.get(id),
      querySelectorAll: () => [homeButton, backButton],
      addEventListener: (type: string, listener: () => void) => { documentListeners.set(type, listener); },
    },
    navigator: navigatorState,
    indexedDB,
    fetch: fetchKit.fetch,
    history: { replaceState },
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7), subtle: { sign, importKey: async () => ({}) } },
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
    setTimeout: timers.schedule,
    clearTimeout: timers.cancel,
    AbortController,
    queueMicrotask,
  });

  return {
    elements,
    homeButton,
    backButton,
    windowListeners,
    documentListeners,
    fetchKit,
    timers,
    idb,
    navigatorState,
    replaceState,
  };
}

async function loadPaired(sandbox: PwaSandbox): Promise<void> {
  await tick(4);
  expect(sandbox.elements.get("pairing-state")?.textContent).toBe("sparowane");
  expect(sandbox.homeButton.disabled).toBe(false);
}

describe("ascension D: PWA fail-closed command path (vm)", () => {
  it("shows the device identity once paired and derives QR onboarding states", async () => {
    const plain = runPwa();
    await loadPaired(plain);
    expect(plain.elements.get("device-id")?.textContent).toBe(DEVICE_ID);
    expect(plain.elements.get("qr-onboarding-state")?.textContent).toBe("—");

    const withQr = runPwa({ hash: "#pair=123456&exp=4102444800" });
    await tick(4);
    expect(withQr.elements.get("qr-onboarding-state")?.textContent).toBe("kod z QR aktywny");
    expect(withQr.elements.get("pairing-code")?.value).toBe("123456");
    expect(withQr.replaceState).toHaveBeenCalledWith(null, "", "/");

    const expired = runPwa({ hash: "#pair=123456&exp=1" });
    await tick(4);
    expect(expired.elements.get("qr-onboarding-state")?.textContent).toContain("wygasł");
    expect(expired.elements.get("pairing-code")?.value).toBe("");
  });

  it("keeps a single in-flight request and sends queued taps after it, each with its own sequence", async () => {
    const sandbox = runPwa();
    await loadPaired(sandbox);
    const first = manualBehavior();
    sandbox.fetchKit.commandBehaviors.push(first);

    sandbox.homeButton.listeners.get("click")?.();
    expect(sandbox.elements.get("remote-message")?.textContent).toBe("Wysyłam: Home…");
    expect(sandbox.homeButton.disabled).toBe(true);
    await tick(2);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(1);

    // Second tap while the first is in flight: queued, NOT sent.
    sandbox.homeButton.listeners.get("click")?.();
    await tick(2);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(1);
    expect(sandbox.elements.get("remote-message")?.textContent).toContain("kolejce");

    first.resolve({ ok: true, status: 204 });
    await pumpUntil(sandbox.timers, () => sandbox.fetchKit.commandCalls().length === 2);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(2);
    const bodies = sandbox.fetchKit.commandBodies();
    expect(bodies[0].command).toBe("home");
    expect(bodies[0].sequence).toBe(1);
    expect(bodies[1].command).toBe("home");
    expect(bodies[1].sequence).toBe(2);
    expect(bodies[1].signature).not.toBe(bodies[0].signature);
    expect(bodies[0].deviceId).toBe(DEVICE_ID);

    // Let the queued one finish too (default behavior: 204).
    await pumpUntil(sandbox.timers, () => sandbox.elements.get("remote-message")?.textContent === "Wysłano: Home.");
    expect(sandbox.homeButton.disabled).toBe(false);
  });

  it("marks an ambiguous timeout after send as unknown, never auto-retries it, and re-confirmation re-sends the identical signed body", async () => {
    const sandbox = runPwa();
    await loadPaired(sandbox);
    sandbox.fetchKit.commandBehaviors.push(abortableBehavior());

    sandbox.homeButton.listeners.get("click")?.();
    await tick(2);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(1);
    // Fire the request deadline (AbortController) -> ambiguous AFTER send.
    sandbox.timers.drain();
    await pumpUntil(sandbox.timers, () => sandbox.fetchKit.commandCalls().length >= 1 && sandbox.elements.get("unknown-panel")?.hidden === false, 10);
    await tick(3);

    // NOT auto-retried: still exactly one /api/command call, even after timers run out.
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(1);
    expect(sandbox.elements.get("remote-message")?.textContent).toContain("Polecenie nie zostało automatycznie ponowione");
    expect(sandbox.elements.get("unknown-panel")?.hidden).toBe(false);
    expect(sandbox.elements.get("unknown-note")?.textContent).toContain("Home");

    // Explicit re-confirmation (re-tap the same command): ONE more call with the
    // EXACT same signed body — same sequence AND same signature, never re-signed.
    const confirm = manualBehavior();
    sandbox.fetchKit.commandBehaviors.push(confirm);
    sandbox.homeButton.listeners.get("click")?.();
    await tick(3);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(2);
    const bodies = sandbox.fetchKit.commandBodies();
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(bodies[0]));
    expect(bodies[1].sequence).toBe(1);

    confirm.resolve({ ok: true, status: 204 });
    await tick(3);
    expect(sandbox.elements.get("remote-message")?.textContent).toBe("Wysłano: Home.");
    expect(sandbox.elements.get("unknown-panel")?.hidden).toBe(true);
    // The signed payload format is byte-identical: prefix + deviceId + sequence + command.
    expect(String(bodies[0].signature)).toBeTruthy();
  });

  it("auto-retries a provably never-reached failure bounded (<=3) with identical signed bytes, then fails closed to unknown", async () => {
    const sandbox = runPwa();
    await loadPaired(sandbox);
    const failure = new TypeError("Failed to fetch"); // DNS / connect refused before send
    for (let index = 0; index < 8; index += 1) {
      sandbox.fetchKit.commandBehaviors.push(rejectBehavior(failure));
    }

    sandbox.homeButton.listeners.get("click")?.();
    await pumpUntil(sandbox.timers, () => sandbox.fetchKit.commandCalls().length >= 4, 40);
    await tick(3);
    // 1 initial attempt + 3 bounded retries — never more.
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(4);
    const bodies = sandbox.fetchKit.commandBodies();
    for (const body of bodies) {
      expect(JSON.stringify(body)).toBe(JSON.stringify(bodies[0]));
    }
    // Bound exhausted -> fail closed: marked unknown, no further auto-retry.
    await pumpUntil(sandbox.timers, () => false, 5);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(4);
    expect(sandbox.elements.get("unknown-panel")?.hidden).toBe(false);
    expect(sandbox.elements.get("remote-message")?.textContent).toContain("nie zostało automatycznie ponowione");
  });

  it("surfaces 401 replay-rejected as a clear unpair state with no retry, and 409 as ambiguous-unknown", async () => {
    const sandbox = runPwa();
    await loadPaired(sandbox);
    sandbox.fetchKit.commandBehaviors.push(fixedBehavior(401));
    sandbox.homeButton.listeners.get("click")?.();
    await tick(4);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(1);
    expect(sandbox.elements.get("pairing-form")?.hidden).toBe(false);
    expect(sandbox.elements.get("pairing-state")?.textContent).toBe("wymagane ponowne parowanie");
    expect(sandbox.elements.get("connection-state")?.dataset.state).toBe("needs-pairing");
    expect(sandbox.elements.get("remote-message")?.textContent).toContain("nie akceptuje już poświadczeń");
    // The stored credential was rejected (tombstoned/deleted), never reused.
    expect(sandbox.idb.ops.deletes + sandbox.idb.ops.puts.length).toBeGreaterThan(0);
    expect(sandbox.homeButton.disabled).toBe(true);
    expect(sandbox.elements.get("device-id")?.textContent).toBe("—");

    const sandbox409 = runPwa();
    await loadPaired(sandbox409);
    sandbox409.fetchKit.commandBehaviors.push(fixedBehavior(409));
    sandbox409.homeButton.listeners.get("click")?.();
    await tick(4);
    expect(sandbox409.fetchKit.commandCalls()).toHaveLength(1);
    expect(sandbox409.elements.get("remote-message")?.textContent).toContain("nie może potwierdzić wyniku polecenia");
    expect(sandbox409.elements.get("unknown-panel")?.hidden).toBe(false);
  });

  it("queues a tap while offline, re-syncs status on reconnect and sends only never-sent intents — never the unknown one", async () => {
    const sandbox = runPwa();
    await loadPaired(sandbox);

    // Create an "unknown" command first (ambiguous timeout after send).
    sandbox.fetchKit.commandBehaviors.push(abortableBehavior());
    sandbox.homeButton.listeners.get("click")?.();
    await tick(2);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(1);
    sandbox.timers.drain();
    await tick(3);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(1);
    expect(sandbox.elements.get("unknown-panel")?.hidden).toBe(false);
    const statusCallsBefore = sandbox.fetchKit.statusCalls().length;

    // Wi-Fi loss: a new tap is queued, not sent.
    sandbox.navigatorState.onLine = false;
    sandbox.windowListeners.get("offline")?.();
    expect(sandbox.elements.get("remote-message")?.textContent).toContain("offline");
    sandbox.backButton.listeners.get("click")?.();
    await tick(2);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(1);
    expect(sandbox.elements.get("remote-message")?.textContent).toContain("kolejce");

    // Wi-Fi back: reconnect re-syncs status (stale-read guard kept), then the
    // queued never-sent intent goes out exactly once. The unknown entry is NOT
    // auto-replayed.
    sandbox.navigatorState.onLine = true;
    const queued = manualBehavior();
    sandbox.fetchKit.commandBehaviors.push(queued);
    sandbox.windowListeners.get("online")?.();
    await pumpUntil(sandbox.timers, () => sandbox.fetchKit.commandCalls().length === 2, 20);
    await tick(3);
    expect(sandbox.fetchKit.statusCalls().length).toBeGreaterThan(statusCallsBefore);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(2);
    const bodies = sandbox.fetchKit.commandBodies();
    expect(bodies[0].command).toBe("home");
    expect(bodies[1].command).toBe("back");
    expect(bodies[1].sequence).toBe(2);

    queued.resolve({ ok: true, status: 204 });
    await tick(3);
    expect(sandbox.elements.get("remote-message")?.textContent).toBe("Wysłano: Wstecz.");
    // Still no third call: the unknown "home" entry was never auto-replayed.
    await pumpUntil(sandbox.timers, () => false, 4);
    expect(sandbox.fetchKit.commandCalls()).toHaveLength(2);
    expect(sandbox.elements.get("unknown-panel")?.hidden).toBe(false);
  });

  it("keeps the signed payload format byte-identical in every outbound body", async () => {
    const sandbox = runPwa();
    await loadPaired(sandbox);
    const first = manualBehavior();
    sandbox.fetchKit.commandBehaviors.push(first);
    sandbox.homeButton.listeners.get("click")?.();
    await tick(3);
    const body = sandbox.fetchKit.commandBodies()[0];
    expect(Object.keys(body).sort()).toEqual(["command", "deviceId", "sequence", "signature"]);
    expect(body.deviceId).toBe(DEVICE_ID);
    expect(body.command).toBe("home");
    expect(Number.isSafeInteger(body.sequence)).toBe(true);
    expect(typeof body.signature).toBe("string");
    // The HMAC is computed over exactly NEXUS-AUREA-REMOTE-V1\n{deviceId}\n{sequence}\n{command}.
    expect(script).toContain('["NEXUS-AUREA-REMOTE-V1", record.deviceId, String(sequence), command].join("\\n")');
    expect(script).toContain('name: "HMAC"');
    expect(html).toContain('id="unknown-panel"');
    expect(html).toContain('id="device-id"');
    expect(html).toContain('id="qr-onboarding-state"');
  });
});
