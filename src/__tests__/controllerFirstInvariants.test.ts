import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const keyboardAndPadSources = [
  "src/services/virtualKeyboard.ts",
  "src/hooks/useVirtualKeyboard.ts",
  "src/components/VirtualKeyboard.tsx",
  "src/services/controllerEngine.ts",
];

describe("controller-first guard rails", () => {
  it("the keyboard and pad engine never use global capture, focus hacks or input injection", () => {
    const forbidden = new RegExp([
      "setFocus\\s*\\(",
      "SendInput",
      "keybd_event",
      "SetWindowsHookEx",
      "WH_KEYBOARD",
      "enigo",
      "rdev",
      "uinput",
      "SendKeys",
      "__TAURI__",
      "@tauri-apps",
      "window\\.addEventListener\\(\\s*[\"']key",
      "document\\.addEventListener\\(\\s*[\"']key",
    ].join("|"));
    for (const file of keyboardAndPadSources) {
      expect(read(file), file).not.toMatch(forbidden);
    }
  });

  it("the keyboard writes only into its own field and never opens, posts or calls out", () => {
    const source = read("src/services/virtualKeyboard.ts") + read("src/hooks/useVirtualKeyboard.ts");
    expect(source).not.toMatch(/window\.open|postMessage|navigator\.clipboard|fetch\(|invoke\(/);
  });

  it("App routes Up/Down, Home and Back through the keyboard before the other handlers", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/moveY: moveControllerVertical/);
    expect(app).toMatch(/home: returnToNexus,/);
    // Every Home path (pad, remote, Control Center) goes through returnToNexus, which closes the keyboard first.
    expect(app).toMatch(/const returnToNexus = useCallback\(\(\) => \{\s*(\/\/[^\n]*\n\s*)*closeKeyboardForHome\(\);/);
    // The remote's Up/Down use the vertical path, not Left/Right.
    expect(app).toMatch(/navigateDirection: \(direction\) => \{\s*if \(direction === "up"\) moveControllerVertical\(-1\);/);
    // A comment in App.tsx mentions setFocus; only a call would retry focus.
    expect(app).not.toMatch(/setFocus\s*\(/);
    const recoverStart = app.indexOf("const recover = (event: KeyboardEvent) => {");
    expect(recoverStart).toBeGreaterThan(0);
    expect(app.slice(recoverStart, recoverStart + 400)).toMatch(/if \(keyboardOpen\(\)\) \{\s*keyboardKeyDown\(event\);/);
    expect(app).toMatch(/<VirtualKeyboard controller=\{keyboard\} \/>/);
  });

  it("the Tauri 2 configuration this sprint runs on is unchanged", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json")) as Record<string, unknown>;
    expect(config["$schema"]).toBe("https://schema.tauri.app/config/2");
    expect(config["identifier"]).toBe("pl.nexus.aurea");
  });

  it("the sprint document exists, names the DualShock 4 and keeps hardware checks marked NOT RUN", () => {
    const doc = read("docs/velora-v1.5-controller-first.md");
    expect(doc).toContain("DualShock 4");
    expect(doc).toContain("NOT RUN");
    expect(doc).toMatch(/globaln/i);
  });
});
