import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type DualSenseConnection = "usb" | "bluetooth" | "unknown";
export type DualSenseModel = "dualSense" | "dualSenseEdge" | "unknown";
export type ChordOutcome =
  | "triggered"
  | "armed"
  | "cooldown"
  | "latched"
  | "released"
  | "rejectedWindow"
  | "ignored";

export type GamepadDeviceInfo = {
  id: string;
  model: DualSenseModel;
  connection: DualSenseConnection;
  connectedAtMs: number;
  lastReportAtMs: number | null;
  reportCount: number;
  lastChordAtMs: number | null;
  reconnectCount: number;
};

export type ChordDiagnostic = {
  outcome: ChordOutcome;
  atMs: number;
};

export type ControlServiceStatus = {
  windows: boolean;
  running: boolean;
  gameMode: boolean;
  controllerCount: number;
  playstationControllerCount: number;
  foregroundProcess: string | null;
  returnHotkeyRegistered: boolean;
  fallbackHotkey?: string;
  gamepadHomeRunning?: boolean;
  gamepadHomeDeviceCount?: number;
  gamepadHomeLastComboAtMs?: number | null;
  gamepadHomeLastError?: string | null;
  gamepadHomeWarning?: string | null;
  gamepadHomeDevices?: GamepadDeviceInfo[];
  gamepadHomeDuplicateReports?: number;
  gamepadHomeReconnects?: number;
  gamepadHomeLastReportAtMs?: number | null;
  gamepadHomeLastChord?: ChordDiagnostic | null;
  lastError: string | null;
};

export type FallbackHotkey = {
  id: string;
  label: string;
  modifiers: number;
  virtualKey: number;
};

export type ControlServiceStopReason = "keyboard-emergency" | "device-enumeration-failed" | string;

export const disabledControlServiceStatus: ControlServiceStatus = {
  windows: false,
  running: false,
  gameMode: false,
  controllerCount: 0,
  playstationControllerCount: 0,
  foregroundProcess: null,
  returnHotkeyRegistered: false,
  fallbackHotkey: "Ctrl+Alt+N",
  gamepadHomeRunning: false,
  gamepadHomeDeviceCount: 0,
  gamepadHomeLastComboAtMs: null,
  gamepadHomeLastError: null,
  gamepadHomeWarning: null,
  gamepadHomeDevices: [],
  gamepadHomeDuplicateReports: 0,
  gamepadHomeReconnects: 0,
  gamepadHomeLastReportAtMs: null,
  gamepadHomeLastChord: null,
  lastError: null,
};

export async function getControlServiceStatus(): Promise<ControlServiceStatus> {
  if (!isTauri()) return disabledControlServiceStatus;
  return invoke<ControlServiceStatus>("get_control_service_status");
}

export async function startControlService(): Promise<ControlServiceStatus> {
  if (!isTauri()) throw new Error("Control Service działa tylko w natywnej aplikacji Windows.");
  return invoke<ControlServiceStatus>("start_control_service");
}

export async function setControlGameMode(enabled: boolean): Promise<ControlServiceStatus> {
  if (!isTauri()) throw new Error("Control Service działa tylko w natywnej aplikacji Windows.");
  return invoke<ControlServiceStatus>("set_control_game_mode", { enabled });
}

export async function stopControlService(): Promise<ControlServiceStatus> {
  if (!isTauri()) throw new Error("Control Service działa tylko w natywnej aplikacji Windows.");
  return invoke<ControlServiceStatus>("stop_control_service");
}

export async function getFallbackHotkeyOptions(): Promise<FallbackHotkey[]> {
  if (!isTauri()) return [];
  return invoke<FallbackHotkey[]>("get_fallback_hotkey_options");
}

export async function setFallbackHotkey(id: string): Promise<ControlServiceStatus> {
  if (!isTauri()) throw new Error("Skrót powrotu działa tylko w natywnej aplikacji Windows.");
  return invoke<ControlServiceStatus>("set_fallback_hotkey", { id });
}

export async function listenForControlServiceStatus(
  callback: (status: ControlServiceStatus) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<ControlServiceStatus>("control-service-status", (event) => callback(event.payload));
}

export async function listenForControlServiceStop(
  callback: (reason: ControlServiceStopReason) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<ControlServiceStopReason>("control-service-stopped", (event) => callback(event.payload));
}

export async function listenForNexusControlReturn(callback: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen("nexus-control-return", callback);
}
