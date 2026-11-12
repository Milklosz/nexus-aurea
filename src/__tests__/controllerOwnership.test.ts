import { describe, expect, it } from "vitest";
import { classifyForegroundProcess, shouldSuspendLocalControllerInput } from "../services/controllerOwnership";

describe("foreground process classification", () => {
  it("recognizes the existing VELORA executable name case-insensitively", () => {
    expect(classifyForegroundProcess("NEXUS-AUREA.EXE")).toBe("velora");
  });

  it("classifies Steam client and overlay processes without claiming input ownership", () => {
    expect(classifyForegroundProcess("C:\\Program Files (x86)\\Steam\\steam.exe")).toBe("steam");
    expect(classifyForegroundProcess("gameoverlayui.exe")).toBe("steam");
  });

  it("treats other foreground applications as external", () => {
    expect(classifyForegroundProcess("eldenring.exe")).toBe("external");
  });

  it("fails closed when the foreground process is unavailable", () => {
    expect(classifyForegroundProcess(null)).toBe("unknown");
    expect(classifyForegroundProcess("  ")).toBe("unknown");
  });

  it("suspends local input for uncertain or external processes only while monitoring is active", () => {
    expect(shouldSuspendLocalControllerInput(false, "steam.exe")).toBe(false);
    expect(shouldSuspendLocalControllerInput(true, "nexus-aurea.exe")).toBe(false);
    expect(shouldSuspendLocalControllerInput(true, "steam.exe")).toBe(true);
    expect(shouldSuspendLocalControllerInput(true, "eldenring.exe")).toBe(true);
    expect(shouldSuspendLocalControllerInput(true, null)).toBe(true);
  });
});
