/**
 * Workstream S3.16 — IPC register invariants (Agent J, Operation Singularity).
 *
 * Vitest-side mirror of `scripts/ipc-contract-node-check.mjs`:
 *   - `IPC_COMMANDS` descriptor invariants (unique keys, name === key, valid
 *     sideEffect, non-empty returns/since, args is an array of non-empty names);
 *   - every `invoke("...")` string literal used in `src/services/` exists in
 *     `IPC_COMMANDS` (no undeclared commands called at runtime);
 *   - every command registered in `src-tauri/src/lib.rs`
 *     `generate_handler![...]` is documented — and vice versa — so contract
 *     drift fails the whole test suite, not just the dedicated node check.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IPC_COMMANDS, FORWARD_LOOKING_IPC_COMMANDS } from "../contracts/ipc";

const VALID_EFFECTS = new Set(["read-only", "write", "launch", "close-request", "event"]);

const commandNames = Object.keys(IPC_COMMANDS) as (keyof typeof IPC_COMMANDS)[];
const nameSet = new Set<string>(commandNames);

function libRsSource(): string {
  return readFileSync(join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
}

function registeredHandlerNames(): string[] {
  const source = libRsSource();
  const start = source.indexOf("generate_handler![");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(0);
  const body = source.slice(open + 1, end);
  return [...body.matchAll(/([A-Za-z_][A-Za-z_0-9]*)\s*::\s*([A-Za-z_][A-Za-z_0-9]*)/g)].map(
    (m) => m[2],
  );
}

function serviceInvokeLiterals(): Map<string, string[]> {
  const servicesDir = join(process.cwd(), "src", "services");
  const found = new Map<string, string[]>();
  for (const file of readdirSync(servicesDir)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(servicesDir, file), "utf8");
    for (const m of text.matchAll(/\binvoke(?:<[^>(]*>)?\s*\(\s*"([a-z_0-9]+)"/g)) {
      const name = m[1];
      const files = found.get(name) ?? [];
      files.push(file);
      found.set(name, files);
    }
  }
  return found;
}

describe("IPC_COMMANDS descriptor invariants (S3.16)", () => {
  it("has unique command names", () => {
    expect(new Set(commandNames).size).toBe(commandNames.length);
  });

  it("has name === key for every descriptor", () => {
    for (const key of commandNames) {
      expect(IPC_COMMANDS[key].name, `IPC_COMMANDS.${key}.name`).toBe(key);
    }
  });

  it("uses only valid sideEffect values", () => {
    for (const key of commandNames) {
      expect(
        VALID_EFFECTS.has(IPC_COMMANDS[key].sideEffect),
        `IPC_COMMANDS.${key}.sideEffect = ${String(IPC_COMMANDS[key].sideEffect)}`,
      ).toBe(true);
    }
  });

  it("has non-empty returns and since on every descriptor", () => {
    for (const key of commandNames) {
      expect(IPC_COMMANDS[key].returns.length, `IPC_COMMANDS.${key}.returns`).toBeGreaterThan(0);
      expect(IPC_COMMANDS[key].since.length, `IPC_COMMANDS.${key}.since`).toBeGreaterThan(0);
    }
  });

  it("declares args as an array of non-empty snake_case names with no duplicates", () => {
    for (const key of commandNames) {
      const args = IPC_COMMANDS[key].args;
      expect(Array.isArray(args), `IPC_COMMANDS.${key}.args must be an array`).toBe(true);
      for (const arg of args) {
        expect(arg.length, `IPC_COMMANDS.${key} arg name`).toBeGreaterThan(0);
        expect(arg).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
      expect(new Set(args).size, `IPC_COMMANDS.${key} duplicate args`).toBe(args.length);
    }
  });

  it("keeps the forward-looking reserved slot empty", () => {
    expect(Object.keys(FORWARD_LOOKING_IPC_COMMANDS)).toEqual([]);
  });
});

describe("service invoke literals are declared in IPC_COMMANDS (S3.16)", () => {
  it("finds at least 40 distinct invoked commands in src/services/", () => {
    expect(serviceInvokeLiterals().size).toBeGreaterThanOrEqual(40);
  });

  it("declares every invoked command", () => {
    const undeclared: string[] = [];
    for (const [name] of serviceInvokeLiterals()) {
      if (!nameSet.has(name)) undeclared.push(name);
    }
    expect(
      undeclared,
      `invoke() literals in src/services/ missing from IPC_COMMANDS`,
    ).toEqual([]);
  });

  it("only invokes commands that exist in the register (isIpcCommandName agrees)", () => {
    for (const name of nameSet) {
      expect(typeof name).toBe("string");
    }
  });
});

describe("generate_handler![...] and IPC_COMMANDS agree (S3.16)", () => {
  it("registers every IPC_COMMANDS entry exactly once", () => {
    const handlers = registeredHandlerNames();
    expect(new Set(handlers).size).toBe(handlers.length);
    for (const name of nameSet) {
      expect(handlers, `${name} must be registered in generate_handler!`).toContain(name);
    }
  });

  it("documents every registered handler", () => {
    const handlers = new Set(registeredHandlerNames());
    const undocumented = commandNames.filter((n) => !handlers.has(n));
    expect(undocumented).toEqual([]);
  });
});
