/**
 * VELORA 1.0 — Ecosystem / typowane zdarzenia (moduł F / B / C / E).
 *
 * Zdarzenia są KONTRAKTEM dla przyszłej integracji z `WindowBroker` /
 * `SessionOrchestrator` (dziedzina DeepSeeka). VELORA nie implementuje tych
 * modułów — udostępnia jedynie stabilne nazwy i ładunki, które późniejszy
 * broker może emitować bez przebudowy frontendu.
 */

import type { LibrarySource } from "./domain";
import type { VeloraError } from "./errors";
import type { AppControlSession, CinemaSession } from "./session";

export const VELORA_EVENTS = {
  libraryChanged: "velora://library-changed",
  cinemaSessionChanged: "velora://cinema-session-changed",
  cinemaExited: "velora://cinema-exited",
  cinemaCloseRequested: "velora://cinema-close-requested",
  appControlSessionChanged: "velora://app-control-session-changed",
  remoteStateChanged: "velora://remote-state-changed",
  remoteCommandEnvelope: "velora://remote-command-envelope",
  remoteCommandAck: "velora://remote-command-ack",
} as const;

export type VeloraEventName = (typeof VELORA_EVENTS)[keyof typeof VELORA_EVENTS];

export interface TypedEvent<TPayload> {
  readonly name: VeloraEventName;
  readonly payload: TPayload;
  readonly emittedAt: string;
}

export interface LibraryChangedPayload {
  readonly source: LibrarySource;
  readonly gameCount: number;
}

export interface CinemaSessionChangedPayload {
  readonly session: CinemaSession;
}

export interface CinemaExitedPayload {
  readonly sessionId: string;
  readonly reason: "closed" | "error";
}

export interface CinemaCloseRequestedPayload {
  readonly sessionId: string;
  readonly confirmed: boolean;
}

export interface AppControlSessionChangedPayload {
  readonly session: AppControlSession;
}

export type RemoteState =
  | "disconnected"
  | "pairing"
  | "paired"
  | "reconnecting"
  | "offline"
  | "error";

export interface RemoteStateChangedPayload {
  readonly state: RemoteState;
  readonly attempt: number;
  readonly reason: VeloraError | null;
}

/**
 * Otoczka polecenia pilota. `signature` jest istniejącym podpisem HMAC-SHA256
 * wyliczanym nad `NEXUS-AUREA-REMOTE-V1\n{deviceId}\n{sequence}\n{command}` —
 * formatu NIE wolno zmieniać. `commandId` jest wyprowadzany deterministycznie
 * z (deviceId, sequence) i służy wyłącznie korelacji potwierdzenia.
 */
export interface RemoteCommandEnvelope {
  readonly command: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly commandId: string;
  readonly signature: string;
}

export interface RemoteCommandAckPayload {
  readonly commandId: string;
  readonly executed: boolean;
  readonly error: VeloraError | null;
}

export function typedEvent<TPayload>(
  name: VeloraEventName,
  payload: TPayload,
  emittedAt = "",
): TypedEvent<TPayload> {
  return { name, payload, emittedAt };
}

export function isVeloraEventName(value: string): value is VeloraEventName {
  return (Object.values(VELORA_EVENTS) as string[]).includes(value);
}
