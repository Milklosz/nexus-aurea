import { describe, expect, it, vi } from "vitest";
import { focusWindowSafely } from "../services/focusWindowSafely";

describe("safe window focus request", () => {
  it("does not report a blocked focus when the window accepts the request", async () => {
    const focusWindow = vi.fn(async () => {});
    const onBlocked = vi.fn();

    await focusWindowSafely(focusWindow, onBlocked);

    expect(focusWindow).toHaveBeenCalledOnce();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("reports the operating-system focus refusal without throwing", async () => {
    const focusWindow = vi.fn(async () => { throw new Error("focus denied"); });
    const onBlocked = vi.fn();

    await expect(focusWindowSafely(focusWindow, onBlocked)).resolves.toBeUndefined();

    expect(onBlocked).toHaveBeenCalledOnce();
  });
});
