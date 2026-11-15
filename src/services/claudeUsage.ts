import { invoke, isTauri } from "@tauri-apps/api/core";

export type ClaudeUsageError = "notInstalled" | "notAuthenticated" | "usageUnavailable" | "parserIncompatible" | "timeout" | "awaitingUsage";
export interface ClaudeUsageLimit {
  categoryId: string;
  categoryLabel: string;
  usedPercent: number;
  resetAt: string | null;
  resetTimezone: string | null;
  resetText: string | null;
}
export interface ClaudeUsageSnapshot {
  source: "claude-code";
  fetchedAt: number | null;
  status: "available" | "stale" | "unavailable";
  limits: ClaudeUsageLimit[];
  sourceVersion: string | null;
  stale: boolean;
  refreshing: boolean;
  errorCode: ClaudeUsageError | null;
  automaticUsageSupported: boolean;
}
export const unavailableClaudeUsage: ClaudeUsageSnapshot = {
  source: "claude-code", fetchedAt: null, status: "unavailable", limits: [], sourceVersion: null,
  stale: false, refreshing: false, errorCode: "usageUnavailable", automaticUsageSupported: false,
};

/** IPC is a data boundary. Never coerce percentages, timestamps or error messages. */
export function validateClaudeUsage(value: unknown): ClaudeUsageSnapshot {
  const bad = (): ClaudeUsageSnapshot => ({ ...unavailableClaudeUsage, errorCode: "parserIncompatible" });
  if (!value || typeof value !== "object") return bad();
  const s = value as Record<string, unknown>;
  const optionalText = (v: unknown, max: number) => v === null || typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v);
  if (s.source !== "claude-code" || !["available", "stale", "unavailable"].includes(String(s.status))
    || !(s.fetchedAt === null || typeof s.fetchedAt === "number" && Number.isSafeInteger(s.fetchedAt) && s.fetchedAt >= 0)
    || typeof s.stale !== "boolean" || typeof s.refreshing !== "boolean" || typeof s.automaticUsageSupported !== "boolean"
    || !optionalText(s.sourceVersion, 80) || !(s.errorCode === null || ["notInstalled", "notAuthenticated", "usageUnavailable", "parserIncompatible", "timeout", "awaitingUsage"].includes(String(s.errorCode)))
    || !Array.isArray(s.limits) || s.limits.length > 32) return bad();
  const ids = new Set<string>();
  for (const limit of s.limits) {
    if (!limit || typeof limit !== "object") return bad();
    const l = limit as Record<string, unknown>;
    if (typeof l.categoryId !== "string" || !l.categoryId || l.categoryId.length > 120 || ids.has(l.categoryId)
      || typeof l.categoryLabel !== "string" || !l.categoryLabel || !optionalText(l.categoryLabel, 120)
      || typeof l.usedPercent !== "number" || !Number.isFinite(l.usedPercent) || l.usedPercent < 0 || l.usedPercent > 100
      || !optionalText(l.resetAt, 80) || typeof l.resetAt === "string" && (!/(Z|[+-]\d{2}:\d{2})$/.test(l.resetAt) || !Number.isFinite(Date.parse(l.resetAt)))
      || !optionalText(l.resetTimezone, 80) || !optionalText(l.resetText, 200)) return bad();
    ids.add(l.categoryId);
  }
  if ((s.limits.length > 0) !== (s.fetchedAt !== null) || (s.status === "available" && (s.limits.length === 0 || s.stale || s.errorCode !== null))
    || (s.status === "unavailable" && s.limits.length !== 0) || (s.status === "stale" && (!s.stale || s.limits.length === 0))) return bad();
  return value as ClaudeUsageSnapshot;
}

export async function getClaudeUsage(manual = false): Promise<ClaudeUsageSnapshot> {
  if (!isTauri()) return unavailableClaudeUsage;
  try { return validateClaudeUsage(await invoke<unknown>("get_claude_usage", { manual })); }
  catch { return unavailableClaudeUsage; }
}

export function formatUsageTime(at: number | string, timeZone = "Europe/Warsaw"): string {
  try { return new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(at)); }
  catch { return "Czas niedostępny"; }
}

export function usageLabel(label: string): string {
  if (label === "Current session") return "Session";
  const weekly = /^Current week \((.+)\)$/.exec(label);
  return weekly ? `Weekly · ${weekly[1] === "all models" ? "All models" : weekly[1]}` : label;
}
