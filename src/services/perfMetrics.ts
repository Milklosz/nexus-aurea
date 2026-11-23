import { invoke, isTauri } from "@tauri-apps/api/core";
import { reportError } from "./errorBus";

/**
 * VELORA 3.0 S3.4 — READ-ONLY performance instrumentation (MEASURE FIRST).
 *
 * Everything here only OBSERVES: no polling loops, no timers, no writes to
 * native state. Numbers are exposed through `getPerfSnapshot()` so a
 * diagnostics panel can surface them as plain numbers. No performance claim
 * is made anywhere — only measured values are recorded.
 *
 * - startup latency: `performance.now()` captured at module load (app entry)
 *   plus the browser's own navigation/paint entries (read once, read-only);
 * - time-to-first-render: the `first-paint` / `first-contentful-paint` entries
 *   when the platform exposes them, otherwise `null` (never fabricated);
 * - `measureInvoke`: a thin wrapper around Tauri `invoke()` that records a
 *   per-command latency histogram (count / p50 / p95 / max) with a bounded
 *   sample ring per command;
 * - a dev-only React render counter (`countRender`).
 */

/** Upper bound of retained latency samples per command name. */
export const MAX_SAMPLES_PER_COMMAND = 256;

function nowPerf(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;
}

/** `performance.now()` at module load — the closest read-only proxy for app entry. */
const APP_ENTRY_PERF_MS = nowPerf();

export interface StartupTiming {
  appEntryPerfMs: number;
  /** Read-only navigation timing, when the platform exposes it. */
  navigationStartMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  /** `first-paint` or `first-contentful-paint`, when exposed; null otherwise. */
  timeToFirstRenderMs: number | null;
}

export interface CommandLatencyHistogram {
  command: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Samples dropped because the ring was full (bounded memory). */
  droppedSamples: number;
}

export interface PerfSnapshot {
  startup: StartupTiming;
  commands: Record<string, Omit<CommandLatencyHistogram, "command">>;
  renderCounts: Record<string, number>;
  sampleCap: number;
}

const samples = new Map<string, number[]>();
const dropped = new Map<string, number>();
const renderCounts = new Map<string, number>();

/** Nearest-rank percentile over an already-sorted ascending copy. */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.max(1, Math.ceil((clamped / 100) * sortedAscending.length));
  return sortedAscending[rank - 1];
}

/** Records one latency sample for a command (bounded ring). Never throws. */
export function recordCommandLatency(command: string, durationMs: number): void {
  if (typeof command !== "string" || command.length === 0 || command.length > 128) return;
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  let bucket = samples.get(command);
  if (!bucket) {
    bucket = [];
    samples.set(command, bucket);
  }
  if (bucket.length >= MAX_SAMPLES_PER_COMMAND) {
    // Bounded memory: drop the OLDEST sample, count the drop truthfully.
    bucket.shift();
    dropped.set(command, (dropped.get(command) ?? 0) + 1);
  }
  bucket.push(durationMs);
}

/** Histogram (count/p50/p95/max) for one command, or all commands. */
export function commandHistogram(command?: string): CommandLatencyHistogram[] {
  const names = command !== undefined ? [command] : [...samples.keys()];
  const result: CommandLatencyHistogram[] = [];
  for (const name of names) {
    const bucket = samples.get(name);
    if (!bucket || bucket.length === 0) continue;
    const sorted = [...bucket].sort((a, b) => a - b);
    result.push({
      command: name,
      count: bucket.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: sorted[sorted.length - 1],
      droppedSamples: dropped.get(name) ?? 0,
    });
  }
  return result;
}

/**
 * Reads the browser's own navigation/paint entries ONCE (read-only). Missing
 * entries are reported as `null` — a missing paint entry is never invented.
 */
export function getStartupTiming(): StartupTiming {
  let navigationStartMs: number | null = null;
  let domContentLoadedMs: number | null = null;
  let loadEventMs: number | null = null;
  let timeToFirstRenderMs: number | null = null;
  try {
    if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
      const navigation = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      if (navigation) {
        navigationStartMs = navigation.startTime ?? null;
        domContentLoadedMs = navigation.domContentLoadedEventEnd ?? null;
        loadEventMs = navigation.loadEventEnd ?? null;
      }
      const paints = performance.getEntriesByType("paint");
      const firstPaint = paints.find((entry) => entry.name === "first-paint");
      const firstContentful = paints.find((entry) => entry.name === "first-contentful-paint");
      const earliest = [firstPaint, firstContentful]
        .filter((entry): entry is PerformanceEntry => Boolean(entry))
        .sort((a, b) => a.startTime - b.startTime)[0];
      timeToFirstRenderMs = earliest ? earliest.startTime : null;
    }
  } catch {
    // Read-only best effort: any failure leaves the fields null.
  }
  return {
    appEntryPerfMs: APP_ENTRY_PERF_MS,
    navigationStartMs,
    domContentLoadedMs,
    loadEventMs,
    timeToFirstRenderMs,
  };
}

/**
 * Thin wrapper around Tauri `invoke()` that measures the command latency and
 * records it in the histogram. The result (or the error) is returned/rethrown
 * UNCHANGED — measurement never swallows and never alters the call.
 */
export async function measureInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`${command}: pomiar invoke wymaga natywnego środowiska Tauri.`);
  }
  const start = nowPerf();
  try {
    const result = await invoke<T>(command, args);
    recordCommandLatency(command, nowPerf() - start);
    return result;
  } catch (error) {
    recordCommandLatency(command, nowPerf() - start);
    reportError(`invoke:${command}`, error);
    throw error;
  }
}

/**
 * Same measurement, but in a browser preview (no Tauri) it returns the safe
 * `fallback` instead of calling native code — the established service pattern.
 */
export async function measureInvokeOr<T>(
  command: string,
  fallback: T,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) return fallback;
  return measureInvoke<T>(command, args);
}

function isDevBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

/**
 * Dev-only React render counter. Pass `enabled` explicitly in tests; in the
 * app it defaults to `import.meta.env.DEV`, so production builds never pay
 * for it. Returns the new count for the component.
 */
export function countRender(component: string, enabled: boolean = isDevBuild()): number {
  if (!enabled) return 0;
  if (typeof component !== "string" || component.length === 0 || component.length > 128) return 0;
  const next = (renderCounts.get(component) ?? 0) + 1;
  renderCounts.set(component, next);
  return next;
}

export function getRenderCounts(): Record<string, number> {
  return Object.fromEntries(renderCounts);
}

/** Plain-numbers snapshot intended for the diagnostics panel (no objects beyond numbers/strings/null). */
export function getPerfSnapshot(): PerfSnapshot {
  const commands: Record<string, Omit<CommandLatencyHistogram, "command">> = {};
  for (const histogram of commandHistogram()) {
    const { command, ...rest } = histogram;
    commands[command] = rest;
  }
  return {
    startup: getStartupTiming(),
    commands,
    renderCounts: getRenderCounts(),
    sampleCap: MAX_SAMPLES_PER_COMMAND,
  };
}

/** Test helper: clears all recorded samples (does not touch native state). */
export function resetPerfMetrics(): void {
  samples.clear();
  dropped.clear();
  renderCounts.clear();
}
