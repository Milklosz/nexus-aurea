/**
 * Whether a window `focus` event should move navigation focus back to the dock.
 *
 * Not while a modal overlay owns focus. Control Center and diagnostics are
 * modal `<dialog>` elements, so dock tiles behind them are inert: focusing
 * them does nothing visible, but it still changes which tile is highlighted
 * underneath the overlay. Any other open dialog counts as an overlay too.
 */
export function shouldRestoreDockFocus(state: {
  diagnosticsOpen: boolean;
  controlCenterOpen: boolean;
  dialogOpen: boolean;
}): boolean {
  return !state.diagnosticsOpen && !state.controlCenterOpen && !state.dialogOpen;
}

// ---------------------------------------------------------------------------
// Ascension B: session-selection restore on VELORA focus-regain
// ---------------------------------------------------------------------------

type SessionSelectionLike = {
  sessionId: string;
  state: string;
  lastActivationAtMs?: number | null;
  launchedAtMs?: number;
};

export type SessionSelectionRestore =
  | { action: "restore"; sessionId: string; changed: boolean }
  | { action: "keep"; sessionId: string | null }
  | { action: "clear"; reason: "sessionEnded" | "noneActive" };

const ACTIVE_SELECTION_STATES: readonly string[] = ["launching", "running", "foreground", "background", "active"];

function selectionIsActive(session: SessionSelectionLike): boolean {
  return ACTIVE_SELECTION_STATES.includes(session.state);
}

/**
 * Decides which session row stays selected when VELORA regains window focus.
 *
 * - While a modal overlay is open the selection is left untouched (focus must
 *   not move underneath an overlay).
 * - If the selected session is still active, it stays selected ("restore").
 * - If the selected session exited/failed, the most recently active remaining
 *   session is selected instead; when none is active the selection clears.
 *
 * This restores the *selection* only. Restoring the OS foreground window of a
 * managed session is a separate, best-effort native action that Windows may
 * deny (foreground lock) — VELORA never forces it.
 */
export function resolveSessionSelectionOnFocusRegain(input: {
  sessions: readonly SessionSelectionLike[];
  selectedSessionId: string | null;
  overlayOpen: boolean;
}): SessionSelectionRestore {
  if (input.overlayOpen) return { action: "keep", sessionId: input.selectedSessionId };
  const selected = input.selectedSessionId
    ? input.sessions.find((session) => session.sessionId === input.selectedSessionId)
    : undefined;
  if (selected && selectionIsActive(selected)) {
    return { action: "restore", sessionId: selected.sessionId, changed: false };
  }
  if (selected && !selectionIsActive(selected)) {
    const fallback = [...input.sessions]
      .filter(selectionIsActive)
      .sort((a, b) => (b.lastActivationAtMs ?? b.launchedAtMs ?? 0) - (a.lastActivationAtMs ?? a.launchedAtMs ?? 0))[0];
    if (fallback) return { action: "restore", sessionId: fallback.sessionId, changed: true };
    return { action: "clear", reason: "sessionEnded" };
  }
  // No selection yet: pick the most recently active session, else keep none.
  const fallback = [...input.sessions]
    .filter(selectionIsActive)
    .sort((a, b) => (b.lastActivationAtMs ?? b.launchedAtMs ?? 0) - (a.lastActivationAtMs ?? a.launchedAtMs ?? 0))[0];
  if (fallback) return { action: "restore", sessionId: fallback.sessionId, changed: input.selectedSessionId !== fallback.sessionId };
  if (input.selectedSessionId !== null) return { action: "clear", reason: "noneActive" };
  return { action: "keep", sessionId: null };
}

/** RestoreResult outcomes (mirror of Rust `RestoreOutcome`). */
export type FocusRestoreOutcome =
  | "restored"
  | "alreadyFocused"
  | "blockedUnsafeForeground"
  | "blockedByWindows"
  | "windowUnavailable"
  | "unsupportedPlatform";

/**
 * Truthful note for a focus-restore outcome. The Windows foreground lock is a
 * hard limitation: automatic foreground focus is never guaranteed and never
 * forced; an unexplained denial (including accessibility-API failure) is
 * reported as "unknown", never guessed.
 */
export function focusRegainOutcomeNote(outcome: FocusRestoreOutcome, denial?: string | null): string {
  switch (outcome) {
    case "restored":
      return "VELORA odzyskała fokus okna.";
    case "alreadyFocused":
      return "VELORA ma już fokus; nic nie trzeba było przełączać.";
    case "blockedByWindows":
      if (denial === "foregroundLock") {
        return "Windows zablokował automatyczny fokus (foreground lock) — VELORA go nie wymusza; użyj Alt+Tab.";
      }
      if (denial === "accessDenied") {
        return "Windows odmówił dostępu do fokusu (access denied) — użyj Alt+Tab.";
      }
      return "Windows odmówił fokusu z nieznanej przyczyny — stan nieznany; użyj Alt+Tab.";
    case "blockedUnsafeForeground":
      return "Przywrócenie fokusu zablokowane: na pierwszym planie jest aplikacja, której VELORA nie uruchomiła.";
    case "windowUnavailable":
      return "Okno VELORA jest chwilowo niedostępne; fokus nie został przywrócony.";
    case "unsupportedPlatform":
      return "Przywracanie fokusu nie jest dostępne na tej platformie.";
  }
}

// ---------------------------------------------------------------------------
// S3.4 reliability: bounded focus recovery on display/HDMI topology change
// ---------------------------------------------------------------------------

import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ExactlyOnceRecoveryGate } from "./focusOwnership";

/** Mirrors the native `velora-display-changed` event name (display_audio.rs). */
export const DISPLAY_CHANGED_EVENT = "velora-display-changed";

/** Shape of the native display-topology event the recovery reacts to. */
export interface DisplayTopologyChangeLike {
  displaySignature?: string | null;
  previousSignature?: string | null;
  atMs?: number;
}

export type TopologyRestoreDecision =
  | { action: "restore"; triggerId: string; restoreNumber: number }
  | { action: "skip"; reason: "same-signature" | "cooldown" | "budget-exhausted" | "restore-in-progress" | "no-signature" };

/** Hard bound on focus restores caused by topology changes — never a loop. */
export const TOPOLOGY_MAX_RESTORES = 3;
/** Minimum spacing between two topology-caused restores (HDMI flapping). */
export const TOPOLOGY_RESTORE_COOLDOWN_MS = 2_000;

export interface DisplayTopologyRecoveryOptions {
  restore: () => void | Promise<void>;
  maxRestores?: number;
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Re-runs focus restore EXACTLY ONCE per display-topology change, bounded:
 *
 * - a repeated event with the same display signature is skipped (the monitor
 *   can re-emit while nothing changed);
 * - each distinct signature may trigger at most one restore (exactly-once
 *   gate), and at most `maxRestores` restores happen in total;
 * - a cooldown spaces out restores so a flapping HDMI handshake cannot burst;
 * - a restore already in progress blocks re-entry, so the callback can never
 *   be re-entered or looped by its own effects.
 *
 * The Ascension exactly-once focus-owner recovery is preserved: this gate only
 * decides WHETHER a topology-triggered restore may run, never what it does.
 */
export class DisplayTopologyFocusRecovery {
  private readonly gate = new ExactlyOnceRecoveryGate(16);
  private readonly restore: () => void | Promise<void>;
  private readonly maxRestores: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private lastSignature: string | null = null;
  private lastRestoreAt = Number.NEGATIVE_INFINITY;
  private restoreCount = 0;
  private inProgress = false;

  constructor(options: DisplayTopologyRecoveryOptions) {
    this.restore = options.restore;
    this.maxRestores = Math.max(1, Math.floor(options.maxRestores ?? TOPOLOGY_MAX_RESTORES));
    this.cooldownMs = Math.max(0, options.cooldownMs ?? TOPOLOGY_RESTORE_COOLDOWN_MS);
    this.now = options.now ?? (() => Date.now());
  }

  get restoresTriggered(): number {
    return this.restoreCount;
  }

  get lastHandledSignature(): string | null {
    return this.lastSignature;
  }

  /**
   * Decides for one topology-change event. When the decision is "restore", the
   * restore callback is started once (asynchronously) and the in-progress
   * guard is released when it settles.
   */
  handleTopologyChange(change: DisplayTopologyChangeLike, nowMs?: number): TopologyRestoreDecision {
    const signature = typeof change.displaySignature === "string" && change.displaySignature.length > 0
      ? change.displaySignature
      : null;
    if (!signature) return { action: "skip", reason: "no-signature" };
    if (signature === this.lastSignature) return { action: "skip", reason: "same-signature" };
    const at = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : this.now();
    if (this.inProgress) return { action: "skip", reason: "restore-in-progress" };
    if (this.restoreCount >= this.maxRestores) return { action: "skip", reason: "budget-exhausted" };
    if (at - this.lastRestoreAt < this.cooldownMs) return { action: "skip", reason: "cooldown" };
    const triggerId = `topology:${signature}`;
    if (!this.gate.tryAcquire(triggerId)) return { action: "skip", reason: "budget-exhausted" };
    this.lastSignature = signature;
    this.lastRestoreAt = at;
    this.restoreCount += 1;
    this.inProgress = true;
    void Promise.resolve()
      .then(() => this.restore())
      .catch(() => {
        // The restore callback reports its own errors; the recovery never loops.
      })
      .finally(() => {
        this.inProgress = false;
      });
    return { action: "restore", triggerId, restoreNumber: this.restoreCount };
  }

  reset(): void {
    this.gate.reset();
    this.lastSignature = null;
    this.lastRestoreAt = Number.NEGATIVE_INFINITY;
    this.restoreCount = 0;
    this.inProgress = false;
  }
}

export type DisplayTopologyListen = (
  callback: (event: DisplayTopologyChangeLike) => void,
) => Promise<() => void> | (() => void);

/**
 * Wires `DisplayTopologyFocusRecovery` to the native display monitor event.
 * Uses `listen()` only inside Tauri; in a browser preview it returns a no-op
 * unlisten (safe fallback, no listener is created). The returned function
 * removes the listener, so nothing leaks across sessions.
 */
export function attachDisplayTopologyRecovery(
  options: DisplayTopologyRecoveryOptions & { listenFn?: DisplayTopologyListen },
): () => void {
  const recovery = new DisplayTopologyFocusRecovery(options);
  if (!isTauri()) return () => {};
  const listenFn: DisplayTopologyListen =
    options.listenFn ??
    ((callback) => listen<DisplayTopologyChangeLike>(DISPLAY_CHANGED_EVENT, (event) => callback(event.payload)));
  let disposed = false;
  let unlisten: (() => void) | null = null;
  const attach = async (): Promise<void> => {
    const stop = await listenFn((event) => {
      // Events arriving after dispose are ignored: no listener, no restore.
      if (!disposed) recovery.handleTopologyChange(event);
    });
    if (disposed) {
      stop();
      return;
    }
    unlisten = stop;
  };
  void attach();
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
