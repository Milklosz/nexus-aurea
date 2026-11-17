import { describe, expect, it } from "vitest";
import { needsSimulationReview, parseSimulationSequence, simulationAnalog, simulationHold, simulationSequenceJson, simulationService } from "../services/controllerSimulation";

describe("bounded semantic controller simulation", () => {
  it("uses a stable analog dead zone, clamps movement, and reduces precision steps", () => {
    expect(simulationAnalog(0.18, -0.1, false)).toEqual({ action: "pointerMove", deltaX: 0, deltaY: 0 });
    expect(simulationAnalog(5, -5, false)).toEqual({ action: "pointerMove", deltaX: 32, deltaY: -32 });
    expect(simulationAnalog(1, -1, true)).toEqual({ action: "pointerMove", deltaX: 8, deltaY: -8 });
    expect(simulationAnalog(NaN, Infinity, false)).toEqual({ action: "pointerMove", deltaX: 0, deltaY: 0 });
  });
  it("bounds repeats and excludes activations, Home and media from held input", () => {
    const steps = simulationHold({ action: "down" }, 999999, 1);
    expect(steps).toHaveLength(50);
    expect(steps[0].delayMs).toBe(600);
    expect(steps[1].delayMs).toBe(100);
    for (const action of ["confirm", "click", "home", "playPause"] as const) expect(simulationHold({ action }, 1000, 100)).toEqual([]);
    expect(simulationHold({ action: "up" }, NaN, 100)).toEqual([]);
  });
  it("requires a local review before replayed activation and media, while navigation proceeds", () => {
    for (const action of ["confirm", "pointerClick", "click", "playPause", "fullscreen", "seekForward"] as const) expect(needsSimulationReview(action)).toBe(true);
    for (const action of ["down", "nextSection", "back", "home", "pointerMove"] as const) expect(needsSimulationReview(action)).toBe(false);
  });
  it("exports bounded portable service actions without identities or hardware acceptance", () => {
    expect(simulationService("edge-cinema:youtube")).toBe("youtube");
    expect(simulationService("private-session-title")).toBeUndefined();
    const exported = JSON.parse(simulationSequenceJson(Array.from({ length: 100 }, () => ({ action: "pointerMove", deltaX: 999, deltaY: -999, serviceId: "youtube", delayMs: 10 }))));
    expect(exported.steps).toHaveLength(64);
    expect(exported.steps[0]).toMatchObject({ action: "pointerMove", deltaX: 32, deltaY: -32, delayMs: 100, serviceId: "youtube" });
    expect(exported.physicalHardwareVerified).toBe(false);
    expect(exported.playbackEffectVerified).toBe(false);
  });
  it("round-trips a semantic regression without trusting supplied checkpoint or target identifiers", () => {
    const raw = simulationSequenceJson([{ action: "down", serviceId: "youtube" }, { action: "confirm", serviceId: "youtube" }, simulationAnalog(1, 0, true)]);
    expect(parseSimulationSequence(raw)).toEqual([
      { action: "down", serviceId: "youtube", delayMs: 600 }, { action: "confirm", serviceId: "youtube", delayMs: 600 },
      { action: "pointerMove", deltaX: 8, deltaY: 0, delayMs: 600 },
    ]);
    const [step] = parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps: [{ action: "confirm", delayMs: 100, requiresReview: false, targetSession: "secret", hwnd: 123 }] }));
    expect(needsSimulationReview(step.action)).toBe(true);
    expect(step).not.toHaveProperty("targetSession");
    expect(step).not.toHaveProperty("hwnd");
  });
  it("rejects unknown actions, oversized recordings, invalid timing, services and pointer coordinates", () => {
    const parse = (steps: unknown[]) => parseSimulationSequence(JSON.stringify({ schemaVersion: 1, steps }));
    expect(() => parse([{ action: "execute", delayMs: 100 }])).toThrow();
    expect(() => parse([{ action: "down", delayMs: 1 }])).toThrow();
    expect(() => parse([{ action: "down", delayMs: 100, serviceId: "private-page" }])).toThrow();
    expect(() => parse([{ action: "pointerMove", delayMs: 100, deltaX: 33, deltaY: 0 }])).toThrow();
    expect(() => parse(Array.from({ length: 65 }, () => ({ action: "down", delayMs: 100 })))).toThrow();
    expect(() => parseSimulationSequence("x".repeat(32769))).toThrow();
  });
});
