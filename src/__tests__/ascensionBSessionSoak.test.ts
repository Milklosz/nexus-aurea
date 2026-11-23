import { describe, expect, it } from "vitest";
import {
  launchKey,
  lifecycleBlocksLaunch,
  lifecycleTransition,
  MAX_SESSION_RECEIPTS,
  parseLaunchKey,
  SESSION_LIFECYCLE_STATES,
  SessionLaunchCoordinator,
  type LifecycleEvent,
  type SessionLifecycleMachine,
} from "../services/veloraSessionManager";

/**
 * Ascension B — seedable soak over the deterministic session lifecycle.
 *
 * Like the CrossSourceGate soak (soakTransitions.test.ts), this is a
 * deterministic, seeded drive of the REAL state machine and launch
 * coordinator — not a wall-clock or hardware test. Thousands of mixed
 * transitions/launches across all managed services assert the invariants on
 * every single step.
 */

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SERVICES = [
  "edge-cinema:netflix",
  "edge-cinema:youtube",
  "edge-cinema:disney",
  "edge-cinema:prime",
  "edge-cinema:max",
  "steamBigPicture",
  "playniteFullscreen",
] as const;

const EVENTS: LifecycleEvent[] = [
  "launchProgress",
  "processReady",
  "closeRequested",
  "closingObserved",
  "exitObserved",
  "crashObserved",
  "launchFailed",
  "superseded",
  "cancelled",
  "reset",
];

/** Invariants for one machine: whitelisted state, bounded monotonic receipts,
 *  last receipt consistent with the machine and reproducible from the table. */
function assertMachineInvariants(m: SessionLifecycleMachine): void {
  expect(SESSION_LIFECYCLE_STATES).toContain(m.state);
  expect(m.receipts.length).toBeLessThanOrEqual(MAX_SESSION_RECEIPTS);
  const seqs = m.receipts.map((r) => r.seq);
  for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  const last = m.receipts[m.receipts.length - 1];
  if (last) {
    expect(last.to).toBe(m.state);
    // The table is the single source of truth: replaying the last receipt's
    // event on its `from` state must reproduce its `to` state.
    expect(lifecycleTransition(last.from, last.cause)).toBe(last.to);
  }
  expect(m.generation).toBeGreaterThanOrEqual(0);
}

describe("ascension B session-lifecycle soak", () => {
  it("preserves all machine invariants over 5000 seeded transitions and launches", () => {
    const random = seededRandom(0xa5c35150 ^ 0x5eed);
    const coordinator = new SessionLaunchCoordinator();
    let now = 1_000;
    let launches = 0;
    let duplicates = 0;
    let stale = 0;
    let adoptions = 0;
    let transitions = 0;
    let exits = 0;

    for (let step = 0; step < 5000; step += 1) {
      now += 1 + Math.floor(random() * 40);
      const service = SERVICES[Math.floor(random() * SERVICES.length)];
      const machine = coordinator.machineFor(service);
      const roll = random();

      if (roll < 0.35) {
        // A launch request, sometimes with an explicit (possibly stale) generation.
        const explicit = random() < 0.3 ? Math.max(0, machine.generation - Math.floor(random() * 3)) : undefined;
        const decision = coordinator.requestLaunch(service, explicit, now);
        if (decision.kind === "launch") {
          launches += 1;
          expect(decision.key).toBe(launchKey(service, decision.generation));
          expect(parseLaunchKey(decision.key)).toEqual({ service, generation: decision.generation });
        } else if (decision.kind === "duplicate") {
          duplicates += 1;
          // A duplicate must reference an in-flight/closing session and must
          // not have changed the machine state or receipts.
          expect(["launch-in-flight", "closing"]).toContain(decision.reason);
          expect(lifecycleBlocksLaunch(machine.state)).toBe(true);
        } else if (decision.kind === "adopt") {
          adoptions += 1;
          expect(machine.state).toBe("active");
          expect(decision.generation).toBe(machine.generation);
        } else {
          stale += 1;
          expect(decision.generation).toBeLessThanOrEqual(machine.generation);
        }
      } else if (roll < 0.45) {
        coordinator.noteLaunched(service, `${service}-s${step}`, now);
      } else if (roll < 0.55) {
        coordinator.noteExit(service, random() < 0.2, now);
        exits += 1;
      } else {
        // A raw lifecycle event on the machine.
        const event = EVENTS[Math.floor(random() * EVENTS.length)];
        const prevSeq = machine.receipts.length > 0 ? machine.receipts[machine.receipts.length - 1].seq : 0;
        const receipt = machine.transition(event, now);
        if (receipt) {
          transitions += 1;
          expect(receipt.to).toBe(machine.state);
          expect(receipt.seq).toBe(prevSeq + 1);
        }
      }

      // Invariants of the touched machine on EVERY step; a full sweep across
      // all services every 250 steps keeps the per-step cost bounded.
      assertMachineInvariants(machine);
      if (step % 250 === 249) {
        for (const svc of SERVICES) assertMachineInvariants(coordinator.machineFor(svc));
      }
    }
    for (const svc of SERVICES) assertMachineInvariants(coordinator.machineFor(svc));

    // The soak must actually exercise every path, not trivially pass.
    expect(launches).toBeGreaterThan(50);
    expect(duplicates).toBeGreaterThan(20);
    expect(adoptions).toBeGreaterThan(20);
    expect(stale).toBeGreaterThan(5);
    expect(transitions).toBeGreaterThan(100);
    expect(exits).toBeGreaterThan(50);

    // Final consistency: each service ends in a whitelisted state and every
    // non-terminal machine is either launching (in flight) or active/closing.
    for (const svc of SERVICES) {
      const m = coordinator.machineFor(svc);
      expect(SESSION_LIFECYCLE_STATES).toContain(m.state);
      if (m.state !== "idle" && m.state !== "exited" && m.state !== "error") {
        expect(lifecycleBlocksLaunch(m.state) || m.state === "active").toBe(true);
      }
    }
  }, 30_000);

  it("is deterministic: the same seed produces the same final machine states and counts", () => {
    const run = (seed: number) => {
      const random = seededRandom(seed);
      const coordinator = new SessionLaunchCoordinator();
      let now = 0;
      let launches = 0;
      let duplicates = 0;
      for (let step = 0; step < 2000; step += 1) {
        now += 1 + Math.floor(random() * 30);
        const service = SERVICES[Math.floor(random() * SERVICES.length)];
        const roll = random();
        if (roll < 0.5) {
          const decision = coordinator.requestLaunch(service, undefined, now);
          if (decision.kind === "launch") launches += 1;
          if (decision.kind === "duplicate") duplicates += 1;
        } else if (roll < 0.7) {
          coordinator.noteLaunched(service, `s${step}`, now);
        } else {
          coordinator.noteExit(service, random() < 0.5, now);
        }
      }
      const states = SERVICES.map((svc) => coordinator.machineFor(svc).state);
      return { launches, duplicates, states, receipts: SERVICES.map((svc) => coordinator.machineFor(svc).receipts.length) };
    };
    expect(run(0xbeef)).toEqual(run(0xbeef));
    expect(run(0xbeef)).not.toEqual(run(0xbeee));
  });
});
