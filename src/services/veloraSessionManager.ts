import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { withTimeout, STATUS_READ_TIMEOUT_MS } from "./withTimeout";

export type ManagedSessionState = "notRunning" | "launching" | "running" | "foreground" | "background" | "unavailable" | "exited" | "failed";
export type ManagedLaunchMethod = "ownedBrowserWindow" | "steamClient" | "gameLauncher" | "playniteClient" | "managedExecutable";

/**
 * The ONE deterministic per-session lifecycle shared by Edge Cinema services
 * (Netflix, YouTube, Disney+, Prime Video, Max), Steam Big Picture and
 * Playnite: idle → launching → active → closing → exited/error.
 * Mirrors Rust `SessionLifecycleState` in `launch_registry.rs` exactly.
 */
export type SessionLifecycleState = "idle" | "launching" | "active" | "closing" | "exited" | "error";

/** Lifecycle events; mirrors Rust `LifecycleEvent` (camelCase serde). */
export type LifecycleEvent =
  | "launchRequested"
  | "launchProgress"
  | "processReady"
  | "closingObserved"
  | "closeRequested"
  | "exitObserved"
  | "crashObserved"
  | "launchFailed"
  | "superseded"
  | "cancelled"
  | "reset";

export type SessionTransitionReceipt = {
  seq: number;
  sessionId: string;
  from: SessionLifecycleState;
  to: SessionLifecycleState;
  cause: LifecycleEvent;
  atMs: number;
};

export interface ManagedSession {
  sessionId: string;
  appId: string;
  applicationType: "playnite" | "steam" | "game" | "cinema" | "managedApp";
  launchMethod: ManagedLaunchMethod;
  name: string;
  state: ManagedSessionState;
  launchedAtMs: number;
  lastObservedAtMs: number;
  lastActivationAtMs: number | null;
  canResume: boolean;
  canClose: boolean;
  lastFailure: string | null;
  /** Owning launch id (equals sessionId for registry-tracked sessions). */
  launchId?: string | null;
  /** True only for launches registered by VELORA itself. */
  managedByVelora?: boolean;
  /** Shared lifecycle state of this session (idle|launching|active|closing|exited|error). */
  lifecycle?: SessionLifecycleState;
  /** Launch generation within the service/app group (idempotent launch key part). */
  generation?: number;
  /** Newest transition receipt (exit/crash diagnostics). */
  lastTransition?: SessionTransitionReceipt | null;
  /** Bounded transition receipts of this session, oldest first. */
  transitionReceipts?: SessionTransitionReceipt[];
}
export interface ManagedApplicationState { appId: string; name: string; state: ManagedSessionState; sessionId: string | null }
export interface ManagedSessionsSnapshot { supported: boolean; sessions: ManagedSession[]; applications: ManagedApplicationState[] }
export interface ManagedSessionActionResult { accepted: boolean; activated: boolean; message: string }

export const emptyManagedSessions: ManagedSessionsSnapshot = { supported: false, sessions: [], applications: [] };

export const managedSessionLabels: Record<ManagedSessionState, string> = {
  notRunning: "Nie uruchomiono przez VELORA",
  launching: "Uruchamianie", running: "Uruchomiona", foreground: "Na pierwszym planie",
  background: "W tle", unavailable: "Niedostępna", exited: "Zakończona", failed: "Błąd",
};

function boundedSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 128 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw new Error("Nieprawidłowy identyfikator sesji.");
  }
}

export async function getManagedSessions(): Promise<ManagedSessionsSnapshot> {
  if (!isTauri()) return emptyManagedSessions;
  return invoke<ManagedSessionsSnapshot>("get_managed_sessions");
}

export async function resumeManagedSession(sessionId: string): Promise<ManagedSessionActionResult> {
  boundedSessionId(sessionId);
  if (!isTauri()) throw new Error("Przywracanie sesji wymaga natywnej aplikacji Windows.");
  return invoke<ManagedSessionActionResult>("resume_managed_session", { sessionId });
}

export async function closeManagedSession(sessionId: string, confirm: boolean): Promise<ManagedSessionActionResult> {
  boundedSessionId(sessionId);
  if (!confirm) throw new Error("Potwierdź zamknięcie wybranej sesji.");
  if (!isTauri()) throw new Error("Zamykanie sesji wymaga natywnej aplikacji Windows.");
  return invoke<ManagedSessionActionResult>("close_managed_session", { sessionId, confirm });
}

/** Existing native watcher supplies notifications; no additional periodic inventory scan. */
export async function listenForManagedSessionUpdate(callback: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen("velora-launch-event", callback);
}

/**
 * Bounded read of the managed-sessions snapshot. Reuses the existing
 * `withTimeout` pattern so a hung IPC can never freeze the panel; the late
 * result is dropped by the timeout race. No new polling is added.
 */
export function readManagedSessions(timeoutMs: number = STATUS_READ_TIMEOUT_MS): Promise<ManagedSessionsSnapshot> {
  return withTimeout(getManagedSessions(), timeoutMs, "Odczyt sesji");
}

// ---------------------------------------------------------------------------
// Ascension B: deterministic per-session lifecycle machine + launch coordinator
// ---------------------------------------------------------------------------

export const SESSION_LIFECYCLE_STATES: readonly SessionLifecycleState[] = [
  "idle",
  "launching",
  "active",
  "closing",
  "exited",
  "error",
];

/** Whitelist parser for wire values; an injected/unknown state falls back to "idle". */
export function safeLifecycleState(value: unknown): SessionLifecycleState {
  return typeof value === "string" && (SESSION_LIFECYCLE_STATES as readonly string[]).includes(value)
    ? (value as SessionLifecycleState)
    : "idle";
}

const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = [
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

export function safeLifecycleEvent(value: unknown): LifecycleEvent | null {
  return typeof value === "string" && (LIFECYCLE_EVENTS as readonly string[]).includes(value)
    ? (value as LifecycleEvent)
    : null;
}

/**
 * Deterministic transition table — the exact mirror of Rust
 * `lifecycle_transition` in `launch_registry.rs`. Returns the next state, or
 * `null` when the pair is invalid (a stale event can never resurrect or
 * corrupt a session). Terminal states leave only via "reset".
 */
export function lifecycleTransition(
  state: SessionLifecycleState,
  event: LifecycleEvent,
): SessionLifecycleState | null {
  switch (event) {
    case "launchRequested":
      return state === "idle" ? "launching" : null;
    case "launchProgress":
      return state === "launching" ? "launching"
        : state === "active" ? "active"
        : state === "closing" ? "launching"
        : null;
    case "processReady":
      return state === "launching" || state === "closing" ? "active"
        : state === "active" ? "active"
        : null;
    case "closeRequested":
    case "closingObserved":
      return state === "launching" || state === "active" ? "closing"
        : state === "closing" ? "closing"
        : null;
    case "exitObserved":
    case "cancelled":
    case "superseded":
      return state === "launching" || state === "active" || state === "closing" ? "exited" : null;
    case "crashObserved":
    case "launchFailed":
      return state === "launching" || state === "active" || state === "closing" ? "error" : null;
    case "reset":
      return "idle";
  }
}

/** States in which a repeated launch event for the same service is a duplicate. */
export function lifecycleBlocksLaunch(state: SessionLifecycleState): boolean {
  return state === "launching" || state === "active" || state === "closing";
}

export const MAX_SESSION_RECEIPTS = 32;

/**
 * One deterministic state machine per session (service/app group). Pure and
 * synchronous so it is trivially testable and soak-able; timestamps are
 * supplied by the caller.
 */
export class SessionLifecycleMachine {
  readonly service: string;
  state: SessionLifecycleState = "idle";
  sessionId: string | null = null;
  generation = 0;
  receipts: SessionTransitionReceipt[] = [];
  private seq = 0;

  constructor(service: string) {
    if (!service || service.length > 128 || /[\u0000-\u001f\u007f]/u.test(service)) {
      throw new Error("Nieprawidłowy klucz usługi sesji.");
    }
    this.service = service;
  }

  /** Applies one event; returns the receipt when the state changed, else null. */
  transition(event: LifecycleEvent, atMs: number, sessionId?: string | null): SessionTransitionReceipt | null {
    const next = lifecycleTransition(this.state, event);
    if (next === null) return null;
    if (event === "launchRequested" && sessionId !== undefined) this.sessionId = sessionId;
    if (next === this.state) return null;
    const from = this.state;
    this.state = next;
    this.seq += 1;
    const receipt: SessionTransitionReceipt = {
      seq: this.seq,
      sessionId: this.sessionId ?? this.service,
      from,
      to: next,
      cause: event,
      atMs,
    };
    this.receipts.push(receipt);
    while (this.receipts.length > MAX_SESSION_RECEIPTS) this.receipts.shift();
    return receipt;
  }

  get lastReceipt(): SessionTransitionReceipt | null {
    return this.receipts.length > 0 ? this.receipts[this.receipts.length - 1] : null;
  }
}

/** Idempotent launch key: `<service>#<generation>`. */
export function launchKey(service: string, generation: number): string {
  return `${service}#${generation}`;
}

export function parseLaunchKey(key: unknown): { service: string; generation: number } | null {
  if (typeof key !== "string" || key.length > 160 || /[\u0000-\u001f\u007f]/u.test(key)) return null;
  const hash = key.lastIndexOf("#");
  if (hash <= 0 || hash === key.length - 1) return null;
  const service = key.slice(0, hash);
  const generation = Number(key.slice(hash + 1));
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  return { service, generation };
}

export type LaunchDecision =
  | { kind: "launch"; key: string; generation: number; sessionId: string | null }
  | { kind: "adopt"; key: string; generation: number; sessionId: string | null }
  | { kind: "duplicate"; key: string; generation: number; sessionId: string | null; reason: "launch-in-flight" | "session-active" | "closing" }
  | { kind: "stale"; key: string; generation: number };

/**
 * Coordinates launches per service so a repeated launch event while a launch
 * is in flight or a session is active can never spawn a duplicate. Launches
 * are idempotent: keyed by `service#generation`; a stale generation (≤ the
 * last issued one) is rejected, never replayed. The native layer remains the
 * authoritative duplicate guard (adoption of the active launch).
 */
export class SessionLaunchCoordinator {
  private machines = new Map<string, SessionLifecycleMachine>();
  private lastKey = new Map<string, string>();
  private readonly pending = new Set<string>();

  machineFor(service: string): SessionLifecycleMachine {
    let machine = this.machines.get(service);
    if (!machine) {
      machine = new SessionLifecycleMachine(service);
      this.machines.set(service, machine);
    }
    return machine;
  }

  requestLaunch(service: string, generation?: number, atMs: number = Date.now()): LaunchDecision {
    const machine = this.machineFor(service);
    if (this.pending.has(service) || machine.state === "launching" || machine.state === "closing") {
      // A launch is in flight (or a close is pending): a repeated launch event
      // is a duplicate — no second IPC, no second spawn.
      const key = this.lastKey.get(service) ?? launchKey(service, machine.generation);
      const reason = machine.state === "closing" ? "closing" : "launch-in-flight";
      return { kind: "duplicate", key, generation: machine.generation, sessionId: machine.sessionId, reason };
    }
    if (machine.state === "active") {
      // Session already active: idempotent adopt — same key, same generation,
      // no new transition. The caller may still call native, which adopts the
      // existing window instead of spawning a duplicate.
      const key = this.lastKey.get(service) ?? launchKey(service, machine.generation);
      return { kind: "adopt", key, generation: machine.generation, sessionId: machine.sessionId };
    }
    const next = generation ?? machine.generation + 1;
    if (generation !== undefined && next <= machine.generation) {
      return { kind: "stale", key: launchKey(service, generation), generation };
    }
    machine.generation = next;
    const key = launchKey(service, next);
    machine.transition("launchRequested", atMs, null);
    this.lastKey.set(service, key);
    return { kind: "launch", key, generation: next, sessionId: machine.sessionId };
  }

  /** Holds the same-service reservation until either launch or adoption IPC settles. */
  async runLaunch(service: string, launch: () => Promise<string | null>): Promise<LaunchDecision> {
    const decision = this.requestLaunch(service);
    if (decision.kind === "duplicate" || decision.kind === "stale") return decision;

    this.pending.add(service);
    try {
      this.noteLaunched(service, await launch());
    } catch (cause) {
      // An adoption can fail to foreground an existing native window. Keep the
      // known session eligible for another focus attempt.
      if (decision.kind === "launch") this.failLaunch(service);
      throw cause;
    } finally {
      this.pending.delete(service);
    }
    return decision;
  }

  /**
   * Records the native receipt's launch id. A successful native launch means
   * the window was spawned or adopted, so the machine moves to active; the
   * watcher later confirms foreground via receipts/events.
   */
  noteLaunched(service: string, sessionId: string | null, atMs: number = Date.now()): void {
    const machine = this.machineFor(service);
    if (sessionId) {
      machine.sessionId = sessionId;
      machine.transition("launchProgress", atMs, sessionId);
      machine.transition("processReady", atMs);
    } else if (machine.state === "launching") {
      // Older receipts can confirm dispatch without identifying a tracked window.
      // Leave the next attempt to the native duplicate guard.
      machine.transition("reset", atMs);
    }
  }

  /** A failed launch moves the machine to error (truthful diagnostic). */
  failLaunch(service: string, atMs: number = Date.now()): void {
    this.machineFor(service).transition("launchFailed", atMs);
  }

  /** Exit/crash observed via read-only markers/events moves the machine to its terminal state. */
  noteExit(service: string, crashed: boolean, atMs: number = Date.now()): void {
    const machine = this.machineFor(service);
    machine.transition(crashed ? "crashObserved" : "exitObserved", atMs);
  }

  /** Syncs machines from a native snapshot (bounded read result). */
  syncFromSnapshot(snapshot: ManagedSessionsSnapshot): void {
    const seen = new Set<string>();
    for (const session of snapshot.sessions) {
      const key = session.launchId ?? session.appId;
      if (!key) continue;
      seen.add(key);
      const machine = this.machineFor(key);
      machine.sessionId = session.sessionId;
      if (typeof session.generation === "number" && Number.isFinite(session.generation)) {
        machine.generation = Math.max(machine.generation, Math.trunc(session.generation));
      }
      const lifecycle = safeLifecycleState(session.lifecycle ?? session.state);
      // Map the richer native state onto the shared machine when no lifecycle
      // field is present: unavailable stays a tracked-but-unconfirmed active.
      const target: SessionLifecycleState =
        session.lifecycle !== undefined
          ? lifecycle
          : session.state === "exited" ? "exited"
          : session.state === "failed" ? "error"
          : session.state === "launching" ? "launching"
          : session.state === "notRunning" ? "idle"
          : "active";
      machine.state = target;
    }
    // Services with no live session drop back to idle unless a launch is in flight.
    for (const [service, machine] of this.machines) {
      if (!seen.has(service) && machine.state !== "launching" && machine.state !== "closing") {
        machine.state = "exited";
      }
    }
  }
}

/** Strict parser for one wire receipt; never throws, never trusts fields. */
export function normalizeSessionReceipt(value: unknown): SessionTransitionReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const wire = value as Record<string, unknown>;
  const seq = wire["seq"];
  const sessionId = wire["sessionId"];
  const atMs = wire["atMs"];
  const cause = safeLifecycleEvent(wire["cause"]);
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 0) return null;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) return null;
  if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0) return null;
  if (!cause) return null;
  return {
    seq: Math.trunc(seq),
    sessionId,
    from: safeLifecycleState(wire["from"]),
    to: safeLifecycleState(wire["to"]),
    cause,
    atMs,
  };
}

/** Parses a bounded list of wire receipts (newest entries kept, capped). */
export function normalizeSessionReceipts(value: unknown, limit: number = MAX_SESSION_RECEIPTS): SessionTransitionReceipt[] {
  if (!Array.isArray(value)) return [];
  const parsed = value
    .map(normalizeSessionReceipt)
    .filter((receipt): receipt is SessionTransitionReceipt => receipt !== null);
  return parsed.slice(-Math.max(1, limit));
}

/** Truthful Polish labels for receipt causes (mirror of Rust `lifecycle_cause_label`). */
export function lifecycleCauseLabel(cause: LifecycleEvent): string {
  switch (cause) {
    case "launchRequested": return "uruchomienie rozpoczęte przez VELORA";
    case "launchProgress": return "proces zaobserwowany; okno niepotwierdzone na pierwszym planie";
    case "processReady": return "okno potwierdzone na pierwszym planie przez rejestr";
    case "closingObserved": return "proces lub okno zniknęło; trwa okres karencji przed zakończeniem";
    case "closeRequested": return "przyjęto potwierdzone żądanie zamknięcia okna";
    case "exitObserved": return "aplikacja zakończyła sesję sama (zamknięcie okna/procesu)";
    case "crashObserved": return "sesja zakończona nieoczekiwanie (możliwy crash; PID mógł zostać ponownie użyty)";
    case "launchFailed": return "uruchomienie nie powiodło się";
    case "superseded": return "sesja zastąpiona nowszym uruchomieniem tej usługi";
    case "cancelled": return "uruchomienie anulowane";
    case "reset": return "stan sesji zresetowany po odzyskaniu po restarcie VELORA";
  }
}

/**
 * EXPLICIT LIMITATION (DRM boundary): VELORA never reads, persists or restores
 * provider playback state for Netflix, YouTube, Disney+, Prime Video or Max.
 * Media control is a blind toggle (Space/K) with no readback; when an
 * accessibility/readback API is unavailable the truthful state is "unknown".
 */
export const PLAYBACK_STATE_LIMITATION =
  "VELORA nie odczytuje ani nie przywraca stanu odtwarzania dostawcy (granica DRM); sterowanie multimediami to ślepy przełącznik, a przy braku API stan pozostaje nieznany.";
