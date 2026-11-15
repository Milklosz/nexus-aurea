// Official Claude Code statusLine stdin adapter. Never persist the whole payload:
// it also contains private workspace/transcript/session information.
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export function extractUsage(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object" || !payload.rate_limits || typeof payload.rate_limits !== "object") return null;
  const rateLimits = {};
  for (const key of ["five_hour", "seven_day"]) {
    const window = payload.rate_limits[key];
    if (window === undefined) continue;
    if (!window || typeof window !== "object" || !Number.isFinite(window.used_percentage)
      || window.used_percentage < 0 || window.used_percentage > 100
      || !Number.isSafeInteger(window.resets_at) || window.resets_at <= 0) throw new Error("Invalid usage window");
    if (window.resets_at * 1000 <= now) continue;
    rateLimits[key] = { used_percentage: window.used_percentage, resets_at: window.resets_at };
  }
  if (Object.keys(rateLimits).length === 0) return null;
  const version = typeof payload.version === "string" && payload.version.length <= 80 && /^[A-Za-z0-9 .()-]+$/.test(payload.version) ? payload.version : null;
  return { schemaVersion: 1, source: "claude-code-statusline", capturedAt: now, sourceVersion: version, rateLimits };
}

export async function writeUsage(snapshot, base) {
  if (!base || !path.isAbsolute(base) || base.replaceAll("\\", "/").startsWith("//")) throw new Error("Local path unavailable");
  const directory = path.join(base, "VELORA");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `claude-usage.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(snapshot), "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path.join(directory, "claude-usage.json"));
  } finally { await unlink(temporary).catch(() => {}); }
}

async function main() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Input too large");
    chunks.push(chunk);
  }
  const snapshot = extractUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!snapshot) { process.stdout.write("Claude · limits pending"); return; }
  await writeUsage(snapshot, process.env.LOCALAPPDATA);
  const labels = { five_hour: "5h", seven_day: "7d" };
  process.stdout.write(Object.entries(snapshot.rateLimits).map(([key, value]) => `${labels[key]} ${value.used_percentage}%`).join(" · "));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => { process.stdout.write("Claude · usage unavailable"); process.exitCode = 1; });
}
