import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SessionOperation, SessionSnapshot } from "./sessionOrchestrator";
import type { ControlServiceStatus } from "./controlService";
import type { DisplayAudioSnapshot } from "./displayAudio";

export type BuildInfo = {
  version: string;
  buildSha: string;
  target: string;
  profile: string;
  windows: boolean;
};

export type DiagnosticsError = {
  source: string;
  message: string;
};

export type LaunchRegistryDiagnostics = {
  windows: boolean;
  sessions: Array<{
    id: string;
    displayName: string;
    phase: string;
    processIds: number[];
    foreground: boolean;
    windowId: number | null;
    error: string | null;
    pidReuseDetected: boolean;
    attention: string | null;
    sessionRevision?: number | null;
  }>;
  lastError: string | null;
  activeSessions: number;
  pollIntervalMs: number;
};

export type WindowBrokerDiagnostics = {
  windows: boolean;
  ownWindow: number | null;
  ownWindowValid: boolean;
  foreground: {
    hwnd: number | null;
    processId: number | null;
    processName: string | null;
    className: string | null;
    windowPresent: boolean;
  };
  trackedProcesses: number[];
  trackedWindows: Array<{
    hwnd: number;
    processId: number;
    processName: string | null;
    className: string | null;
    processCreatedAt100Ns: number | null;
    score: number;
    isMain: boolean;
  }>;
  lastError: string | null;
  pollIntervalMs: number;
};

export type DiagnosticsSnapshot = {
  generatedAtMs: number;
  build: BuildInfo;
  session: SessionSnapshot;
  sessionOperations: SessionOperation[];
  persistenceError: string | null;
  launchRegistry: LaunchRegistryDiagnostics;
  windowBroker: WindowBrokerDiagnostics;
  controlService: ControlServiceStatus;
  displayAudio: DisplayAudioSnapshot;
  errors: DiagnosticsError[];
  limitations: string[];
};

export type DiagnosticsExport = {
  generatedAtMs: number;
  sha256: string;
  reportJson: string;
};

export function previewDiagnosticsSnapshot(message: string): DiagnosticsSnapshot {
  return {
    generatedAtMs: Date.now(),
    build: {
      version: "web",
      buildSha: "unknown",
      target: "browser",
      profile: "preview",
      windows: false,
    },
    session: {
      current: "veloraHome",
      previous: null,
      revision: 0,
      transitionedAtMs: 0,
      context: null,
      allowedTargets: [],
    },
    sessionOperations: [],
    persistenceError: null,
    launchRegistry: {
      windows: false,
      sessions: [],
      lastError: null,
      activeSessions: 0,
      pollIntervalMs: 0,
    },
    windowBroker: {
      windows: false,
      ownWindow: null,
      ownWindowValid: false,
      foreground: { hwnd: null, processId: null, processName: null, className: null, windowPresent: false },
      trackedProcesses: [],
      trackedWindows: [],
      lastError: null,
      pollIntervalMs: 0,
    },
    controlService: {
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
      lastError: null,
    },
    displayAudio: {
      windows: false,
      supported: false,
      displays: [],
      audio: [],
      displayError: null,
      audioError: null,
      policy: {
        readOnly: true,
        automaticModeChanges: false,
        notes: ["Diagnostyka wymaga natywnej aplikacji Windows."],
      },
      limitations: [message],
      displaySignature: "",
      capturedAtMs: Date.now(),
    },
    errors: [{ source: "diagnostics", message }],
    limitations: [message],
  };
}

export async function getDiagnosticsSnapshot(): Promise<DiagnosticsSnapshot> {
  if (!isTauri()) {
    return previewDiagnosticsSnapshot("Diagnostyka systemowa wymaga natywnej aplikacji Windows.");
  }
  return invoke<DiagnosticsSnapshot>("get_diagnostics_snapshot");
}

export async function exportDiagnosticsReport(): Promise<DiagnosticsExport> {
  if (!isTauri()) {
    throw new Error("Eksport diagnostyki wymaga natywnej aplikacji Windows.");
  }
  return invoke<DiagnosticsExport>("export_diagnostics_report");
}
