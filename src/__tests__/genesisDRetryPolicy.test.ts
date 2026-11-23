import { describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  planRetry,
  runWithRetry,
  DEFAULT_BASE_MS,
  DEFAULT_JITTER_FRACTION,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_MS,
} from "../services/retryPolicy";

describe("retryPolicy backoff bounds and jitter", () => {
  it("delay stays within [backoff*(1-jitter), backoff] and is capped", () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const backoff = Math.min(DEFAULT_BASE_MS * 2 ** attempt, DEFAULT_MAX_MS);
      const low = backoff * (1 - DEFAULT_JITTER_FRACTION);
      for (const roll of [0, 0.25, 0.5, 0.999, 1]) {
        const delay = backoffDelayMs(attempt, DEFAULT_BASE_MS, DEFAULT_MAX_MS, DEFAULT_JITTER_FRACTION, () => roll);
        expect(delay).toBeGreaterThanOrEqual(low - 1e-9);
        expect(delay).toBeLessThanOrEqual(backoff + 1e-9);
        expect(delay).toBeLessThanOrEqual(DEFAULT_MAX_MS);
      }
    }
  });

  it("is capped at maxMs for very large attempts and never negative", () => {
    expect(backoffDelayMs(60, 200, 1_600)).toBeLessThanOrEqual(1_600);
    expect(backoffDelayMs(0, 0, 1_600, 0.5, () => 0)).toBe(0);
    expect(backoffDelayMs(-5, 200, 1_600, 0.5, () => 1)).toBeGreaterThanOrEqual(0);
  });

  it("respects a configurable base/max", () => {
    const delay = backoffDelayMs(2, 100, 500, 0.5, () => 1);
    expect(delay).toBe(400); // backoff = 100 * 2^2 = 400, full jitter
    expect(backoffDelayMs(10, 100, 500, 0.5, () => 1)).toBe(500);
  });
});

describe("planRetry decision table", () => {
  it("NEVER retries an ambiguous failure — returns unknown", () => {
    for (const attempt of [0, 1, 2, 99]) {
      const plan = planRetry({ failureKind: "ambiguous", attempt, idempotent: true });
      expect(plan.retry).toBe(false);
      expect(plan).toEqual({ retry: false, outcome: "unknown" });
    }
  });

  it("treats an unrecognized failure kind as ambiguous (fail closed)", () => {
    expect(planRetry({ failureKind: "weird", attempt: 0, idempotent: true })).toEqual({
      retry: false,
      outcome: "unknown",
    });
  });

  it("never retries a non-idempotent operation even when never-reached", () => {
    expect(planRetry({ failureKind: "never-reached", attempt: 0, idempotent: false })).toEqual({
      retry: false,
      outcome: "not-retryable",
    });
    expect(planRetry({ failureKind: "never-reached", attempt: 0 })).toEqual({
      retry: false,
      outcome: "not-retryable",
    });
  });

  it("retries never-reached failures of idempotent operations within budget, with a bounded delay", () => {
    const plan = planRetry({ failureKind: "never-reached", attempt: 1, maxAttempts: 3, idempotent: true, random: () => 0.5 });
    expect(plan.retry).toBe(true);
    if (plan.retry) {
      const backoff = DEFAULT_BASE_MS * 2;
      expect(plan.delayMs).toBeGreaterThanOrEqual(backoff * (1 - DEFAULT_JITTER_FRACTION));
      expect(plan.delayMs).toBeLessThanOrEqual(backoff);
      expect(plan.attempt).toBe(1);
    }
  });

  it("stops at maxAttempts (exhausted) and honors a configurable budget", () => {
    expect(planRetry({ failureKind: "never-reached", attempt: DEFAULT_MAX_ATTEMPTS, idempotent: true }))
      .toEqual({ retry: false, outcome: "exhausted" });
    const plan = planRetry({ failureKind: "never-reached", attempt: 4, maxAttempts: 5, idempotent: true });
    expect(plan.retry).toBe(true);
    expect(planRetry({ failureKind: "never-reached", attempt: 5, maxAttempts: 5, idempotent: true }))
      .toEqual({ retry: false, outcome: "exhausted" });
  });
});

describe("runWithRetry", () => {
  it("returns success without retrying when the operation succeeds first", async () => {
    const operation = vi.fn(async () => "ok");
    const result = await runWithRetry({
      operation,
      classify: () => "never-reached",
      idempotent: true,
      wait: async () => {},
    });
    expect(result).toEqual({ status: "success", value: "ok", attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries never-reached failures with backoff and then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await runWithRetry({
      operation: async () => {
        calls += 1;
        if (calls < 3) throw new Error("connect refused");
        return "done";
      },
      classify: () => "never-reached",
      idempotent: true,
      maxAttempts: 3,
      random: () => 0.5,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result.status).toBe("success");
    expect(result.attempts).toBe(3);
    expect(waits.length).toBe(2);
    for (const delay of waits) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(DEFAULT_MAX_MS);
    }
  });

  it("NEVER retries an ambiguous failure: status unknown, error preserved, one execution", async () => {
    const failure = new Error("timeout after send");
    const operation = vi.fn(async () => {
      throw failure;
    });
    const result = await runWithRetry({
      operation,
      classify: () => "ambiguous",
      idempotent: true,
      wait: async () => {
        throw new Error("wait must not be called for ambiguous failures");
      },
    });
    expect(result.status).toBe("unknown");
    expect(result).toMatchObject({ error: failure, attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-idempotent operations and never swallows the error", async () => {
    const failure = new Error("boom");
    const operation = vi.fn(async () => {
      throw failure;
    });
    const result = await runWithRetry({
      operation,
      classify: () => "never-reached",
      idempotent: false,
      wait: async () => {},
    });
    expect(result).toEqual({ status: "failed", error: failure, attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("is bounded by maxAttempts and reports the exhausted failure", async () => {
    const failure = new Error("dns");
    const operation = vi.fn(async () => {
      throw failure;
    });
    const result = await runWithRetry({
      operation,
      classify: () => "never-reached",
      idempotent: true,
      maxAttempts: 2,
      wait: async () => {},
    });
    expect(result).toEqual({ status: "failed", error: failure, attempts: 3 });
    expect(operation).toHaveBeenCalledTimes(3); // 1 initial + 2 bounded retries
  });
});
