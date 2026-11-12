/**
 * VELORA 1.0 — Ecosystem / granice adapterów danych i akcji (moduł F).
 *
 * Wzorzec z `playniteLibrary.ts` (`PlayniteLibraryAdapter`) uogólniony do
 * wspólnego kontraktu. `prototype: true` w deskryptorze oznacza adapter
 * przygotowany do przyszłej integracji, a nie uruchomioną integrację —
 * raport końcowy rozróżnia obie kategorie.
 */

import type { ActionAck, VeloraAction } from "./actions";
import type { VeloraLibrarySnapshot } from "./domain";
import type { RemoteCommandEnvelope, TypedEvent } from "./events";
import type { AppControlSession, CinemaSession } from "./session";

export interface DataAdapter<T> {
  readonly id: string;
  read(): Promise<T>;
}

export interface LibraryAdapter<TGame> extends DataAdapter<VeloraLibrarySnapshot<TGame>> {
  readonly source: string;
}

/** Adapter cyklu życia Edge Cinema — NIE jest to WindowBroker. */
export interface CinemaLifecycleAdapter {
  readonly id: string;
  getSession(): Promise<CinemaSession>;
  requestClose(sessionId: string): Promise<ActionAck>;
  markExited(sessionId: string): Promise<CinemaSession>;
  subscribe(listener: (event: TypedEvent<unknown>) => void): () => void;
}

/** Adapter sterowania aplikacjami z kanapy (Home → apka → zamknięcie → Home). */
export interface AppControlAdapter {
  readonly id: string;
  dispatch(action: VeloraAction): Promise<ActionAck>;
  getSession(): Promise<AppControlSession>;
  subscribe(listener: (event: TypedEvent<unknown>) => void): () => void;
}

/** Adapter transportu iPhone Remote (bez zmiany HMAC / replay / TLS). */
export interface RemoteTransportAdapter {
  readonly id: string;
  send(envelope: RemoteCommandEnvelope): Promise<ActionAck>;
  subscribe(listener: (event: TypedEvent<unknown>) => void): () => void;
}

export type AdapterKind = "library" | "cinema" | "app-control" | "remote";

export interface AdapterDescriptor {
  readonly id: string;
  readonly kind: AdapterKind;
  /** `true` = kontrakt/prototyp, nieuruchomiona integracja produkcyjna. */
  readonly prototype: boolean;
}
