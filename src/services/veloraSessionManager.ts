import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ManagedSessionState = "notRunning" | "launching" | "running" | "foreground" | "background" | "unavailable" | "exited" | "failed";
export type ManagedLaunchMethod = "ownedBrowserWindow" | "steamClient" | "gameLauncher" | "playniteClient" | "managedExecutable";
export interface ManagedSession {
  sessionId: string;
  appId: string;
  applicationType: "playnite" | "steam" | "game" | "cinema" | "managedApp";
  launchMethod: ManagedLaunchMethod;
  name: string;
  state: ManagedSessionState;
  launchedAtMs: number;
  lastObservedAtMs: number;
  lastActivationAtMs: number | null;
  canResume: boolean;
  canClose: boolean;
  lastFailure: string | null;
}
export interface ManagedApplicationState { appId: string; name: string; state: ManagedSessionState; sessionId: string | null }
export interface ManagedSessionsSnapshot { supported: boolean; sessions: ManagedSession[]; applications: ManagedApplicationState[] }
export interface ManagedSessionActionResult { accepted: boolean; activated: boolean; message: string }

export const emptyManagedSessions: ManagedSessionsSnapshot = { supported: false, sessions: [], applications: [] };

export const managedSessionLabels: Record<ManagedSessionState, string> = {
  notRunning: "Nie uruchomiono przez VELORA",
  launching: "Uruchamianie", running: "Uruchomiona", foreground: "Na pierwszym planie",
  background: "W tle", unavailable: "Niedostępna", exited: "Zakończona", failed: "Błąd",
};

function boundedSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 128 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw new Error("Nieprawidłowy identyfikator sesji.");
  }
}

export async function getManagedSessions(): Promise<ManagedSessionsSnapshot> {
  if (!isTauri()) return emptyManagedSessions;
  return invoke<ManagedSessionsSnapshot>("get_managed_sessions");
}

export async function resumeManagedSession(sessionId: string): Promise<ManagedSessionActionResult> {
  boundedSessionId(sessionId);
  if (!isTauri()) throw new Error("Przywracanie sesji wymaga natywnej aplikacji Windows.");
  return invoke<ManagedSessionActionResult>("resume_managed_session", { sessionId });
}

export async function closeManagedSession(sessionId: string, confirm: boolean): Promise<ManagedSessionActionResult> {
  boundedSessionId(sessionId);
  if (!confirm) throw new Error("Potwierdź zamknięcie wybranej sesji.");
  if (!isTauri()) throw new Error("Zamykanie sesji wymaga natywnej aplikacji Windows.");
  return invoke<ManagedSessionActionResult>("close_managed_session", { sessionId, confirm });
}

/** Existing native watcher supplies notifications; no additional periodic inventory scan. */
export async function listenForManagedSessionUpdate(callback: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen("velora-launch-event", callback);
}
