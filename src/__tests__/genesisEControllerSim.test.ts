/**
 * Workstream S3.5 (Agent E, genesis) — CONTROLLER SIMULATION REGRESSION.
 *
 * Additional deterministic coverage over the existing
 * `src/services/controllerSimulation.ts` module (the ascension-era
 * controllerSimulation.test.ts stays untouched): hold expansion bounds,
 * analog dead-zone symmetry, export/parse round-trip fidelity, review-gate
 * coverage of every activation/media action, and the in-memory recording /
 * home-boundary lifecycle (subscribe, settle, clear) including its bounds.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SIMULATION_STEPS,
  clearControllerSimulationMemory,
  needsSimulationReview,
  parseSimulationSequence,
  readControllerSimulationMemory,
  rememberControllerSimulationHomeBoundary,
  rememberControllerSimulationReceipts,
  rememberControllerSimulationRecording,
  settleControllerSimulationHomeBoundary,
  simulationAnalog,
  simulationHold,
  simulationSequenceJson,
  simulationService,
  subscribeControllerSimulationHomeBoundary,
  type SimulationStep,
} from "../services/controllerSimulation";
import type { TvNavigationReceipt } from "../services/tvNavigation";

beforeEach(() => clearControllerSimulationMemory());
afterEach(() => clearControllerSimulationMemory());

const ALL_ACTIONS = [
  "up", "down", "left", "right", "confirm", "back", "home", "openControlCenter",
  "playPause", "seekForward", "seekBackward", "scrollUp", "scrollDown", "pointerMove", "pointerClick", "pointerBack",
  "pointerToggle", "nextSection", "previousSection", "captions", "click", "fullscreen", "playerMute", "mute", "volumeUp", "volumeDown",
] as const;

describe("genesis E: controller simulation — service mapping and review gate", () => {
  it("maps only the five known streaming services and rejects anything else", () => {
    for (const service of ["youtube", "netflix", "disney", "max", "prime"] as const) {
      expect(simulationService(`edge-cinema:${service}`)).toBe(service);
      expect(simulationService(service)).toBe(service);
    }
    expect(simulationService("edge-cinema:hbo")).toBeUndefined();
    expect(simulationService("steam")).toBeUndefined();
    expect(simulationService(undefined)).toBeUndefined();
    expect(simulationService("edge-cinema:")).toBeUndefined();
  });

  it("requires a local review checkpoint for exactly the activation/media actions", () => {
    const review = ALL_ACTIONS.filter((action) => needsSimulationReview(action));
    expect(review.sort()).toEqual(
      ["captions", "click", "confirm", "fullscreen", "playPause", "playerMute", "pointerClick", "seekBackward", "seekForward"].sort(),
    );
    // Pure navigation never blocks on review.
    for (const action of ["up", "down", "left", "right", "back", "home", "scrollUp", "scrollDown", "pointerMove", "nextSection", "previousSection"] as const) {
      expect(needsSimulationReview(action)).toBe(false);
    }
  });
});

describe("genesis E: controller simulation — holds and analog input stay bounded", () => {
  it("expands a hold into a bounded series of semantic repeats with clamped timing", () => {
    const steps = simulationHold({ action: "right", serviceId: "netflix" }, 2000, 250);
    expect(steps.length).toBeLessThanOrEqual(MAX_SIMULATION_STEPS);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].delayMs).toBe(600);
    for (const step of steps.slice(1)) expect(step.delayMs).toBe(250);
    // The action and service survive the expansion unchanged.
    for (const step of steps) expect(step).toMatchObject({ action: "right", serviceId: "netflix" });
  });

  it("clamps hold duration and interval into the documented 100–5000 / 100–1000 ms windows", () => {
    expect(simulationHold({ action: "up" }, 10, 10)[0]?.delayMs).toBe(600);
    const slow = simulationHold({ action: "up" }, 60_000, 5_000);
    // duration clamps to 5000 ms, interval to 1000 ms → ceil(5000/1000) = 5 repeats.
    expect(slow).toHaveLength(5);
    expect(slow[1].delayMs).toBe(1000);
    expect(simulationHold({ action: "up" }, Number.NaN, 100)).toEqual([]);
    expect(simulationHold({ action: "up" }, 1000, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("never expands non-repeatable actions into holds", () => {
    for (const action of ["confirm", "back", "home", "playPause", "click", "fullscreen", "volumeUp"] as const) {
      expect(simulationHold({ action }, 5000, 100)).toEqual([]);
    }
  });

  it("applies a symmetric dead zone and clamps analog deltas to ±32 (±8 in precision mode)", () => {
    expect(simulationAnalog(0.17, -0.17, false)).toEqual({ action: "pointerMove", deltaX: 0, deltaY: 0 });
    expect(simulationAnalog(0.18, -0.18, false)).toEqual({ action: "pointerMove", deltaX: 0, deltaY: 0 });
    expect(simulationAnalog(-0.5, 0.5, false)).toEqual({ action: "pointerMove", deltaX: -12, deltaY: 12 });
    expect(simulationAnalog(-0.5, 0.5, true)).toEqual({ action: "pointerMove", deltaX: -3, deltaY: 3 });
    expect(simulationAnalog(100, -100, false)).toEqual({ action: "pointerMove", deltaX: 32, deltaY: -32 });
    expect(simulationAnalog(Number.NaN, Number.POSITIVE_INFINITY, true)).toEqual({ action: "pointerMove", deltaX: 0, deltaY: 0 });
  });
});

describe("genesis E: controller simulation — portable export/parse round-trip", () => {
  it("exports at most MAX_SIMULATION_STEPS sanitized steps with truthful verification flags", () => {
    const steps: SimulationStep[] = Array.from({ length: MAX_SIMULATION_STEPS + 40 }, (_, index) => ({
      action: "down",
      serviceId: "max",
      delayMs: index,
    }));
    const exported = JSON.parse(simulationSequenceJson(steps));
    expect(exported.schemaVersion).toBe(1);
    expect(exported.source).toBe("simulator");
    expect(exported.physicalHardwareVerified).toBe(false);
    expect(exported.playbackEffectVerified).toBe(false);
    expect(exported.activationPolicy).toBe("local-review-checkpoint");
    expect(exported.steps).toHaveLength(MAX_SIMULATION_STEPS);
    // Timing is clamped into 100–1000 ms on export.
    for (const step of exported.steps) {
      expect(step.delayMs).toBeGreaterThanOrEqual(100);
      expect(step.delayMs).toBeLessThanOrEqual(1000);
      expect(step.requiresReview).toBe(false);
    }
  });

  it("round-trips every action family through export + parse without trusting extra fields", () => {
    const original: SimulationStep[] = [
      { action: "up", delayMs: 100 },
      { action: "confirm", serviceId: "youtube", delayMs: 1000 },
      { action: "pointerMove", deltaX: -32, deltaY: 32, delayMs: 500 },
      ...simulationHold({ action: "down" }, 1200, 300),
    ];
    const parsed = parseSimulationSequence(simulationSequenceJson(original));
    expect(parsed).toHaveLength(Math.min(original.length, MAX_SIMULATION_STEPS));
    expect(parsed[0]).toEqual({ action: "up", delayMs: 100 });
    expect(parsed[1]).toEqual({ action: "confirm", serviceId: "youtube", delayMs: 1000 });
    expect(parsed[2]).toEqual({ action: "pointerMove", deltaX: -32, deltaY: 32, delayMs: 500 });
    // Export clamps delayMs, so the round-trip is the clamped projection.
    for (const step of parsed) {
      expect(ALL_ACTIONS).toContain(step.action);
      if (step.action === "pointerMove") {
        expect(Math.abs(step.deltaX ?? 0)).toBeLessThanOrEqual(32);
        expect(Math.abs(step.deltaY ?? 0)).toBeLessThanOrEqual(32);
      }
    }
  });

  it("rejects malformed, oversized, unknown or out-of-range sequences", () => {
    expect(() => parseSimulationSequence("not json")).toThrow();
    expect(() => parseSimulationSequence("x".repeat(32_769))).toThrow();
    expect(() => parseSimulationSequence(JSON.stringify({ schemaVersion: 2, steps: [{ action: "up", delayMs: 100 }] }))).toThrow();
    expect(() => parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps: [] }))).toThrow();
    expect(() => parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps: Array.from({ length: MAX_SIMULATION_STEPS + 1 }, () => ({ action: "up", delayMs: 100 })) }))).toThrow();
    expect(() => parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps: [{ action: "rm -rf", delayMs: 100 }] }))).toThrow();
    expect(() => parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps: [{ action: "up", delayMs: 99 }] }))).toThrow();
    expect(() => parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps: [{ action: "up", delayMs: 1001 }] }))).toThrow();
    expect(() => parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps: [{ action: "pointerMove", deltaX: 32, deltaY: 33, delayMs: 100 }] }))).toThrow();
    expect(() => parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps: [{ action: "pointerMove", deltaX: 1.5, deltaY: 0, delayMs: 100 }] }))).toThrow();
  });
});

describe("genesis E: controller simulation — bounded in-memory recording and home boundary", () => {
  it("stores a bounded, re-parsed recording and never trusts raw input", () => {
    rememberControllerSimulationRecording([
      { action: "down", delayMs: 5 }, // delay clamped to 100 on store
      { action: "confirm", serviceId: "netflix" },
      ...Array.from({ length: 100 }, () => ({ action: "up" as const })),
    ]);
    const memory = readControllerSimulationMemory();
    expect(memory.recorded).toHaveLength(MAX_SIMULATION_STEPS);
    expect(memory.recorded[0]).toEqual({ action: "down", delayMs: 100 });
    expect(memory.recorded[1]).toEqual({ action: "confirm", serviceId: "netflix", delayMs: 600 });
    expect(memory.receipts).toEqual([]);
    expect(memory.homeBoundary).toBeNull();
    // Reading is a copy: mutating it cannot corrupt the stored state.
    memory.recorded.length = 0;
    expect(readControllerSimulationMemory().recorded).toHaveLength(MAX_SIMULATION_STEPS);
  });

  it("sanitizes receipts through the navigation evidence JSON (no ids, no page data)", () => {
    const receipt: TvNavigationReceipt = {
      action: "confirm", sequence: 7, generation: 2, targetSession: "managed",
      accepted: true, mode: "automatic", activeStrategy: "keyboard", effect: "unverified", lastResult: null,
      dispatchElapsedMs: 12, spatialQueryMs: 3, spatialCandidateCount: 1,
      effectObservation: "notChecked", homeTransitionReady: true,
    };
    rememberControllerSimulationReceipts([receipt]);
    const [stored] = readControllerSimulationMemory().receipts;
    expect(stored).toMatchObject({ action: "confirm", sequence: 7, generation: 2, targetSession: "managed", accepted: true, mode: "automatic" });
    expect(stored).not.toHaveProperty("raw");
    // The stored copy is bounded to the last 64 receipts.
    rememberControllerSimulationReceipts(Array.from({ length: 100 }, (_, index) => ({ ...receipt, sequence: index })));
    expect(readControllerSimulationMemory().receipts).toHaveLength(64);
  });

  it("notifies home-boundary subscribers and settles an accepted boundary exactly once", () => {
    const events: string[] = [];
    const unsubscribe = subscribeControllerSimulationHomeBoundary(() => events.push("changed"));
    const pending = rememberControllerSimulationHomeBoundary({
      accepted: null,
      remaining: [{ action: "home" }, { action: "openControlCenter" }],
    });
    expect(pending).not.toBeNull();
    expect(pending!.accepted).toBeNull();
    expect(pending!.remaining).toEqual([
      { action: "home", delayMs: 600 },
      { action: "openControlCenter", delayMs: 600 },
    ]);
    expect(events).toEqual(["changed"]);

    settleControllerSimulationHomeBoundary(pending!, true);
    expect(readControllerSimulationMemory().homeBoundary?.accepted).toBe(true);
    // Settling again with a stale reference is a no-op.
    settleControllerSimulationHomeBoundary(pending!, false);
    expect(readControllerSimulationMemory().homeBoundary?.accepted).toBe(true);

    // Rejecting clears the boundary.
    const pending2 = rememberControllerSimulationHomeBoundary({ accepted: null, remaining: [{ action: "home" }] });
    settleControllerSimulationHomeBoundary(pending2!, false);
    expect(readControllerSimulationMemory().homeBoundary).toBeNull();
    expect(events).toEqual(["changed", "changed", "changed", "changed"]);

    unsubscribe();
    rememberControllerSimulationHomeBoundary(null);
    expect(events).toEqual(["changed", "changed", "changed", "changed"]);
  });

  it("clears all simulation memory", () => {
    rememberControllerSimulationRecording([{ action: "up" }]);
    rememberControllerSimulationHomeBoundary({ accepted: null, remaining: [{ action: "home" }] });
    clearControllerSimulationMemory();
    expect(readControllerSimulationMemory()).toEqual({ recorded: [], receipts: [], homeBoundary: null });
  });
});
