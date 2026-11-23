import type { RecoveryReason, SessionRecovery } from "./sessionOrchestrator";

/**
 * Text for the one-time notice shown after VELORA restarts.
 *
 * The native side reports recovery in the session snapshot (`get_session_state`).
 * It also emits a `velora-session-recovery` event during setup, but that event
 * fires before the WebView exists and cannot be received, so the UI reads the
 * snapshot instead. Returns null when there is nothing to report.
 */
export function startupRecoveryNotice(recovery: SessionRecovery | null | undefined): string | null {
  if (!recovery) return null;
  const message = recovery.message.trim();
  return message.length > 0 ? message : null;
}

/** Truthful Polish label for a crash/restart recovery reason (mirror of Rust `recovery_reason_label`). */
export function recoveryCauseLabel(reason: RecoveryReason | null | undefined): string {
  switch (reason) {
    case "unexpectedExit": return "nieoczekiwane zakończenie poprzedniego procesu VELORA";
    case "cleanRestart": return "czysty restart VELORA";
    case "corruptState": return "uszkodzony zapisany stan sesji";
    case "orphanedLaunch": return "osierocony kontekst uruchomienia";
    default: return "nieznana przyczyna odzyskania stanu";
  }
}
