/**
 * VELORA 3.0 S3.4 — bounded retry policy (fail-closed).
 *
 * Rules, in order:
 *  1. AMBIGUOUS failures (timeout / unknown outcome — the request may have
 *     reached the other side) are NEVER blindly retried. The caller gets
 *     `outcome: "unknown"` and must ask for explicit re-confirmation.
 *  2. Only idempotent / read-only / server-deduped operations may be retried
 *     at all (`idempotent: true` must be passed explicitly).
 *  3. Retries are bounded by `maxAttempts` (default 3) with exponential
 *     backoff + jitter, capped at `maxMs`.
 *
 * The policy is pure and injectable (clock, wait, random) so it is
 * deterministic under test. It never swallows errors: every failure path
 * returns the original error to the caller.
 */

export type RetryFailureKind = "never-reached" | "ambiguous";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_MS = 200;
export const DEFAULT_MAX_MS = 1_600;
/** Fraction of the backoff that is randomized ("equal jitter"). */
export const DEFAULT_JITTER_FRACTION = 0.5;

export interface RetryPlanInput {
  failureKind: RetryFailureKind | string;
  /** Number of retries already performed for this operation (0-based). */
  attempt: number;
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Must be true for the operation to be retryable at all. */
  idempotent?: boolean;
  jitterFraction?: number;
  random?: () => number;
}

export type RetryPlan =
  | { retry: true; delayMs: number; attempt: number }
  | { retry: false; outcome: "unknown" }
  | { retry: false; outcome: "not-retryable" }
  | { retry: false; outcome: "exhausted" };

function clampNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Exponential backoff with jitter, capped at `maxMs`. With the default
 * "equal jitter" the delay lies in [backoff * (1 - j), backoff], so it is
 * always >= half the deterministic backoff and never above the cap.
 * `random` is injectable for deterministic tests.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number = DEFAULT_BASE_MS,
  maxMs: number = DEFAULT_MAX_MS,
  jitterFraction: number = DEFAULT_JITTER_FRACTION,
  random: () => number = Math.random,
): number {
  const base = clampNonNegative(baseMs, DEFAULT_BASE_MS);
  const cap = clampNonNegative(maxMs, DEFAULT_MAX_MS);
  const jitter = Math.min(1, Math.max(0, Number.isFinite(jitterFraction) ? jitterFraction : DEFAULT_JITTER_FRACTION));
  const a = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const shift = Math.min(a, 30);
  const backoff = Math.min(base * 2 ** shift, cap);
  const roll = typeof random === "function" ? random() : 0;
  const jitterSpan = backoff * jitter;
  const jittered = backoff - jitterSpan + Math.min(1, Math.max(0, roll)) * jitterSpan;
  return Math.max(0, Math.min(cap, jittered));
}

/**
 * The single decision point. Ambiguous => "unknown" and never a retry;
 * non-idempotent => "not-retryable"; budget exhausted => "exhausted"; only a
 * provably never-reached failure of an idempotent operation within budget
 * yields `retry: true` with a bounded, jittered delay.
 */
export function planRetry(input: RetryPlanInput): RetryPlan {
  const maxAttempts = Math.max(1, Math.floor(clampNonNegative(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS)));
  const attempt = Number.isFinite(input.attempt) ? Math.max(0, Math.floor(input.attempt)) : 0;
  if (input.failureKind === "ambiguous") {
    return { retry: false, outcome: "unknown" };
  }
  if (input.failureKind !== "never-reached") {
    // Fail closed: an unrecognized failure kind is treated as ambiguous.
    return { retry: false, outcome: "unknown" };
  }
  if (input.idempotent !== true) {
    return { retry: false, outcome: "not-retryable" };
  }
  if (attempt >= maxAttempts) {
    return { retry: false, outcome: "exhausted" };
  }
  return {
    retry: true,
    attempt,
    delayMs: backoffDelayMs(
      attempt,
      clampNonNegative(input.baseMs ?? DEFAULT_BASE_MS, DEFAULT_BASE_MS),
      clampNonNegative(input.maxMs ?? DEFAULT_MAX_MS, DEFAULT_MAX_MS),
      input.jitterFraction ?? DEFAULT_JITTER_FRACTION,
      input.random ?? Math.random,
    ),
  };
}

export interface RunWithRetryOptions<T> {
  operation: (attempt: number) => Promise<T>;
  /** Classifies a thrown failure; "ambiguous" is never retried. */
  classify: (cause: unknown, attempt: number) => RetryFailureKind | string;
  /** The operation must be idempotent/read-only/server-deduped to be retried. */
  idempotent: boolean;
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  wait?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number }) => void;
}

export type RunWithRetryResult<T> =
  | { status: "success"; value: T; attempts: number }
  | { status: "unknown"; error: unknown; attempts: number }
  | { status: "failed"; error: unknown; attempts: number };

/**
 * Runs `operation` under the bounded policy. `attempts` counts real executions
 * (1 = no retry happened). An ambiguous failure resolves as
 * `{ status: "unknown" }` with the original error — never a blind retry, and
 * the error is never swallowed.
 */
export async function runWithRetry<T>(options: RunWithRetryOptions<T>): Promise<RunWithRetryResult<T>> {
  const maxAttempts = Math.max(1, Math.floor(clampNonNegative(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS)));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  while (true) {
    try {
      const value = await options.operation(attempt);
      return { status: "success", value, attempts: attempt + 1 };
    } catch (error) {
      const kind = options.classify(error, attempt);
      const plan = planRetry({
        failureKind: kind,
        attempt,
        maxAttempts,
        baseMs: options.baseMs,
        maxMs: options.maxMs,
        idempotent: options.idempotent,
        random: options.random,
      });
      if (plan.retry) {
        attempt += 1;
        options.onRetry?.({ attempt, delayMs: plan.delayMs });
        await wait(plan.delayMs);
        continue;
      }
      if (plan.outcome === "unknown") {
        return { status: "unknown", error, attempts: attempt + 1 };
      }
      return { status: "failed", error, attempts: attempt + 1 };
    }
  }
}
