import { describe, expect, it } from "vitest";
import {
  launchKey,
  lifecycleBlocksLaunch,
  lifecycleCauseLabel,
  lifecycleTransition,
  MAX_SESSION_RECEIPTS,
  normalizeSessionReceipt,
  normalizeSessionReceipts,
  parseLaunchKey,
  safeLifecycleState,
  SessionLaunchCoordinator,
  SessionLifecycleMachine,
  SESSION_LIFECYCLE_STATES,
  type LifecycleEvent,
  type SessionLifecycleState,
} from "../services/veloraSessionManager";

/**
 * Ascension B — deterministic per-session lifecycle machine and the
 * idempotent launch coordinator. Pure functions/classes only: no IPC, no
 * timers, no hardware.
 */

const STATES: SessionLifecycleState[] = ["idle", "launching", "active", "closing", "exited", "error"];
const EVENTS: LifecycleEvent[] = [
  "launchRequested",
  "launchProgress",
  "processReady",
  "closingObserved",
  "closeRequested",
  "exitObserved",
  "crashObserved",
  "launchFailed",
  "superseded",
  "cancelled",
  "reset",
];

describe("lifecycleTransition mirrors the single shared state machine", () => {
  it("allows exactly idle → launching → active → closing → exited/error plus reset", () => {
    expect(lifecycleTransition("idle", "launchRequested")).toBe("launching");
    expect(lifecycleTransition("launching", "launchProgress")).toBe("launching");
    expect(lifecycleTransition("launching", "processReady")).toBe("active");
    expect(lifecycleTransition("launching", "closeRequested")).toBe("closing");
    expect(lifecycleTransition("launching", "closingObserved")).toBe("closing");
    expect(lifecycleTransition("launching", "launchFailed")).toBe("error");
    expect(lifecycleTransition("launching", "crashObserved")).toBe("error");
    expect(lifecycleTransition("launching", "exitObserved")).toBe("exited");
    expect(lifecycleTransition("launching", "cancelled")).toBe("exited");
    expect(lifecycleTransition("launching", "superseded")).toBe("exited");
    expect(lifecycleTransition("active", "closeRequested")).toBe("closing");
    expect(lifecycleTransition("active", "closingObserved")).toBe("closing");
    expect(lifecycleTransition("active", "processReady")).toBe("active");
    expect(lifecycleTransition("active", "exitObserved")).toBe("exited");
    expect(lifecycleTransition("active", "crashObserved")).toBe("error");
    expect(lifecycleTransition("closing", "processReady")).toBe("active");
    expect(lifecycleTransition("closing", "launchProgress")).toBe("launching");
    expect(lifecycleTransition("closing", "exitObserved")).toBe("exited");
    expect(lifecycleTransition("closing", "crashObserved")).toBe("error");
    for (const state of STATES) {
      expect(lifecycleTransition(state, "reset")).toBe("idle");
    }
  });

  it("rejects every other pair so a stale event can never resurrect a session", () => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        const next = lifecycleTransition(state, event);
        const allowed =
          (state === "idle" && event === "launchRequested") ||
          event === "reset" ||
          (state === "launching" &&
            ["launchProgress", "processReady", "closeRequested", "closingObserved", "launchFailed", "crashObserved", "exitObserved", "cancelled", "superseded"].includes(event)) ||
          (state === "active" &&
            ["closeRequested", "closingObserved", "processReady", "launchProgress", "exitObserved", "cancelled", "superseded", "crashObserved", "launchFailed"].includes(event)) ||
          (state === "closing" &&
            ["processReady", "launchProgress", "closeRequested", "closingObserved", "exitObserved", "cancelled", "superseded", "crashObserved", "launchFailed"].includes(event));
        if (allowed) expect(next).not.toBeNull();
        else expect(next).toBeNull();
      }
    }
    expect(lifecycleTransition("exited", "launchRequested")).toBeNull();
    expect(lifecycleTransition("error", "processReady")).toBeNull();
    expect(lifecycleTransition("idle", "processReady")).toBeNull();
    expect(lifecycleTransition("active", "launchRequested")).toBeNull();
  });

  it("blocks launches exactly while launching, active or closing", () => {
    expect(lifecycleBlocksLaunch("launching")).toBe(true);
    expect(lifecycleBlocksLaunch("active")).toBe(true);
    expect(lifecycleBlocksLaunch("closing")).toBe(true);
    expect(lifecycleBlocksLaunch("idle")).toBe(false);
    expect(lifecycleBlocksLaunch("exited")).toBe(false);
    expect(lifecycleBlocksLaunch("error")).toBe(false);
  });
});

describe("SessionLifecycleMachine", () => {
  it("records bounded monotonic receipts and only on real state changes", () => {
    const machine = new SessionLifecycleMachine("edge-cinema:netflix");
    expect(machine.state).toBe("idle");
    expect(machine.transition("processReady", 1)).toBeNull(); // invalid from idle
    const r1 = machine.transition("launchRequested", 10, "cinema-1");
    expect(r1).toMatchObject({ seq: 1, from: "idle", to: "launching", cause: "launchRequested", sessionId: "cinema-1" });
    expect(machine.transition("launchProgress", 20)).toBeNull(); // no state change → no receipt
    expect(machine.transition("processReady", 30)).toMatchObject({ seq: 2, from: "launching", to: "active" });
    expect(machine.transition("closeRequested", 40)).toMatchObject({ seq: 3, from: "active", to: "closing" });
    expect(machine.transition("exitObserved", 50)).toMatchObject({ seq: 4, from: "closing", to: "exited" });
    expect(machine.state).toBe("exited");
    expect(machine.transition("launchRequested", 60)).toBeNull(); // terminal
    expect(machine.receipts).toHaveLength(4);
    expect(machine.lastReceipt?.to).toBe("exited");
    // reset is the only exit from terminal
    expect(machine.transition("reset", 70)).toMatchObject({ from: "exited", to: "idle" });
    expect(machine.state).toBe("idle");
  });

  it("caps receipts at MAX_SESSION_RECEIPTS keeping seq monotonic", () => {
    const machine = new SessionLifecycleMachine("steamBigPicture");
    for (let i = 0; i < MAX_SESSION_RECEIPTS + 25; i += 1) {
      const event: LifecycleEvent = i % 2 === 0 ? "launchRequested" : "processReady";
      machine.transition(event, 1000 + i);
      machine.transition("reset", 1000 + i); // idle again so launchRequested is valid
    }
    expect(machine.receipts.length).toBeLessThanOrEqual(MAX_SESSION_RECEIPTS);
    const seqs = machine.receipts.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("rejects invalid service keys", () => {
    expect(() => new SessionLifecycleMachine("")).toThrow();
    expect(() => new SessionLifecycleMachine("bad\nkey")).toThrow();
    expect(() => new SessionLifecycleMachine("x".repeat(129))).toThrow();
  });
});

describe("SessionLaunchCoordinator — idempotent launches keyed by service+generation", () => {
  it("suppresses duplicate launch events while a launch is in flight", () => {
    const coordinator = new SessionLaunchCoordinator();
    const first = coordinator.requestLaunch("edge-cinema:netflix", undefined, 100);
    expect(first).toMatchObject({ kind: "launch", generation: 1, key: "edge-cinema:netflix#1" });
    const second = coordinator.requestLaunch("edge-cinema:netflix", undefined, 110);
    expect(second).toMatchObject({ kind: "duplicate", reason: "launch-in-flight", generation: 1, key: "edge-cinema:netflix#1" });
    // The duplicate changed nothing: still exactly one launch receipt.
    expect(coordinator.machineFor("edge-cinema:netflix").receipts).toHaveLength(1);
  });

  it("adopts (idempotently) while the session is active, without a new generation", () => {
    const coordinator = new SessionLaunchCoordinator();
    coordinator.requestLaunch("playniteFullscreen", undefined, 1);
    coordinator.noteLaunched("playniteFullscreen", "playnite-1", 2);
    const machine = coordinator.machineFor("playniteFullscreen");
    expect(machine.state).toBe("active");
    const again = coordinator.requestLaunch("playniteFullscreen", undefined, 3);
    expect(again).toMatchObject({ kind: "adopt", generation: 1, sessionId: "playnite-1" });
    expect(machine.receipts).toHaveLength(2); // launchRequested + processReady, nothing more
  });

  it("rejects stale generations and never replays them", () => {
    const coordinator = new SessionLaunchCoordinator();
    coordinator.requestLaunch("steamBigPicture", undefined, 1); // generation 1
    coordinator.noteLaunched("steamBigPicture", "steam-1", 2);
    coordinator.noteExit("steamBigPicture", false, 3); // exited
    const stale = coordinator.requestLaunch("steamBigPicture", 1, 4);
    expect(stale.kind).toBe("stale");
    const fresh = coordinator.requestLaunch("steamBigPicture", 5, 5);
    expect(fresh).toMatchObject({ kind: "launch", generation: 5, key: "steamBigPicture#5" });
  });

  it("keeps services isolated: a Netflix launch never blocks Disney+", () => {
    const coordinator = new SessionLaunchCoordinator();
    expect(coordinator.requestLaunch("edge-cinema:netflix", undefined, 1).kind).toBe("launch");
    expect(coordinator.requestLaunch("edge-cinema:disney", undefined, 1).kind).toBe("launch");
    expect(coordinator.requestLaunch("edge-cinema:netflix", undefined, 2).kind).toBe("duplicate");
    expect(coordinator.machineFor("edge-cinema:netflix").sessionId).toBeNull();
  });

  it("maps native exits/crashes to terminal states with truthful receipts", () => {
    const coordinator = new SessionLaunchCoordinator();
    coordinator.requestLaunch("edge-cinema:max", undefined, 1);
    coordinator.noteLaunched("edge-cinema:max", "cinema-7", 2);
    coordinator.noteExit("edge-cinema:max", true, 3);
    const machine = coordinator.machineFor("edge-cinema:max");
    expect(machine.state).toBe("error");
    expect(machine.lastReceipt?.cause).toBe("crashObserved");
    // After a crash the service can be launched again with a new generation.
    expect(coordinator.requestLaunch("edge-cinema:max", undefined, 4)).toMatchObject({ kind: "launch", generation: 2 });
  });

  it("syncs from a native snapshot without inventing sessions", () => {
    const coordinator = new SessionLaunchCoordinator();
    coordinator.syncFromSnapshot({
      supported: true,
      sessions: [
        {
          sessionId: "cinema-1", appId: "netflix", applicationType: "cinema", launchMethod: "ownedBrowserWindow",
          name: "Netflix", state: "foreground", launchedAtMs: 1, lastObservedAtMs: 2, lastActivationAtMs: 2,
          canResume: true, canClose: true, lastFailure: null,
          launchId: "cinema-1", managedByVelora: true, lifecycle: "active", generation: 3,
        },
      ],
      applications: [],
    });
    const machine = coordinator.machineFor("cinema-1");
    expect(machine.state).toBe("active");
    expect(machine.generation).toBe(3);
    expect(machine.sessionId).toBe("cinema-1");
    // Active after sync → adopt, not duplicate-launch.
    expect(coordinator.requestLaunch("cinema-1", undefined, 10).kind).toBe("adopt");
  });
});

describe("launch keys and wire normalization", () => {
  it("round-trips service#generation and rejects malformed keys", () => {
    expect(launchKey("edge-cinema:netflix", 7)).toBe("edge-cinema:netflix#7");
    expect(parseLaunchKey("edge-cinema:netflix#7")).toEqual({ service: "edge-cinema:netflix", generation: 7 });
    for (const bad of ["", "no-hash", "#3", "svc#", "svc#abc", "svc#-1", "svc\n#1", 42, null]) {
      expect(parseLaunchKey(bad)).toBeNull();
    }
  });

  it("whitelists lifecycle states and events, never trusting wire values", () => {
    for (const state of SESSION_LIFECYCLE_STATES) expect(safeLifecycleState(state)).toBe(state);
    expect(safeLifecycleState("active; rm -rf")).toBe("idle");
    expect(safeLifecycleState(42)).toBe("idle");
    expect(normalizeSessionReceipt({ seq: 1, sessionId: "s", from: "active", to: "exited", cause: "exitObserved", atMs: 5 }))
      .toMatchObject({ from: "active", to: "exited", cause: "exitObserved" });
    expect(normalizeSessionReceipt({ seq: -1, sessionId: "s", from: "active", to: "exited", cause: "exitObserved", atMs: 5 })).toBeNull();
    expect(normalizeSessionReceipt({ seq: 1, sessionId: "s", from: "active", to: "exited", cause: "hacked", atMs: 5 })).toBeNull();
    expect(normalizeSessionReceipt("nope")).toBeNull();
    const list = normalizeSessionReceipts([
      { seq: 1, sessionId: "s", from: "idle", to: "launching", cause: "launchRequested", atMs: 1 },
      { garbage: true },
      { seq: 2, sessionId: "s", from: "launching", to: "active", cause: "processReady", atMs: 2 },
    ]);
    expect(list).toHaveLength(2);
    expect(normalizeSessionReceipts("nope")).toEqual([]);
  });

  it("labels every cause truthfully without playback-state claims", () => {
    for (const event of EVENTS) {
      const label = lifecycleCauseLabel(event);
      expect(label.length).toBeGreaterThan(0);
      expect(label.toLowerCase()).not.toContain("playback");
      expect(label.toLowerCase()).not.toContain("zweryfikowano");
    }
    expect(lifecycleCauseLabel("crashObserved")).toContain("nieoczekiwanie");
  });
});
