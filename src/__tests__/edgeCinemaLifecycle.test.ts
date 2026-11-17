// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_CINEMA_SESSION,
  VELORA_EVENTS,
  idempotencyKey,
  type CinemaSession,
} from "../contracts";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  // Typowana sygnatura listen (wzorzec z controlService.test.ts) pozwala
  // bezpiecznie czytać mocks.listen.mock.calls[0][1] przy strict + tsc -b.
  listen: vi.fn(
    async (_event: string, _handler: (event: { payload: unknown }) => void) => vi.fn(),
  ),
  // Stub własnego okna VELORA dla tranzytywnego importu windowMode.ts.
  window: {
    isFullscreen: vi.fn(async () => false),
    setFullscreen: vi.fn(async () => {}),
    setDecorations: vi.fn(async () => {}),
    minimize: vi.fn(async () => {}),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks.window }));

import {
  EDGE_CINEMA_LIFECYCLE_DESCRIPTOR,
  createFallbackEdgeCinemaLifecycleAdapter,
  createTauriEdgeCinemaLifecycleAdapter,
  edgeCinemaLifecycleErrorMessage,
  getEdgeCinemaSession,
  markEdgeCinemaExited,
  normalizeCinemaSession,
  requestEdgeCinemaClose,
  resetEdgeCinemaSession,
  setVeloraFullscreen,
  shouldBlockDuplicateLaunch,
  shouldRestoreVeloraOnExit,
} from "../services/edgeCinemaLifecycle";

const validWire = {
  sessionId: "edge-cinema-4321-1700000000",
  state: "active",
  appId: "edge-cinema",
  pid: 4321,
  windowTitle: "VELORA-EdgeCinema",
  profileDir: "C:/VELORA/VELORA-EdgeCinema",
  url: "https://www.netflix.com/pl/",
  launchedAt: "1700000000",
  lastError: null,
  managedByVelora: true,
};

beforeEach(() => {
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockReset();
  mocks.window.isFullscreen.mockClear();
  mocks.window.setFullscreen.mockClear();
  mocks.window.setDecorations.mockClear();
  mocks.window.minimize.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("Edge Cinema Lifecycle 2.0 — honest descriptor", () => {
  it("marks the adapter as a prototype, not a launched integration", () => {
    expect(EDGE_CINEMA_LIFECYCLE_DESCRIPTOR).toEqual({
      id: "edge-cinema-lifecycle",
      kind: "cinema",
      prototype: true,
    });
  });
});

describe("getEdgeCinemaSession", () => {
  it("invokes exactly get_edge_cinema_session and normalizes a valid wire payload", async () => {
    mocks.invoke.mockResolvedValueOnce(validWire);

    const session = await getEdgeCinemaSession();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_edge_cinema_session");
    expect(session).toMatchObject({
      sessionId: "edge-cinema-4321-1700000000",
      status: "active",
      appId: "edge-cinema",
      pid: 4321,
      windowTitle: "VELORA-EdgeCinema",
      profileDir: "C:/VELORA/VELORA-EdgeCinema",
      url: "https://www.netflix.com/pl/",
      launchedAt: "1700000000",
      lastError: null,
      managedByVelora: true,
    });
  });

  it("falls back to safe defaults for malformed wire without throwing", async () => {
    mocks.invoke.mockResolvedValueOnce({
      state: 42,
      pid: "not-a-number",
      appId: "",
      managedByVelora: "yes",
      sessionId: {},
      lastError: 99,
    });

    const session = await getEdgeCinemaSession();

    expect(session.status).toBe("idle");
    expect(session.pid).toBeNull();
    expect(session.appId).toBe("edge-cinema");
    expect(session.lastError).toBeNull();
    expect(session.managedByVelora).toBe(false);

    expect(() => normalizeCinemaSession(null)).not.toThrow();
    expect(() => normalizeCinemaSession("garbage")).not.toThrow();
    expect(normalizeCinemaSession(null).status).toBe("idle");
  });

  it("returns an error session with a sanitized lastError when invoke rejects", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("raw failure C:\\secret 0xDEAD"));

    const session = await getEdgeCinemaSession();

    expect(session.status).toBe("error");
    expect(session.lastError).not.toBeNull();
    expect(session.lastError?.code).toBe("edge-error");
    expect(session.lastError?.message).not.toMatch(/C:\\|0x|secret/i);
  });

  it("keeps web preview read-only: IDLE_CINEMA_SESSION and invoke NOT called", async () => {
    mocks.isTauri.mockReturnValue(false);

    const session = await getEdgeCinemaSession();

    expect(session).toEqual(IDLE_CINEMA_SESSION);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("requestEdgeCinemaClose", () => {
  it("sends { sessionId, confirm: true } and returns an executed ack", async () => {
    mocks.invoke.mockResolvedValueOnce({ state: "closing" });

    const ack = await requestEdgeCinemaClose("edge-cinema-1-1");

    expect(mocks.invoke).toHaveBeenCalledWith("request_edge_cinema_close", {
      sessionId: "edge-cinema-1-1",
      confirm: true,
    });
    expect(ack.status).toBe("executed");
    expect(ack.error).toBeNull();
    expect(ack.idempotencyKey).toBe(idempotencyKey(["edge-close", "edge-cinema-1-1"]));
  });

  it("returns a rejected ack with edge-error when invoke rejects", async () => {
    mocks.invoke.mockRejectedValueOnce(
      new Error("Zamknięcie okna Edge Cinema wymaga potwierdzenia."),
    );

    const ack = await requestEdgeCinemaClose("edge-cinema-1-1");

    expect(ack.status).toBe("rejected");
    expect(ack.error?.code).toBe("edge-error");
  });
});

describe("mark / reset session commands", () => {
  it("markEdgeCinemaExited calls report_edge_cinema_exit and normalizes", async () => {
    mocks.invoke.mockResolvedValueOnce({ state: "exited" });

    const session = await markEdgeCinemaExited("edge-cinema-1-1");

    expect(mocks.invoke).toHaveBeenCalledWith("report_edge_cinema_exit", {
      sessionId: "edge-cinema-1-1",
    });
    expect(session.status).toBe("exited");
  });

  it("resetEdgeCinemaSession calls reset_edge_cinema_session", async () => {
    mocks.invoke.mockResolvedValueOnce({ state: "idle" });

    const session = await resetEdgeCinemaSession();

    expect(mocks.invoke).toHaveBeenCalledWith("reset_edge_cinema_session");
    expect(session.status).toBe("idle");
  });
});

describe("createTauriEdgeCinemaLifecycleAdapter().subscribe", () => {
  it("registers the 3 VELORA_EVENTS names and returns an unsubscribe", () => {
    const adapter = createTauriEdgeCinemaLifecycleAdapter();

    const stop = adapter.subscribe(vi.fn());

    expect(mocks.listen).toHaveBeenCalledTimes(3);
    expect(mocks.listen.mock.calls.map((call) => call[0])).toEqual([
      VELORA_EVENTS.cinemaSessionChanged,
      VELORA_EVENTS.cinemaExited,
      VELORA_EVENTS.cinemaCloseRequested,
    ]);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("forwards the handler payload as a typed event", () => {
    const listener = vi.fn();
    const adapter = createTauriEdgeCinemaLifecycleAdapter();
    adapter.subscribe(listener);

    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => void;
    const payload = { session: { state: "active" } };

    handler({ payload });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        name: VELORA_EVENTS.cinemaSessionChanged,
        payload,
      }),
    );
  });

  it("does not register listeners outside Tauri", () => {
    mocks.isTauri.mockReturnValue(false);
    const adapter = createTauriEdgeCinemaLifecycleAdapter();

    const stop = adapter.subscribe(vi.fn());

    expect(mocks.listen).not.toHaveBeenCalled();
    expect(typeof stop).toBe("function");
  });
});

describe("createFallbackEdgeCinemaLifecycleAdapter", () => {
  it("is a web-preview no-op that never calls invoke", async () => {
    const adapter = createFallbackEdgeCinemaLifecycleAdapter();

    expect(await adapter.getSession()).toEqual(IDLE_CINEMA_SESSION);
    expect((await adapter.requestClose("s1")).status).toBe("rejected");
    expect(await adapter.markExited("s1")).toEqual(IDLE_CINEMA_SESSION);
    expect(typeof adapter.subscribe(vi.fn())).toBe("function");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("shouldRestoreVeloraOnExit / shouldBlockDuplicateLaunch", () => {
  it("shouldRestoreVeloraOnExit is true only for closed + managed sessions", () => {
    const base = { ...IDLE_CINEMA_SESSION };
    expect(shouldRestoreVeloraOnExit({ ...base, status: "exited", managedByVelora: true })).toBe(true);
    expect(shouldRestoreVeloraOnExit({ ...base, status: "error", managedByVelora: true })).toBe(true);
    expect(shouldRestoreVeloraOnExit({ ...base, status: "exited", managedByVelora: false })).toBe(false);
    expect(shouldRestoreVeloraOnExit({ ...base, status: "active", managedByVelora: true })).toBe(false);
    expect(shouldRestoreVeloraOnExit({ ...base, status: "idle", managedByVelora: true })).toBe(false);
  });

  it("shouldBlockDuplicateLaunch is true only for active + managed sessions", () => {
    const base = { ...IDLE_CINEMA_SESSION };
    expect(shouldBlockDuplicateLaunch({ ...base, status: "active" })).toBe(true);
    expect(shouldBlockDuplicateLaunch({ ...base, status: "launching" })).toBe(true);
    expect(shouldBlockDuplicateLaunch({ ...base, status: "exited" })).toBe(false);
    expect(shouldBlockDuplicateLaunch({ ...base, status: "active", managedByVelora: false })).toBe(false);
  });
});

describe("setVeloraFullscreen", () => {
  it("uses the existing windowMode helper on VELORA's own window", async () => {
    await setVeloraFullscreen(true);
    expect(mocks.window.setFullscreen).toHaveBeenCalledWith(true);
  });
});

describe("edgeCinemaLifecycleErrorMessage", () => {
  it("maps duplicate / unconfirmed / non-Windows errors without leaking raw text", () => {
    expect(edgeCinemaLifecycleErrorMessage("Okno Edge Cinema jest już uruchomione. VELORA nie uruchamia duplikatu."))
      .toMatch(/duplikatu/);
    expect(edgeCinemaLifecycleErrorMessage(new Error("Zamknięcie okna Edge Cinema wymaga potwierdzenia. C:\\secret 0xDEAD")))
      .toMatch(/potwierdzenia/);
    expect(edgeCinemaLifecycleErrorMessage("Edge Cinema jest dostępne tylko w natywnej aplikacji Windows."))
      .toMatch(/Windows/);

    const leaky = edgeCinemaLifecycleErrorMessage(
      new Error("raw C:\\Users\\secret os error 0x5 at foo"),
    );
    expect(leaky).not.toMatch(/C:\\|0x|os error| at /i);
  });

  it("maps protected-content, site-change and navigation failures to calm, honest guidance", () => {
    const protectedNotice = edgeCinemaLifecycleErrorMessage("Treść chroniona — PlayReady error");
    expect(protectedNotice).toMatch(/nie omija zabezpieczeń/);
    expect(protectedNotice).toMatch(/nie gwarantuje odtwarzania/);
    expect(protectedNotice).not.toMatch(/kompatybiln|sprawdzon/i);

    const siteNotice = edgeCinemaLifecycleErrorMessage("Strona usługi zmieniła adres");
    expect(siteNotice).toMatch(/oficjalny adres/);
    expect(siteNotice).not.toMatch(/kompatybiln|sprawdzon/i);

    const navNotice = edgeCinemaLifecycleErrorMessage("navigation failed");
    expect(navNotice).toMatch(/Sprawdź połączenie/);
    expect(navNotice).toMatch(/nie gwarantuje/);
  });
});

describe("normalizeCinemaSession", () => {
  it("rejects an injected state (falls back to idle)", () => {
    expect(normalizeCinemaSession({ state: "HACKED", managedByVelora: true, pid: 7 }).status).toBe("idle");
    expect(normalizeCinemaSession({ state: {} }).status).toBe("idle");
    expect(normalizeCinemaSession({ state: "active" }).status).toBe("active");
  });

  it("sanitizes lastError into a VeloraError", () => {
    const session = normalizeCinemaSession({ state: "error", lastError: "boom\nC:\\secret" });
    expect(session.lastError?.code).toBe("edge-error");
    expect(session.lastError?.message).not.toMatch(/\n/);
  });
});

/**
 * Deterministic simulated workflows: repeated Home → launch → close/crash →
 * restore → Home cycles driven purely through the adapter's pure helpers. No
 * native calls are made, so the assertions are stable on any machine.
 */
describe("Edge Cinema Lifecycle — deterministic workflows", () => {
  it("normalizes injected/tampered state to a safe idle record across every cycle", () => {
    const tampered: unknown[] = [
      { state: "HACKED", managedByVelora: true, pid: 7 },
      { state: null },
      { state: 42 },
      { state: "active\u0000" },
      { state: "__proto__" },
      { state: "ACTIVE", managedByVelora: "true", pid: -5, sessionId: {} },
      [],
      "active",
      null,
      undefined,
    ];
    for (let cycle = 0; cycle < 64; cycle++) {
      for (const value of tampered) {
        // The state is the security boundary: anything outside the whitelist
        // (or any non-object input) always collapses to idle.
        expect(normalizeCinemaSession(value).status).toBe("idle");
      }
    }
    // Other fields are sanitized by type, independently of the state.
    const sanitized = normalizeCinemaSession({
      state: "ACTIVE",
      managedByVelora: "true",
      pid: -5,
      sessionId: {},
      lastError: 42,
    });
    expect(sanitized.pid).toBeNull();
    expect(sanitized.sessionId).toBeNull();
    expect(sanitized.managedByVelora).toBe(false);
    expect(sanitized.lastError).toBeNull();

    // A genuine active wire from the native layer is preserved.
    expect(normalizeCinemaSession({ ...validWire, state: "active" }).status).toBe("active");
  });

  it("offers no duplicate launch while a managed session is active, across repeated transitions", () => {
    const states: CinemaSession["status"][] = [
      "idle", "launching", "active", "closing", "exited", "error",
    ];
    for (let cycle = 0; cycle < 64; cycle++) {
      for (const status of states) {
        for (const managedByVelora of [true, false]) {
          const session: CinemaSession = { ...IDLE_CINEMA_SESSION, status, managedByVelora };
          expect(shouldBlockDuplicateLaunch(session)).toBe(
            (status === "active" || status === "launching") && managedByVelora,
          );
        }
      }
    }
  });

  it("holds the restoration predicate only at terminal, managed transitions", () => {
    const base: CinemaSession = { ...IDLE_CINEMA_SESSION, managedByVelora: true };
    const expectations: Array<[CinemaSession["status"], boolean]> = [
      ["active", false],
      ["launching", false],
      ["closing", false],
      ["exited", true],
      ["idle", false],
      ["active", false],
      ["error", true],
      ["idle", false],
    ];
    for (let cycle = 0; cycle < 64; cycle++) {
      for (const [status, expected] of expectations) {
        expect(shouldRestoreVeloraOnExit({ ...base, status })).toBe(expected);
      }
    }
    // The native launch registry ends a session once; this predicate is only a
    // pure signal and never calls focus itself.
    expect(shouldRestoreVeloraOnExit({ ...base, status: "exited", managedByVelora: false })).toBe(false);
    expect(shouldRestoreVeloraOnExit({ ...base, status: "active" })).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not add a second focus path — the native broker owns focus", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/services/edgeCinemaLifecycle.ts"),
      "utf8",
    );
    for (const api of [
      "setFocus",
      "setForegroundWindow",
      "request_foreground",
      "restore_velora_window",
      "AttachThreadInput",
      "SendInput",
    ]) {
      expect(source).not.toMatch(new RegExp(`\\b${api}\\b`));
    }
    // The only window helper used is fullscreen on VELORA's own window.
    expect(source).toContain("windowMode");
  });
});
