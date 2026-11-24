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
  launch_playnite_game: {
    name: "launch_playnite_game",
    args: ["gameId"],
    returns: "Result<PlayniteLaunchReceipt, String> — tylko kanoniczne playnite://playnite/start/<guid>",
    sideEffect: "launch",
    since: "velora-v1",
  },

  // --- Sesje i okna (jeden właściciel: SessionOrchestrator) ---
  get_session_state: {
    name: "get_session_state",
    args: [],
    returns: "SessionSnapshot",
    sideEffect: "read-only",
    since: "v1-core",
  },
  request_session_transition: {
    name: "request_session_transition",
    args: ["request"],
    returns: "Result<SessionSnapshot, SessionError>",
    sideEffect: "write",
    since: "v1-core",
  },
  return_velora_home: {
    name: "return_velora_home",
    args: [],
    returns: "Result<ReturnHomeResult, SessionError>",
    sideEffect: "write",
    since: "v1-core",
  },
  get_session_operations: {
    name: "get_session_operations",
    args: [],
    returns: "SessionOperation[]",
    sideEffect: "read-only",
    since: "v1-system-intelligence",
  },
  cancel_session_operation: {
    name: "cancel_session_operation",
    args: ["operationId"],
    returns: "SessionOperation | null",
    sideEffect: "write",
    since: "v1-system-intelligence",
  },
  get_window_broker_status: {
    name: "get_window_broker_status",
    args: [],
    returns: "WindowBrokerSnapshot",
    sideEffect: "read-only",
    since: "v1-core",
  },
  restore_velora_window: {
    name: "restore_velora_window",
    args: [],
    returns: "RestoreResult",
    sideEffect: "write",
    since: "v1-core",
  },
  get_launch_registry_status: {
    name: "get_launch_registry_status",
    args: [],
    returns: "LaunchRegistrySnapshot",
    sideEffect: "read-only",
    since: "v1-core",
  },
  cancel_launch_session: {
    name: "cancel_launch_session",
    args: ["launchId"],
    returns: "Result<LaunchSession, String>",
    sideEffect: "write",
    since: "v1-core",
  },

  // --- Diagnostics / display-audio (read-only) ---
  get_display_audio_status: {
    name: "get_display_audio_status",
    args: [],
    returns: "DisplayAudioSnapshot",
    sideEffect: "read-only",
    since: "v1-system-intelligence",
  },
  get_diagnostics_snapshot: {
    name: "get_diagnostics_snapshot",
    args: [],
    returns: "DiagnosticsSnapshot",
    sideEffect: "read-only",
    since: "v1-system-intelligence",
  },
  export_diagnostics_report: {
    name: "export_diagnostics_report",
    args: [],
    returns: "Result<DiagnosticsExport, String>",
    sideEffect: "write",
    since: "v1-system-intelligence",
  },

  // --- Edge Cinema (B) ---
  launch_edge_cinema: {
    name: "launch_edge_cinema",
    args: ["url"],
    returns: "Result<EdgeCinemaReceipt, String> — receipt zawiera launchId i adopted",
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

  // --- VELORA 3.0 genesis (promoted from forward-looking at integration) ---
  // S3.2 Gaming Hub (Agent B): read-only Steam library + canonical steam:// launch.
  get_steam_library: {
    name: "get_steam_library",
    args: [],
    returns: "Result<SteamLibrarySnapshot, String> (read-only appmanifest/libraryfolders VDF; no credential/save/DRM access)",
    sideEffect: "read-only",
    since: "velora-3-genesis",
  },
  launch_steam_game: {
    name: "launch_steam_game",
    args: ["appid"],
    returns: "Result<SteamLaunchReceipt, String> — canonical steam://run/<appid> only; never kills a process",
    sideEffect: "launch",
    since: "velora-3-genesis",
  },
  get_game_process_state: {
    name: "get_game_process_state",
    args: ["id"],
    returns: "Result<GameProcessState, String> (observation-only; never kills the process)",
    sideEffect: "read-only",
    since: "velora-3-genesis",
  },
  // S3.4 Reliability (Agent D): read-only WebView2 working-set watch.
  get_memory_watch_status: {
    name: "get_memory_watch_status",
    args: [],
    returns: "MemoryWatchStatus (read-only working-set sample; no GC API, no process action)",
    sideEffect: "read-only",
    since: "velora-3-genesis",
  },

  // --- S3.16 integration backfill: handlers registered in generate_handler![...]
  // that predate the contract register (documented from the Rust signatures and
  // the `src/services/*` call sites; see scripts/ipc-contract-node-check.mjs,
  // which enforces exact set equality with the handler registry). ---
  // --- Audio, TV mode, platform launchers, lifecycle ---
  get_system_audio: {
    name: "get_system_audio",
    args: [],
    returns: "Result<AudioEndpointInfo, String> — bounded endpoint hash, nigdy ścieżka/nazwa urządzenia",
    sideEffect: "read-only",
    since: "v1-core",
  },
  set_system_audio_volume: {
    name: "set_system_audio_volume",
    args: ["percent", "expectedEndpointId"],
    returns: "Result<AudioEndpointInfo, String> — odrzuca poza zakresem i niezgodny endpoint",
    sideEffect: "write",
    since: "v1-core",
  },
  set_system_audio_mute: {
    name: "set_system_audio_mute",
    args: ["muted", "expectedEndpointId"],
    returns: "Result<AudioEndpointInfo, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  get_tv_mode_status: {
    name: "get_tv_mode_status",
    args: [],
    returns: "Result<TvModeStatus, String>",
    sideEffect: "read-only",
    since: "v1-core",
  },
  set_tv_mode: {
    name: "set_tv_mode",
    args: ["displayId", "fullscreen"],
    returns: "Result<TvModeStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  get_platform_launcher_status: {
    name: "get_platform_launcher_status",
    args: [],
    returns: "PlatformLauncherStatus",
    sideEffect: "read-only",
    since: "v1-core",
  },
  launch_platform: {
    name: "launch_platform",
    args: ["launcher"],
    returns: "Result<void, String> — wyłącznie platformy z listy",
    sideEffect: "launch",
    since: "v1-core",
  },
  exit_velora: {
    name: "exit_velora",
    args: [],
    returns: "void — zamknięcie aplikacji na życzenie użytkownika",
    sideEffect: "close-request",
    since: "v1-core",
  },
  restart_velora: {
    name: "restart_velora",
    args: [],
    returns: "void — restart aplikacji",
    sideEffect: "write",
    since: "v1-core",
  },

  // --- Sesje zarządzane (velora_session_manager) ---
  get_managed_sessions: {
    name: "get_managed_sessions",
    args: [],
    returns: "ManagedSessionsSnapshot",
    sideEffect: "read-only",
    since: "v1-core",
  },
  resume_managed_session: {
    name: "resume_managed_session",
    args: ["sessionId"],
    returns: "Result<ManagedSessionActionResult, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  close_managed_session: {
    name: "close_managed_session",
    args: ["sessionId", "confirm"],
    returns: "Result<ManagedSessionActionResult, String> — żądanie zamknięcia z potwierdzeniem",
    sideEffect: "close-request",
    since: "v1-core",
  },

  // --- Kontroler natywny (pad_hub) ---
  get_native_controller_status: {
    name: "get_native_controller_status",
    args: [],
    returns: "NativeControllerStatus",
    sideEffect: "read-only",
    since: "v1-core",
  },
  set_controller_home_enabled: {
    name: "set_controller_home_enabled",
    args: ["enabled"],
    returns: "Result<NativeControllerStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  get_controller_fallback_status: {
    name: "get_controller_fallback_status",
    args: [],
    returns: "ControllerFallbackStatus",
    sideEffect: "read-only",
    since: "v1-core",
  },
  configure_controller_fallback: {
    name: "configure_controller_fallback",
    args: ["config"],
    returns: "Result<ControllerFallbackStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },

  // --- Streaming control & nawigacja TV (streaming_control) ---
  get_streaming_control_status: {
    name: "get_streaming_control_status",
    args: [],
    returns: "StreamingControlStatus",
    sideEffect: "read-only",
    since: "v1-core",
  },
  configure_streaming_control: {
    name: "configure_streaming_control",
    args: ["enabled", "pointerMode"],
    returns: "Result<StreamingControlStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  get_tv_navigation_status: {
    name: "get_tv_navigation_status",
    args: [],
    returns: "TvNavigationStatus",
    sideEffect: "read-only",
    since: "v1-core",
  },
  configure_tv_navigation: {
    name: "configure_tv_navigation",
    args: ["enabled", "mode"],
    returns: "Result<TvNavigationStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  set_tv_navigation_mode: {
    name: "set_tv_navigation_mode",
    args: ["mode"],
    returns: "Result<TvNavigationStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  set_tv_navigation_media_controls: {
    name: "set_tv_navigation_media_controls",
    args: ["armed", "sessionId"],
    returns: "Result<TvNavigationStatus, String> — akcje multimedialne tylko w ramach sesji",
    sideEffect: "write",
    since: "v1-core",
  },
  capture_tv_navigation_target: {
    name: "capture_tv_navigation_target",
    args: ["sessionId"],
    returns: "Result<TvNavigationStatus, String> — capture z gatingiem sesji i generacją",
    sideEffect: "write",
    since: "v1-core",
  },
  simulate_tv_navigation_action: {
    name: "simulate_tv_navigation_action",
    args: ["action", "sequence", "generation", "targetSession", "deltaX", "deltaY"],
    returns: "Result<NavigationActionReceipt, String> — numerowane, generacyjne, z limitem budżetu akcji",
    sideEffect: "write",
    since: "v1-core",
  },
  cancel_tv_navigation_simulation: {
    name: "cancel_tv_navigation_simulation",
    args: [],
    returns: "Result<TvNavigationStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },

  // --- Couch Control (control_service) ---
  get_control_service_status: {
    name: "get_control_service_status",
    args: [],
    returns: "ControlServiceStatus",
    sideEffect: "read-only",
    since: "v1-core",
  },
  start_control_service: {
    name: "start_control_service",
    args: [],
    returns: "Result<ControlServiceStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  stop_control_service: {
    name: "stop_control_service",
    args: [],
    returns: "Result<ControlServiceStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  set_control_game_mode: {
    name: "set_control_game_mode",
    args: ["enabled"],
    returns: "Result<ControlServiceStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },
  get_fallback_hotkey_options: {
    name: "get_fallback_hotkey_options",
    args: [],
    returns: "FallbackHotkey[]",
    sideEffect: "read-only",
    since: "v1-core",
  },
  set_fallback_hotkey: {
    name: "set_fallback_hotkey",
    args: ["id"],
    returns: "Result<ControlServiceStatus, String>",
    sideEffect: "write",
    since: "v1-core",
  },

  // --- iPhone Remote (C): zaufanie i odzyskiwanie (istniejący protokół bez zmian) ---
  begin_remote_trust_approval: {
    name: "begin_remote_trust_approval",
    args: [],
    returns: "Result<String, String> — jednorazowy token zatwierdzenia zaufania",
    sideEffect: "write",
    since: "v0.9.2",
  },
  inspect_remote_trust_profile: {
    name: "inspect_remote_trust_profile",
    args: [],
    returns: "Result<RemoteTrustProfilePreview, String>",
    sideEffect: "read-only",
    since: "v0.9.2",
  },
  prepare_remote_trust_profile: {
    name: "prepare_remote_trust_profile",
    args: ["approvalToken"],
    returns: "Result<RemoteAccessStatus, String>",
    sideEffect: "write",
    since: "v0.9.2",
  },
  cleanup_remote_trust_artifacts: {
    name: "cleanup_remote_trust_artifacts",
    args: ["approvalToken"],
    returns: "Result<RemoteTrustCleanupReport, String>",
    sideEffect: "write",
    since: "v0.9.2",
  },
  stop_remote_access: {
    name: "stop_remote_access",
    args: [],
    returns: "RemoteAccessStatus",
    sideEffect: "write",
    since: "v0.9.2",
  },
  revoke_all_remote_devices: {
    name: "revoke_all_remote_devices",
    args: [],
    returns: "Result<RemoteAccessStatus, String>",
    sideEffect: "write",
    since: "v0.9.2",
  },
  inspect_remote_recovery: {
    name: "inspect_remote_recovery",
    args: [],
    returns: "Result<RemoteRecoveryPlan, String>",
    sideEffect: "read-only",
    since: "v0.9.2",
  },
  run_remote_recovery: {
    name: "run_remote_recovery",
    args: ["mode", "confirmation"],
    returns: "Result<RemoteAccessStatus, String>",
    sideEffect: "write",
    since: "v0.9.2",
  },

  // --- Menedżer aplikacji/gier, muzyka, usage widget (velora-2) ---
  get_app_manager_status: {
    name: "get_app_manager_status",
    args: [],
    returns: "Result<AppManagerSnapshot, String>",
    sideEffect: "read-only",
    since: "velora-2",
  },
  get_gaming_diagnostics: {
    name: "get_gaming_diagnostics",
    args: [],
    returns: "Result<GamingDiagnostics, String>",
    sideEffect: "read-only",
    since: "velora-2",
  },
  launch_managed_app: {
    name: "launch_managed_app",
    args: ["id"],
    returns: "Result<LaunchReceipt, String>",
    sideEffect: "launch",
    since: "velora-2",
  },
  launch_managed_game: {
    name: "launch_managed_game",
    args: ["id"],
    returns: "Result<ManagedGameLaunchReceipt, String>",
    sideEffect: "launch",
    since: "velora-2",
  },
  get_apple_music_status: {
    name: "get_apple_music_status",
    args: [],
    returns: "AppleMusicStatus",
    sideEffect: "read-only",
    since: "velora-2",
  },
  control_apple_music: {
    name: "control_apple_music",
    args: ["action"],
    returns: "Result<void, String>",
    sideEffect: "write",
    since: "velora-2",
  },
  adjust_system_volume: {
    name: "adjust_system_volume",
    args: ["action"],
    returns: "Result<void, String>",
    sideEffect: "write",
    since: "velora-2",
  },
  get_claude_usage: {
    name: "get_claude_usage",
    args: ["manual"],
    returns: "Result<UsageSnapshot, String> — poza Tauri zwraca wyłącznie jawny `unsupported`",
    sideEffect: "read-only",
    since: "velora-2",
  },
} as const satisfies Record<string, IpcDescriptor>;

export type IpcCommandName = keyof typeof IPC_COMMANDS;

export function isIpcCommandName(value: string): value is IpcCommandName {
  return Object.prototype.hasOwnProperty.call(IPC_COMMANDS, value);
}

export function ipcDescriptor(name: string): IpcDescriptor | null {
  return isIpcCommandName(name) ? IPC_COMMANDS[name] : null;
}

/**
 * ---------------------------------------------------------------------------
 * FORWARD-LOOKING ENTRIES — VELORA 3.0 genesis workstreams S3.1–S3.4.
 *
 * At integration the S3.2/S3.4 commands (get_steam_library, launch_steam_game,
 * get_game_process_state, get_memory_watch_status) were PROMOTED into
 * `IPC_COMMANDS` above because their handlers now exist in
 * `src-tauri/src/lib.rs`. This export is kept as an empty reserved slot for any
 * future additive command that an agent documents before its handler lands;
 * existing `IPC_COMMANDS` entries are never modified or removed.
 * ---------------------------------------------------------------------------
 */
export const FORWARD_LOOKING_IPC_COMMANDS = {} as const satisfies Record<string, IpcDescriptor>;

export type ForwardLookingIpcCommandName = keyof typeof FORWARD_LOOKING_IPC_COMMANDS;
