import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractUsage, writeUsage } from "./claude-usage-statusline.mjs";

const now = 1_800_000_000_000;
const input = { version: "2.1.322", rate_limits: { five_hour: { used_percentage: 0, resets_at: now / 1000 + 100 }, seven_day: { used_percentage: 79, resets_at: now / 1000 + 200 }, spend_limit: { used_usd: 999 } }, transcript_path: "PRIVATE", session_id: "PRIVATE", token: "PRIVATE" };
test("extracts only documented subscription windows and preserves zero", () => {
  const value = extractUsage(input, now);
  assert.deepEqual(Object.keys(value.rateLimits), ["five_hour", "seven_day"]);
  assert.equal(value.rateLimits.five_hour.used_percentage, 0);
  assert.equal(value.capturedAt, now); assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(value).includes("spend_limit"), false);
});
test("missing and expired windows never produce artificial zero limits", () => {
  assert.equal(extractUsage({}, now), null);
  assert.equal(extractUsage({ rate_limits: {} }, now), null);
  assert.equal(extractUsage(input, now + 300_000), null);
});
test("both UNC separator forms are rejected before any filesystem write", async () => {
  for (const base of ["//server/share", "\\\\server\\share"]) await assert.rejects(writeUsage(extractUsage(input, now), base), /Local path unavailable/);
});
test("invalid percentages and reset values fail closed", () => {
  for (const used_percentage of [-1, 101, NaN, Infinity, "79"]) {
    assert.throws(() => extractUsage({ rate_limits: { five_hour: { used_percentage, resets_at: now / 1000 + 100 } } }, now));
  }
  assert.throws(() => extractUsage({ rate_limits: { five_hour: { used_percentage: 1, resets_at: "tomorrow" } } }, now));
});
test("writes only sanitized data and atomically replaces an earlier snapshot", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "velora-statusline-test-"));
  try {
    await writeUsage(extractUsage(input, now), base);
    await writeUsage(extractUsage(input, now + 1000), base);
    const text = await readFile(path.join(base, "VELORA", "claude-usage.json"), "utf8");
    assert.equal(text.includes("PRIVATE"), false); assert.equal(JSON.parse(text).capturedAt, now + 1000);
  } finally { assert.ok(path.resolve(base).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(base, { recursive: true, force: true }); }
});
test("CLI accepts stdin without model/network calls and reports pending before first response", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./claude-usage-statusline.mjs", import.meta.url))], { input: "{}", encoding: "utf8", timeout: 2000, windowsHide: true });
  assert.equal(output, "Claude · limits pending");
});
