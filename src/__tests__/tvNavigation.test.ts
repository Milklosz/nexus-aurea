import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureTvNavigation, getTvNavigationStatus, navigationEvidenceJson, simulateTvNavigationAction, SPATIAL_FAILURE_KINDS, type TvNavigationReceipt } from "../services/tvNavigation";
const mocks = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.tauri, invoke: mocks.invoke }));
beforeEach(() => { mocks.tauri = false; vi.clearAllMocks(); });
describe("TV navigation contract", () => {
  it("never invokes native input from a browser preview", async () => {
    expect((await getTvNavigationStatus()).simulatorAvailable).toBe(false);
    await expect(configureTvNavigation(true, "keyboard")).rejects.toThrow(/diagnostycznej/);
    await expect(simulateTvNavigationAction({ action: "home", sequence: 1, generation: 0, targetSession: null })).rejects.toThrow(/diagnostycznej/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("passes a single normalized flat action and current generation to the native command", async () => {
    mocks.tauri = true;
    const input = { action: "down" as const, sequence: 1, generation: 7, targetSession: "owned" };
    await simulateTvNavigationAction(input);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("simulate_tv_navigation_action", input);
  });
  it("bounds export and strips identifiers, errors and arbitrary text while retaining unverified effects", () => {
    const receipt: TvNavigationReceipt = { action: "playPause", sequence: 1, generation: 7, targetSession: "private-session",
      accepted: true, mode: "keyboard", activeStrategy: "https://private.example", ownership: "verified", effect: "unverified", lastResult: "password=secret" };
    const raw = navigationEvidenceJson(Array.from({ length: 100 }, () => receipt));
    const exported = JSON.parse(raw);
    expect(exported.actions).toHaveLength(64);
    expect(exported.physicalHardwareVerified).toBe(false);
    expect(exported.actions[0].effect).toBe("unverified");
    expect(raw).not.toContain("private-session"); expect(raw).not.toContain("private.example"); expect(raw).not.toContain("secret");
    expect(exported.actions[0].strategy).toBe("redacted");
    expect(exported.actions[0].effectObservation).toBe("notChecked");
    expect(exported.actions[0].effectObservationSource).toBe("localOperator");
  });
  it("keeps a local observed-effect annotation separate from native command acceptance", () => {
    const receipt: TvNavigationReceipt = { action: "playPause", sequence: 1, generation: 7, targetSession: "owned",
      accepted: true, mode: "keyboard", activeStrategy: "keyboard", effect: "unverified", lastResult: null, effectObservation: "notObserved" };
    const exported = JSON.parse(navigationEvidenceJson([receipt]));
    expect(exported.actions[0]).toMatchObject({ commandAccepted: true, effect: "unverified", effectObservation: "notObserved" });
    expect(exported.physicalHardwareVerified).toBe(false);
  });
  it("exports only bounded diagnostic counters and known fallback codes", () => {
    const receipt: TvNavigationReceipt = { action: "down", sequence: 1, generation: 7, targetSession: "owned", accepted: true,
      mode: "spatial", activeStrategy: "keyboard", effect: "unverified", lastResult: "private page error", fallbackActivated: true,
      fallbackReason: "queryBudgetExhausted", spatialDiagnostics: { providerAvailable: true, focusInScope: true,
        visitedCount: 128, candidateCount: 0, queryMs: 40, budgetExhausted: true, cacheHit: false,
        rejected: { disabled: 1, offscreen: 2, password: 0, notKeyboardFocusable: 100, invalidBounds: 0, outsideScope: 0, propertyUnavailable: -3 },
      } };
    const exported = JSON.parse(navigationEvidenceJson([receipt]));
    expect(exported.actions[0]).toMatchObject({ fallbackActivated: true, fallbackReason: "queryBudgetExhausted",
      spatialDiagnostics: { visitedCount: 128, candidateCount: 0, rejected: { offscreen: 2, propertyUnavailable: null } } });
    expect(JSON.parse(navigationEvidenceJson([{ ...receipt, fallbackReason: "focusNotCandidate" }])).actions[0].fallbackReason).toBe("focusNotCandidate");
    expect(JSON.parse(navigationEvidenceJson([{ ...receipt, activeStrategy: "spatial-pointer-hybrid" }])).actions[0].strategy).toBe("spatial-pointer-hybrid");
    const malicious = JSON.parse(navigationEvidenceJson([{ ...receipt, fallbackReason: "private-page-content" as TvNavigationReceipt["fallbackReason"] }]));
    expect(malicious.actions[0].fallbackReason).toBe("redacted");
    expect(JSON.stringify(malicious)).not.toContain("private-page-content");
    expect(navigationEvidenceJson([receipt])).not.toContain("private page error");
  });
  it("mirrors the complete native failure contract in one shared allowlist", () => {
    expect(SPATIAL_FAILURE_KINDS).toHaveLength(16);
    expect(new Set(SPATIAL_FAILURE_KINDS).size).toBe(SPATIAL_FAILURE_KINDS.length);
    const base: TvNavigationReceipt = { action: "down", sequence: 1, generation: 7, targetSession: "owned",
      accepted: false, mode: "spatial", activeStrategy: "spatial", effect: "unverified", lastResult: null };
    for (const reason of SPATIAL_FAILURE_KINDS) {
      const exported = JSON.parse(navigationEvidenceJson([{ ...base, fallbackReason: reason }]));
      expect(exported.actions[0].fallbackReason).toBe(reason);
    }
    // Ownership/authorization/target codes are exportable as codes but are
    // never a frontend decision to activate fallback.
    for (const reason of ["focusOutsideOwnedWindow", "scopeChanged", "authorizationRevoked", "targetChanged", "unsupportedPlatform"] as const) {
      const exported = JSON.parse(navigationEvidenceJson([{ ...base, fallbackReason: reason, fallbackActivated: true }]));
      expect(exported.actions[0].fallbackReason).toBe(reason);
    }
  });
  it("exports typed fallback feedback without leaking arbitrary notice text", () => {
    const receipt: TvNavigationReceipt = { action: "confirm", sequence: 1, generation: 7, targetSession: "owned",
      accepted: false, mode: "spatial", activeStrategy: "spatial", effect: "unverified", lastResult: "private error",
      fallbackReason: "queryBudgetExhausted", fallbackActivated: true, modeChangedByFallback: true,
      fallbackNotice: "sticky pointer fallback enabled — original action was not repeated" };
    const raw = navigationEvidenceJson([receipt]);
    const exported = JSON.parse(raw);
    expect(exported.actions[0]).toMatchObject({ modeChangedByFallback: true, fallbackNoticePresent: true, fallbackReason: "queryBudgetExhausted" });
    expect(raw).not.toContain("private error");
    expect(raw).not.toContain("original action was not repeated");
    const without = JSON.parse(navigationEvidenceJson([{ ...receipt, modeChangedByFallback: false, fallbackNotice: null }]));
    expect(without.actions[0]).toMatchObject({ modeChangedByFallback: false, fallbackNoticePresent: false });
  });
});
