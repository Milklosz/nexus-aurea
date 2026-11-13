import type { SessionRecovery } from "./sessionOrchestrator";

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
