import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Stored = { deviceId: string; key?: object; sequence?: number; confirmedByServer?: boolean; credentialGeneration?: string; rejectedByServer?: boolean };
type DatabaseState = { value: Stored | null; failNextDelete?: boolean };
const databaseQueues = new WeakMap<DatabaseState, { running: boolean; queue: (() => void)[] }>();
type BrowserLock = { name: string } | null;
const script = readFileSync("public/remote/app.js", "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

function client(options: {
  stored?: DatabaseState;
  locks?: { request: (name: string, options: { ifAvailable: boolean }, callback: (lock: BrowserLock) => Promise<void>) => Promise<void> };
  commandResponse?: () => Promise<{ ok: boolean; status: number }>;
  pairResponse?: () => Promise<{ status: number }>;
  beforeMutationRead?: () => void;
} = {}) {
  const stored = options.stored ?? { value: { deviceId: "phone", key: {}, sequence: 0, confirmedByServer: true } };
  const element = () => {
    const events = new Map<string, (event: Record<string, unknown>) => void>();
    return {
      disabled: true, hidden: false, textContent: "", value: "", dataset: {} as Record<string, string>,
      events, setPointerCapture: vi.fn(),
      setAttribute(name: string, value: string) { this.dataset[name] = value; },
      addEventListener(name: string, callback: (event: Record<string, unknown>) => void) { events.set(name, callback); },
      fire(name: string, event: Record<string, unknown> = {}) { events.get(name)?.(event); },
    };
  };
  const ids = ["connection-state", "server-state", "origin-state", "pairing-state", "paired-count", "remote-message",
    "pairing-form", "pair-button", "pairing-code", "device-name", "retry-button", "navigation-touchpad", "pad-mode", "touch-mode"];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  elements["navigation-touchpad"].hidden = true;
  const pad = element();
  const commandButton = element();
  elements["pairing-code"].value = "123456";
  elements["device-name"].value = "iPhone";
  commandButton.dataset.command = "home";
  const indexedDB = {
    open() {
      const request: { result?: unknown; onsuccess?: () => void } = {};
      const database = {
        close() {},
        transaction(_storeName: string, mode: string) {
          const transaction: { oncomplete?: () => void; onabort?: () => void; objectStore?: () => unknown } = {};
          let pending: Stored | null | undefined;
          let abort = false;
          transaction.objectStore = () => ({
            get() {
              const result: { result?: Stored; onsuccess?: () => void } = {};
              let serialized = databaseQueues.get(stored);
              if (!serialized) { serialized = { running: false, queue: [] }; databaseQueues.set(stored, serialized); }
              const queue = serialized;
              const run = () => queueMicrotask(() => {
                if (mode === "readwrite") options.beforeMutationRead?.();
                result.result = stored.value ? { ...stored.value } : undefined;
                result.onsuccess?.();
                queueMicrotask(() => {
                  if (abort) transaction.onabort?.();
                  else { if (pending !== undefined) stored.value = pending; transaction.oncomplete?.(); }
                  const next = queue.queue.shift();
                  if (next) next(); else queue.running = false;
                });
              });
              if (queue.running) queue.queue.push(run);
              else { queue.running = true; run(); }
              return result;
            },
            put(value: Stored) { pending = { ...value }; },
            delete() { if (stored.failNextDelete) { stored.failNextDelete = false; abort = true; } else pending = null; },
          });
          return transaction;
        },
      };
      queueMicrotask(() => { request.result = database; request.onsuccess?.(); });
      return request;
    },
  };
  const navigator = { onLine: true, locks: options.locks };
  const windowEvents = new Map<string, () => void>();
  const fetch = vi.fn(async (url: string, _init?: { body?: string }) => {
    if (url === "./api/status") return { ok: true, status: 200, json: async () => ({ enabled: true, pairedDeviceCount: 1 }) };
    if (url === "./api/pair") return options.pairResponse?.() ?? { status: 201 };
    return options.commandResponse?.() ?? { ok: true, status: 200 };
  });
  const signature = vi.fn(async () => new Uint8Array([1]).buffer);
  let randomByte = 10;
  runInNewContext(script, {
    document: { visibilityState: "visible", getElementById: (id: string) => elements[id],
      querySelectorAll: () => [commandButton], querySelector: () => pad, addEventListener() {} },
    window: { isSecureContext: true, location: { protocol: "https:" }, crypto: { subtle: {} }, indexedDB,
      addEventListener: (name: string, callback: () => void) => windowEvents.set(name, callback) },
    navigator, indexedDB, fetch, crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(randomByte++), subtle: { sign: signature, importKey: async () => ({}) } },
    TextEncoder, Uint8Array, AbortController, queueMicrotask,
    setTimeout: () => 1, clearTimeout() {}, btoa: (value: string) => value,
  });
  const touch = (name: string, extra: Record<string, unknown> = {}) => elements["navigation-touchpad"].fire(name,
    { pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 100, timeStamp: 100, ...extra });
  const commands = () => fetch.mock.calls.filter(([url]) => url === "./api/command")
    .map(([, init]) => JSON.parse(init?.body ?? "{}") as { command: string; sequence: number });
  return { elements, pad, touch, commands, stored, navigator, windowEvents, signature, commandButton };
}

describe("authenticated remote navigation touchpad", () => {
  it("sends one existing direction on swipe and select on a deliberate tap", async () => {
    const page = client();
    await settle();
    page.elements["touch-mode"].fire("click");
    expect(page.pad.hidden).toBe(true);
    expect(page.elements["navigation-touchpad"].hidden).toBe(false);
    page.touch("pointerdown");
    page.touch("pointerup", { clientX: 180, timeStamp: 300 });
    await settle();
    expect(page.commands()).toEqual([{ command: "right", sequence: 1, deviceId: "phone", signature: "\u0001" }]);
    page.touch("pointerdown");
    page.touch("pointerup", { timeStamp: 250 });
    await settle();
    expect(page.commands().map(command => command.command)).toEqual(["right", "select"]);
    expect(page.signature).toHaveBeenCalledTimes(2);
  });

  it("cancels interrupted, multi-finger, ambiguous and offline gestures without deferred replay", async () => {
    const page = client();
    await settle();
    page.elements["touch-mode"].fire("click");
    page.touch("pointerdown"); page.touch("pointercancel"); page.touch("pointerup", { clientX: 180 });
    page.touch("pointerdown"); page.touch("pointerdown", { isPrimary: false, pointerId: 2 }); page.touch("pointerup", { clientX: 180 });
    page.touch("pointerdown"); page.touch("pointerup", { clientX: 115 });
    page.touch("pointerdown"); page.touch("pointerup", { timeStamp: 2000 });
    page.touch("pointerdown"); page.elements["pad-mode"].fire("click"); page.touch("pointerup", { clientX: 180 });
    page.elements["touch-mode"].fire("click"); page.touch("pointerdown");
    page.navigator.onLine = false; page.windowEvents.get("offline")?.();
    page.touch("pointerup", { clientX: 180 });
    page.navigator.onLine = true; page.windowEvents.get("online")?.();
    await settle();
    expect(page.commands()).toEqual([]);
    expect(page.signature).not.toHaveBeenCalled();
  });

  it("does not queue another tab's action and rereads the shared sequence before its next action", async () => {
    let locked = false;
    const request = vi.fn(async (name: string, options: { ifAvailable: boolean }, callback: (lock: BrowserLock) => Promise<void>) => {
      expect(options.ifAvailable).toBe(true);
      if (locked) return callback(null);
      locked = true;
      try { await callback({ name }); } finally { locked = false; }
    });
    let complete!: (value: { ok: boolean; status: number }) => void;
    const response = new Promise<{ ok: boolean; status: number }>(resolve => { complete = resolve; });
    const stored = { value: { deviceId: "phone", key: {}, sequence: 0, confirmedByServer: true } };
    const first = client({ stored, locks: { request }, commandResponse: () => response });
    const second = client({ stored, locks: { request } });
    await settle();
    first.commandButton.fire("click"); await settle();
    second.commandButton.fire("click"); await settle();
    expect(second.commands()).toEqual([]);
    expect(second.elements["remote-message"].textContent).toContain("Inna karta");
    complete({ ok: true, status: 200 }); await settle();
    expect(second.commands()).toEqual([]);
    second.commandButton.fire("click"); await settle();
    expect(first.commands()[0].sequence).toBe(1);
    expect(second.commands()[0].sequence).toBe(2);
  });

  it("rejects a changed pairing or exhausted sequence before signing", async () => {
    const page = client();
    await settle();
    page.stored.value = { ...page.stored.value, deviceId: "different-phone" };
    page.commandButton.fire("click"); await settle();
    expect(page.commands()).toEqual([]);
    page.stored.value = { ...page.stored.value, deviceId: "phone", sequence: Number.MAX_SAFE_INTEGER };
    page.commandButton.fire("click"); await settle();
    expect(page.signature).not.toHaveBeenCalled();
  });

  it("preserves a replacement generation after stale 401 and accepts it on refresh without Web Locks", async () => {
    let complete!: (value: { ok: boolean; status: number }) => void;
    const response = new Promise<{ ok: boolean; status: number }>(resolve => { complete = resolve; });
    const old = { deviceId: "phone", credentialGeneration: "old", key: {}, sequence: 0, confirmedByServer: true };
    const replacement = { ...old, credentialGeneration: "new", key: {}, sequence: 12 };
    const stored: DatabaseState = { value: old };
    let commands = 0;
    const page = client({ stored, commandResponse: () => ++commands === 1 ? response : Promise.resolve({ ok: true, status: 200 }) });
    await settle(); page.commandButton.fire("click"); await settle();
    stored.value = replacement;
    complete({ ok: false, status: 401 }); await settle();
    expect(stored.value).toEqual(replacement);
    page.windowEvents.get("online")?.(); await settle();
    expect(page.commandButton.disabled).toBe(false);
    page.commandButton.fire("click"); await settle();
    expect(page.commands().map(command => command.sequence)).toEqual([1, 13]);
    expect(stored.value?.credentialGeneration).toBe("new");
  });

  it("never replaces a newer credential while reserving a sequence", async () => {
    const old = { deviceId: "phone", credentialGeneration: "old", key: {}, sequence: 0, confirmedByServer: true };
    const replacement = { ...old, credentialGeneration: "new", key: {}, sequence: 40 };
    const stored: DatabaseState = { value: old };
    const page = client({ stored, beforeMutationRead: () => { stored.value = replacement; } });
    await settle(); page.commandButton.fire("click"); await settle();
    expect(stored.value).toEqual(replacement);
    expect(page.commands()).toEqual([]);
    expect(page.signature).not.toHaveBeenCalled();
  });

  it("reserves distinct sequences in one serialized readwrite transaction without Web Locks", async () => {
    const stored: DatabaseState = { value: { deviceId: "phone", key: {}, sequence: 0, confirmedByServer: true } };
    const first = client({ stored }); const second = client({ stored });
    await settle(); first.commandButton.fire("click"); second.commandButton.fire("click"); await settle();
    expect([...first.commands(), ...second.commands()].map(command => command.sequence).sort()).toEqual([1, 2]);
    expect(stored.value?.sequence).toBe(2);
  });

  it("does not delete a newer confirmed pairing during stale unconfirmed status cleanup", async () => {
    const replacement = { deviceId: "fresh", credentialGeneration: "new", key: {}, sequence: 7, confirmedByServer: true };
    const stored: DatabaseState = { value: { deviceId: "unconfirmed", key: {}, sequence: 0, confirmedByServer: false } };
    const page = client({ stored, beforeMutationRead: () => { stored.value = replacement; } });
    await settle();
    expect(stored.value).toEqual(replacement);
    page.windowEvents.get("online")?.(); await settle();
    expect(page.commandButton.disabled).toBe(false);
  });

  it.each([201, 400])("preserves a concurrent pairing after this attempt's HTTP %s", async status => {
    let complete!: (value: { status: number }) => void;
    const response = new Promise<{ status: number }>(resolve => { complete = resolve; });
    const stored: DatabaseState = { value: null };
    const page = client({ stored, pairResponse: () => response });
    await settle(); page.elements["pairing-form"].fire("submit", { preventDefault() {} }); await settle();
    const replacement = { deviceId: "fresh", credentialGeneration: "new", key: {}, sequence: 7, confirmedByServer: true };
    stored.value = replacement;
    complete({ status }); await settle();
    expect(stored.value).toEqual(replacement);
    if (status === 201) expect(page.commandButton.disabled).toBe(false);
  });

  it("guards the rejection tombstone when deletion fails and another tab replaces the key", async () => {
    const old = { deviceId: "phone", credentialGeneration: "old", key: {}, sequence: 0, confirmedByServer: true };
    const replacement = { ...old, credentialGeneration: "new", key: {}, sequence: 4 };
    const stored: DatabaseState = { value: old, failNextDelete: true };
    let mutations = 0;
    const page = client({ stored, commandResponse: async () => ({ ok: false, status: 401 }),
      beforeMutationRead: () => { if (++mutations === 3) stored.value = replacement; } });
    await settle(); page.commandButton.fire("click"); await settle();
    expect(mutations).toBe(3);
    expect(stored.value).toEqual(replacement);
  });
});
