import { invoke, isTauri } from "@tauri-apps/api/core";

export type TvNavigationMode = "automatic" | "keyboard" | "spatial" | "pointer";
export type TvNavigationAction =
  | "up" | "down" | "left" | "right"
  | "confirm" | "back" | "home" | "openControlCenter"
  | "playPause" | "seekForward" | "seekBackward"
  | "scrollUp" | "scrollDown" | "pointerMove" | "pointerClick"
  | "pointerBack" | "pointerToggle" | "nextSection" | "previousSection" | "captions" | "click"
  | "fullscreen" | "playerMute" | "mute" | "volumeUp" | "volumeDown";

export interface SpatialDiagnostics {
  providerAvailable: boolean;
  focusInScope: boolean | null;
  visitedCount: number;
  candidateCount: number;
  rejected: {
    disabled: number; offscreen: number; password: number; notKeyboardFocusable: number;
    invalidBounds: number; outsideScope: number; propertyUnavailable: number;
  };
  queryMs: number;
  budgetExhausted: boolean;
  cacheHit: boolean;
}

export interface TvNavigationReceipt {
  action: TvNavigationAction;
  serviceId?: string | null;
  sequence: number;
  generation: number;
  targetSession: string | null;
  accepted: boolean;
  mode: TvNavigationMode;
  activeStrategy: string;
  ownership?: string | null;
  effect: string;
  lastResult: string | null;
  dispatchElapsedMs?: number;
  spatialQueryMs?: number | null;
  spatialCandidateCount?: number | null;
  spatialDiagnostics?: SpatialDiagnostics | null;
  fallbackReason?: string | null;
  fallbackActivated?: boolean;
  /** Explicit local operator annotation; independent of the native dispatch receipt. */
  effectObservation?: "notChecked" | "observed" | "notObserved";
  /** Native status confirmed completed Home and focused trusted main, after dispatch. */
  homeTransitionReady?: boolean;
}

export interface TvNavigationStatus {
  windows?: boolean;
  simulatorAvailable: boolean;
  enabled: boolean;
  mode: TvNavigationMode;
  activeStrategy: string;
  generation: number;
  mediaControlsArmed: boolean;
  lastSimulatorSequence?: number;
  simulatorHomeReady?: boolean;
  targetSession?: { sessionId: string; serviceId: string; label: string } | null;
  mediaControlSession?: { sessionId: string; serviceId: string; label: string } | null;
  lastResult: string | null;
}

export const unavailableTvNavigation: TvNavigationStatus = {
  windows: false,
  simulatorAvailable: false,
  enabled: false,
  mode: "automatic",
  activeStrategy: "unavailable",
  generation: 0,
  mediaControlsArmed: false,
  lastResult: null,
};

export async function getTvNavigationStatus(): Promise<TvNavigationStatus> {
  if (!isTauri()) return unavailableTvNavigation;
  return invoke<TvNavigationStatus>("get_tv_navigation_status");
}

export async function configureTvNavigation(enabled: boolean, mode: TvNavigationMode): Promise<TvNavigationStatus> {
  if (!isTauri()) throw new Error("Symulator wymaga diagnostycznej aplikacji Windows.");
  return invoke<TvNavigationStatus>("configure_tv_navigation", { enabled, mode });
}

export interface TvSimulatorInput {
  action: TvNavigationAction;
  sequence: number;
  generation: number;
  targetSession: string | null;
  deltaX?: number;
  deltaY?: number;
}

export async function simulateTvNavigationAction(input: TvSimulatorInput): Promise<Omit<TvNavigationReceipt, "action">> {
  if (!isTauri()) throw new Error("Symulator wymaga diagnostycznej aplikacji Windows.");
  return invoke<Omit<TvNavigationReceipt, "action">>("simulate_tv_navigation_action", input as unknown as Record<string, unknown>);
}

export async function captureTvNavigationTarget(sessionId: string): Promise<TvNavigationStatus> {
  if (!isTauri()) throw new Error("Symulator wymaga diagnostycznej aplikacji Windows.");
  return invoke<TvNavigationStatus>("capture_tv_navigation_target", { sessionId });
}

export async function setTvNavigationMediaControls(armed: boolean, sessionId?: string): Promise<TvNavigationStatus> {
  if (!isTauri()) throw new Error("Symulator wymaga diagnostycznej aplikacji Windows.");
  return invoke<TvNavigationStatus>("set_tv_navigation_media_controls", { armed, sessionId: sessionId || null });
}

export async function setTvNavigationMode(mode: TvNavigationMode): Promise<TvNavigationStatus> {
  if (!isTauri()) throw new Error("Nawigacja TV wymaga natywnej aplikacji Windows.");
  return invoke<TvNavigationStatus>("set_tv_navigation_mode", { mode });
}

export async function cancelTvNavigationSimulation(): Promise<TvNavigationStatus> {
  if (!isTauri()) throw new Error("Symulator wymaga diagnostycznej aplikacji Windows.");
  return invoke<TvNavigationStatus>("cancel_tv_navigation_simulation");
}

const actions: ReadonlySet<string> = new Set<TvNavigationAction>([
  "up", "down", "left", "right", "confirm", "back", "home", "openControlCenter",
  "playPause", "seekForward", "seekBackward", "scrollUp", "scrollDown", "pointerMove",
  "pointerClick", "pointerBack", "pointerToggle", "nextSection", "previousSection", "captions", "click",
  "fullscreen", "playerMute", "mute", "volumeUp", "volumeDown",
]);

/** Export uses an allowlist: no native error strings, session identifiers, titles or page data. */
export function navigationEvidenceJson(receipts: readonly TvNavigationReceipt[]): string {
  const codes = new Set([
    "automatic", "keyboard", "spatial", "pointer", "spatial-pointer-hybrid", "unavailable", "unsupported", "unknown",
    "unverified", "effectUnverified", "observed", "notObserved", "notDispatched", "commandSent", "commandAccepted",
    "focus-observed", "invoke-accepted-effect-unverified",
    "owned", "verified", "denied", "accepted", "rejected", "notApplicable", "notChecked",
  ]);
  const safeCode = (value: string) => codes.has(value) ? value : "redacted";
  const serviceIds = new Set(["netflix", "disney", "max", "prime", "youtube"]);
  const fallbackReasons = new Set(["providerUnavailable", "focusOutsideOwnedWindow", "focusAncestryTooDeep", "noEligibleCandidates",
    "queryBudgetExhausted", "noCandidateInDirection", "actionBudgetExceeded", "scopeChanged", "candidateInvalidated", "focusNotObserved",
    "invokeUnsupported", "providerCallFailed", "authorizationRevoked", "targetChanged", "unsupportedPlatform", "focusNotCandidate"]);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const diagnostics = (value?: SpatialDiagnostics | null) => value ? {
    providerAvailable: value.providerAvailable === true,
    focusInScope: typeof value.focusInScope === "boolean" ? value.focusInScope : null,
    visitedCount: count(value.visitedCount), candidateCount: count(value.candidateCount), queryMs: count(value.queryMs),
    budgetExhausted: value.budgetExhausted === true, cacheHit: value.cacheHit === true,
    rejected: Object.fromEntries((["disabled", "offscreen", "password", "notKeyboardFocusable", "invalidBounds", "outsideScope", "propertyUnavailable"] as const)
      .map(key => [key, count(value.rejected?.[key])])),
  } : null;
  return JSON.stringify({
    schemaVersion: 2,
    physicalHardwareVerified: false,
    effectPolicy: "A command receipt does not establish a playback effect.",
    actions: receipts.slice(-64).map(receipt => ({
      action: actions.has(receipt.action) ? receipt.action : "redacted",
      source: "simulator",
      serviceId: receipt.serviceId && serviceIds.has(receipt.serviceId) ? receipt.serviceId : null,
      sequence: Number.isSafeInteger(receipt.sequence) ? receipt.sequence : null,
      generation: Number.isSafeInteger(receipt.generation) ? receipt.generation : null,
      targetPresent: receipt.targetSession !== null,
      strategy: safeCode(receipt.activeStrategy),
      ownership: receipt.ownership ? safeCode(receipt.ownership) : "unreported",
      commandAccepted: receipt.accepted,
      effect: safeCode(receipt.effect),
      effectObservation: receipt.effectObservation === "observed" || receipt.effectObservation === "notObserved" ? receipt.effectObservation : "notChecked",
      effectObservationSource: "localOperator",
      homeTransitionReady: typeof receipt.homeTransitionReady === "boolean" ? receipt.homeTransitionReady : null,
      resultPresent: receipt.lastResult !== null,
      dispatchElapsedMs: Number.isFinite(receipt.dispatchElapsedMs) ? receipt.dispatchElapsedMs : null,
      spatialQueryMs: Number.isFinite(receipt.spatialQueryMs) ? receipt.spatialQueryMs : null,
      spatialCandidateCount: Number.isSafeInteger(receipt.spatialCandidateCount) ? receipt.spatialCandidateCount : null,
      spatialDiagnostics: diagnostics(receipt.spatialDiagnostics),
      fallbackReason: receipt.fallbackReason ? fallbackReasons.has(receipt.fallbackReason) ? receipt.fallbackReason : "redacted" : null,
      fallbackActivated: receipt.fallbackActivated === true,
    })),
  }, null, 2);
}
