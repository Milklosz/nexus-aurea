import { describe, expect, it } from "vitest";
import {
  INITIAL_APP_CONTROL_STATE,
  backAction,
  canSafelyClose,
  classifyLaunchError,
  confirmClose,
  escapeAction,
  homeAction,
  reduceAppControlFlow,
  requestClose,
  type AppControlState,
} from "../services/appControl";
import { HOME_APP_CONTROL_SESSION, type SessionPhase } from "../contracts";

const ALL_PHASES: readonly SessionPhase[] = [
  "home", "app-launch", "app-active", "confirm-close", "returning-home",
];

function stateAt(phase: SessionPhase): AppControlState {
  return { session: { ...HOME_APP_CONTROL_SESSION, phase }, history: [phase] };
}

function confirmCloseState(): AppControlState {
  let state = reduceAppControlFlow(
    INITIAL_APP_CONTROL_STATE,
    { type: "app.launch", appId: "netflix", requestId: "req-launch" },
  );
  const sessionId = state.session.sessionId ?? "";
  state = reduceAppControlFlow(state, { type: "app.focus", sessionId });
  state = reduceAppControlFlow(state, requestClose(sessionId, "req-close"));
  return state;
}

describe("powrót do Home — z KAŻDEJ fazy sterowania", () => {
  it("backAction() kończy w fazie home dla każdej fazy startowej", () => {
    for (const phase of ALL_PHASES) {
      expect(reduceAppControlFlow(stateAt(phase), backAction()).session.phase).toBe("home");
    }
  });

  it("homeAction() kończy w fazie home dla każdej fazy startowej", () => {
    for (const phase of ALL_PHASES) {
      expect(reduceAppControlFlow(stateAt(phase), homeAction()).session.phase).toBe("home");
    }
  });

  it("escapeAction() kończy w fazie home dla każdej fazy startowej", () => {
    for (const phase of ALL_PHASES) {
      expect(reduceAppControlFlow(stateAt(phase), escapeAction()).session.phase).toBe("home");
    }
  });

  it("navigation.escape z confirm-close ANULUJE zamknięcie (brak returning-home)", () => {
    const base = confirmCloseState();
    expect(base.session.phase).toBe("confirm-close");
    const escaped = reduceAppControlFlow(base, escapeAction());
    expect(escaped.session.phase).toBe("home");
    expect(escaped.session.phase).not.toBe("returning-home");
    expect(escaped.history).not.toContain("returning-home");
  });

  it("navigation.escape ląduje w stanie NIEDESTRUKCYJNYM (brak apki/tokenu/błędu)", () => {
    const escaped = reduceAppControlFlow(confirmCloseState(), escapeAction());
    expect(escaped.session.app).toBeNull();
    expect(escaped.session.closeConfirmationToken).toBeNull();
    expect(escaped.session.lastError).toBeNull();
    expect(canSafelyClose(escaped.session)).toBe(false);
  });

  it("każda akcja powrotu czyści token oczekującego zamknięcia", () => {
    const base = confirmCloseState();
    for (const action of [backAction(), homeAction(), escapeAction()]) {
      const next = reduceAppControlFlow(base, action);
      expect(next.session.closeConfirmationToken).toBeNull();
      expect(next.session.phase).toBe("home");
    }
  });

  it("historia zapisuje returning-home PRZED home po potwierdzonym zamknięciu", () => {
    let state = confirmCloseState();
    const token = state.session.closeConfirmationToken ?? "";
    const sessionId = state.session.sessionId ?? "";
    state = reduceAppControlFlow(state, confirmClose(sessionId, token)); // returning-home
    state = reduceAppControlFlow(state, homeAction()); // home
    const returningIdx = state.history.lastIndexOf("returning-home");
    const homeIdx = state.history.lastIndexOf("home");
    expect(returningIdx).toBeGreaterThanOrEqual(0);
    expect(homeIdx).toBeGreaterThan(returningIdx);
    expect(state.session.phase).toBe("home");
  });

  it("błąd uruchomienia, po którym nastąpi Home, i tak wraca do Home", () => {
    const errored: AppControlState = {
      session: {
        ...INITIAL_APP_CONTROL_STATE.session,
        phase: "app-launch",
        lastError: classifyLaunchError(new Error("spawn (os error 2) at C:\\Apps")),
      },
      history: ["home", "app-launch"],
    };
    expect(errored.session.lastError?.code).toBe("launch-failed");
    const home = reduceAppControlFlow(errored, homeAction());
    expect(home.session.phase).toBe("home");
    expect(home.session.lastError).toBeNull();
    expect(home.session.app).toBeNull();
  });

  it("polecenia pilota 'back' oraz 'home' również wracają do Home", () => {
    const active = reduceAppControlFlow(
      reduceAppControlFlow(
        INITIAL_APP_CONTROL_STATE,
        { type: "app.launch", appId: "netflix", requestId: "r" },
      ),
      { type: "app.focus", sessionId: "s" },
    );
    for (const command of ["back", "home"]) {
      const next = reduceAppControlFlow(active, {
        type: "remote.command", command, requestId: "r", sequence: 1, deviceId: "d",
      });
      expect(next.session.phase).toBe("home");
    }
  });

  it("INITIAL_APP_CONTROL_STATE.session to dokładnie HOME_APP_CONTROL_SESSION", () => {
    expect(INITIAL_APP_CONTROL_STATE.session).toBe(HOME_APP_CONTROL_SESSION);
    expect(INITIAL_APP_CONTROL_STATE.session.phase).toBe("home");
    expect(INITIAL_APP_CONTROL_STATE.session.closeConfirmationToken).toBeNull();
  });

  it("wielokrotne powroty do Home utrzymują historię w granicy 16 faz", () => {
    let state = INITIAL_APP_CONTROL_STATE;
    for (let i = 0; i < 25; i += 1) {
      state = reduceAppControlFlow(state, { type: "app.launch", appId: "x", requestId: `r${i}` });
      state = reduceAppControlFlow(state, homeAction());
    }
    expect(state.session.phase).toBe("home");
    expect(state.history.length).toBe(16);
  });
});
