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

export type AppManagerSnapshot = {
  windows: boolean;
  foregroundProcess: string | null;
  apps: ManagedApp[];
};

export type LaunchReceipt = {
  id: string;
  alreadyRunning: boolean;
  focusRestoreSupported: boolean;
};

export type ManagedAppId = "steamBigPicture" | "appleMusic" | "playniteFullscreen" | "chrome" | "edge" | "firefox";

export function managedAppErrorMessage(cause: unknown, fallback = "Uruchomienie aplikacji nie powiodło się."): string {
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string" && cause.message) {
    return cause.message;
  }
  return fallback;
}

export const emptyAppManagerSnapshot: AppManagerSnapshot = {
  windows: false,
  foregroundProcess: null,
  apps: [],
};

export async function getAppManagerStatus(): Promise<AppManagerSnapshot> {
  if (!isTauri()) return emptyAppManagerSnapshot;
  return invoke<AppManagerSnapshot>("get_app_manager_status");
}

export async function launchManagedApp(id: ManagedAppId): Promise<LaunchReceipt> {
  if (!isTauri()) throw new Error("App Manager wymaga natywnej aplikacji Windows.");
  return invoke<LaunchReceipt>("launch_managed_app", { id });
}

export async function listenForManagedAppExit(callback: (id: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<string>("managed-app-exited", event => callback(event.payload));
}
