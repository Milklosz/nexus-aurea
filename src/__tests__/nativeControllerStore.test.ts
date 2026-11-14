import { describe, expect, it, vi } from "vitest";
import { NativeControllerStore, type NativeControllerDeps } from "../services/nativeControllerStore";
import type { NativeControllerEvent, NativeControllerStatus } from "../services/nativeController";

function harness(initial: Partial<NativeControllerStatus> = {}) {
  let emit: ((event: NativeControllerEvent) => void) | null = null;
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  let status: NativeControllerStatus = {
    supported: true, running: true, lastError: null, pads: [], ignoredReports: 0, ...initial,
  };
  const listen = vi.fn(async (callback: (event: NativeControllerEvent) => void) => {
    emit = callback;
    const stop = vi.fn(() => { if (emit === callback) emit = null; });
    stops.push(stop);
    return stop;
  });
  const deps: NativeControllerDeps = {
    listen,
    getStatus: vi.fn(async () => status),
    now: () => 1000,
  };
  return {
    store: new NativeControllerStore(deps),
    deps,
    listen,
    stops,
    fire: (event: NativeControllerEvent) => emit?.(event),
    setStatus: (next: Partial<NativeControllerStatus>) => { status = { ...status, ...next }; },
    hasListener: () => emit !== null,
  };
}

const connected = (device: string): NativeControllerEvent => ({ kind: "connected", device, revision: "v2", transport: "usb" });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NativeControllerStore", () => {
  it("shares one listener across consumers and removes it with the last release", async () => {
    const h = harness();
    const a = h.store.acquire();
    const b = h.store.acquire();
    const c = h.store.acquire();
    await flush();
    expect(h.listen).toHaveBeenCalledTimes(1);
    expect(h.store.listenerCount).toBe(1);
    a(); b();
    expect(h.store.listenerCount).toBe(1);
    c();
    expect(h.store.listenerCount).toBe(0);
    expect(h.stops[0]).toHaveBeenCalledTimes(1);
    expect(h.hasListener()).toBe(false);
  });

  it("release is idempotent", async () => {
    const h = harness();
    const release = h.store.acquire();
    await flush();
    release(); release(); release();
    expect(h.stops[0]).toHaveBeenCalledTimes(1);
    const again = h.store.acquire();
    await flush();
    expect(h.listen).toHaveBeenCalledTimes(2);
    again();
  });

  it("does not leak a listener when released before the async listen resolves", async () => {
    const h = harness();
    const release = h.store.acquire();
    release(); // before the listen promise settled
    await flush();
    expect(h.stops[0]).toHaveBeenCalledTimes(1);
    expect(h.store.listenerCount).toBe(0);
  });

  it("applies events and notifies subscribers", async () => {
    const h = harness();
    const seen = vi.fn();
    h.store.subscribe(seen);
    h.store.acquire();
    await flush();
    h.fire(connected("a"));
    expect(h.store.getModel().pads).toHaveLength(1);
    expect(seen).toHaveBeenCalled();
  });

  it("seeds pads that were connected before the listener attached", async () => {
    const h = harness({ pads: [{ device: "pre", revision: "v1", transport: "bluetooth" }] });
    h.store.acquire();
    await flush();
    expect(h.store.getModel().pads.map((pad) => pad.device)).toEqual(["pre"]);
    expect(h.store.getModel().activeDevice).toBe("pre");
  });

  it("reconcile drops a pad the native layer no longer lists (missed disconnect)", async () => {
    const h = harness();
    h.store.acquire();
    await flush();
    h.fire(connected("a"));
    h.setStatus({ pads: [] });
    await h.store.reconcile();
    expect(h.store.getModel().pads).toEqual([]);
    expect(h.store.getModel().activeDevice).toBeNull();
  });

  it("stays quiet when the native layer is unsupported (non-Windows), leaving the Gamepad API fallback", async () => {
    const h = harness({ supported: false, running: false });
    h.store.acquire();
    await flush();
    expect(h.store.getModel().unavailableReason).toBeNull();
    expect(h.store.getModel().pads).toEqual([]);
  });

  it("reports unavailable when the native runtime failed to start", async () => {
    const h = harness({ running: false, lastError: "Raw Input registration failed" });
    h.store.acquire();
    await flush();
    expect(h.store.getModel().unavailableReason).toContain("Raw Input");
  });

  it("a failed listen marks the layer unavailable instead of throwing", async () => {
    const h = harness();
    (h.deps.listen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no ipc"));
    h.store.acquire();
    await flush();
    expect(h.store.getModel().unavailableReason).toBe("listen failed");
  });

  it("ignores events from a previous generation after remount (reload safety)", async () => {
    const h = harness();
    const first = h.store.acquire();
    await flush();
    const staleEmit = h.listen.mock.calls[0]![0] as (event: NativeControllerEvent) => void;
    first();
    h.store.acquire();
    await flush();
    staleEmit(connected("ghost")); // old callback is detached; must not reach the model
    expect(h.store.getModel().pads.map((pad) => pad.device)).not.toContain("ghost");
  });

  it("resets the model when the last consumer leaves", async () => {
    const h = harness();
    const release = h.store.acquire();
    await flush();
    h.fire(connected("a"));
    release();
    expect(h.store.getModel().pads).toEqual([]);
  });
});
