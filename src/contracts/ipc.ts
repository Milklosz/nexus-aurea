/**
 * VELORA 1.0 — Ecosystem / dokumentacja IPC jako kod (moduł F).
 *
 * Jeden, typowany rejestr komend Tauri `invoke()`. Argumenty i zwracane
 * kształty są opisane deklaratywnie, aby przyszły frontend mógł zostać
 * przebudowany bez zgadywania nazw komend i bez zmian w backendzie.
 *
 * UWAGA: to jest dokumentacja/kontrakt, a nie klient IPC. Wywołania wykonują
 * istniejące serwisy (`src/services/*`) przez `invoke()` z `@tauri-apps/api/core`.
 */

export type IpcSideEffect =
  | "read-only"
  | "write"
  | "launch"
  | "close-request"
  | "event";

export interface IpcDescriptor {
  readonly name: string;
  readonly args: readonly string[];
  readonly returns: string;
  readonly sideEffect: IpcSideEffect;
  readonly since: string;
}

export const IPC_COMMANDS = {
  // --- Playnite Library (A) ---
  get_playnite_library: {
    name: "get_playnite_library",
    args: [],
    returns: "PlayniteLibrarySnapshot (source|available|reason|games|readOnly)",
    sideEffect: "read-only",
    since: "v1-experience",
  },
  get_playnite_manifest: {
    name: "get_playnite_manifest",
    args: [],
    returns: "Result<PlayniteManifestView, String> — pełny, typowany widok manifestu",
    sideEffect: "read-only",
    since: "v1-ecosystem",
  },

  // --- Edge Cinema (B) ---
  launch_edge_cinema: {
    name: "launch_edge_cinema",
    args: ["url"],
    returns: "Result<EdgeCinemaReceipt, String>",
    sideEffect: "launch",
    since: "v1-experience",
  },
  get_edge_cinema_status: {
    name: "get_edge_cinema_status",
    args: [],
    returns: "EdgeCinemaStatus (środowisko: OS/Edge/profil)",
    sideEffect: "read-only",
    since: "v1-experience",
  },
  get_edge_cinema_session: {
    name: "get_edge_cinema_session",
    args: [],
    returns: "EdgeCinemaSession (diagnostyka sesji: status|pid|sessionId|lastError)",
    sideEffect: "read-only",
    since: "v1-ecosystem",
  },
  request_edge_cinema_close: {
    name: "request_edge_cinema_close",
    args: ["sessionId", "confirm"],
    returns: "Result<EdgeCinemaSession, String> — emituje zdarzenie, NIE zabija procesu",
    sideEffect: "close-request",
    since: "v1-ecosystem",
  },
  report_edge_cinema_exit: {
    name: "report_edge_cinema_exit",
    args: ["sessionId"],
    returns: "Result<EdgeCinemaSession, String> — adapter wykrycia zamknięcia",
    sideEffect: "event",
    since: "v1-ecosystem",
  },
  reset_edge_cinema_session: {
    name: "reset_edge_cinema_session",
    args: [],
    returns: "EdgeCinemaSession — recovery po restarcie VELORA",
    sideEffect: "write",
    since: "v1-ecosystem",
  },

  // --- Autostart & Recovery (D) ---
  get_autostart_status: {
    name: "get_autostart_status",
    args: [],
    returns: "AutostartStatus",
    sideEffect: "read-only",
    since: "v1-experience",
  },
  set_autostart_enabled: {
    name: "set_autostart_enabled",
    args: ["enabled", "windowed"],
    returns: "Result<AutostartStatus, String> — jedyny zapis: HKCU ...\\Run /v VELORA",
    sideEffect: "write",
    since: "v1-experience",
  },
  get_startup_mode: {
    name: "get_startup_mode",
    args: [],
    returns: "StartupMode",
    sideEffect: "read-only",
    since: "v1-experience",
  },
  get_autostart_diagnostics: {
    name: "get_autostart_diagnostics",
    args: [],
    returns: "AutostartDiagnostics (healthy|issues|pathValid|commandValid)",
    sideEffect: "read-only",
    since: "v1-ecosystem",
  },
  get_autostart_recovery: {
    name: "get_autostart_recovery",
    args: [],
    returns: "AutostartRecoveryReport (stale entry po restarcie/aktualizacji)",
    sideEffect: "read-only",
    since: "v1-ecosystem",
  },

  // --- iPhone Remote (C) — komendy istniejące, bez zmian protokołu ---
  get_remote_access_status: {
    name: "get_remote_access_status",
    args: [],
    returns: "RemoteAccessStatus",
    sideEffect: "read-only",
    since: "v0.9.2",
  },
  start_remote_access: {
    name: "start_remote_access",
    args: ["trustConfirmed"],
    returns: "Result<RemoteAccessStatus, String>",
    sideEffect: "launch",
    since: "v0.9.2",
  },
  begin_remote_pairing: {
    name: "begin_remote_pairing",
    args: [],
    returns: "Result<RemoteAccessStatus, String>",
    sideEffect: "write",
    since: "v0.9.2",
  },
  revoke_remote_device: {
    name: "revoke_remote_device",
    args: ["deviceId"],
    returns: "Result<RemoteAccessStatus, String>",
    sideEffect: "write",
    since: "v0.9.2",
  },
} as const satisfies Record<string, IpcDescriptor>;

export type IpcCommandName = keyof typeof IPC_COMMANDS;

export function isIpcCommandName(value: string): value is IpcCommandName {
  return Object.prototype.hasOwnProperty.call(IPC_COMMANDS, value);
}

export function ipcDescriptor(name: string): IpcDescriptor | null {
  return isIpcCommandName(name) ? IPC_COMMANDS[name] : null;
}
