export type ForegroundProcessClass = "velora" | "steam" | "external" | "unknown";

export function classifyForegroundProcess(processName: string | null | undefined): ForegroundProcessClass {
  if (!processName?.trim()) return "unknown";

  const executable = processName.trim().split(/[\\/]/).pop()?.toLowerCase();
  if (!executable) return "unknown";
  // The native side accepts both names (window_broker::is_velora_process); the bundle is named VELORA.
  if (executable === "nexus-aurea.exe" || executable === "velora.exe") return "velora";
  if (executable === "steam.exe" || executable === "gameoverlayui.exe") return "steam";
  return "external";
}

export function shouldSuspendLocalControllerInput(
  controlServiceRunning: boolean,
  foregroundProcess: string | null | undefined,
): boolean {
  return controlServiceRunning && classifyForegroundProcess(foregroundProcess) !== "velora";
}
