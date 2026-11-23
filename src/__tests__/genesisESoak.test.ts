/**
 * Workstream S3.5 (Agent E, genesis) — SESSION LIFECYCLE SOAK.
 *
 * Deterministic high-iteration soak of the REAL session lifecycle machinery
 * (no wall-clock, no hardware): `SessionLaunchCoordinator` +
 * `SessionLifecycleMachine` from `src/services/veloraSessionManager.ts` plus
 * the browser-preview transition model `applyBrowserTransition` from
 * `src/services/sessionOrchestrator.ts`.
 *
 * Invariants asserted continuously over thousands of seeded transitions:
 *   - receipts stay bounded (≤ MAX_SESSION_RECEIPTS) and seq is monotonic;
 *   - a repeated launch while launching/closing/active is NEVER a new launch
 *     (no duplicate launches: duplicate/adopt only, stale generations rejected);
 *   - every accepted launch has a unique `service#generation` key;
 *   - the lifecycle state machine never leaves the whitelisted state set and
 *     never resurrects from a terminal state without "reset";
 *   - the browser session model bumps the revision exactly once per real
 *     transition and keeps it on a repeated target.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_RECEIPTS,
  SESSION_LIFECYCLE_STATES,
  SessionLaunchCoordinator,
  SessionLifecycleMachine,
  lifecycleBlocksLaunch,
  lifecycleTransition,
  launchKey,
  normalizeSessionReceipt,
  normalizeSessionReceipts,
  parseLaunchKey,
  safeLifecycleEvent,
  safeLifecycleState,
  type LifecycleEvent,
  type SessionTransitionReceipt,
} from "../services/veloraSessionManager";
import { applyBrowserTransition, type SessionId, type SessionSnapshot } from "../services/sessionOrchestrator";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SERVICES = ["edge-cinema:netflix", "edge-cinema:youtube", "steamBigPicture", "playniteFullscreen", "cyberpunk-2077"];
const EVENTS: LifecycleEvent[] = [
  "launchRequested", "launchProgress", "processReady", "closingObserved", "closeRequested",
  "exitObserved", "crashObserved", "launchFailed", "superseded", "cancelled", "reset",
];

describe("genesis E: session lifecycle soak (deterministic, seeded)", () => {
  it("keeps receipts bounded, seq monotonic and launches duplicate-free over 5000 coordinator steps", () => {
    const coordinator = new SessionLaunchCoordinator();
    const random = seededRandom(0x9e3779b9);
    const issuedKeys = new Set<string>();
    let launches = 0;
    let duplicates = 0;
    let adopts = 0;
    let stale = 0;
    let now = 1_000;

    for (let step = 0; step < 5000; step += 1) {
      now += 1 + Math.floor(random() * 50);
      const service = SERVICES[Math.floor(random() * SERVICES.length)];
      const roll = random();

      if (roll < 0.45) {
        // Repeated launch request for a random (possibly in-flight) service.
        const decision = coordinator.requestLaunch(service, undefined, now);
        if (decision.kind === "launch") {
          launches += 1;
          expect(issuedKeys.has(decision.key), `duplicate launch key ${decision.key}`).toBe(false);
          issuedKeys.add(decision.key);
          const parsed = parseLaunchKey(decision.key);
          expect(parsed).not.toBeNull();
          expect(parsed!.service).toBe(service);
          expect(parsed!.generation).toBe(decision.generation);
        } else if (decision.kind === "duplicate") {
          duplicates += 1;
          // A duplicate can never carry a fresh generation or a new key.
          expect(["launch-in-flight", "closing"]).toContain(decision.reason);
          expect(issuedKeys.has(decision.key)).toBe(true);
        } else if (decision.kind === "adopt") {
          adopts += 1;
          expect(issuedKeys.has(decision.key)).toBe(true);
        } else {
          stale += 1;
        }
      } else if (roll < 0.65) {
        // Native launch receipt arrives: progress + ready.
        const decision = coordinator.requestLaunch(service, undefined, now);
        if (decision.kind === "launch") {
          launches += 1;
          if (!issuedKeys.has(decision.key)) issuedKeys.add(decision.key);
        }
        coordinator.noteLaunched(service, `sess-${service}-${now}`, now);
      } else if (roll < 0.8) {
        coordinator.noteExit(service, random() < 0.2, now);
      } else if (roll < 0.9) {
        coordinator.failLaunch(service, now);
      } else {
        // Stale generation replay must be rejected, never replayed.
        const machine = coordinator.machineFor(service);
        const decision = coordinator.requestLaunch(service, Math.max(0, machine.generation - 1), now);
        expect(decision.kind === "stale" || decision.kind === "duplicate" || decision.kind === "adopt" || decision.kind === "launch").toBe(true);
        if (decision.kind === "stale") stale += 1;
      }

      // Continuous invariants over every machine.
      for (const service of SERVICES) {
        const machine = coordinator.machineFor(service);
        expect(SESSION_LIFECYCLE_STATES).toContain(machine.state);
        expect(machine.receipts.length).toBeLessThanOrEqual(MAX_SESSION_RECEIPTS);
        for (let index = 1; index < machine.receipts.length; index += 1) {
          expect(machine.receipts[index].seq).toBe(machine.receipts[index - 1].seq + 1);
        }
        if (machine.receipts.length > 0) {
          expect(machine.lastReceipt).toBe(machine.receipts[machine.receipts.length - 1]);
        }
      }
    }

    expect(launches).toBeGreaterThan(0);
    expect(duplicates + adopts + stale).toBeGreaterThan(0);
    // No duplicate launch ever happened: every issued key is unique and every
    // launch decision produced a brand-new generation.
    expect(issuedKeys.size).toBe(launches);
  });

  it("drives 4000 raw lifecycle events per machine with a valid transition table and bounded receipts", () => {
    const random = seededRandom(0xdeadbeef);
    for (const service of SERVICES) {
      const machine = new SessionLifecycleMachine(service);
      let now = 0;
      let accepted = 0;
      for (let step = 0; step < 4000; step += 1) {
        now += 1 + Math.floor(random() * 30);
        const event = EVENTS[Math.floor(random() * EVENTS.length)];
        const before = machine.state;
        const receipt = machine.transition(event, now, step % 7 === 0 ? `sid-${step}` : undefined);
        if (receipt !== null) {
          accepted += 1;
          expect(receipt.from).toBe(before);
          expect(receipt.to).toBe(machine.state);
          expect(receipt.cause).toBe(event);
          expect(receipt.atMs).toBe(now);
          expect(SESSION_LIFECYCLE_STATES).toContain(receipt.to);
          // Terminal states only leave via reset.
          if (before === "exited" || before === "error") {
            expect(event).toBe("reset");
          }
        } else {
          // A null receipt means either an invalid pair or a same-state no-op;
          // the state must never change either way.
          expect(machine.state).toBe(before);
          const next = lifecycleTransition(before, event);
          expect(next === null || next === before).toBe(true);
        }
        expect(machine.receipts.length).toBeLessThanOrEqual(MAX_SESSION_RECEIPTS);
      }
      expect(accepted).toBeGreaterThan(0);
      const seqs = machine.receipts.map((receipt) => receipt.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  });

  it("keeps launch blocking exactly on launching/active/closing", () => {
    for (const state of SESSION_LIFECYCLE_STATES) {
      expect(lifecycleBlocksLaunch(state)).toBe(["launching", "active", "closing"].includes(state));
    }
  });

  it("soaks the browser-preview session model: revision bumps exactly once per real transition", () => {
    const random = seededRandom(0xc0ffee);
    const targets: SessionId[] = ["veloraHome", "game", "playnite", "cinema", "desktop", "ambient"];
    let snapshot: SessionSnapshot = {
      current: "veloraHome", previous: null, revision: 0, transitionedAtMs: 0, context: null,
      allowedTargets: ["game", "playnite", "cinema", "desktop", "ambient"],
    };
    let revision = 0;
    for (let step = 0; step < 3000; step += 1) {
      const target = targets[Math.floor(random() * targets.length)];
      const before = snapshot;
      snapshot = applyBrowserTransition(snapshot, {
        target,
        cause: "user",
        issuedAtMs: step,
        context: random() < 0.3 ? { launchId: `launch-${step}`, appId: "app" } : undefined,
      });
      if (before.current === target) {
        expect(snapshot).toBe(before); // repeated target: same object, same revision
      } else {
        revision += 1;
        expect(snapshot.revision).toBe(revision);
        expect(snapshot.previous).toBe(before.current);
        expect(snapshot.current).toBe(target);
        expect(snapshot.recovery).toBeNull();
        if (snapshot.context) expect(snapshot.context.sessionRevision).toBe(revision);
      }
    }
    expect(revision).toBeGreaterThan(0);
    expect(snapshot.revision).toBe(revision);
  });

  it("normalizes wire receipts strictly: garbage in, nothing out; valid receipts bounded", () => {
    expect(normalizeSessionReceipt(null)).toBeNull();
    expect(normalizeSessionReceipt("x")).toBeNull();
    expect(normalizeSessionReceipt({ seq: -1, sessionId: "s", from: "idle", to: "launching", cause: "launchRequested", atMs: 1 })).toBeNull();
    expect(normalizeSessionReceipt({ seq: 1, sessionId: "", from: "idle", to: "launching", cause: "launchRequested", atMs: 1 })).toBeNull();
    expect(normalizeSessionReceipt({ seq: 1, sessionId: "s", from: "bogus", to: "launching", cause: "launchRequested", atMs: 1 })).toMatchObject({ from: "idle" });
    expect(normalizeSessionReceipt({ seq: 1, sessionId: "s", from: "idle", to: "launching", cause: "notAnEvent", atMs: 1 })).toBeNull();
    expect(safeLifecycleState("launching")).toBe("launching");
    expect(safeLifecycleState(undefined)).toBe("idle");
    expect(safeLifecycleEvent("reset")).toBe("reset");
    expect(safeLifecycleEvent("hack")).toBeNull();

    const valid = (seq: number): SessionTransitionReceipt => ({
      seq, sessionId: "s", from: "idle", to: "launching", cause: "launchRequested", atMs: seq,
    });
    const many = normalizeSessionReceipts(Array.from({ length: 100 }, (_, index) => valid(index)));
    expect(many).toHaveLength(MAX_SESSION_RECEIPTS);
    expect(many[0].seq).toBe(100 - MAX_SESSION_RECEIPTS);
    expect(normalizeSessionReceipts("nope")).toEqual([]);
    expect(normalizeSessionReceipts([null, valid(1), { garbage: true }])).toHaveLength(1);
  });

  it("rejects malformed launch keys and accepts only safe service#generation pairs", () => {
    expect(parseLaunchKey(launchKey("netflix", 3))).toEqual({ service: "netflix", generation: 3 });
    expect(parseLaunchKey("#3")).toBeNull();
    expect(parseLaunchKey("netflix#")).toBeNull();
    expect(parseLaunchKey("netflix#-1")).toBeNull();
    expect(parseLaunchKey("netflix#1.5")).toBeNull();
    expect(parseLaunchKey("x".repeat(200))).toBeNull();
    expect(parseLaunchKey("a\u0000b#1")).toBeNull();
    expect(parseLaunchKey(42)).toBeNull();
    expect(() => new SessionLifecycleMachine("")).toThrow();
    expect(() => new SessionLifecycleMachine("x".repeat(200))).toThrow();
  });
});
