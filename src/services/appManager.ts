import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ManagedApp = {
  id: string;
  name: string;
  processName: string;
  installed: boolean;
  runningInstances: number;
  focusRestoreSupported: boolean;
  lastError: string | null;
};

export type ManagedGame = { id: string; name: string; launcher: string };

export type AppManagerSnapshot = {
  windows: boolean;
  foregroundProcess: string | null;
  apps: ManagedApp[];
  games: ManagedGame[];
  gamesError: string | null;
};

export type GamingDiagnostics = {
  windows: boolean;
  playniteDetected: boolean;
  gogGalaxyDetected: boolean;
  gogGalaxyRunningInstances: number | null;
  gogGalaxyProcessError: string | null;
  cyberpunkInstallDetected: boolean;
  diskSpace: Array<{
    drive: string;
    availableBytes: number | null;
    totalBytes: number | null;
    error: string | null;
  }>;
  diskSpaceError: string | null;
};

export type LaunchReceipt = {
  id: string;
  alreadyRunning: boolean;
  focusRestoreSupported: boolean;
};

export type ManagedAppExit = {
  id: string;
  foregroundProcess: string | null;
  shouldFocus: boolean;
};

export type LaunchEventPayload = {
  previousPhase: string;
  atMs: number;
  session: {
    id: string;
    kind: string;
    displayName: string;
    appId: string | null;
    phase: string;
    error: string | null;
    attention: string | null;
  };
};

export type ManagedAppId = "steamBigPicture" | "appleMusic" | "playniteFullscreen" | "chrome" | "edge" | "firefox";

function userFacingManagedAppError(message: string): string {
  const spawnFailure = message.match(/^Windows nie uruchomił aplikacji (.+?):\s*(.*)$/i);
  if (!spawnFailure) return message;

  const appName = spawnFailure[1].trim();
  const osError = spawnFailure[2].match(/\(os error (\d+)\)/i)?.[1];
  if (osError === "2") return `Nie znaleziono pliku aplikacji ${appName}. Sprawdź instalację.`;
  if (osError === "5") return `Windows odmówił uruchomienia ${appName}. Sprawdź uprawnienia.`;
  return `Nie udało się uruchomić ${appName}. Sprawdź instalację i spróbuj ponownie.`;
}

export function managedAppErrorMessage(cause: unknown, fallback = "Uruchomienie aplikacji nie powiodło się."): string {
  if (typeof cause === "string" && cause.trim()) return userFacingManagedAppError(cause);
  if (cause instanceof Error && cause.message) return userFacingManagedAppError(cause.message);
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string" && cause.message) {
    return userFacingManagedAppError(cause.message);
  }
  return fallback;
}

export const emptyAppManagerSnapshot: AppManagerSnapshot = {
  windows: false,
  foregroundProcess: null,
  apps: [],
  games: [],
  gamesError: null,
};

export async function getAppManagerStatus(): Promise<AppManagerSnapshot> {
  if (!isTauri()) return emptyAppManagerSnapshot;
  return invoke<AppManagerSnapshot>("get_app_manager_status");
}

export async function getGamingDiagnostics(): Promise<GamingDiagnostics> {
  if (!isTauri()) throw new Error("Diagnostyka wymaga natywnej aplikacji Windows.");
  return invoke<GamingDiagnostics>("get_gaming_diagnostics");
}

export async function launchManagedApp(id: ManagedAppId): Promise<LaunchReceipt> {
  if (!isTauri()) throw new Error("App Manager wymaga natywnej aplikacji Windows.");
  return invoke<LaunchReceipt>("launch_managed_app", { id });
}

export async function launchManagedGame(id: string): Promise<{ id: string; launched: boolean }> {
  const numericId = Number(id);
  if (!/^[1-9][0-9]{0,9}$/.test(id) || !Number.isSafeInteger(numericId) || numericId > 4294967295) {
    throw new Error("Nieprawidłowy identyfikator gry Steam.");
  }
  if (!isTauri()) throw new Error("Uruchamianie gier wymaga natywnego App Managera Windows.");
  return invoke<{ id: string; launched: boolean }>("launch_managed_game", { id });
}

export async function listenForManagedAppExit(callback: (exit: ManagedAppExit) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<ManagedAppExit>("managed-app-exited", event => {
    const exit = event.payload;
    if (
      typeof exit?.id === "string"
      && typeof exit.shouldFocus === "boolean"
      && (exit?.foregroundProcess === null || typeof exit.foregroundProcess === "string")
    ) {
      callback(exit);
    }
  });
}

/** Native LaunchRegistry phase events, used only for truthful failure notices. */
export async function listenForLaunchEvent(
  callback: (event: LaunchEventPayload) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<LaunchEventPayload>("velora-launch-event", event => {
    const payload = event.payload;
    const session = payload?.session;
    if (
      !session
      || typeof session.id !== "string"
      || typeof session.kind !== "string"
      || typeof session.displayName !== "string"
      || (session.appId !== null && typeof session.appId !== "string")
      || typeof session.phase !== "string"
      || (session.error !== null && typeof session.error !== "string")
      || (session.attention !== null && typeof session.attention !== "string")
    ) {
      return;
    }
    callback(payload);
  });
}
