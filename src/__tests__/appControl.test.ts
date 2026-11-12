import { describe, expect, it, vi } from "vitest";
import {
  APP_CONTROL_DESCRIPTOR,
  APP_CONTROL_STORAGE_KEY,
  INITIAL_APP_CONTROL_STATE,
  appControlErrorMessage,
  appControlPhaseIsClosed,
  backAction,
  canSafelyClose,
  cancelClose,
  classifyLaunchError,
  clearRecoveredSession,
  confirmClose,
  confirmCloseRequiresToken,
  createAppControlAdapter,
  escapeAction,
  homeAction,
  isDestructiveAction,
  isNavigationAction,
  persistAppControlSession,
  readRecoveredSession,
  recoveryNotice,
  reduceAppControlFlow,
  remoteCommandToAction,
  requestClose,
  type AppControlState,
  type RecoveryStorage,
} from "../services/appControl";
import {
  HOME_APP_CONTROL_SESSION,
  VELORA_EVENTS,
  veloraError,
  type AppControlSession,
  type VeloraAction,
  type VeloraApp,
} from "../contracts";

function launch(appId = "netflix", requestId = "req-launch"): VeloraAction {
  return { type: "app.launch", appId, requestId };
}

function flowToConfirm() {
  let state = reduceAppControlFlow(INITIAL_APP_CONTROL_STATE, launch());
  const sessionId = state.session.sessionId ?? "";
  state = reduceAppControlFlow(state, { type: "app.focus", sessionId });
  state = reduceAppControlFlow(state, requestClose(sessionId, "req-close"));
  return { state, sessionId, token: state.session.closeConfirmationToken ?? "" };
}

function happyPath() {
  const s0 = INITIAL_APP_CONTROL_STATE;
  const s1 = reduceAppControlFlow(s0, launch());
  const sessionId = s1.session.sessionId ?? "";
  const s2 = reduceAppControlFlow(s1, { type: "app.focus", sessionId });
  const s3 = reduceAppControlFlow(s2, requestClose(sessionId, "req-close"));
  const token = s3.session.closeConfirmationToken ?? "";
  const s4 = reduceAppControlFlow(s3, confirmClose(sessionId, token));
  const s5 = reduceAppControlFlow(s4, homeAction());
  return { s0, s1, s2, s3, s4, s5, sessionId, token };
}

function unmanagedState(): AppControlState {
  const app: VeloraApp = {
    id: "foreign",
    kind: "streaming-window",
    label: "Foreign",
    availability: "available",
    managedByVelora: false,
    launch: null,
  };
  return {
    session: {
      sessionId: "foreign-session",
      phase: "confirm-close",
      app,
      closeConfirmationToken: "tok",
      lastError: null,
    },
    history: ["home", "app-launch", "app-active", "confirm-close"],
  };
}

function makeDeps() {
  const dispatchClose = vi.fn(async () => true);
  const requestFocus = vi.fn(async () => {});
  const deps = { dispatchClose, requestFocus, nowMs: () => 1_700_000_000_000 };
  return { deps, dispatchClose, requestFocus };
}

function makeStorage() {
  const values = new Map<string, string>();
  const storage: RecoveryStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  return { storage, values };
}

describe("reduceAppControlFlow — pełna ścieżka Home → aplikacja → zamknięcie → Home", () => {
  it("przechodzi home → app-launch → app-active → confirm-close → returning-home → home", () => {
    const { s0, s1, s2, s3, s4, s5 } = happyPath();
    expect(s0.session.phase).toBe("home");
    expect(s1.session.phase).toBe("app-launch");
    expect(s2.session.phase).toBe("app-active");
    expect(s3.session.phase).toBe("confirm-close");
    expect(s4.session.phase).toBe("returning-home");
    expect(s5.session.phase).toBe("home");
  });

  it("app.launch działa wyłącznie z fazy home", () => {
    const s1 = reduceAppControlFlow(INITIAL_APP_CONTROL_STATE, launch());
    const again = reduceAppControlFlow(s1, launch("other", "req-2"));
    expect(again.session.phase).toBe("app-launch");
    expect(again.session.app?.id).toBe("netflix");
  });

  it("app.launch buduje minimalną aplikację zarządzaną przez VELORA", () => {
    const s1 = reduceAppControlFlow(INITIAL_APP_CONTROL_STATE, launch("steam", "r"));
    expect(s1.session.app).toEqual({
      id: "steam",
      kind: "managed-launcher",
      label: "steam",
      availability: "available",
      managedByVelora: true,
      launch: null,
    });
    expect(s1.session.sessionId).not.toBeNull();
  });

  it("token potwierdzenia jest deterministyczny (sessionId + requestId)", () => {
    const s1 = reduceAppControlFlow(INITIAL_APP_CONTROL_STATE, launch());
    const sessionId = s1.session.sessionId ?? "";
    const a = reduceAppControlFlow(s1, requestClose(sessionId, "same"));
    const b = reduceAppControlFlow(s1, requestClose(sessionId, "same"));
    expect(a.session.closeConfirmationToken).not.toBeNull();
    expect(a.session.closeConfirmationToken).toBe(b.session.closeConfirmationToken);
  });
});

describe("reduceAppControlFlow — bezpieczne, potwierdzone zamknięcie", () => {
  it("app.close.confirm z BŁĘDNYM tokenem jest odrzucone (app-close-unconfirmed)", () => {
    const { state, sessionId } = flowToConfirm();
    const rejected = reduceAppControlFlow(state, confirmClose(sessionId, "WRONG"));
    expect(rejected.session.phase).toBe("confirm-close");
    expect(rejected.session.lastError?.code).toBe("app-close-unconfirmed");
  });

  it("app.close.confirm na aplikacji NIEZARZĄDZANEJ jest odrzucone (foreign-process)", () => {
    const state = unmanagedState();
    const rejected = reduceAppControlFlow(state, confirmClose("foreign-session", "tok"));
    expect(rejected.session.phase).toBe("confirm-close");
    expect(rejected.session.lastError?.code).toBe("foreign-process");
  });

  it("app.close.confirm bez wcześniejszego żądania (brak tokenu) jest odrzucone", () => {
    const s1 = reduceAppControlFlow(INITIAL_APP_CONTROL_STATE, launch());
    const sessionId = s1.session.sessionId ?? "";
    const s2 = reduceAppControlFlow(s1, { type: "app.focus", sessionId });
    expect(s2.session.closeConfirmationToken).toBeNull();
    const rejected = reduceAppControlFlow(s2, confirmClose(sessionId, "cokolwiek"));
    expect(rejected.session.lastError?.code).toBe("app-close-unconfirmed");
    expect(rejected.session.phase).toBe("app-active");
  });

  it("app.close.cancel czyści token i wraca do app-active", () => {
    const { state, sessionId } = flowToConfirm();
    const cancelled = reduceAppControlFlow(state, cancelClose(sessionId));
    expect(cancelled.session.phase).toBe("app-active");
    expect(cancelled.session.closeConfirmationToken).toBeNull();
  });

  it("poprawne potwierdzenie na sesji MANAGED przechodzi do returning-home", () => {
    const { state, sessionId, token } = flowToConfirm();
    const accepted = reduceAppControlFlow(state, confirmClose(sessionId, token));
    expect(accepted.session.phase).toBe("returning-home");
    expect(accepted.session.closeConfirmationToken).toBeNull();
    expect(accepted.session.lastError).toBeNull();
  });
});

describe("pomocnicy bezpieczeństwa", () => {
  it("canSafelyClose wymaga aplikacji managed ORAZ tokenu", () => {
    const { s2, s3 } = happyPath();
    expect(canSafelyClose(s3.session)).toBe(true);
    expect(canSafelyClose(s2.session)).toBe(false);
    expect(canSafelyClose(HOME_APP_CONTROL_SESSION)).toBe(false);
    expect(canSafelyClose(unmanagedState().session)).toBe(false);
  });

  it("confirmCloseRequiresToken jest true tylko w confirm-close z tokenem", () => {
    expect(confirmCloseRequiresToken(flowToConfirm().state)).toBe(true);
    expect(confirmCloseRequiresToken(INITIAL_APP_CONTROL_STATE)).toBe(false);
    expect(confirmCloseRequiresToken(happyPath().s4)).toBe(false);
  });

  it("isNavigationAction / isDestructiveAction klasyfikują dokładnie", () => {
    expect(isNavigationAction(backAction())).toBe(true);
    expect(isNavigationAction(escapeAction())).toBe(true);
    expect(isNavigationAction(homeAction())).toBe(true);
    expect(isNavigationAction(launch())).toBe(false);
    expect(isDestructiveAction(requestClose("s", "r"))).toBe(true);
    expect(isDestructiveAction(confirmClose("s", "t"))).toBe(true);
    expect(isDestructiveAction(cancelClose("s"))).toBe(false);
    expect(isDestructiveAction(backAction())).toBe(false);
    expect(isDestructiveAction(launch())).toBe(false);
  });

  it("appControlPhaseIsClosed wykorzystuje współdzielony isClosedSession", () => {
    expect(appControlPhaseIsClosed("home")).toBe(true);
    expect(appControlPhaseIsClosed("app-launch")).toBe(false);
    expect(appControlPhaseIsClosed("app-active")).toBe(false);
    expect(appControlPhaseIsClosed("confirm-close")).toBe(false);
    expect(appControlPhaseIsClosed("returning-home")).toBe(false);
  });

  it("APP_CONTROL_DESCRIPTOR jest uczciwie oznaczony jako prototyp", () => {
    expect(APP_CONTROL_DESCRIPTOR).toEqual({ id: "app-control", kind: "app-control", prototype: true });
  });
});

describe("mapowanie poleceń pilota i historia", () => {
  it("remote.command mapuje back/home/escape, a select/strzałki/unknown są no-op", () => {
    expect(remoteCommandToAction("back")).toEqual(backAction());
    expect(remoteCommandToAction("home")).toEqual(homeAction());
    expect(remoteCommandToAction("escape")).toEqual(escapeAction());
    expect(remoteCommandToAction("select")).toBeNull();
    expect(remoteCommandToAction("up")).toBeNull();
    expect(remoteCommandToAction("right")).toBeNull();
    expect(remoteCommandToAction("bogus")).toBeNull();
  });

  it("remote.command 'home' z app-active wraca do Home, a nieznane polecenie nic nie zmienia", () => {
    const { s2 } = happyPath();
    const remoteHome: VeloraAction = { type: "remote.command", command: "home", requestId: "r", sequence: 1, deviceId: "d" };
    expect(reduceAppControlFlow(s2, remoteHome).session.phase).toBe("home");
    const unknown: VeloraAction = { type: "remote.command", command: "bogus", requestId: "r", sequence: 2, deviceId: "d" };
    expect(reduceAppControlFlow(s2, unknown)).toBe(s2);
  });

  it("display.fullscreen nie zmienia fazy, ale zapisuje ją w historii", () => {
    const s1 = reduceAppControlFlow(INITIAL_APP_CONTROL_STATE, launch());
    const full = reduceAppControlFlow(s1, { type: "display.fullscreen", enabled: true });
    expect(full.session.phase).toBe("app-launch");
    expect(full.history.length).toBe(s1.history.length + 1);
    expect(full.history[full.history.length - 1]).toBe("app-launch");
  });

  it("historia jest ograniczona do ostatnich 16 faz", () => {
    let state = INITIAL_APP_CONTROL_STATE;
    for (let i = 0; i < 40; i += 1) {
      state = reduceAppControlFlow(state, { type: "display.fullscreen", enabled: i % 2 === 0 });
    }
    expect(state.history.length).toBe(16);
  });
});

describe("czytelne błędy bez wycieków surowych danych", () => {
  const raw = "C:\\Program Files\\app.exe failed (os error 2)\n    at spawn (node:internal)\n Error: stack trace";

  it("classifyLaunchError zwraca launch-failed i nigdy nie wycieka os error / ścieżek / stosu", () => {
    const error = classifyLaunchError(new Error(raw));
    expect(error.code).toBe("launch-failed");
    expect(error.recoverable).toBe(true);
    expect(error.message).toMatch(/Nie udało się uruchomić aplikacji/);
    expect(JSON.stringify(error)).not.toMatch(/os error|Program Files|at spawn|stack|Error:/i);
  });

  it("classifyLaunchError nie rzuca dla dowolnej przyczyny", () => {
    expect(classifyLaunchError(null).code).toBe("launch-failed");
    expect(classifyLaunchError(undefined).code).toBe("launch-failed");
    expect(classifyLaunchError({}).code).toBe("launch-failed");
    expect(classifyLaunchError("błąd (os error 5)").cause).toMatch(/uprawnienia/);
  });

  it("appControlErrorMessage mapuje kody na czyste komunikaty po polsku", () => {
    expect(appControlErrorMessage(veloraError("app-close-unconfirmed", "x"))).toMatch(/potwierdzenia/);
    expect(appControlErrorMessage(veloraError("foreign-process", "x"))).toMatch(/VELORA/);
    expect(appControlErrorMessage(classifyLaunchError(new Error("x")))).toMatch(/Nie udało się uruchomić aplikacji/);
    expect(appControlErrorMessage(raw)).not.toMatch(/os error|Program Files|Error:/i);
    expect(appControlErrorMessage({})).toMatch(/nieoczekiwany błąd/i);
  });
});

describe("createAppControlAdapter — prototyp nad wstrzykniętymi deps", () => {
  it("wywołuje dispatchClose TYLKO przy potwierdzonym zamknięciu sesji MANAGED", async () => {
    const { deps, dispatchClose } = makeDeps();
    const adapter = createAppControlAdapter(deps);
    await adapter.dispatch(launch());
    const sessionId = (await adapter.getSession()).sessionId ?? "";
    await adapter.dispatch({ type: "app.focus", sessionId });
    await adapter.dispatch(requestClose(sessionId, "req-close"));
    const token = (await adapter.getSession()).closeConfirmationToken ?? "";
    const ack = await adapter.dispatch(confirmClose(sessionId, token));
    expect(dispatchClose).toHaveBeenCalledOnce();
    expect(dispatchClose).toHaveBeenCalledWith(sessionId);
    expect(ack.status).toBe("executed");
    expect(ack.idempotencyKey).toMatch(/^velora-/);
    expect((await adapter.getSession()).phase).toBe("returning-home");
  });

  it("NIE wywołuje dispatchClose przy błędnym tokenie (niepotwierdzone)", async () => {
    const { deps, dispatchClose } = makeDeps();
    const adapter = createAppControlAdapter(deps);
    await adapter.dispatch(launch());
    const sessionId = (await adapter.getSession()).sessionId ?? "";
    await adapter.dispatch({ type: "app.focus", sessionId });
    await adapter.dispatch(requestClose(sessionId, "req-close"));
    const ack = await adapter.dispatch(confirmClose(sessionId, "WRONG"));
    expect(dispatchClose).not.toHaveBeenCalled();
    expect(ack.status).toBe("rejected");
    expect(ack.error?.code).toBe("app-close-unconfirmed");
  });

  it("NIE wywołuje dispatchClose dla obcej / niezarządzanej aplikacji (brak apki w Home)", async () => {
    const { deps, dispatchClose } = makeDeps();
    const adapter = createAppControlAdapter(deps);
    const ack = await adapter.dispatch(confirmClose("fake", "tok"));
    expect(dispatchClose).not.toHaveBeenCalled();
    expect(ack.status).toBe("rejected");
    expect(ack.error?.code).toBe("foreign-process");
  });

  it("wywołuje requestFocus przy powrocie do Home (tylko prośba o fokus)", async () => {
    const { deps, requestFocus } = makeDeps();
    const adapter = createAppControlAdapter(deps);
    await adapter.dispatch(launch());
    const sessionId = (await adapter.getSession()).sessionId ?? "";
    await adapter.dispatch({ type: "app.focus", sessionId });
    await adapter.dispatch(backAction());
    expect(requestFocus).toHaveBeenCalledOnce();
    expect((await adapter.getSession()).phase).toBe("home");
  });

  it("subscribe emituje typowane zdarzenie i respektuje unsubscribe", async () => {
    const { deps } = makeDeps();
    const adapter = createAppControlAdapter(deps);
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    await adapter.dispatch(launch());
    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0][0] as {
      name: string;
      payload: { session: AppControlSession };
      emittedAt: string;
    };
    expect(event.name).toBe(VELORA_EVENTS.appControlSessionChanged);
    expect(event.payload.session.phase).toBe("app-launch");
    expect(typeof event.emittedAt).toBe("string");
    unsubscribe();
    await adapter.dispatch({ type: "display.fullscreen", enabled: true });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("recovery po restarcie VELORA — wyłącznie do odczytu, bez auto-akcji", () => {
  const notice = "VELORA została uruchomiona ponownie. Aplikacja nie została wznowiona automatycznie — wróć do ekranu głównego.";

  it("persist → read → clear działa w obie strony na magazynie Map", () => {
    const { storage, values } = makeStorage();
    const active = reduceAppControlFlow(
      reduceAppControlFlow(INITIAL_APP_CONTROL_STATE, launch()),
      { type: "app.focus", sessionId: "s" },
    );
    persistAppControlSession(storage, active.session);
    expect(values.get(APP_CONTROL_STORAGE_KEY)).toBeTruthy();
    const recovered = readRecoveredSession(storage);
    expect(recovered).not.toBeNull();
    expect(recovered?.phase).toBe("home");
    expect(recovered?.app).toBeNull();
    expect(recovered?.closeConfirmationToken).toBeNull();
    clearRecoveredSession(storage);
    expect(readRecoveredSession(storage)).toBeNull();
  });

  it("odczytany stan jest zawsze 'home' i nigdy nie wznawia aplikacji automatycznie", () => {
    const { storage } = makeStorage();
    persistAppControlSession(storage, flowToConfirm().state.session);
    const recovered = readRecoveredSession(storage);
    expect(recovered?.phase).toBe("home");
    expect(recovered?.lastError?.message).toContain("nie została wznowiona automatycznie");
    expect(canSafelyClose(recovered!)).toBe(false);
  });

  it("uszkodzony / niezgodny JSON daje bezpieczny null", () => {
    const { storage, values } = makeStorage();
    values.set(APP_CONTROL_STORAGE_KEY, "{nie jest json");
    expect(readRecoveredSession(storage)).toBeNull();
    values.set(APP_CONTROL_STORAGE_KEY, JSON.stringify({ phase: "bogus" }));
    expect(readRecoveredSession(storage)).toBeNull();
    values.set(APP_CONTROL_STORAGE_KEY, JSON.stringify(null));
    expect(readRecoveredSession(storage)).toBeNull();
    values.set(APP_CONTROL_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(readRecoveredSession(storage)).toBeNull();
  });

  it("magazyn rzucający wyjątki daje null i nie powoduje rzucenia", () => {
    const throwing: RecoveryStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(readRecoveredSession(throwing)).toBeNull();
    expect(() => persistAppControlSession(throwing, HOME_APP_CONTROL_SESSION)).not.toThrow();
    expect(() => clearRecoveredSession(throwing)).not.toThrow();
  });

  it("recoveryNotice ma dokładną, manualną treść bez języka auto-relaunch", () => {
    expect(recoveryNotice(HOME_APP_CONTROL_SESSION)).toBe(notice);
    expect(notice).toContain("wróć do ekranu głównego");
    expect(notice).not.toMatch(/wznawiam|samoczynnie uruchamiam|auto-?relaunch|auto-?launch/i);
  });
});
