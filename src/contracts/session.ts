/**
 * VELORA 1.0 — Ecosystem / typowane statusy sesji (moduł F).
 *
 * Umożliwia jednoznaczne rozróżnienie okna AKTYWNEGO od ZAMKNIĘTEGO oraz
 * jawne modelowanie fazy sterowania z kanapy (Home → aplikacja → zamknięcie → Home).
 */

import type { VeloraApp } from "./domain";
import type { VeloraError } from "./errors";

export type SessionStatus =
  | "idle"
  | "launching"
  | "active"
  | "closing"
  | "exited"
  | "error";

export type SessionPhase =
  | "home"
  | "app-launch"
  | "app-active"
  | "confirm-close"
  | "returning-home";

export interface CinemaSession {
  readonly sessionId: string | null;
  readonly status: SessionStatus;
  readonly appId: string;
  readonly pid: number | null;
  readonly windowTitle: string | null;
  readonly profileDir: string | null;
  readonly url: string | null;
  readonly launchedAt: string | null;
  readonly lastError: VeloraError | null;
  readonly managedByVelora: boolean;
}

export interface AppControlSession {
  readonly sessionId: string | null;
  readonly phase: SessionPhase;
  readonly app: VeloraApp | null;
  readonly closeConfirmationToken: string | null;
  readonly lastError: VeloraError | null;
}

export const IDLE_CINEMA_SESSION: CinemaSession = {
  sessionId: null,
  status: "idle",
  appId: "edge-cinema",
  pid: null,
  windowTitle: null,
  profileDir: null,
  url: null,
  launchedAt: null,
  lastError: null,
  managedByVelora: true,
};

export const HOME_APP_CONTROL_SESSION: AppControlSession = {
  sessionId: null,
  phase: "home",
  app: null,
  closeConfirmationToken: null,
  lastError: null,
};

/** Okno uznajemy za aktywne wyłącznie w fazie uruchamiania lub aktywnej. */
export function isActiveSession(session: CinemaSession): boolean {
  return session.status === "launching" || session.status === "active";
}

/** Okno uznajemy za zamknięte wyłącznie po jawnym wyjściu lub błędzie. */
export function isClosedSession(session: CinemaSession): boolean {
  return session.status === "exited" || session.status === "error";
}
