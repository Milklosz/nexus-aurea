export type ForegroundProcessClass = "velora" | "steam" | "external" | "unknown";

export function classifyForegroundProcess(processName: string | null | undefined): ForegroundProcessClass {
  if (!processName?.trim()) return "unknown";

  const executable = processName.trim().split(/[\\/]/).pop()?.toLowerCase();
  if (!executable) return "unknown";
  if (executable === "nexus-aurea.exe") return "velora";
  if (executable === "steam.exe" || executable === "gameoverlayui.exe") return "steam";
  return "external";
}

export function shouldSuspendLocalControllerInput(
  controlServiceRunning: boolean,
  foregroundProcess: string | null | undefined,
): boolean {
  return controlServiceRunning && classifyForegroundProcess(foregroundProcess) !== "velora";
}
