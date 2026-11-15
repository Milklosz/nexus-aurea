import { describe, expect, it, vi } from "vitest";
import { formatUsageTime, getClaudeUsage, unavailableClaudeUsage, usageLabel, validateClaudeUsage } from "../services/claudeUsage";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => mocks.tauri }));

describe("Claude Usage data boundary", () => {
  it("uses only the fixed Tauri command and boolean refresh flag", async () => {
    mocks.invoke.mockResolvedValue(unavailableClaudeUsage);
    expect(await getClaudeUsage(true)).toEqual(unavailableClaudeUsage);
    expect(mocks.invoke).toHaveBeenLastCalledWith("get_claude_usage", { manual: true });
  });
  it("fails closed on IPC error or browser preview", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("private raw output"));
    expect(await getClaudeUsage()).toEqual(unavailableClaudeUsage);
    mocks.tauri = false; expect(await getClaudeUsage()).toEqual(unavailableClaudeUsage); mocks.tauri = true;
  });
  it.each([null, {}, { ...unavailableClaudeUsage, limits: [0] }, { ...unavailableClaudeUsage, fetchedAt: "today" },
    { ...unavailableClaudeUsage, status: "available" }, { ...unavailableClaudeUsage, source: "other" }])("rejects malformed data", (value) => {
    expect(validateClaudeUsage(value).errorCode).toBe("parserIncompatible");
  });
  it("does not accept out-of-range or ambiguous reset times", () => {
    const limit = { categoryId: "future", categoryLabel: "Future", usedPercent: 0, resetAt: null, resetTimezone: null, resetText: null };
    const data = { ...unavailableClaudeUsage, status: "available", errorCode: null, fetchedAt: 1, limits: [limit] };
    expect(validateClaudeUsage(data).limits).toHaveLength(1);
    for (const usedPercent of [-1, 101, Infinity, NaN, "79"]) expect(validateClaudeUsage({ ...data, limits: [{ ...limit, usedPercent }] }).errorCode).toBe("parserIncompatible");
    expect(validateClaudeUsage({ ...data, limits: [{ ...limit, resetAt: "2026-11-18T14:59:00" }] }).errorCode).toBe("parserIncompatible");
  });
  it("formats Europe/Warsaw summer and winter using the timezone database", () => {
    expect(formatUsageTime("2026-11-18T13:59:00Z")).toContain("14:59");
    expect(formatUsageTime("2026-07-18T12:59:00Z")).toContain("14:59");
    expect(formatUsageTime("invalid")).toBe("Czas niedostępny");
  });
  it("keeps unknown category names and maps known headings without fixing the model list", () => {
    expect(usageLabel("Current session")).toBe("Session");
    expect(usageLabel("Current week (Future)")).toBe("Weekly · Future");
    expect(usageLabel("Current other quota")).toBe("Current other quota");
  });
});
