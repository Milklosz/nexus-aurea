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
