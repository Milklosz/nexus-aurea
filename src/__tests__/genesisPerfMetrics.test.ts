import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { clearErrorBus, getErrorBusSnapshot, getRecentErrors } from "../services/errorBus";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(async (): Promise<unknown> => ({ ok: true })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: mocks.isTauri,
  invoke: mocks.invoke,
}));

import {
  MAX_SAMPLES_PER_COMMAND,
  commandHistogram,
  countRender,
  getPerfSnapshot,
  getRenderCounts,
  getStartupTiming,
  measureInvoke,
  measureInvokeOr,
  percentile,
  recordCommandLatency,
  resetPerfMetrics,
} from "../services/perfMetrics";

beforeEach(() => {
  resetPerfMetrics();
  clearErrorBus();
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async () => ({ ok: true }));
});

afterEach(() => {
  resetPerfMetrics();
  clearErrorBus();
  vi.restoreAllMocks();
});

describe("perfMetrics percentile and histogram", () => {
  it("percentile is nearest-rank over a sorted copy and 0 when empty", () => {
    expect(percentile([], 50)).toBe(0);
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
  });

  it("records latency samples and computes count/p50/p95/max per command", () => {
    for (const value of [10, 20, 30, 40, 100]) recordCommandLatency("get_session_state", value);
    recordCommandLatency("get_diagnostics_snapshot", 5);
    const histograms = commandHistogram();
    const byName = Object.fromEntries(histograms.map((h) => [h.command, h]));
    expect(byName["get_session_state"]).toEqual({
      command: "get_session_state",
      count: 5,
      p50Ms: 30,
      p95Ms: 100,
      maxMs: 100,
      droppedSamples: 0,
    });
    expect(byName["get_diagnostics_snapshot"].count).toBe(1);
    expect(commandHistogram("get_session_state")).toHaveLength(1);
    expect(commandHistogram("missing")).toHaveLength(0);
  });

  it("bounds the sample ring per command and counts dropped samples truthfully", () => {
    for (let index = 0; index < MAX_SAMPLES_PER_COMMAND + 25; index += 1) {
      recordCommandLatency("cmd", index);
    }
    const [histogram] = commandHistogram("cmd");
    expect(histogram.count).toBe(MAX_SAMPLES_PER_COMMAND);
    expect(histogram.droppedSamples).toBe(25);
    expect(histogram.maxMs).toBe(MAX_SAMPLES_PER_COMMAND + 24);
  });

  it("ignores invalid samples (unknown command, negative/non-finite latency)", () => {
    recordCommandLatency("", 10);
    recordCommandLatency("cmd", -1);
    recordCommandLatency("cmd", Number.NaN);
    expect(commandHistogram()).toHaveLength(0);
  });
});

describe("perfMetrics startup timing (read-only)", () => {
  it("reports the app-entry timestamp and never fabricates paint entries", () => {
    const startup = getStartupTiming();
    expect(typeof startup.appEntryPerfMs).toBe("number");
    expect(startup.appEntryPerfMs).toBeGreaterThanOrEqual(0);
    for (const field of [startup.navigationStartMs, startup.domContentLoadedMs, startup.loadEventMs, startup.timeToFirstRenderMs]) {
      expect(field === null || (typeof field === "number" && Number.isFinite(field))).toBe(true);
    }
  });
});

describe("perfMetrics measureInvoke wrapper", () => {
  it("measures and records a successful invoke latency", async () => {
    mocks.invoke.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { value: 42 };
    });
    const result = await measureInvoke<{ value: number }>("get_session_state");
    expect(result).toEqual({ value: 42 });
    const [histogram] = commandHistogram("get_session_state");
    expect(histogram.count).toBe(1);
    expect(histogram.maxMs).toBeGreaterThanOrEqual(0);
    expect(histogram.p50Ms).toBe(histogram.maxMs);
  });

  it("rethrows the original error, still records latency, and reports to the error bus", async () => {
    const failure = new Error("ipc down");
    mocks.invoke.mockRejectedValue(failure);
    await expect(measureInvoke("get_session_state")).rejects.toBe(failure);
    expect(commandHistogram("get_session_state")).toHaveLength(1);
    const bus = getRecentErrors();
    expect(bus.some((entry) => entry.source === "invoke:get_session_state" && entry.message.includes("ipc down"))).toBe(true);
  });

  it("in a browser preview measureInvoke throws truthfully and measureInvokeOr returns the fallback without invoking", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(measureInvoke("get_session_state")).rejects.toThrow(/Tauri/);
    expect(mocks.invoke).not.toHaveBeenCalled();
    const fallback = { supported: false, sessions: [], applications: [] };
    const result = await measureInvokeOr("get_managed_sessions", fallback);
    expect(result).toBe(fallback);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(commandHistogram()).toHaveLength(0);
  });
});

describe("perfMetrics dev-only render counter and snapshot", () => {
  it("counts renders only when enabled (dev)", () => {
    expect(countRender("Home", true)).toBe(1);
    expect(countRender("Home", true)).toBe(2);
    expect(countRender("Home", false)).toBe(0);
    expect(getRenderCounts()).toEqual({ Home: 2 });
  });

  it("exposes a plain-numbers snapshot for diagnostics", async () => {
    recordCommandLatency("cmd", 12);
    countRender("Panel", true);
    const snapshot = getPerfSnapshot();
    expect(snapshot.sampleCap).toBe(MAX_SAMPLES_PER_COMMAND);
    expect(snapshot.commands["cmd"]).toEqual({ count: 1, p50Ms: 12, p95Ms: 12, maxMs: 12, droppedSamples: 0 });
    expect(snapshot.renderCounts).toEqual({ Panel: 1 });
    expect(typeof snapshot.startup.appEntryPerfMs).toBe("number");
    expect(getErrorBusSnapshot().size).toBe(0);
  });
});
