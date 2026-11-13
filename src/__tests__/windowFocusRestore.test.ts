import { describe, expect, it } from "vitest";
import { shouldRestoreDockFocus } from "../services/windowFocusRestore";

const idle = { diagnosticsOpen: false, controlCenterOpen: false, dialogOpen: false };

describe("shouldRestoreDockFocus", () => {
  it("restores dock focus when no overlay is open", () => {
    expect(shouldRestoreDockFocus(idle)).toBe(true);
  });

  it("does not move focus under an open Control Center", () => {
    expect(shouldRestoreDockFocus({ ...idle, controlCenterOpen: true })).toBe(false);
  });

  it("does not move focus under open diagnostics", () => {
    expect(shouldRestoreDockFocus({ ...idle, diagnosticsOpen: true })).toBe(false);
  });

  it("does not move focus while any other dialog is open", () => {
    expect(shouldRestoreDockFocus({ ...idle, dialogOpen: true })).toBe(false);
  });
});
