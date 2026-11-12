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
  sessionRevision?: number;
};

export type RecoveryReason = "unexpectedExit" | "cleanRestart" | "corruptState" | "orphanedLaunch";

export type SessionRecovery = {
  recoveredAtMs: number;
  previousSession: SessionId;
  previousRevision: number;
  reason: RecoveryReason;
  message: string;
};

export type SessionSnapshot = {
  current: SessionId;
  previous: SessionId | null;
  revision: number;
  transitionedAtMs: number;
  context: SessionContext | null;
  allowedTargets: SessionId[];
  recovery?: SessionRecovery | null;
};

export type SessionErrorCode =
  | "invalidTransition"
  | "internalStateUnavailable"
  | "staleRevision"
  | "expiredCommand"
  | "invalidCommand"
  | "cancelled";

export type SessionError = {
  code: SessionErrorCode;
  message: string;
  from: SessionId;
  target: SessionId;
  currentRevision: number;
  allowedTargets: SessionId[];
};

export type SessionOperation = {
  id: string;
  kind: "returnHome";
  status: "pending" | "completed" | "cancelled" | "timedOut";
  startedAtMs: number;
  deadlineAtMs: number;
  finishedAtMs: number | null;
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
  denial?: "foregroundLock" | "accessDenied" | "invalidWindow" | "notFocused" | "unknown" | null;
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
  operationId: string;
  timedOut: boolean;
};

export type TransitionRequest = {
  target: SessionId;
  cause: TransitionCause;
  context?: SessionContext;
  commandId?: string;
  expectedRevision?: number;
  issuedAtMs?: number;
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
      operationId: "browser-preview",
      timedOut: false,
    };
  }
  return invoke<ReturnHomeResult>("return_velora_home");
}

export async function getSessionOperations(): Promise<SessionOperation[]> {
  if (!isTauri()) return [];
  return invoke<SessionOperation[]>("get_session_operations");
}

export async function cancelSessionOperation(operationId: string): Promise<SessionOperation | null> {
  if (!isTauri()) return null;
  return invoke<SessionOperation | null>("cancel_session_operation", { operationId });
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
