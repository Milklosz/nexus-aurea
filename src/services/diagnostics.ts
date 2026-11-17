import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SessionOperation, SessionSnapshot } from "./sessionOrchestrator";
import type { ControlServiceStatus } from "./controlService";
import type { DisplayAudioSnapshot } from "./displayAudio";
import { disabledNativeControllerStatus, type NativeControllerStatus } from "./nativeController";

export type BuildInfo = {
  version: string;
  buildSha: string;
  checkoutSha: string;
  branch: string;
  buildRef: string;
  dirty: string;
  event: string;
  prHeadSha: string | null;
  prBaseSha: string | null;
  target: string;
  profile: string;
  rustcVersion: string;
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
  nativeController: NativeControllerStatus;
  displayAudio: DisplayAudioSnapshot;
  remote?: { enabled: boolean; secureOriginAvailable: boolean; pairedDeviceCount: number; recoveryRequired: boolean };
  errors: DiagnosticsError[];
  limitations: string[];
};

export type DiagnosticsExport = {
  generatedAtMs: number;
  sha256: string;
  reportJson: string;
};

/**
 * Browser-only mirror of the native diagnostics sanitizer (defense in depth).
 * The web preview never talks to the remote service, but free-form text can
 * still be rendered in the System Intelligence panel. Bound and redact it so a
 * caller cannot surface credentials, one-time pairing codes or local paths.
 * Not a universal secret detector — the native report is the real boundary.
 */
const SENSITIVE_DIAGNOSTICS_MARKERS = [
  "token=",
  "secret=",
  "password=",
  "authorization",
  "bearer ",
  "https://",
  "http://",
  "pair=",
  "pairing",
  "bootstrap",
  "otp=",
  "pin=",
  "qr=",
  "qrcode",
  "one-time code",
  "kod jednorazowy",
  "deviceid",
  "device_id",
  "hmac",
  "signature",
  "nonce",
  "credential",
  "private key",
  "cert=",
];

export function sanitizeDiagnosticsText(input: string): string {
  return input
    .slice(0, 2048)
    .split(/\r?\n/)
    .slice(0, 4)
    .map((line) => {
      const lower = line.toLowerCase();
      if (
        /[\\/](users|home|appdata)[\\/]/i.test(line) ||
        lower.includes("documents and settings")
      ) {
        return "<redacted-path>";
      }
      if (
        SENSITIVE_DIAGNOSTICS_MARKERS.some((marker) => lower.includes(marker)) ||
        /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(line) ||
        /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(line) ||
        /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i.test(line)
      ) {
        return "<redacted-detail>";
      }
      return line.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256);
    })
    .join(" ")
    .slice(0, 1024);
}

export function previewDiagnosticsSnapshot(message: string): DiagnosticsSnapshot {
  const safeMessage = sanitizeDiagnosticsText(message);
  return {
    generatedAtMs: Date.now(),
    build: {
      version: "web",
      buildSha: "unknown",
      checkoutSha: "unknown",
      branch: "unknown",
      buildRef: "unknown",
      dirty: "unknown",
      event: "preview",
      prHeadSha: null,
      prBaseSha: null,
      target: "browser",
      profile: "preview",
      rustcVersion: "unknown",
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
    nativeController: disabledNativeControllerStatus,
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
      limitations: [safeMessage],
      displaySignature: "",
      capturedAtMs: Date.now(),
    },
    errors: [{ source: "diagnostics", message: safeMessage }],
    limitations: [safeMessage],
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
