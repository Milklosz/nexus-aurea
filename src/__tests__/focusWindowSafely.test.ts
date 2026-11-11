import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { focusWindowSafely } from "../services/focusWindowSafely";

describe("safe window focus request", () => {
  it("restores a minimized window before focusing it", async () => {
    const events: string[] = [];
    const window = {
      unminimize: vi.fn(async () => { events.push("unminimize"); }),
      setFocus: vi.fn(async () => { events.push("focus"); }),
    };
    const onBlocked = vi.fn();

    await focusWindowSafely(window, onBlocked);

    expect(events).toEqual(["unminimize", "focus"]);
    expect(window.unminimize).toHaveBeenCalledOnce();
    expect(window.setFocus).toHaveBeenCalledOnce();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("reports a failed restore or focus request without throwing", async () => {
    const window = {
      unminimize: vi.fn(async () => {}),
      setFocus: vi.fn(async () => { throw new Error("focus denied"); }),
    };
    const onBlocked = vi.fn();

    await expect(focusWindowSafely(window, onBlocked)).resolves.toBeUndefined();

    expect(onBlocked).toHaveBeenCalledOnce();
  });

  it("grants only the Tauri capability required to unminimize the VELORA window", () => {
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));

    expect(capability.permissions).toContain("core:window:allow-unminimize");
  });
});
