import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  model: { pads: [] as Array<{ device: string }>, activeDevice: null as string | null },
  status: null as unknown,
  statusKnown: false,
  statusReadInFlight: false,
  reconcile: vi.fn(async () => {}),
  invalidateStatusRead: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("../services/nativeControllerStore", () => ({
  nativeControllerStore: {
    getModel: () => mocks.model,
    getStatusSnapshot: () => mocks.status,
    getStatusKnown: () => mocks.statusKnown,
    getStatusReadInFlight: () => mocks.statusReadInFlight,
    reconcile: mocks.reconcile,
    invalidateStatusRead: mocks.invalidateStatusRead,
  },
}));

import { launchManagedApp, launchManagedGame } from "../services/appManager";
import { disabledNativeControllerStatus, type NativeControllerStatus } from "../services/nativeController";
import {
  CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE,
  establishControllerHomeReadiness,
  isControllerHomeReady,
  reconcileNativeStatusBounded,
} from "../services/controllerHomePreflight";
import type { SessionSnapshot } from "../services/sessionOrchestrator";
import { launchPlayniteGame } from "../services/playniteLibrary";

const PLAYNITE_GAME = "64f78cd1-0b00-4271-a9e1-89abc55f66cc";

function armedStatus() {
  return {
    ...disabledNativeControllerStatus,
    supported: true,
    running: true,
    homeEnabled: true,
    pads: [{ device: "native-pad", revision: "v2" as const, transport: "bluetooth" as const }],
  };
}

function setGamepads(pads: Array<{ connected: boolean; id: string }>) {
  vi.stubGlobal("navigator", { getGamepads: () => pads });
}

beforeEach(() => {
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockReset();
  mocks.model = { pads: [], activeDevice: null };
  mocks.status = disabledNativeControllerStatus;
  mocks.statusKnown = false;
  mocks.statusReadInFlight = false;
  mocks.reconcile.mockReset();
  mocks.reconcile.mockResolvedValue(undefined);
  mocks.invalidateStatusRead.mockReset();
  setGamepads([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("direct controller Home launch guard", () => {
  it("blocks direct Steam, Playnite, and game launches when a native controller has no confirmed Home", async () => {
    mocks.model = { pads: [{ device: "native-pad" }], activeDevice: "native-pad" };

    await expect(launchManagedApp("steamBigPicture")).rejects.toThrow(CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE);
    await expect(launchManagedApp("playniteFullscreen")).rejects.toThrow(CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE);
    await expect(launchManagedGame("440")).rejects.toThrow(CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE);
    await expect(launchPlayniteGame(PLAYNITE_GAME)).rejects.toThrow(CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE);

    expect(mocks.reconcile).toHaveBeenCalledTimes(4);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("treats every connected browser Gamepad as observed, including a Steam virtual pad", async () => {
    setGamepads([{ connected: true, id: "Xbox 360 Controller (Steam Virtual Gamepad)" }]);

    await expect(launchManagedGame("440")).rejects.toThrow(CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("allows all direct launch paths after a fresh healthy native Home acknowledgement", async () => {
    mocks.model = { pads: [{ device: "native-pad" }], activeDevice: "native-pad" };
    mocks.status = armedStatus();
    mocks.statusKnown = true;
    mocks.invoke
      .mockResolvedValueOnce({ id: "steamBigPicture", alreadyRunning: false, focusRestoreSupported: true })
      .mockResolvedValueOnce({ id: "440", launched: true })
      .mockResolvedValueOnce({ gameId: PLAYNITE_GAME, launched: true, playniteLaunchId: "playnite-1" });

    await expect(launchManagedApp("steamBigPicture")).resolves.toMatchObject({ id: "steamBigPicture" });
    await expect(launchManagedGame("440")).resolves.toMatchObject({ launched: true });
    await expect(launchPlayniteGame(PLAYNITE_GAME)).resolves.toMatchObject({ launched: true });

    expect(mocks.reconcile).toHaveBeenCalledTimes(3);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps no-controller launches unchanged without requiring a status read", async () => {
    mocks.invoke.mockResolvedValueOnce({ id: "440", launched: true });

    await expect(launchManagedGame("440")).resolves.toMatchObject({ launched: true });

    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("launch_managed_game", { id: "440" });
  });

  it("keeps browser preview launch failures unchanged even if a Gamepad is present", async () => {
    mocks.isTauri.mockReturnValue(false);
    setGamepads([{ connected: true, id: "Xbox 360 Controller (Steam Virtual Gamepad)" }]);

    await expect(launchManagedGame("440")).rejects.toThrow("natywnego App Managera Windows");
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("fails closed after a two-second status timeout and invalidates the pending read", async () => {
    setGamepads([{ connected: true, id: "Xbox 360 Controller (Steam Virtual Gamepad)" }]);
    mocks.reconcile.mockImplementation(() => new Promise<void>(() => {}));
    vi.useFakeTimers();

    const launchAssertion = expect(launchManagedGame("440")).rejects.toThrow(CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE);
    await vi.advanceTimersByTimeAsync(2_000);

    await launchAssertion;
    expect(mocks.invalidateStatusRead).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("controller Home readiness is bound to an explicit session/revision token", () => {
  function session(revision: number, launchId?: string): SessionSnapshot {
    return {
      current: "game",
      previous: "veloraHome",
      revision,
      transitionedAtMs: 1_000 + revision,
      context: launchId ? { launchId } : null,
      allowedTargets: ["veloraHome"],
    };
  }

  it("reports readiness false when the revision differs", () => {
    const ready = establishControllerHomeReadiness(session(2, "game-1"), 1_000);
    expect(isControllerHomeReady(ready, session(2, "game-1"))).toBe(true);
    expect(isControllerHomeReady(ready, session(3, "game-1"))).toBe(false);
    expect(isControllerHomeReady(ready, session(2, "game-2"))).toBe(false);
  });

  it("requires an explicit Resume after a diagnostics remount", () => {
    // A remounted diagnostics panel has no acknowledgement and must not
    // silently resume a Home action confirmed for an earlier session.
    let readiness: ReturnType<typeof establishControllerHomeReadiness> | null = null;
    const current = session(4, "game-4");
    expect(isControllerHomeReady(readiness, current)).toBe(false);

    // Restoring a stale acknowledgement from before the remount is not enough.
    readiness = establishControllerHomeReadiness(session(3, "game-3"), 900);
    expect(isControllerHomeReady(readiness, current)).toBe(false);

    // Only an explicit re-establishment for the current session is ready.
    readiness = establishControllerHomeReadiness(current, 1_100);
    expect(isControllerHomeReady(readiness, current)).toBe(true);
  });

  it("ignores a late status reply after the bounded read epoch was invalidated", async () => {
    const actual = await vi.importActual<typeof import("../services/nativeControllerStore")>(
      "../services/nativeControllerStore",
    );
    let resolveStatus!: (status: NativeControllerStatus) => void;
    let getStatusCalls = 0;
    const store = new actual.NativeControllerStore({
      listen: async () => () => {},
      getStatus: () => {
        getStatusCalls += 1;
        return new Promise<NativeControllerStatus>((resolve) => { resolveStatus = resolve; });
      },
      setHomeEnabled: async () => disabledNativeControllerStatus,
      now: () => 0,
    });

    vi.useFakeTimers();
    // The bounded read resolves when its deadline invalidates the epoch (it does
    // not throw), so drive the clock and let it settle.
    let settled = false;
    const bounded = reconcileNativeStatusBounded(store).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2_000);
    await bounded;

    // A late native status reply arrives only after the read epoch was invalidated.
    resolveStatus(armedStatus());
    await Promise.resolve();
    await Promise.resolve();
    vi.useRealTimers();

    expect(settled).toBe(true);
    expect(getStatusCalls).toBe(1);
    // The stale reply is ignored: no status was ever applied, so a remounted
    // panel cannot treat it as a fresh, healthy Home acknowledgement.
    expect(store.getStatusKnown()).toBe(false);
    expect(store.getStatusSnapshot()).toBe(disabledNativeControllerStatus);
  });
});
