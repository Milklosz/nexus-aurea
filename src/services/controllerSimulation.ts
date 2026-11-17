import { navigationEvidenceJson, type TvNavigationAction, type TvNavigationReceipt } from "./tvNavigation";

export const MAX_SIMULATION_STEPS = 64;
export type SimulationService = "youtube" | "netflix" | "disney" | "max" | "prime";
export interface SimulationStep {
  action: TvNavigationAction;
  deltaX?: number;
  deltaY?: number;
  delayMs?: number;
  serviceId?: SimulationService;
}

const services = new Set<SimulationService>(["youtube", "netflix", "disney", "max", "prime"]);
const actions = new Set<TvNavigationAction>(["up", "down", "left", "right", "confirm", "back", "home", "openControlCenter",
  "playPause", "seekForward", "seekBackward", "scrollUp", "scrollDown", "pointerMove", "pointerClick", "pointerBack",
  "pointerToggle", "nextSection", "previousSection", "captions", "click", "fullscreen", "playerMute", "mute", "volumeUp", "volumeDown"]);
export function simulationService(appId?: string): SimulationService | undefined {
  const service = appId?.replace(/^edge-cinema:/, "") as SimulationService;
  return services.has(service) ? service : undefined;
}

/** Replay never activates content or changes playback before a local screen-review checkpoint. */
export function needsSimulationReview(action: TvNavigationAction): boolean {
  return ["confirm", "click", "pointerClick", "playPause", "seekForward", "seekBackward", "fullscreen", "playerMute", "captions"].includes(action);
}

const repeatable = new Set<TvNavigationAction>(["up", "down", "left", "right", "scrollUp", "scrollDown", "pointerMove"]);
/** A hold is a bounded series of semantic repeats, not proof of raw HID/PS delivery. */
export function simulationHold(step: SimulationStep, durationMs: number, intervalMs: number): SimulationStep[] {
  if (!repeatable.has(step.action) || !Number.isFinite(durationMs) || !Number.isFinite(intervalMs)) return [];
  const interval = Math.max(100, Math.min(1000, Math.round(intervalMs)));
  const duration = Math.max(100, Math.min(5000, durationMs));
  const count = Math.min(MAX_SIMULATION_STEPS, Math.max(1, Math.ceil(duration / interval)));
  return Array.from({ length: count }, (_, index) => ({ ...step, delayMs: index === 0 ? 600 : interval }));
}

export function simulationAnalog(x: number, y: number, precision: boolean): Pick<SimulationStep, "action" | "deltaX" | "deltaY"> {
  const axis = (value: number) => {
    if (!Number.isFinite(value)) return 0;
    const bounded = Math.max(-1, Math.min(1, value));
    if (Math.abs(bounded) <= 0.18) return 0;
    const normalized = (Math.abs(bounded) - 0.18) / 0.82;
    return Math.round(Math.sign(bounded) * normalized * (precision ? 8 : 32));
  };
  return { action: "pointerMove", deltaX: axis(x), deltaY: axis(y) };
}

/** No session identifiers, page data, errors or arbitrary text are recorded. */
export function simulationSequenceJson(steps: readonly SimulationStep[]): string {
  return JSON.stringify({ schemaVersion: 1, source: "simulator", physicalHardwareVerified: false,
    playbackEffectVerified: false, activationPolicy: "local-review-checkpoint",
    steps: steps.slice(0, MAX_SIMULATION_STEPS).map(step => ({
      action: step.action, serviceId: step.serviceId ?? null,
      delayMs: Math.max(100, Math.min(1000, step.delayMs ?? 600)),
      ...(step.action === "pointerMove" ? { deltaX: Math.max(-32, Math.min(32, step.deltaX ?? 0)), deltaY: Math.max(-32, Math.min(32, step.deltaY ?? 0)) } : {}),
      requiresReview: needsSimulationReview(step.action),
    })),
  }, null, 2);
}

/** Accept only portable semantic steps; never accept targets, key codes or process/window handles. */
export function parseSimulationSequence(raw: string): SimulationStep[] {
  if (raw.length > 32_768) throw new Error("Sekwencja przekracza limit 32 KB.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Sekwencja nie jest poprawnym JSON."); }
  const invalid = () => new Error("Nieprawidłowa sekwencja: wymagane 1–64 dozwolone akcje, odstęp 100–1000 ms i kroki wskaźnika −32…32.");
  if (!parsed || typeof parsed !== "object" || !("schemaVersion" in parsed) || parsed.schemaVersion !== 1 || !("steps" in parsed)
    || !Array.isArray(parsed.steps) || parsed.steps.length < 1 || parsed.steps.length > MAX_SIMULATION_STEPS) throw invalid();
  return parsed.steps.map((value: unknown) => {
    if (!value || typeof value !== "object" || !("action" in value) || !actions.has(value.action as TvNavigationAction)) throw invalid();
    const step = value as Record<string, unknown>;
    if (!Number.isSafeInteger(step.delayMs) || (step.delayMs as number) < 100 || (step.delayMs as number) > 1000) throw invalid();
    if (step.serviceId !== undefined && step.serviceId !== null && !services.has(step.serviceId as SimulationService)) throw invalid();
    const pointer: Pick<SimulationStep, "deltaX" | "deltaY"> = {};
    if (step.action === "pointerMove") {
      for (const key of ["deltaX", "deltaY"] as const) {
        if (!Number.isSafeInteger(step[key]) || Math.abs(step[key] as number) > 32) throw invalid();
        pointer[key] = step[key] as number;
      }
    }
    return { action: step.action as TvNavigationAction, delayMs: step.delayMs as number,
      ...(step.serviceId ? { serviceId: step.serviceId as SimulationService } : {}), ...pointer };
  });
}

export interface SimulationHomeBoundary {
  remaining: SimulationStep[];
  accepted: boolean | null;
}
interface SimulationMemory {
  recorded: SimulationStep[];
  receipts: TvNavigationReceipt[];
  homeBoundary: SimulationHomeBoundary | null;
}
let simulationMemory: SimulationMemory = { recorded: [], receipts: [], homeBoundary: null };
const portableSteps = (steps: readonly SimulationStep[]) => steps.length ? parseSimulationSequence(simulationSequenceJson(steps)) : [];

/** Bounded, sanitized process memory only. No runner, timer, session ID or persistent storage. */
export function readControllerSimulationMemory(): SimulationMemory {
  return { recorded: [...simulationMemory.recorded], receipts: [...simulationMemory.receipts],
    homeBoundary: simulationMemory.homeBoundary ? { ...simulationMemory.homeBoundary, remaining: [...simulationMemory.homeBoundary.remaining] } : null };
}
export function rememberControllerSimulationRecording(steps: readonly SimulationStep[]): void {
  simulationMemory.recorded = portableSteps(steps.slice(0, MAX_SIMULATION_STEPS));
}
export function rememberControllerSimulationReceipts(receipts: readonly TvNavigationReceipt[]): void {
  const safe = JSON.parse(navigationEvidenceJson(receipts)).actions as Array<Record<string, unknown>>;
  simulationMemory.receipts = safe.map((value, index) => ({
    action: receipts.slice(-64)[index].action, serviceId: value.serviceId as string | null,
    sequence: value.sequence as number, generation: value.generation as number,
    targetSession: value.targetPresent ? "managed" : null, accepted: value.commandAccepted === true,
    mode: ["automatic", "keyboard", "spatial", "pointer"].includes(receipts.slice(-64)[index].mode) ? receipts.slice(-64)[index].mode : "automatic",
    activeStrategy: value.strategy as string, ownership: value.ownership as string, effect: value.effect as string,
    lastResult: null, dispatchElapsedMs: value.dispatchElapsedMs as number | undefined,
    spatialQueryMs: value.spatialQueryMs as number | null, spatialCandidateCount: value.spatialCandidateCount as number | null,
    effectObservation: value.effectObservation as TvNavigationReceipt["effectObservation"],
    homeTransitionReady: typeof value.homeTransitionReady === "boolean" ? value.homeTransitionReady : undefined,
    fallbackReason: value.fallbackReason as string | null, fallbackActivated: value.fallbackActivated === true,
    spatialDiagnostics: value.spatialDiagnostics as TvNavigationReceipt["spatialDiagnostics"],
  }));
}
export function rememberControllerSimulationHomeBoundary(boundary: SimulationHomeBoundary | null): void {
  simulationMemory.homeBoundary = boundary ? { accepted: boundary.accepted, remaining: portableSteps(boundary.remaining.slice(0, MAX_SIMULATION_STEPS)) } : null;
}
export function clearControllerSimulationMemory(): void {
  simulationMemory = { recorded: [], receipts: [], homeBoundary: null };
}
