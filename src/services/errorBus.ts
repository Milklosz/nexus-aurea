/**
 * VELORA 3.0 S3.4 — bounded in-memory error ring buffer.
 *
 * Recent errors are aggregated here so a diagnostics panel can surface them,
 * and so NO error is ever swallowed silently: every reported error is stored
 * (bounded ring — the oldest entry is evicted and counted) and every
 * listener is notified synchronously. `reportError` never throws.
 *
 * Messages are sanitized (control characters stripped, length capped) and
 * never contain secrets: callers pass only an already-safe message or error.
 */

export interface ErrorBusEntry {
  seq: number;
  atMs: number;
  source: string;
  message: string;
}

export interface ErrorBusSnapshot {
  size: number;
  capacity: number;
  evicted: number;
  lastSeq: number;
  listeners: number;
}

/** Maximum number of retained error entries (ring buffer). */
export const ERROR_BUS_CAPACITY = 64;
/** Maximum stored message length. */
export const ERROR_MESSAGE_MAX_LENGTH = 240;

export type ErrorBusListener = (entry: ErrorBusEntry) => void;

const entries: ErrorBusEntry[] = [];
const listeners = new Set<ErrorBusListener>();
let evictedCount = 0;
let lastSeq = 0;

function nowMs(): number {
  return typeof Date !== "undefined" && Date.now ? Date.now() : 0;
}

/** Sanitizes an arbitrary thrown value into a short, control-free string. */
export function sanitizeErrorMessage(error: unknown, maxLength: number = ERROR_MESSAGE_MAX_LENGTH): string {
  let raw: string;
  if (typeof error === "string") raw = error;
  else if (error instanceof Error) raw = `${error.name}: ${error.message}`;
  else if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    raw = typeof message === "string" ? message : String(message ?? error);
  } else {
    raw = String(error);
  }
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function boundedSource(source: string): string {
  const cleaned = typeof source === "string" ? source.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return cleaned.slice(0, 64) || "unknown";
}

/**
 * Records one error. ALWAYS stores it (bounded) and notifies listeners; never
 * throws, never drops silently — eviction is counted in the snapshot.
 */
export function reportError(source: string, error: unknown, atMs: number = nowMs()): ErrorBusEntry {
  lastSeq += 1;
  const entry: ErrorBusEntry = {
    seq: lastSeq,
    atMs: Number.isFinite(atMs) && atMs >= 0 ? atMs : 0,
    source: boundedSource(source),
    message: sanitizeErrorMessage(error),
  };
  entries.push(entry);
  while (entries.length > ERROR_BUS_CAPACITY) {
    entries.shift();
    evictedCount += 1;
  }
  for (const listener of [...listeners]) {
    try {
      listener(entry);
    } catch {
      // A broken listener must never break reporting for the others.
    }
  }
  return entry;
}

/** Newest-last list of retained entries, optionally limited. */
export function getRecentErrors(limit: number = ERROR_BUS_CAPACITY): ErrorBusEntry[] {
  const max = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : ERROR_BUS_CAPACITY));
  return entries.slice(-max);
}

/** Subscribes to new entries; returns the unsubscribe function. */
export function subscribeToErrorBus(listener: ErrorBusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Number of active listeners — used by soak tests to prove no listener leaks. */
export function errorBusListenerCount(): number {
  return listeners.size;
}

export function getErrorBusSnapshot(): ErrorBusSnapshot {
  return {
    size: entries.length,
    capacity: ERROR_BUS_CAPACITY,
    evicted: evictedCount,
    lastSeq,
    listeners: listeners.size,
  };
}

/** Test helper: clears the ring (does not touch any native state). */
export function clearErrorBus(): void {
  entries.length = 0;
  evictedCount = 0;
  lastSeq = 0;
}
