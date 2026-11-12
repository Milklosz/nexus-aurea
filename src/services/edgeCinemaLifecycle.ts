/**
 * VELORA 1.0 — Ecosystem / MODUŁ B: Edge Cinema Lifecycle adapter.
 *
 * The native commands are now backed by the integrated
 * `LaunchRegistry` + `WindowBroker` path. This TypeScript adapter remains a
 * thin, typed view over those commands; it is not mounted as a second session
 * owner. `prototype: true` means the UI wiring is still opt-in, not that the
 * native lifecycle is fake.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { windowMode } from "./windowMode";
import {
  IDLE_CINEMA_SESSION,
  VELORA_EVENTS,
  actionAck,
  idempotencyKey,
  isActiveSession,
  isClosedSession,
  typedEvent,
  veloraError,
  type ActionAck,
  type AdapterDescriptor,
  type CinemaLifecycleAdapter,
  type CinemaSession,
  type TypedEvent,
} from "../contracts";

/** Uczciwy deskryptor: kontrakt/prototyp, a nie uruchomiona integracja. */
export const EDGE_CINEMA_LIFECYCLE_DESCRIPTOR: AdapterDescriptor = {
  id: "edge-cinema-lifecycle",
  kind: "cinema",
  prototype: true,
};

/** camelCase mirror Rust `EdgeCinemaSession` (`state` → TS `status`). */
export type EdgeCinemaSessionWire = {
  sessionId: string | null;
  state: string;
  appId: string;
  pid: number | null;
  windowTitle: string | null;
  profileDir: string | null;
  url: string | null;
  launchedAt: string | null;
  lastError: string | null;
  managedByVelora: boolean;
};

const SESSION_STATES = [
  "idle",
  "launching",
  "active",
  "closing",
  "exited",
  "error",
] as const;

const GENERIC_LIFECYCLE_ERROR =
  "Nie udało się zrealizować operacji Edge Cinema. Spróbuj ponownie.";

function extractMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/** Usuwa znaki sterujące i ogranicza długość diagnozy. */
function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
  return cleaned.length > 0 ? cleaned : null;
}

/** Akceptuje wyłącznie jawnie dozwolone stany; wstrzyknięty `state` → "idle". */
function safeStatus(value: unknown): CinemaSession["status"] {
  if (typeof value === "string" && (SESSION_STATES as readonly string[]).includes(value)) {
    return value as CinemaSession["status"];
  }
  return "idle";
}

/**
 * Ścisła normalizacja wire → CinemaSession. NIGDY nie rzuca, zawsze zwraca
 * bezpieczny rekord. Odrzuca wstrzyknięty `state` spoza whitelisty (fallback
 * do "idle"), sanityzuje `lastError` i nie ufa pozostałym polom.
 */
export function normalizeCinemaSession(value: unknown): CinemaSession {
  const wire: Record<string, unknown> =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const optionalString = (key: string): string | null =>
    typeof wire[key] === "string" ? (wire[key] as string) : null;

  const appId = wire["appId"];
  const pidValue = wire["pid"];
  const pid =
    typeof pidValue === "number" && Number.isFinite(pidValue) && pidValue >= 0
      ? Math.trunc(pidValue)
      : null;
  const lastErrorText = safeText(wire["lastError"]);

  return {
    sessionId: optionalString("sessionId"),
    status: safeStatus(wire["state"]),
    appId: typeof appId === "string" && appId.length > 0 ? appId : "edge-cinema",
    pid,
    windowTitle: optionalString("windowTitle"),
    profileDir: optionalString("profileDir"),
    url: optionalString("url"),
    launchedAt: optionalString("launchedAt"),
    lastError: lastErrorText
      ? veloraError("edge-error", lastErrorText, true)
      : null,
    // Bezpieczny default: nie zakładamy, że VELORA zarządza nieznaną sesją.
    managedByVelora: wire["managedByVelora"] === true,
  };
}

/** Czyste, polskie mapowanie błędów (bez wycieków surowych tekstów). */
export function edgeCinemaLifecycleErrorMessage(cause: unknown): string {
  const message = extractMessage(cause);
  if (/już uruchomione|duplikat/i.test(message)) {
    return "Okno Edge Cinema jest już uruchomione. VELORA nie uruchamia duplikatu.";
  }
  if (/potwierdzenia/i.test(message)) {
    return "Zamknięcie okna Edge Cinema wymaga potwierdzenia.";
  }
  if (/nie uruchomiła VELORA|nie można jej zamknąć/i.test(message)) {
    return "Tej sesji Edge Cinema nie można zamknąć z VELORA — okno nie zostało uruchomione przez aplikację.";
  }
  if (/tylko w natywnej aplikacji Windows/i.test(message)) {
    return "Edge Cinema jest dostępne tylko w natywnej aplikacji Windows.";
  }
  if (/nie uruchomił okna|spawn/i.test(message)) {
    return "Nie udało się uruchomić okna Edge Cinema. Spróbuj ponownie.";
  }
  return GENERIC_LIFECYCLE_ERROR;
}

/** Odczyt sesji. Podgląd WWW → IDLE; błąd `invoke` → sesja w stanie error. */
export async function getEdgeCinemaSession(): Promise<CinemaSession> {
  if (!isTauri()) return IDLE_CINEMA_SESSION;
  try {
    const wire = await invoke<EdgeCinemaSessionWire>("get_edge_cinema_session");
    return normalizeCinemaSession(wire);
  } catch (cause) {
    return {
      ...IDLE_CINEMA_SESSION,
      status: "error",
      lastError: veloraError("edge-error", edgeCinemaLifecycleErrorMessage(cause), true),
    };
  }
}

/**
 * Prośba o zamknięcie (wyłącznie potwierdzona). Zwraca ActionAck; w razie
 * błędu natywnego — rejected ack z `veloraError("edge-error", ...)`.
 */
export async function requestEdgeCinemaClose(sessionId: string): Promise<ActionAck> {
  const key = idempotencyKey(["edge-close", sessionId]);
  try {
    await invoke<EdgeCinemaSessionWire>("request_edge_cinema_close", {
      sessionId,
      confirm: true,
    });
    return actionAck(sessionId, "executed", key);
  } catch (cause) {
    return actionAck(
      sessionId,
      "rejected",
      key,
      veloraError("edge-error", edgeCinemaLifecycleErrorMessage(cause), true),
    );
  }
}

/** SAFE adapter wykrycia zamknięcia (wołany w przyszłości przez brokera). */
export async function markEdgeCinemaExited(sessionId: string): Promise<CinemaSession> {
  const wire = await invoke<EdgeCinemaSessionWire>("report_edge_cinema_exit", { sessionId });
  return normalizeCinemaSession(wire);
}

/** Recovery po restarcie VELORA (czyści stan do idle, wyłącznie pamięć). */
export async function resetEdgeCinemaSession(): Promise<CinemaSession> {
  const wire = await invoke<EdgeCinemaSessionWire>("reset_edge_cinema_session");
  return normalizeCinemaSession(wire);
}

/** Adapter Tauri: get/close/exit przez `invoke`, subskrypcja przez `listen`. */
export function createTauriEdgeCinemaLifecycleAdapter(): CinemaLifecycleAdapter {
  return {
    id: EDGE_CINEMA_LIFECYCLE_DESCRIPTOR.id,
    getSession: getEdgeCinemaSession,
    requestClose: requestEdgeCinemaClose,
    markExited: markEdgeCinemaExited,
    subscribe(listener: (event: TypedEvent<unknown>) => void): () => void {
      if (!isTauri()) return () => {};
      const names = [
        VELORA_EVENTS.cinemaSessionChanged,
        VELORA_EVENTS.cinemaExited,
        VELORA_EVENTS.cinemaCloseRequested,
      ] as const;
      const unlisteners: Array<() => void> = [];
      let closed = false;
      for (const name of names) {
        void listen<unknown>(name, (event) => {
          listener(typedEvent(name, event.payload));
        })
          .then((unlisten) => {
            if (closed) unlisten();
            else unlisteners.push(unlisten);
          })
          .catch(() => {});
      }
      return () => {
        closed = true;
        for (const unlisten of unlisteners) unlisten();
        unlisteners.length = 0;
      };
    },
  };
}

/** Podgląd WWW: bezpieczny no-op, nigdy nie dotyka warstwy natywnej. */
export function createFallbackEdgeCinemaLifecycleAdapter(): CinemaLifecycleAdapter {
  return {
    id: EDGE_CINEMA_LIFECYCLE_DESCRIPTOR.id,
    getSession: async () => IDLE_CINEMA_SESSION,
    requestClose: async (sessionId) =>
      actionAck(
        sessionId,
        "rejected",
        idempotencyKey(["edge-close", sessionId]),
        veloraError("unavailable", "Edge Cinema jest dostępne tylko w natywnej aplikacji Windows."),
      ),
    markExited: async () => IDLE_CINEMA_SESSION,
    subscribe: () => () => {},
  };
}

/**
 * Ustawia pełny ekran WYŁĄCZNIE własnego okna VELORA. Korzysta z istniejącego
 * helpera `windowMode(enabled)` z `windowMode.ts` (w module nie ma osobnej
 * eksportowanej funkcji `setFullscreen`; plik jest wyłącznie czytany, nie
 * modyfikowany). Pełny ekran samego Edge to wyłącznie flaga
 * `--start-fullscreen` przy uruchomieniu. VELORA NIE gwarantuje i NIE omija
 * DRM / HDCP / 4K / HDR — brak jakichkolwiek flag bypass.
 */
export async function setVeloraFullscreen(enabled: boolean): Promise<void> {
  await windowMode(enabled);
}

/**
 * Czy po zamknięciu zarządzanej sesji VELORA powinna odzyskać fokus.
 *
 * NATIVE WIRING (integrated in `integration/velora-v1`): the native
 * `LaunchRegistry` ends the Cinema launch, calls `WindowBroker::restore_velora`
 * exactly once and emits `velora-return-home`; `App.tsx` consumes that event.
 * This pure helper documents the intended ownership rule for any future UI
 * adapter and does not add a second focus call.
 */
export function shouldRestoreVeloraOnExit(session: CinemaSession): boolean {
  return isClosedSession(session) && session.managedByVelora;
}

/**
 * Klientowy, niewiążący odpowiednik Rust `should_reject_duplicate`: wczesna
 * wskazówka dla UI, czy zablokować ponowne uruchomienie. Ostateczna decyzja
 * zawsze należy do warstwy natywnej (Rust).
 */
export function shouldBlockDuplicateLaunch(session: CinemaSession): boolean {
  return isActiveSession(session) && session.managedByVelora;
}
