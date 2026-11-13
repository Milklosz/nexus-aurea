/**
 * Rejects if `task` does not settle within `ms`. The late result of a timed-out task is
 * dropped by the caller's request guards; this only frees the UI so it can report the
 * failure and offer a retry instead of waiting forever.
 */
export function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label}: brak odpowiedzi w ciągu ${ms} ms`)), ms);
  });
  return Promise.race([task, timeout]).finally(() => window.clearTimeout(timer));
}

/** How long a Windows or iPhone Remote status read may take before the panel reports it failed. */
export const STATUS_READ_TIMEOUT_MS = 8_000;
