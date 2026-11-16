import { describe, expect, it, vi } from "vitest";
import { NativeControllerStore, type NativeControllerDeps } from "../services/nativeControllerStore";
import { disabledNativeControllerStatus, type NativeControllerEvent, type NativeControllerStatus } from "../services/nativeController";

function harness(initial: Partial<NativeControllerStatus> = {}) {
  let emit: ((event: NativeControllerEvent) => void) | null = null;
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  let status: NativeControllerStatus = {
    ...disabledNativeControllerStatus, supported: true, running: true, ...initial,
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
    setHomeEnabled: vi.fn(async (enabled: boolean) => {
      status = { ...status, homeEnabled: enabled, homeOverride: enabled };
      return status;
    }),
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

  it("publishes the session-only Home policy returned by the native command", async () => {
    const h = harness();
    await h.store.setHomeEnabled(true);
    expect(h.deps.setHomeEnabled).toHaveBeenCalledWith(true);
    expect(h.store.getStatusSnapshot()).toMatchObject({ homeEnabled: true, homeOverride: true });
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

  it("clears stale native ownership when the sink stops without an error", async () => {
    const h = harness({ pads: [{ device: "a", revision: "v2", transport: "usb" }] });
    const release = h.store.acquire();
    await flush();
    expect(h.store.getModel().pads).toHaveLength(1);
    h.setStatus({ running: false, pads: [] });
    await h.store.reconcile();
    expect(h.store.getModel().pads).toEqual([]);
    release();
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

  it("a status reply that raced a disconnect never resurrects the pad", async () => {
    const h = harness({ pads: [{ device: "a", revision: "v2", transport: "usb" }] });
    h.store.acquire();
    await flush();
    expect(h.store.getModel().pads).toHaveLength(1);
    // The next status request is answered with a pad list taken BEFORE the pad vanished.
    let calls = 0;
    (h.deps.getStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        h.fire({ kind: "disconnected", device: "a" }); // the event overtakes the stale reply
        return { ...disabledNativeControllerStatus, supported: true, running: true, pads: [{ device: "a", revision: "v2", transport: "usb" }] };
      }
      return { ...disabledNativeControllerStatus, supported: true, running: true, pads: [] };
    });
    await h.store.reconcile();
    expect(calls).toBe(2); // asked again because an event arrived in flight
    expect(h.store.getModel().pads).toEqual([]);
  });

  it("shares one pending native status read and ignores its reply after the store generation changes", async () => {
    const h = harness();
    let resolveOld!: (status: NativeControllerStatus) => void;
    (h.deps.getStatus as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise<NativeControllerStatus>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ ...disabledNativeControllerStatus, supported: true, running: true, pads: [] });
    const release = h.store.acquire();
    await flush();
    expect(h.deps.getStatus).toHaveBeenCalledTimes(1);

    const reads = [h.store.reconcile(), h.store.reconcile(), h.store.reconcile()];
    expect(h.deps.getStatus).toHaveBeenCalledTimes(1);
    release();
    const releaseAgain = h.store.acquire();
    await flush();
    expect(h.deps.getStatus).toHaveBeenCalledTimes(2);

    resolveOld({
      ...disabledNativeControllerStatus,
      supported: true,
      running: true,
      pads: [{ device: "stale", revision: "v2", transport: "usb" }],
    });
    await Promise.all(reads);
    await flush();
    expect(h.store.getModel().pads.map((pad) => pad.device)).not.toContain("stale");
    expect(h.store.getStatusSnapshot().pads.map((pad) => pad.device)).not.toContain("stale");
    releaseAgain();
  });

  it("marks a timed out native status read unknown and ignores a late reply", async () => {
    const h = harness();
    let resolveRead!: (status: NativeControllerStatus) => void;
    (h.deps.getStatus as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<NativeControllerStatus>((resolve) => { resolveRead = resolve; }),
    );
    const release = h.store.acquire();
    await flush();
    h.store.invalidateStatusRead();
    resolveRead({
      ...disabledNativeControllerStatus,
      supported: true,
      running: true,
      pads: [{ device: "late", revision: "v2", transport: "usb" }],
    });
    await flush();
    expect(h.store.getStatusKnown()).toBe(false);
    expect(h.store.getModel().pads.map((pad) => pad.device)).not.toContain("late");
    release();
  });

  it("keeps timed-out status reads singleflight until settle, then allows a fresh read", async () => {
    const h = harness();
    let resolveStalled!: (status: NativeControllerStatus) => void;
    (h.deps.getStatus as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise<NativeControllerStatus>((resolve) => { resolveStalled = resolve; }))
      .mockResolvedValueOnce({ ...disabledNativeControllerStatus, supported: true, running: true, pads: [] });

    const stalled = h.store.reconcile();
    expect(h.deps.getStatus).toHaveBeenCalledTimes(1);
    h.store.invalidateStatusRead();
    const joinedAfterFirstTimeout = h.store.reconcile();
    h.store.invalidateStatusRead();
    const joinedAfterSecondTimeout = h.store.reconcile();

    expect(h.deps.getStatus).toHaveBeenCalledTimes(1);
    resolveStalled({
      ...disabledNativeControllerStatus,
      supported: true,
      running: true,
      pads: [{ device: "stale", revision: "v2", transport: "usb" }],
    });
    await Promise.all([stalled, joinedAfterFirstTimeout, joinedAfterSecondTimeout]);
    await flush();
    expect(h.store.getStatusKnown()).toBe(false);
    expect(h.store.getModel().pads).toEqual([]);

    await h.store.reconcile();
    expect(h.deps.getStatus).toHaveBeenCalledTimes(2);
    expect(h.store.getStatusKnown()).toBe(true);
  });

  it("keeps an explicit Home acknowledgement newer than an older pending status read", async () => {
    const h = harness();
    let resolveRead!: (status: NativeControllerStatus) => void;
    (h.deps.getStatus as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<NativeControllerStatus>((resolve) => { resolveRead = resolve; }),
    );
    const release = h.store.acquire();
    await flush();

    const enabled = await h.store.setHomeEnabled(true);
    expect(enabled.homeEnabled).toBe(true);
    resolveRead({ ...disabledNativeControllerStatus, supported: true, running: true, homeEnabled: false });
    await flush();

    expect(h.store.getStatusSnapshot().homeEnabled).toBe(true);
    release();
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
