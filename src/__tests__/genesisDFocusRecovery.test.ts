// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  listen: vi.fn(
    (_event: string, _cb: (e: { payload: unknown }) => void): Promise<() => void> =>
      Promise.resolve(() => {}),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  DISPLAY_CHANGED_EVENT,
  DisplayTopologyFocusRecovery,
  TOPOLOGY_MAX_RESTORES,
  attachDisplayTopologyRecovery,
  type DisplayTopologyChangeLike,
} from "../services/windowFocusRestore";
import { ExactlyOnceRecoveryGate } from "../services/focusOwnership";
import { focusWindowSafelyBounded } from "../services/focusWindowSafely";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mocks.isTauri.mockReturnValue(false);
  mocks.listen.mockReset();
  mocks.listen.mockImplementation(() => Promise.resolve(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExactlyOnceRecoveryGate", () => {
  it("allows each trigger exactly once and is bounded", () => {
    const gate = new ExactlyOnceRecoveryGate(3);
    expect(gate.tryAcquire("a")).toBe(true);
    expect(gate.tryAcquire("a")).toBe(false);
    expect(gate.tryAcquire("a")).toBe(false);
    expect(gate.tryAcquire("b")).toBe(true);
    expect(gate.tryAcquire("c")).toBe(true);
    expect(gate.tryAcquire("d")).toBe(false); // budget exhausted
    expect(gate.acquiredCount).toBe(3);
    gate.reset();
    expect(gate.tryAcquire("a")).toBe(true); // reset starts a fresh session boundary
    expect(gate.tryAcquire("a")).toBe(false);
  });

  it("rejects empty/invalid trigger ids", () => {
    const gate = new ExactlyOnceRecoveryGate(2);
    expect(gate.tryAcquire("")).toBe(false);
    expect(gate.tryAcquire("x".repeat(200))).toBe(false);
  });
});

describe("DisplayTopologyFocusRecovery — HDMI reconnect triggers ONE bounded restore", () => {
  it("restores exactly once per distinct display signature", async () => {
    const restore = vi.fn(async () => {});
    const recovery = new DisplayTopologyFocusRecovery({ restore, cooldownMs: 0 });
    const first = recovery.handleTopologyChange({ displaySignature: "sig-A", atMs: 1_000 });
    expect(first.action).toBe("restore");
    await flush();
    expect(restore).toHaveBeenCalledTimes(1);

    // The monitor re-emitting the same signature (nothing changed) is skipped.
    expect(recovery.handleTopologyChange({ displaySignature: "sig-A", atMs: 1_100 }).action).toBe("skip");
    await flush();
    expect(restore).toHaveBeenCalledTimes(1);

    // HDMI reconnect: a NEW signature triggers exactly one more restore.
    const second = recovery.handleTopologyChange({ displaySignature: "sig-B", atMs: 1_200 });
    expect(second.action).toBe("restore");
    await flush();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(recovery.restoresTriggered).toBe(2);
  });

  it("never loops: the restore budget is hard-bounded and cooldown blocks bursts", async () => {
    const restore = vi.fn(async () => {});
    let now = 0;
    const recovery = new DisplayTopologyFocusRecovery({ restore, cooldownMs: 1_000, now: () => now });
    const decisions: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      now += 2_000; // cooldown always satisfied
      const decision = recovery.handleTopologyChange({ displaySignature: `sig-${index}`, atMs: now });
      decisions.push(decision.action);
      await flush();
    }
    expect(recovery.restoresTriggered).toBe(TOPOLOGY_MAX_RESTORES);
    expect(restore).toHaveBeenCalledTimes(TOPOLOGY_MAX_RESTORES);
    expect(decisions.filter((d) => d === "restore")).toHaveLength(TOPOLOGY_MAX_RESTORES);
    expect(decisions.filter((d) => d === "skip")).toHaveLength(50 - TOPOLOGY_MAX_RESTORES);
    // The last decision is budget-exhausted, never another restore.
    const last = recovery.handleTopologyChange({ displaySignature: "sig-final", atMs: now + 10_000 });
    expect(last).toEqual({ action: "skip", reason: "budget-exhausted" });
    await flush();
    expect(restore).toHaveBeenCalledTimes(TOPOLOGY_MAX_RESTORES);
  });

  it("skips events without a signature and while a restore is in progress (re-entrancy guard)", async () => {
    let release!: () => void;
    const restore = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const recovery = new DisplayTopologyFocusRecovery({ restore, cooldownMs: 0 });
    expect(recovery.handleTopologyChange({ displaySignature: "sig-1", atMs: 1 }).action).toBe("restore");
    await Promise.resolve(); // let the restore callback start (it stays pending)
    // While the first restore is still running, a new topology event must not re-enter.
    expect(recovery.handleTopologyChange({ displaySignature: "sig-2", atMs: 2 })).toEqual({
      action: "skip",
      reason: "restore-in-progress",
    });
    release();
    await flush();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(recovery.handleTopologyChange({ displaySignature: "sig-2", atMs: 3 }).action).toBe("restore");
    await flush();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(recovery.handleTopologyChange({}).action).toBe("skip");
    expect(recovery.handleTopologyChange({ displaySignature: null }).action).toBe("skip");
  });

  it("a restore that itself emits a topology event cannot cascade (never loops)", async () => {
    const recovery = new DisplayTopologyFocusRecovery({ restore: () => {
      // Re-entrant "event" fired synchronously from inside the restore.
      recovery.handleTopologyChange({ displaySignature: "sig-cascade", atMs: 5 });
    }, cooldownMs: 0 });
    expect(recovery.handleTopologyChange({ displaySignature: "sig-root", atMs: 1 }).action).toBe("restore");
    await flush();
    expect(recovery.restoresTriggered).toBe(1);
  });
});

describe("attachDisplayTopologyRecovery wiring", () => {
  it("in a browser preview (no Tauri) it installs nothing and returns a safe no-op", () => {
    mocks.isTauri.mockReturnValue(false);
    const restore = vi.fn();
    const unlisten = attachDisplayTopologyRecovery({ restore });
    expect(typeof unlisten).toBe("function");
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });

  it("inside Tauri it listens to velora-display-changed once and unlisten removes the listener", async () => {
    mocks.isTauri.mockReturnValue(true);
    const unlistenFn = vi.fn();
    const captured: { cb?: (event: DisplayTopologyChangeLike) => void } = {};
    mocks.listen.mockImplementation((_event: string, cb: (e: { payload: DisplayTopologyChangeLike }) => void) => {
      captured.cb = (event) => cb({ payload: event });
      return Promise.resolve(unlistenFn);
    });
    const restore = vi.fn(async () => {});
    const dispose = attachDisplayTopologyRecovery({ restore, cooldownMs: 0 });
    await flush();
    expect(mocks.listen).toHaveBeenCalledWith(DISPLAY_CHANGED_EVENT, expect.any(Function));
    const emit = (event: DisplayTopologyChangeLike): void => captured.cb?.(event);
    emit({ displaySignature: "sig-1", atMs: 1 });
    emit({ displaySignature: "sig-1", atMs: 2 }); // duplicate skipped
    await flush();
    expect(restore).toHaveBeenCalledTimes(1);
    emit({ displaySignature: "sig-2", atMs: 3 });
    await flush();
    expect(restore).toHaveBeenCalledTimes(2);
    dispose();
    expect(unlistenFn).toHaveBeenCalledTimes(1);
    emit({ displaySignature: "sig-3", atMs: 4 });
    await flush();
    expect(restore).toHaveBeenCalledTimes(2); // no events after dispose
  });
});

describe("focusWindowSafelyBounded", () => {
  const makeWindow = (behavior: "ok" | "fail" | "hang") => ({
    unminimize: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {
      if (behavior === "fail") throw new Error("denied");
      if (behavior === "hang") await new Promise(() => {});
    }),
  });

  it("reports focus success exactly once", async () => {
    const window = makeWindow("ok");
    const onBlocked = vi.fn();
    const onFocused = vi.fn();
    await focusWindowSafelyBounded(window, onBlocked, onFocused);
    expect(onFocused).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("reports a blocked focus exactly once even with several allowed attempts (never loops)", async () => {
    const window = makeWindow("fail");
    const onBlocked = vi.fn();
    const onFocused = vi.fn();
    await focusWindowSafelyBounded(window, onBlocked, onFocused, { maxAttempts: 3 });
    expect(window.setFocus).toHaveBeenCalledTimes(3);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onFocused).not.toHaveBeenCalled();
  });

  it("a hung native focus call is bounded by the per-attempt timeout", async () => {
    const window = makeWindow("hang");
    const onBlocked = vi.fn();
    const onFocused = vi.fn();
    await focusWindowSafelyBounded(window, onBlocked, onFocused, { timeoutMs: 10, maxAttempts: 1 });
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onFocused).not.toHaveBeenCalled();
  });
});
