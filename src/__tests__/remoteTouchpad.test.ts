import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Stored = { deviceId: string; key: object; sequence: number; confirmedByServer: boolean };
type BrowserLock = { name: string } | null;
const script = readFileSync("public/remote/app.js", "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

function client(options: {
  stored?: { value: Stored };
  locks?: { request: (name: string, options: { ifAvailable: boolean }, callback: (lock: BrowserLock) => Promise<void>) => Promise<void> };
  commandResponse?: () => Promise<{ ok: boolean; status: number }>;
} = {}) {
  const stored = options.stored ?? { value: { deviceId: "phone", key: {}, sequence: 0, confirmedByServer: true } };
  const element = () => {
    const events = new Map<string, (event: Record<string, unknown>) => void>();
    return {
      disabled: true, hidden: false, textContent: "", dataset: {} as Record<string, string>,
      events, setPointerCapture: vi.fn(),
      setAttribute(name: string, value: string) { this.dataset[name] = value; },
      addEventListener(name: string, callback: (event: Record<string, unknown>) => void) { events.set(name, callback); },
      fire(name: string, event: Record<string, unknown> = {}) { events.get(name)?.(event); },
    };
  };
  const ids = ["connection-state", "server-state", "origin-state", "pairing-state", "paired-count", "remote-message",
    "pairing-form", "pair-button", "retry-button", "navigation-touchpad", "pad-mode", "touch-mode"];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  elements["navigation-touchpad"].hidden = true;
  const pad = element();
  const commandButton = element();
  commandButton.dataset.command = "home";
  const indexedDB = {
    open() {
      const request: { result?: unknown; onsuccess?: () => void } = {};
      const database = {
        close() {},
        transaction() {
          const transaction: { oncomplete?: () => void; objectStore?: () => unknown } = {};
          transaction.objectStore = () => ({
            get() {
              const result: { result?: Stored; onsuccess?: () => void } = {};
              queueMicrotask(() => {
                result.result = { ...stored.value };
                result.onsuccess?.();
                transaction.oncomplete?.();
              });
              return result;
            },
            put(value: Stored) { stored.value = { ...value }; queueMicrotask(() => transaction.oncomplete?.()); },
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
    return options.commandResponse?.() ?? { ok: true, status: 200 };
  });
  const signature = vi.fn(async () => new Uint8Array([1]).buffer);
  runInNewContext(script, {
    document: { visibilityState: "visible", getElementById: (id: string) => elements[id],
      querySelectorAll: () => [commandButton], querySelector: () => pad, addEventListener() {} },
    window: { isSecureContext: true, location: { protocol: "https:" }, crypto: { subtle: {} }, indexedDB,
      addEventListener: (name: string, callback: () => void) => windowEvents.set(name, callback) },
    navigator, indexedDB, fetch, crypto: { subtle: { sign: signature } },
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
});
