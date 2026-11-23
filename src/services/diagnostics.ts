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

/* ------------------------------------------------------------------------- *
 * Control Center 4.0 — readable diagnostic summary (PURE, ADDITIVE).
 * Aggregates an existing snapshot into per-area items with an explicit
 * ok / warning / error / unknown state. Never fabricates a value: missing
 * or malformed fields become "unknown", never a guessed number.
 * ------------------------------------------------------------------------- */

export type DiagnosticsSummaryState = "ok" | "warning" | "error" | "unknown";

export type DiagnosticsSummaryItem = {
  id: string;
  label: string;
  state: DiagnosticsSummaryState;
  detail: string;
};

export type DiagnosticsSummary = {
  generatedAtMs: number;
  buildLabel: string;
  errorCount: number;
  pendingOperations: number;
  activeLaunches: number;
  trackedWindows: number;
  displays: number;
  audioEndpoints: number;
  controllerPads: number;
  items: DiagnosticsSummaryItem[];
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read-only, defensive aggregation of a diagnostics snapshot into a short,
 * human-readable summary. Every count is taken as-is; anything unreadable is
 * reported as unknown instead of being coerced.
 */
export function summarizeDiagnostics(snapshot: DiagnosticsSnapshot): DiagnosticsSummary {
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : [];
  const operations = Array.isArray(snapshot?.sessionOperations) ? snapshot.sessionOperations : [];
  const pendingOperations = operations.filter((operation) => operation?.status === "pending").length;
  const launches = snapshot?.launchRegistry;
  const activeLaunches = num(launches?.activeSessions) ?? (Array.isArray(launches?.sessions) ? launches.sessions.length : 0);
  const windows = snapshot?.windowBroker;
  const trackedWindows = Array.isArray(windows?.trackedWindows) ? windows.trackedWindows.length : 0;
  const displays = Array.isArray(snapshot?.displayAudio?.displays) ? snapshot.displayAudio.displays.length : 0;
  const audioEndpoints = Array.isArray(snapshot?.displayAudio?.audio) ? snapshot.displayAudio.audio.length : 0;
  const controllerPads = Array.isArray(snapshot?.nativeController?.pads) ? snapshot.nativeController.pads.length : 0;

  const build = snapshot?.build;
  const buildLabel = [str(build?.version), str(build?.target), str(build?.profile)]
    .filter((part): part is string => part !== null)
    .join(" · ") || "nieznany build";

  const controlService = snapshot?.controlService;
  const controlRunning = controlService?.running === true;
  const controlWindows = controlService?.windows === true;

  const remote = snapshot?.remote;
  const remoteEnabled = remote?.enabled === true;

  const items: DiagnosticsSummaryItem[] = [
    {
      id: "build",
      label: "Build",
      state: build?.windows === true ? "ok" : "unknown",
      detail: buildLabel,
    },
    {
      id: "session",
      label: "Sesja",
      state: str(snapshot?.session?.current) ? "ok" : "unknown",
      detail: str(snapshot?.session?.current)
        ? `${snapshot.session.current} · stan ${num(snapshot.session.revision) ?? "?"}`
        : "stan sesji nieznany",
    },
    {
      id: "operations",
      label: "Operacje sesji",
      state: pendingOperations > 0 ? "warning" : "ok",
      detail: `${pendingOperations} oczekujących`,
    },
    {
      id: "launches",
      label: "Uruchomienia",
      state: activeLaunches > 0 ? "ok" : "unknown",
      detail: `${activeLaunches} aktywnych`,
    },
    {
      id: "windows",
      label: "Okna",
      state: windows?.windows === true ? "ok" : "unknown",
      detail: `${trackedWindows} śledzonych · pierwszy plan: ${str(windows?.foreground?.processName) ?? "brak"}`,
    },
    {
      id: "control-service",
      label: "Control Service",
      state: !controlWindows ? "unknown" : controlRunning ? "ok" : "warning",
      detail: !controlWindows
        ? "niedostępny poza Windows"
        : controlRunning
          ? `aktywny · kontrolery HID: ${num(controlService.controllerCount) ?? 0}`
          : "wyłączony",
    },
    {
      id: "controller",
      label: "Kontroler natywny",
      state: snapshot?.nativeController?.supported === true ? "ok" : "unknown",
      detail: snapshot?.nativeController?.supported === true
        ? `${controllerPads} pad(y) · powrót Home: ${snapshot.nativeController.homeEnabled ? "włączony" : "wyłączony"}`
        : "niedostępny na tej platformie",
    },
    {
      id: "display-audio",
      label: "Wyświetlacze i audio",
      state: snapshot?.displayAudio?.windows === true && displays > 0 ? "ok" : snapshot?.displayAudio?.windows === true ? "warning" : "unknown",
      detail: `${displays} wyświetlaczy · ${audioEndpoints} punktów audio`,
    },
    {
      id: "remote",
      label: "Pilot zdalny",
      state: !remote ? "unknown" : remoteEnabled ? (remote.recoveryRequired === true ? "error" : "ok") : remote.recoveryRequired === true ? "error" : "ok",
      detail: remote
        ? `${remoteEnabled ? "włączony" : "wyłączony"} · urządzenia: ${num(remote.pairedDeviceCount) ?? 0}${remote.recoveryRequired === true ? " · wymagane odzyskiwanie" : ""}`
        : "stan nieznany",
    },
    {
      id: "errors",
      label: "Wykryte problemy",
      state: errors.length > 0 ? "error" : "ok",
      detail: errors.length > 0 ? `${errors.length} wpis(ów) w dzienniku błędów` : "brak zgłoszonych błędów",
    },
  ];

  return {
    generatedAtMs: num(snapshot?.generatedAtMs) ?? 0,
    buildLabel,
    errorCount: errors.length,
    pendingOperations,
    activeLaunches,
    trackedWindows,
    displays,
    audioEndpoints,
    controllerPads,
    items,
  };
}

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
