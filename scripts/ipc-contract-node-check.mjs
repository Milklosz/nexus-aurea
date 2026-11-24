// Workstream S3.16 — IPC contract drift detection (Agent J, Operation Singularity).
//
// Source-of-truth check, run with:  pnpm test:ipc-contract  (node --test).
//
// It parses three surfaces and asserts they agree:
//   1. `src-tauri/src/lib.rs`  — commands registered in `tauri::generate_handler![...]`;
//   2. `src/contracts/ipc.ts`  — the typed `IPC_COMMANDS` register (documentation as code);
//   3. `docs/ipc-contract.md`  — the command tables (parsed leniently: only the
//      `| \`command\` | ... | Skutek |` rows; the doc is a draft and is NOT
//      required to list every command).
//
// Any drift (a registered handler missing from the register, a register entry
// without a handler, or a register entry without a registered handler) fails
// this check. Test-side mirror of these invariants:
// `src/__tests__/ipcContract.test.ts`.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB_RS = path.join(ROOT, "src-tauri", "src", "lib.rs");
const IPC_TS = path.join(ROOT, "src", "contracts", "ipc.ts");
const DOC_MD = path.join(ROOT, "docs", "ipc-contract.md");

const EFFECTS = new Set(["read-only", "write", "launch", "close-request", "event"]);

/** Extract the command names registered in `tauri::generate_handler![...]`. */
export function parseRegisteredHandlers(libRsSource) {
  const start = libRsSource.indexOf("generate_handler![");
  assert.notEqual(start, -1, "lib.rs must contain `generate_handler![`");
  const open = libRsSource.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < libRsSource.length; i += 1) {
    if (libRsSource[i] === "[") depth += 1;
    else if (libRsSource[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, "generate_handler![ must be closed");
  const body = libRsSource.slice(open + 1, end);
  const entries = [...body.matchAll(/([A-Za-z_][A-Za-z_0-9]*)\s*::\s*([A-Za-z_][A-Za-z_0-9]*)/g)].map(
    (m) => m[2],
  );
  assert.ok(entries.length > 0, "generate_handler![ must register at least one command");
  const duplicates = entries.filter((name, i) => entries.indexOf(name) !== i);
  return { entries, duplicates: [...new Set(duplicates)] };
}

/**
 * Parse the `IPC_COMMANDS` register out of ipc.ts without a TS toolchain:
 * key lines `  name: {`, plus the `name`, `args`, `returns`, `sideEffect`
 * fields of each descriptor.
 */
export function parseIpcRegister(ipcTsSource) {
  const start = ipcTsSource.indexOf("export const IPC_COMMANDS");
  assert.notEqual(start, -1, "src/contracts/ipc.ts must export IPC_COMMANDS");
  const forward = ipcTsSource.indexOf("export const FORWARD_LOOKING_IPC_COMMANDS");
  const body = forward > start ? ipcTsSource.slice(start, forward) : ipcTsSource.slice(start);
  const keys = [...body.matchAll(/^\s{2}([a-z_][a-z_0-9]*):\s*\{/gm)].map((m) => m[1]);
  const descriptors = new Map();
  const keyRe = /^\s{2}([a-z_][a-z_0-9]*):\s*\{/gm;
  for (let i = 0; i < keys.length; i += 1) {
    keyRe.lastIndex = 0;
    for (const m of body.matchAll(keyRe)) {
      if (m[1] !== keys[i]) continue;
      const from = m.index;
      const to = i + 1 < keys.length ? body.indexOf(`\n  ${keys[i + 1]}: {`) : body.length;
      const chunk = body.slice(from, to);
      const name = chunk.match(/\bname:\s*"([a-z_0-9]+)"/);
      const argsChunk = chunk.match(/\bargs:\s*\[([^\]]*)\]/);
      const returns = chunk.match(/\breturns:\s*"((?:[^"\\]|\\.)*)"/);
      const sideEffect = chunk.match(/\bsideEffect:\s*"([a-z-]+)"/);
      const since = chunk.match(/\bsince:\s*"([^"]+)"/);
      descriptors.set(keys[i], {
        name: name ? name[1] : null,
        args: argsChunk
          ? [...argsChunk[1].matchAll(/"([^"]+)"/g)].map((a) => a[1])
          : null,
        returns: returns ? returns[1] : null,
        sideEffect: sideEffect ? sideEffect[1] : null,
        since: since ? since[1] : null,
      });
      break;
    }
  }
  return { keys, descriptors };
}

/**
 * Parse the markdown command tables leniently: only rows of the shape
 * `| \`command\` | args | returns | effect | ... |`.
 */
export function parseIpcDocTables(docSource) {
  const rows = [];
  for (const m of docSource.matchAll(/^\|\s*`([a-z_][a-z_0-9]*)`\s*\|([^|]*)\|([^|]*)\|\s*([a-z-]+)\s*\|/gm)) {
    const argsCell = m[2];
    let argCount = 0;
    const brace = argsChunkOf(argsCell);
    if (brace !== null) argCount = brace === "" ? 0 : brace.split(",").length;
    else if (argsCell.includes("wnętrzu") || argsCell.includes("injected")) argCount = -1;
    else if (!/^\s*(—|-)?\s*$/.test(argsCell)) argCount = -1;
    rows.push({ name: m[1], argCount, effect: m[4] });
  }
  return rows;
}

function argsChunkOf(cell) {
  const m = cell.match(/\{([^}]*)\}/);
  return m ? m[1] : null;
}

test("S3.16: every registered handler has an IPC_COMMANDS descriptor and vice versa", async () => {
  const [libRs, ipcTs] = await Promise.all([readFile(LIB_RS, "utf8"), readFile(IPC_TS, "utf8")]);

  const { entries, duplicates } = parseRegisteredHandlers(libRs);
  assert.deepEqual(
    duplicates,
    [],
    `generate_handler! registers duplicate commands: ${duplicates.join(", ")}`,
  );
  const handlers = new Set(entries);

  const { keys, descriptors } = parseIpcRegister(ipcTs);
  assert.strictEqual(
    descriptors.size,
    keys.length,
    "every IPC_COMMANDS key must yield a parseable descriptor",
  );
  for (const key of keys) {
    const d = descriptors.get(key);
    assert.equal(d.name, key, `IPC_COMMANDS.${key} must have name === key`);
    assert.ok(Array.isArray(d.args), `IPC_COMMANDS.${key}.args must be an array`);
    assert.ok(d.returns, `IPC_COMMANDS.${key}.returns must be a non-empty string`);
    assert.ok(EFFECTS.has(d.sideEffect), `IPC_COMMANDS.${key}.sideEffect must be one of ${[...EFFECTS]}`);
    assert.ok(d.since, `IPC_COMMANDS.${key}.since must be a non-empty string`);
  }

  const missingFromRegister = [...handlers].filter((h) => !descriptors.has(h)).sort();
  const notRegistered = keys.filter((k) => !handlers.has(k)).sort();
  assert.deepEqual(
    missingFromRegister,
    [],
    `handlers registered in lib.rs but missing from IPC_COMMANDS (${missingFromRegister.length}): ` +
      missingFromRegister.join(", "),
  );
  assert.deepEqual(
    notRegistered,
    [],
    `IPC_COMMANDS entries without a registered handler: ${notRegistered.join(", ")}`,
  );

  console.log(
    `ipc-contract: generate_handler = ${handlers.size} commands, IPC_COMMANDS = ${keys.length} descriptors — sets match`,
  );
});

test("S3.16: docs/ipc-contract.md tables agree with IPC_COMMANDS", async () => {
  const [ipcTs, docMd] = await Promise.all([readFile(IPC_TS, "utf8"), readFile(DOC_MD, "utf8")]);
  const { keys, descriptors } = parseIpcRegister(ipcTs);
  const rows = parseIpcDocTables(docMd);
  assert.ok(rows.length > 0, "docs/ipc-contract.md must contain at least one command table row");

  for (const row of rows) {
    assert.ok(
      keys.includes(row.name),
      `docs/ipc-contract.md table lists '${row.name}' which is not in IPC_COMMANDS`,
    );
    const d = descriptors.get(row.name);
    if (row.argCount >= 0) {
      assert.equal(
        d.args.length,
        row.argCount,
        `docs/ipc-contract.md argument count for '${row.name}' differs from IPC_COMMANDS`,
      );
    }
    if (EFFECTS.has(row.effect)) {
      assert.equal(
        d.sideEffect,
        row.effect,
        `docs/ipc-contract.md Skutek for '${row.name}' differs from IPC_COMMANDS sideEffect`,
      );
    }
  }
  console.log(`ipc-contract: ${rows.length} documented table rows agree with IPC_COMMANDS`);
});
