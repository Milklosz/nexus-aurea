import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelSessionOperation,
  getSessionOperations,
  getSessionState,
  listenForReturnHome,
  listenForSessionChange,
  requestSessionTransition,
  returnVeloraHome,
  type SessionChangedEvent,
  type SessionOperation,
  type SessionSnapshot,
} from "../services/sessionOrchestrator";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

afterEach(() => vi.clearAllMocks());
beforeEach(() => mocks.isTauri.mockReturnValue(true));

const snapshot: SessionSnapshot = {
  current: "game",
  previous: "veloraHome",
  revision: 2,
  transitionedAtMs: 1000,
  context: { launchId: "game-1", appId: "1091500" },
  allowedTargets: ["veloraHome", "playnite", "cinema", "desktop", "ambient"],
};

describe("Session Orchestrator native bridge", () => {
  it("reads and requests explicit session transitions", async () => {
    mocks.invoke.mockResolvedValueOnce(snapshot);
    await expect(getSessionState()).resolves.toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith("get_session_state");

    mocks.invoke.mockResolvedValueOnce(snapshot);
    await requestSessionTransition({ target: "game", cause: "launch" });
    expect(mocks.invoke).toHaveBeenLastCalledWith("request_session_transition", {
      request: { target: "game", cause: "launch" },
    });
  });

  it("returns home through the native broker command", async () => {
    const result = {
      session: { ...snapshot, current: "veloraHome" as const },
      restore: {
        attempted: true,
        restored: true,
        outcome: "restored" as const,
        reason: "userRequest" as const,
        ownWindow: 10,
        foregroundBefore: { hwnd: 20, processId: 30, processName: "game.exe", className: "Game", windowPresent: true },
        foregroundAfter: { hwnd: 10, processId: 40, processName: "velora.exe", className: "VELORA", windowPresent: true },
        errorCode: null,
        message: "VELORA odzyskała fokus.",
      },
    };
    mocks.invoke.mockResolvedValueOnce(result);
    await expect(returnVeloraHome()).resolves.toEqual(result);
    expect(mocks.invoke).toHaveBeenLastCalledWith("return_velora_home");
  });

  it("supports operation inspection and cancellation", async () => {
    const operation: SessionOperation = {
      id: "op-1",
      kind: "returnHome",
      status: "pending",
      startedAtMs: 10,
      deadlineAtMs: 3010,
      finishedAtMs: null,
    };
    mocks.invoke.mockResolvedValueOnce([operation]);
    await expect(getSessionOperations()).resolves.toEqual([operation]);
    expect(mocks.invoke).toHaveBeenLastCalledWith("get_session_operations");
    mocks.invoke.mockResolvedValueOnce({ ...operation, status: "cancelled", finishedAtMs: 20 });
    await expect(cancelSessionOperation(operation.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(mocks.invoke).toHaveBeenLastCalledWith("cancel_session_operation", { operationId: "op-1" });
  });

  it("passes idempotency and revision fields to the native command", async () => {
    mocks.invoke.mockResolvedValueOnce(snapshot);
    await requestSessionTransition({
      target: "game",
      cause: "launch",
      commandId: "cmd-1",
      expectedRevision: 1,
      issuedAtMs: 100,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("request_session_transition", {
      request: {
        target: "game",
        cause: "launch",
        commandId: "cmd-1",
        expectedRevision: 1,
        issuedAtMs: 100,
      },
    });
  });

  it("stays a local no-op in a browser preview", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(getSessionState()).resolves.toMatchObject({ current: "veloraHome" });
    await expect(requestSessionTransition({ target: "cinema", cause: "user" })).resolves.toMatchObject({ current: "cinema" });
    await expect(returnVeloraHome()).resolves.toMatchObject({ restore: { outcome: "unsupportedPlatform" } });
    await expect(getSessionOperations()).resolves.toEqual([]);
    await expect(cancelSessionOperation("op-1")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("forwards session and return-home events", async () => {
    const sessionCallback = vi.fn();
    const homeCallback = vi.fn();
    await listenForSessionChange(sessionCallback);
    await listenForReturnHome(homeCallback);
    expect(mocks.listen.mock.calls[0][0]).toBe("velora-session-changed");
    expect(mocks.listen.mock.calls[1][0]).toBe("velora-return-home");
    const changed: SessionChangedEvent = {
      from: "veloraHome",
      to: "game",
      cause: "launch",
      context: { launchId: "game-1" },
      revision: 2,
      atMs: 1000,
    };
    const sessionHandler = mocks.listen.mock.calls[0][1] as (event: { payload: SessionChangedEvent }) => void;
    sessionHandler({ payload: changed });
    expect(sessionCallback).toHaveBeenCalledWith(changed);
    const homeHandler = mocks.listen.mock.calls[1][1] as (event: { payload: unknown }) => void;
    homeHandler({ payload: { cause: "gamepadHome", session: snapshot, restore: { restored: true } } });
    expect(homeCallback).toHaveBeenCalledOnce();
  });
});
