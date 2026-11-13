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
