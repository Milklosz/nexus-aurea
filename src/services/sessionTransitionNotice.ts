import type { LifecycleEvent } from "./veloraSessionManager";
import { lifecycleCauseLabel, PLAYBACK_STATE_LIMITATION } from "./veloraSessionManager";

const FALLBACK_NOTICE = "Nie udało się zmienić sesji VELORA. Wróć do ekranu głównego i spróbuj ponownie.";

/**
 * Toast text for a session transition that the native side rejected.
 *
 * The native error carries a human-readable `message`. Anything else (a closed
 * IPC channel, an unexpected value) gets a generic notice, so the user always
 * learns that the session did not change.
 */
export function sessionTransitionFailureNotice(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return `Nie udało się zmienić sesji VELORA: ${message.trim()}`;
    }
  }
  return FALLBACK_NOTICE;
}

/**
 * Truthful diagnostic shown when a managed session exits or crashes. The
 * cause comes from the native transition receipt (read-only markers/events —
 * VELORA never kills processes or enumerates windows to detect this). An
 * unrecognized cause is reported as "unknown", never guessed, and the notice
 * never claims anything about provider playback state.
 */
export function sessionExitNotice(cause: string | null | undefined, lastError: string | null | undefined): string {
  const known = typeof cause === "string" ? (lifecycleCauseLabel(cause as LifecycleEvent) ?? null) : null;
  const base = known ?? "Przyczyna zakończenia sesji jest nieznana — VELORA zna tylko własny rejestr uruchomień.";
  const error = typeof lastError === "string" ? lastError.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240) : "";
  const suffix = error.length > 0 ? ` Szczegóły: ${error}` : "";
  return `${base}.${suffix} ${PLAYBACK_STATE_LIMITATION}`;
}

export { PLAYBACK_STATE_LIMITATION };
