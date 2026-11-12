/**
 * FOREGROUND POLICY GUARD (VELORA hardware fix).
 *
 * Tauri's `window.setFocus()` is implemented by tao's `set_focus`. When
 * `SetForegroundWindow` is refused, tao injects an Alt keypress to get past the
 * Windows foreground lock. VELORA must not reach that path from its own UI: the
 * native WindowBroker owns the single, policy-checked focus attempt, and the
 * WebView only reports the outcome.
 *
 * These assertions read the sources as text, the same way the iPhone Remote
 * guard does, so a future edit that reintroduces a WebView focus retry fails
 * loudly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const broker = readFileSync(resolve(process.cwd(), "src-tauri/src/window_broker.rs"), "utf8");

describe("foreground policy guard", () => {
  it("never retries focus from the WebView when the local Home transaction fails", () => {
    expect(app).not.toMatch(/\bsetFocus\s*\(/);
    expect(app).not.toMatch(/from "\.\/services\/focusWindowSafely"/);
    expect(app).not.toMatch(/\bgetCurrentWindow\b/);
  });

  it("keeps the single native focus attempt and its policy re-check", () => {
    expect(broker).toContain("native::request_foreground(own_window, reason)");
    expect(broker).toContain("fn request_foreground(own_window: u64, reason: RestoreReason)");
    expect(broker).not.toMatch(/\bSendInput\b/);
    expect(broker).not.toMatch(/\bkeybd_event\b/);
    expect(broker).not.toMatch(/\bAttachThreadInput\b/);
  });

  it("uses only the documented foreground hand-off for launched applications", () => {
    const launchers = [
      "src-tauri/src/edge_cinema.rs",
      "src-tauri/src/app_manager.rs",
      "src-tauri/src/platform_launchers.rs",
      "src-tauri/src/playnite_library.rs",
    ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
    expect(launchers).toContain("grant_foreground_handoff");
    expect(launchers).not.toMatch(/\bSendInput\b|\bkeybd_event\b|\bAttachThreadInput\b|\bSystemParametersInfo\b/);
  });
});
