/**
 * VELORA 1.0 — Moduł E: Couch-only Application Control.
 *
 * ANALIZA + typowany kontrakt + PRZETESTOWANY prototyp reducera/adaptera.
 * NIE jest wpięty w App.tsx, nie dodaje komend Tauri, nie importuje
 * `@tauri-apps` na poziomie modułu i nie wykonuje żadnego skutku ubocznego
 * przy imporcie — wszystkie efekty przechodzą przez wstrzyknięte `deps`.
 * Moduł jest czysty, dzięki czemu testy działają w środowisku `node` (bez DOM).
 *
 * Zasada bezpieczeństwa (README): VELORA wyłącznie PROSI o zwrócenie fokusu
 * (`focusWindowSafely` / `deps.requestFocus`). Jedynie sesja URUCHOMIONA
 * PRZEZ VELORA (`managedByVelora === true`) może być kandydatem do zamknięcia
 * i to dopiero po świadomym potwierdzeniu z ważnym tokenem. Żaden obcy proces
 * (foreign process) nie jest zamykany. Po restarcie VELORA recovery jest
 * wyłącznie do odczytu — bez automatycznego wznawiania / zamykania czegokolwiek.
 */

import {
  actionAck,
  HOME_APP_CONTROL_SESSION,
  idempotencyKey,
  isClosedSession,
  messageFromUnknown,
  toVeloraError,
  typedEvent,
  veloraError,
  VELORA_EVENTS,
  type ActionAck,
  type AdapterDescriptor,
  type AppControlAdapter,
  type AppControlSession,
  type SessionPhase,
  type TypedEvent,
  type VeloraAction,
  type VeloraActionType,
  type VeloraApp,
  type VeloraError,
} from "../contracts";

/** Deskryptor uczenie oznaczony jako prototyp (nieuruchomiona integracja). */
export const APP_CONTROL_DESCRIPTOR: AdapterDescriptor = {
  id: "app-control",
  kind: "app-control",
  prototype: true,
};

export const APP_CONTROL_STORAGE_KEY = "velora.v1.appControl.session";

const HISTORY_LIMIT = 16;

const SESSION_PHASES: readonly SessionPhase[] = [
  "home", "app-launch", "app-active", "confirm-close", "returning-home",
];

const NAVIGATION_ACTION_TYPES: ReadonlySet<VeloraActionType> = new Set<VeloraActionType>([
  "navigation.back",
  "navigation.escape",
  "navigation.home",
]);

const DESTRUCTIVE_ACTION_TYPES: ReadonlySet<VeloraActionType> = new Set<VeloraActionType>([
  "app.close.confirm",
  "app.close.request",
]);

/** Czy akcja należy do rodziny nawigacji (Wstecz / Escape / Home). */
export function isNavigationAction(action: VeloraAction): boolean {
  return NAVIGATION_ACTION_TYPES.has(action.type);
}

/**
 * Czy akcja jest destrukcyjna. PRAWDA wyłącznie dla `app.close.request`
 * (żądanie zamknięcia) i `app.close.confirm` (potwierdzenie zamknięcia).
 * `app.close.cancel`, `navigation.*`, `display.fullscreen` i reszta NIE są.
 */
export function isDestructiveAction(action: VeloraAction): boolean {
  return DESTRUCTIVE_ACTION_TYPES.has(action.type);
}

export interface AppControlState {
  readonly session: AppControlSession;
  readonly history: readonly SessionPhase[];
}

export const INITIAL_APP_CONTROL_STATE: AppControlState = {
  session: HOME_APP_CONTROL_SESSION,
  history: ["home"],
};

/** Czy w tej chwili potwierdzenie zamknięcia wymaga podania ważnego tokenu. */
export function confirmCloseRequiresToken(state: AppControlState): boolean {
  return state.session.phase === "confirm-close" && state.session.closeConfirmationToken !== null;
}

/**
 * Jedyny bezpieczny kandydat do zamknięcia: istnieje aplikacja, została
 * uruchomiona przez VELORA i istnieje token potwierdzenia. Nigdy nie zwraca
 * `true` dla obcego / niezarządzanego procesu.
 */
export function canSafelyClose(session: AppControlSession): boolean {
  return (
    session.app !== null &&
    session.app.managedByVelora === true &&
    session.closeConfirmationToken !== null
  );
}

function appendHistory(history: readonly SessionPhase[], phase: SessionPhase): readonly SessionPhase[] {
  return [...history, phase].slice(-HISTORY_LIMIT);
}

function transition(state: AppControlState, session: AppControlSession): AppControlState {
  return { session, history: appendHistory(state.history, session.phase) };
}

function isSessionPhase(value: unknown): value is SessionPhase {
  return typeof value === "string" && (SESSION_PHASES as readonly string[]).includes(value);
}

const LAUNCH_FAILED_MESSAGE = "Nie udało się uruchomić aplikacji. Sprawdź instalację i spróbuj ponownie.";

/**
 * Mapuje znane, techniczne przyczyny na STAŁE, czytelne komunikaty.
 * Świadomie NIE zwraca surowej wiadomości (ścieżki, `os error`, stosu).
 */
function safeLaunchDiagnostic(cause: unknown): string | null {
  const raw = messageFromUnknown(cause);
  if (raw === null) return null;
  if (/os error 2|nie znaleziono pliku|not found|does not exist/i.test(raw)) {
    return "Nie znaleziono pliku aplikacji. Sprawdź instalację.";
  }
  if (/os error 5|access is denied|odmówił|permission/i.test(raw)) {
    return "Windows odmówił uruchomienia aplikacji. Sprawdź uprawnienia.";
  }
  return "Uruchomienie aplikacji zostało odrzucone przez system.";
}

/** Czysty, czytelny komunikat dla użytkownika; NIGDY nie zwraca surowego błędu / stosu. */
export function appControlErrorMessage(cause: unknown): string {
  const error = toVeloraError(cause, "Wystąpił nieoczekiwany błąd VELORA.");
  switch (error.code) {
    case "app-close-unconfirmed":
      return "Zamknięcie aplikacji wymaga potwierdzenia. Wybierz „Zamknij” jeszcze raz.";
    case "foreign-process":
      return "Aplikacja nie została uruchomiona przez VELORA — nie można jej zamknąć z tego miejsca.";
    case "launch-failed":
      return LAUNCH_FAILED_MESSAGE;
    default:
      return "Wystąpił nieoczekiwany błąd VELORA. Wróć do ekranu głównego i spróbuj ponownie.";
  }
}

/** Klasyfikuje dowolną przyczynę jako typowany, bezpieczny błąd `launch-failed`. Nigdy nie rzuca. */
export function classifyLaunchError(cause: unknown): VeloraError {
  return veloraError("launch-failed", LAUNCH_FAILED_MESSAGE, true, safeLaunchDiagnostic(cause));
}

/**
 * Projekcja fazy sterowania na słownik cyklu życia `CinemaSession` z użyciem
 * współdzielonego predykatu `isClosedSession`. Tylko faza "home" jest stanem
 * zamkniętym (brak aktywnego okna aplikacji). Zapytanie wyłącznie do odczytu —
 * nigdy nie zleca zamknięcia. Granica dla przyszłego WindowBrokera (DeepSeek).
 */
export function appControlPhaseIsClosed(phase: SessionPhase): boolean {
  const status = phase === "home" ? "exited" : "active";
  return isClosedSession({
    sessionId: null,
    status,
    appId: "",
    pid: null,
    windowTitle: null,
    profileDir: null,
    url: null,
    launchedAt: null,
    lastError: null,
    managedByVelora: true,
  });
}

// --- Akcje (kreatory) -------------------------------------------------------

export function requestClose(sessionId: string, requestId: string): VeloraAction {
  return { type: "app.close.request", sessionId, requestId };
}

export function confirmClose(sessionId: string, token: string): VeloraAction {
  return { type: "app.close.confirm", sessionId, token };
}

export function cancelClose(sessionId: string): VeloraAction {
  return { type: "app.close.cancel", sessionId };
}

export function backAction(): VeloraAction {
  return { type: "navigation.back" };
}

export function escapeAction(): VeloraAction {
  return { type: "navigation.escape" };
}

export function homeAction(): VeloraAction {
  return { type: "navigation.home" };
}

const REMOTE_IN_APP_COMMANDS: ReadonlySet<string> = new Set([
  "select", "up", "down", "left", "right",
]);

/**
 * Mapuje polecenie iPhone Remote na akcję cyklu życia aplikacji.
 * "back" / "home" / "escape" wracają do Home (i anulują oczekujące zamknięcie).
 * Ruchy fokusu wewnątrz UI ("select" + strzałki) oraz nieznane polecenia są
 * no-op na tej warstwie — nigdy nie uruchamiają ani nie zamykają aplikacji.
 */
export function remoteCommandToAction(command: string): VeloraAction | null {
  if (command === "back") return backAction();
  if (command === "home") return homeAction();
  if (command === "escape") return escapeAction();
  if (REMOTE_IN_APP_COMMANDS.has(command)) return null;
  return null;
}

// --- Czysty reducer przepływu ----------------------------------------------

/**
 * Home -> app-launch -> app-active -> confirm-close -> returning-home -> home.
 *
 * NIGDY nie zwraca stanu zamykającego obcy / niezarządzany proces: przejście
 * do "returning-home" jest możliwe wyłącznie po `app.close.confirm` z ważnym
 * tokenem ORAZ `managedByVelora === true`. Każda akcja nawigacyjna z DOWOLNEJ
 * fazy wraca do bezpiecznego, niedestrukcyjnego stanu "home".
 */
export function reduceAppControlFlow(state: AppControlState, action: VeloraAction): AppControlState {
  if (action.type === "remote.command") {
    const mapped = remoteCommandToAction(action.command);
    return mapped === null ? state : reduceAppControlFlow(state, mapped);
  }

  const current = state.session;

  switch (action.type) {
    case "app.launch": {
      if (current.phase !== "home") return state; // uruchamiamy wyłącznie z Home
      const app: VeloraApp = {
        id: action.appId,
        kind: "managed-launcher",
        label: action.appId,
        availability: "available",
        managedByVelora: true,
        launch: null,
      };
      const session: AppControlSession = {
        sessionId: idempotencyKey(["session", action.appId, action.requestId]),
        phase: "app-launch",
        app,
        closeConfirmationToken: null,
        lastError: null,
      };
      return transition(state, session);
    }
    case "app.focus":
    case "status.refresh": {
      const session: AppControlSession = {
        ...current,
        phase: "app-active",
        closeConfirmationToken: null,
        lastError: null,
      };
      return transition(state, session);
    }
    case "app.close.request": {
      const session: AppControlSession = {
        ...current,
        phase: "confirm-close",
        closeConfirmationToken: idempotencyKey(["close", action.sessionId, action.requestId]),
        lastError: null,
      };
      return transition(state, session);
    }
    case "app.close.confirm": {
      const accepted = canSafelyClose(current) && action.token === current.closeConfirmationToken;
      if (accepted) {
        const session: AppControlSession = {
          ...current,
          phase: "returning-home",
          closeConfirmationToken: null,
          lastError: null,
        };
        return transition(state, session);
      }
      // ODRZUCONE: pozostajemy w aktualnej fazie, dopisujemy typowany błąd.
      const managed = current.app !== null && current.app.managedByVelora === true;
      const code = managed ? "app-close-unconfirmed" : "foreign-process";
      const message = managed
        ? "Zamknięcie aplikacji wymaga ważnego potwierdzenia."
        : "Aplikacja nie została uruchomiona przez VELORA i nie może zostać zamknięta.";
      return {
        session: { ...current, lastError: veloraError(code, message, true) },
        history: state.history,
      };
    }
    case "app.close.cancel": {
      const session: AppControlSession = {
        ...current,
        phase: "app-active",
        closeConfirmationToken: null,
        lastError: null,
      };
      return transition(state, session);
    }
    case "navigation.back":
    case "navigation.escape":
    case "navigation.home": {
      // Z DOWOLNEJ fazy -> bezpieczny, niedestrukcyjny Home (anuluje zamknięcie).
      return transition(state, { ...HOME_APP_CONTROL_SESSION });
    }
    case "display.fullscreen": {
      // Bez zmiany fazy — zapisujemy wyłącznie w historii.
      return { session: state.session, history: appendHistory(state.history, state.session.phase) };
    }
    default:
      return state;
  }
}

// --- Prototypowy adapter (wstrzykiwane zależności) -------------------------

export interface AppControlDeps {
  dispatchClose(sessionId: string): Promise<boolean>;
  requestFocus(): Promise<void>;
  nowMs?: () => number;
}

function requestIdOf(action: VeloraAction): string {
  if ("requestId" in action) return action.requestId;
  const parts: (string | number)[] = [action.type];
  if ("token" in action) parts.push(action.token);
  if ("sessionId" in action) parts.push(action.sessionId);
  if ("enabled" in action) parts.push(action.enabled ? 1 : 0);
  return idempotencyKey(parts);
}

function statusFor(action: VeloraAction, previous: AppControlState, next: AppControlState): ActionAck["status"] {
  if (action.type === "app.close.request") return "pending-confirmation";
  if (action.type === "app.close.confirm") {
    return next.session.lastError !== null ? "rejected" : "executed";
  }
  if (action.type === "remote.command" && next === previous) return "not-applicable";
  if (action.type === "display.fullscreen") return "not-applicable";
  return "accepted";
}

/**
 * Prototype adapter over injected deps; NOT wired into App.tsx.
 * Wiring plan in docs/couch-control-flow.md. No process is killed.
 */
export function createAppControlAdapter(deps: AppControlDeps): AppControlAdapter {
  let state: AppControlState = INITIAL_APP_CONTROL_STATE;
  const listeners = new Set<(event: TypedEvent<unknown>) => void>();

  const nowIso = (): string => {
    const readNow = deps.nowMs ?? (() => Date.now());
    return new Date(readNow()).toISOString();
  };

  const emit = (): void => {
    const event: TypedEvent<unknown> = typedEvent(
      VELORA_EVENTS.appControlSessionChanged,
      { session: state.session },
      nowIso(),
    );
    for (const listener of listeners) listener(event);
  };

  const dispatch = async (action: VeloraAction): Promise<ActionAck> => {
    const previous = state;
    const requestId = requestIdOf(action);
    const key = idempotencyKey([action.type, previous.session.sessionId ?? "", requestId]);
    const next = reduceAppControlFlow(previous, action);

    // SAFE GATE: `dispatchClose` TYLKO dla potwierdzonego, MANAGED zamknięcia,
    // które reducer faktycznie przyjął (faza "returning-home", brak błędu).
    const confirmedManagedClose =
      action.type === "app.close.confirm" &&
      canSafelyClose(previous.session) &&
      action.token === previous.session.closeConfirmationToken &&
      previous.session.app?.managedByVelora === true &&
      next.session.phase === "returning-home" &&
      next.session.lastError === null;
    if (confirmedManagedClose) {
      await deps.dispatchClose(previous.session.sessionId ?? "");
    }

    state = next;

    // Powrót do Home: VELORA wyłącznie PROSI o fokus (bez force-close).
    const wasActiveApp =
      previous.session.phase === "app-launch" ||
      previous.session.phase === "app-active" ||
      previous.session.phase === "confirm-close";
    const headingHome = next.session.phase === "home" || next.session.phase === "returning-home";
    if (wasActiveApp && headingHome) {
      await deps.requestFocus();
    }

    if (next !== previous) emit();

    return actionAck(requestId, statusFor(action, previous, next), key, next.session.lastError, nowIso());
  };

  return {
    id: APP_CONTROL_DESCRIPTOR.id,
    dispatch,
    getSession: async () => state.session,
    subscribe(listener: (event: TypedEvent<unknown>) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// --- Recovery po restarcie VELORA (wyłącznie do odczytu) -------------------

/** Wstrzykiwalny magazyn — brak zależności od DOM / localStorage. */
export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function persistAppControlSession(storage: RecoveryStorage, session: AppControlSession): void {
  try {
    storage.setItem(APP_CONTROL_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Magazyn może być niedostępny; zapis jest wyłącznie best-effort.
  }
}

function isVeloraAppLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.kind === "string" &&
    typeof r.label === "string" &&
    typeof r.availability === "string" &&
    typeof r.managedByVelora === "boolean" &&
    (r.launch === null || (typeof r.launch === "object" && r.launch !== null))
  );
}

function isVeloraErrorLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.code === "string" &&
    typeof r.message === "string" &&
    typeof r.recoverable === "boolean" &&
    (r.cause === null || typeof r.cause === "string")
  );
}

function isPersistedSession(value: unknown): value is AppControlSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    isSessionPhase(r.phase) &&
    (r.sessionId === null || typeof r.sessionId === "string") &&
    (r.closeConfirmationToken === null || typeof r.closeConfirmationToken === "string") &&
    (r.app === null || isVeloraAppLike(r.app)) &&
    (r.lastError === null || isVeloraErrorLike(r.lastError))
  );
}

export function readRecoveredSession(storage: RecoveryStorage): AppControlSession | null {
  let raw: string | null;
  try {
    raw = storage.getItem(APP_CONTROL_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedSession(parsed)) return null;
    // Recovery jest WYŁĄCZNIE do odczytu: brak auto-relaunch / auto-close.
    // Zawsze zwracamy bezpieczny stan "home" z notatką o ręcznym powrocie.
    return {
      ...HOME_APP_CONTROL_SESSION,
      lastError: veloraError("unknown", recoveryNotice(parsed), true),
    };
  } catch {
    return null;
  }
}

export function clearRecoveredSession(storage: RecoveryStorage): void {
  try {
    storage.setItem(APP_CONTROL_STORAGE_KEY, "");
  } catch {
    // Brak magazynu nie jest błędem krytycznym.
  }
}

/** Stały, czytelny komunikat recovery. Recovery jest zawsze MANUALNE. */
export function recoveryNotice(_session: AppControlSession): string {
  return "VELORA została uruchomiona ponownie. Aplikacja nie została wznowiona automatycznie — wróć do ekranu głównego.";
}
