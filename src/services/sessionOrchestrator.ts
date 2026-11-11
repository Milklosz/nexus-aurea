import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SessionId = "veloraHome" | "game" | "playnite" | "cinema" | "desktop" | "ambient";

export type TransitionCause =
  | "user"
  | "gamepadHome"
  | "controlService"
  | "launch"
  | "processExit"
  | "system";

export type SessionContext = {
  launchId?: string;
  appId?: string;
  processId?: number;
};

export type SessionSnapshot = {
  current: SessionId;
  previous: SessionId | null;
  revision: number;
  transitionedAtMs: number;
  context: SessionContext | null;
  allowedTargets: SessionId[];
};

export type RestoreResult = {
  attempted: boolean;
  restored: boolean;
  outcome:
    | "restored"
    | "alreadyFocused"
    | "blockedUnsafeForeground"
    | "blockedByWindows"
    | "windowUnavailable"
    | "unsupportedPlatform";
  reason: "userRequest" | "sessionEnded" | "manual";
  ownWindow: number | null;
  foregroundBefore: {
    hwnd: number | null;
    processId: number | null;
    processName: string | null;
    className: string | null;
    windowPresent: boolean;
  };
  foregroundAfter: {
    hwnd: number | null;
    processId: number | null;
    processName: string | null;
    className: string | null;
    windowPresent: boolean;
  };
  errorCode: number | null;
  message: string;
};

export type SessionChangedEvent = {
  from: SessionId;
  to: SessionId;
  cause: TransitionCause;
  context: SessionContext | null;
  revision: number;
  atMs: number;
};

export type ReturnHomeEvent = {
  cause: TransitionCause;
  session: SessionSnapshot;
  restore: RestoreResult;
};

export type ReturnHomeResult = {
  session: SessionSnapshot;
  restore: RestoreResult;
};

export type TransitionRequest = {
  target: SessionId;
  cause: TransitionCause;
  context?: SessionContext;
};

const browserSession: SessionSnapshot = {
  current: "veloraHome",
  previous: null,
  revision: 0,
  transitionedAtMs: 0,
  context: null,
  allowedTargets: ["game", "playnite", "cinema", "desktop", "ambient"],
};

export async function getSessionState(): Promise<SessionSnapshot> {
  if (!isTauri()) return browserSession;
  return invoke<SessionSnapshot>("get_session_state");
}

export async function requestSessionTransition(request: TransitionRequest): Promise<SessionSnapshot> {
  if (!isTauri()) {
    return { ...browserSession, current: request.target };
  }
  return invoke<SessionSnapshot>("request_session_transition", { request });
}

export async function returnVeloraHome(): Promise<ReturnHomeResult> {
  if (!isTauri()) {
    return {
      session: browserSession,
      restore: {
        attempted: false,
        restored: false,
        outcome: "unsupportedPlatform",
        reason: "userRequest",
        ownWindow: null,
        foregroundBefore: { hwnd: null, processId: null, processName: null, className: null, windowPresent: false },
        foregroundAfter: { hwnd: null, processId: null, processName: null, className: null, windowPresent: false },
        errorCode: null,
        message: "Przywracanie okna wymaga natywnej aplikacji Windows.",
      },
    };
  }
  return invoke<ReturnHomeResult>("return_velora_home");
}

export async function listenForSessionChange(
  callback: (event: SessionChangedEvent) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<SessionChangedEvent>("velora-session-changed", (event) => callback(event.payload));
}

export async function listenForReturnHome(
  callback: (event: ReturnHomeEvent) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<ReturnHomeEvent>("velora-return-home", (event) => callback(event.payload));
}
