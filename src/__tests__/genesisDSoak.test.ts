import { describe, expect, it, vi } from "vitest";
import {
  MAX_SESSION_RECEIPTS,
  SessionLaunchCoordinator,
  lifecycleTransition,
  type SessionLifecycleState,
} from "../services/veloraSessionManager";
import {
  ERROR_BUS_CAPACITY,
  clearErrorBus,
  errorBusListenerCount,
  getErrorBusSnapshot,
  reportError,
  subscribeToErrorBus,
} from "../services/errorBus";
import { MAX_SAMPLES_PER_COMMAND, commandHistogram, recordCommandLatency, resetPerfMetrics } from "../services/perfMetrics";
import { DisplayTopologyFocusRecovery } from "../services/windowFocusRestore";
import { CrossSourceGate } from "../services/crossSourceGate";
import type { ControllerAction } from "../services/controllerEngine";

/**
 * S3.4 long-session soak: many session transitions plus reliability
 * primitives, asserting the bounded invariants (receipt ring, error ring,
 * latency ring, topology-restore budget, listener balance, gate epoch) hold
 * at every step. Deterministic — no wall-clock waits, no hardware claims.
 */

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SERVICES = ["netflix", "youtube", "disney", "prime", "max", "steam-big-picture", "playnite"];

describe("genesis D soak — long-session stability of owned reliability state", () => {
  it("survives 3000 mixed session transitions with bounded receipts and a valid lifecycle machine", () => {
    const coordinator = new SessionLaunchCoordinator();
    const random = seededRandom(0xd3_11a_b1e);
    let now = 1_000_000;
    let launches = 0;
    let duplicates = 0;
    let exits = 0;

    for (let step = 0; step < 3000; step += 1) {
      now += 1 + Math.floor(random() * 500);
      const service = SERVICES[Math.floor(random() * SERVICES.length)];
      const roll = random();
      if (roll < 0.35) {
        const decision = coordinator.requestLaunch(service, undefined, now);
        if (decision.kind === "launch") {
          launches += 1;
          const machine = coordinator.machineFor(service);
          if (machine.state === "launching" && random() < 0.4) {
            // A repeated launch event while the launch is in flight is a duplicate.
            expect(coordinator.requestLaunch(service, undefined, now).kind).toBe("duplicate");
            duplicates += 1;
          }
          coordinator.noteLaunched(service, `${service}-session-${launches}`, now);
          if (machine.state === "active" && random() < 0.3) {
            // A launch event while the session is active adopts — never spawns.
            expect(coordinator.requestLaunch(service, undefined, now).kind).toBe("adopt");
            duplicates += 1;
          }
        } else {
          duplicates += 1;
        }
      } else if (roll < 0.55) {
        coordinator.noteExit(service, random() < 0.2, now);
        exits += 1;
      } else if (roll < 0.7) {
        coordinator.failLaunch(service, now);
      } else if (roll < 0.8) {
        coordinator.syncFromSnapshot({ supported: true, sessions: [], applications: [] });
      } else if (roll < 0.9) {
        // Session boundary: reset returns the machine to idle.
        coordinator.machineFor(service).transition("reset", now);
      } else {
        // Invalid transitions must never corrupt the machine.
        const machine = coordinator.machineFor(service);
        const before = machine.state as SessionLifecycleState;
        const receipt = machine.transition("exitObserved", now);
        if (receipt === null) {
          expect(machine.state).toBe(before);
        } else {
          expect(lifecycleTransition(before, "exitObserved")).toBe(machine.state);
        }
      }
      // Invariant at every step: receipts stay bounded.
      for (const service of SERVICES) {
        expect(coordinator.machineFor(service).receipts.length).toBeLessThanOrEqual(MAX_SESSION_RECEIPTS);
      }
    }

    expect(launches).toBeGreaterThan(0);
    expect(duplicates).toBeGreaterThan(0);
    expect(exits).toBeGreaterThan(0);
    for (const service of SERVICES) {
      const machine = coordinator.machineFor(service);
      expect(machine.receipts.length).toBeLessThanOrEqual(MAX_SESSION_RECEIPTS);
      expect(["idle", "launching", "active", "closing", "exited", "error"]).toContain(machine.state);
    }
  });

  it("keeps the error ring bounded and listener count balanced over 2000 report/subscribe cycles", () => {
    clearErrorBus();
    expect(errorBusListenerCount()).toBe(0);
    const random = seededRandom(0xeb_001);
    for (let step = 0; step < 2000; step += 1) {
      const unsubscribe = subscribeToErrorBus(() => {});
      reportError("soak", new Error(`failure ${step}`), step);
      unsubscribe();
      if (random() < 0.01) {
        reportError("soak", `extra ${step}`, step);
      }
      // Every subscribe is unsubscribed in the same step (no leaked listeners).
      expect(errorBusListenerCount()).toBe(0);
    }
    const snapshot = getErrorBusSnapshot();
    expect(snapshot.size).toBeLessThanOrEqual(ERROR_BUS_CAPACITY);
    expect(snapshot.evicted).toBeGreaterThan(0);
    expect(snapshot.listeners).toBe(0);
    clearErrorBus();
  });

  it("bounds per-command latency samples over 20000 recorded invokes", () => {
    resetPerfMetrics();
    const commands = ["get_session_state", "get_diagnostics_snapshot", "get_window_broker_status", "get_display_audio_status"];
    for (let index = 0; index < 20_000; index += 1) {
      recordCommandLatency(commands[index % commands.length], index % 97);
    }
    for (const histogram of commandHistogram()) {
      expect(histogram.count).toBeLessThanOrEqual(MAX_SAMPLES_PER_COMMAND);
      expect(histogram.count + histogram.droppedSamples).toBe(5_000);
      expect(histogram.p95Ms).toBeLessThanOrEqual(histogram.maxMs);
      expect(histogram.p50Ms).toBeLessThanOrEqual(histogram.p95Ms);
    }
    resetPerfMetrics();
    expect(commandHistogram()).toHaveLength(0);
  });

  it("never lets topology-triggered restores exceed the budget over 1000 flapping HDMI events", async () => {
    const restore = vi.fn(async () => {});
    let now = 0;
    const recovery = new DisplayTopologyFocusRecovery({ restore, cooldownMs: 500, now: () => now });
    let restores = 0;
    for (let step = 0; step < 1000; step += 1) {
      now += 1_000; // cooldown satisfied
      const signature = step % 2 === 0 ? `sig-even-${step}` : `sig-odd-${step}`;
      const decision = recovery.handleTopologyChange({ displaySignature: signature, atMs: now });
      if (decision.action === "restore") restores += 1;
      await Promise.resolve();
    }
    expect(restores).toBeLessThanOrEqual(3);
    expect(restore.mock.calls.length).toBeLessThanOrEqual(3);
    expect(recovery.restoresTriggered).toBe(restores);
  });

  it("keeps the cross-source gate epoch monotonic and resets bounded over 1000 transitions", () => {
    const gate = new CrossSourceGate(90, 400);
    const random = seededRandom(0x9a7e);
    const actions: ControllerAction[] = [
      { type: "move", delta: 1 },
      { type: "move", delta: -1 },
      { type: "confirm" },
      { type: "back" },
      { type: "options" },
    ];
    let now = 0;
    let epoch = gate.currentEpoch;
    for (let step = 0; step < 1000; step += 1) {
      now += 1 + Math.floor(random() * 120);
      if (random() < 0.1) {
        epoch = gate.advanceEpoch();
      }
      expect(gate.currentEpoch).toBe(epoch);
      gate.accept("native", actions[Math.floor(random() * actions.length)], now);
      if (random() < 0.2) gate.reset();
      // reset() never rewinds the epoch.
      expect(gate.currentEpoch).toBe(epoch);
    }
  });
});
