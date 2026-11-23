// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusRegainOutcomeNote,
  resolveSessionSelectionOnFocusRegain,
  shouldRestoreDockFocus,
} from "../services/windowFocusRestore";
import { sessionExitNotice } from "../services/sessionTransitionNotice";
import { recoveryCauseLabel } from "../services/sessionRecovery";
import { SessionsPanel } from "../components/SessionsPanel";
import type { ManagedSession } from "../services/veloraSessionManager";

const mocks = vi.hoisted(() => ({ get: vi.fn(), resume: vi.fn(), close: vi.fn(), listen: vi.fn(async (_cb: () => void) => () => {}) }));
vi.mock("../services/veloraSessionManager", async () => ({
  ...(await vi.importActual<typeof import("../services/veloraSessionManager")>("../services/veloraSessionManager")),
  getManagedSessions: mocks.get,
  resumeManagedSession: mocks.resume,
  closeManagedSession: mocks.close,
  listenForManagedSessionUpdate: mocks.listen,
}));

const baseSession: ManagedSession = {
  sessionId: "cinema-1", appId: "netflix", applicationType: "cinema", name: "Netflix",
  launchMethod: "ownedBrowserWindow", state: "foreground", launchedAtMs: 1, lastObservedAtMs: 2,
  lastActivationAtMs: 2, canResume: true, canClose: true, lastFailure: null,
  launchId: "cinema-1", managedByVelora: true, lifecycle: "active", generation: 1,
};

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("resolveSessionSelectionOnFocusRegain", () => {
  const sessions = [
    { sessionId: "cinema-1", state: "foreground", lastActivationAtMs: 10 },
    { sessionId: "cinema-2", state: "exited", lastActivationAtMs: 5 },
  ];

  it("keeps the selection untouched while a modal overlay is open", () => {
    expect(resolveSessionSelectionOnFocusRegain({ sessions, selectedSessionId: "cinema-1", overlayOpen: true }))
      .toEqual({ action: "keep", sessionId: "cinema-1" });
  });

  it("restores the selected session when it is still active", () => {
    expect(resolveSessionSelectionOnFocusRegain({ sessions, selectedSessionId: "cinema-1", overlayOpen: false }))
      .toEqual({ action: "restore", sessionId: "cinema-1", changed: false });
  });

  it("moves the selection to the most recent active session when the selected one exited", () => {
    const decision = resolveSessionSelectionOnFocusRegain({ sessions, selectedSessionId: "cinema-2", overlayOpen: false });
    expect(decision).toEqual({ action: "restore", sessionId: "cinema-1", changed: true });
  });

  it("clears the selection when the selected session ended and none is active", () => {
    const only = [{ sessionId: "cinema-2", state: "exited", lastActivationAtMs: 5 }];
    expect(resolveSessionSelectionOnFocusRegain({ sessions: only, selectedSessionId: "cinema-2", overlayOpen: false }))
      .toEqual({ action: "clear", reason: "sessionEnded" });
    expect(resolveSessionSelectionOnFocusRegain({ sessions: [], selectedSessionId: "cinema-9", overlayOpen: false }))
      .toEqual({ action: "clear", reason: "noneActive" });
  });

  it("selects the most recently active session when nothing was selected", () => {
    const decision = resolveSessionSelectionOnFocusRegain({ sessions, selectedSessionId: null, overlayOpen: false });
    expect(decision).toEqual({ action: "restore", sessionId: "cinema-1", changed: true });
    expect(resolveSessionSelectionOnFocusRegain({ sessions: [], selectedSessionId: null, overlayOpen: false }))
      .toEqual({ action: "keep", sessionId: null });
  });

  it("keeps the existing shouldRestoreDockFocus overlay rule", () => {
    expect(shouldRestoreDockFocus({ diagnosticsOpen: false, controlCenterOpen: false, dialogOpen: false })).toBe(true);
    expect(shouldRestoreDockFocus({ diagnosticsOpen: true, controlCenterOpen: false, dialogOpen: false })).toBe(false);
  });
});

describe("focusRegainOutcomeNote — truthful foreground-lock and unknown states", () => {
  it("documents the Windows foreground lock instead of promising focus", () => {
    const note = focusRegainOutcomeNote("blockedByWindows", "foregroundLock");
    expect(note).toContain("foreground lock");
    expect(note).toContain("nie wymusza");
  });

  it("reports an unexplained denial as unknown, never guessed", () => {
    expect(focusRegainOutcomeNote("blockedByWindows", null)).toContain("nieznan");
    expect(focusRegainOutcomeNote("blockedByWindows", "unknown")).toContain("nieznan");
    expect(focusRegainOutcomeNote("blockedByWindows", "accessDenied")).toContain("access denied");
    expect(focusRegainOutcomeNote("restored")).toContain("odzyskała fokus");
    expect(focusRegainOutcomeNote("blockedUnsafeForeground")).toContain("nie uruchomiła");
  });
});

describe("session exit notices", () => {
  it("surfaces a truthful diagnostic with the playback-state limitation", () => {
    const notice = sessionExitNotice("crashObserved", "boom");
    expect(notice).toContain("nieoczekiwanie");
    expect(notice).toContain("boom");
    expect(notice).toContain("nie odczytuje ani nie przywraca stanu odtwarzania");
  });

  it("reports an unrecognized cause as unknown instead of guessing", () => {
    expect(sessionExitNotice("something-else", null)).toContain("nieznana");
    expect(sessionExitNotice(null, null)).toContain("nieznana");
  });

  it("labels recovery reasons truthfully", () => {
    expect(recoveryCauseLabel("unexpectedExit")).toContain("nieoczekiwane");
    expect(recoveryCauseLabel("cleanRestart")).toContain("czysty restart");
    expect(recoveryCauseLabel(null)).toContain("nieznana");
  });
});

describe("SessionsPanel — bounded reads, selection restore, diagnostics", () => {
  it("reports a truthful error when the bounded session read times out", async () => {
    vi.useFakeTimers();
    mocks.get.mockReturnValue(new Promise(() => {})); // hung IPC
    render(<SessionsPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(screen.getByRole("alert").textContent).toContain("Nie udało się odczytać sesji");
  });

  it("restores the session selection on VELORA focus-regain", async () => {
    mocks.get.mockResolvedValue({ supported: true, sessions: [baseSession], applications: [] });
    render(<SessionsPanel />);
    const article = await screen.findByText("Netflix").then((el) => el.closest("article")!);
    await waitFor(() => expect(article.getAttribute("aria-current")).toBe("true"));

    // The selected session exits; another becomes active; focus-regain moves the selection.
    const exited = { ...baseSession, state: "exited" as const, lifecycle: "exited" as const, canResume: false, canClose: false };
    const other: ManagedSession = { ...baseSession, sessionId: "cinema-2", appId: "youtube", name: "YouTube", state: "foreground", lifecycle: "active", lastActivationAtMs: 99 };
    mocks.get.mockResolvedValue({ supported: true, sessions: [exited, other], applications: [] });
    fireEvent(window, new Event("focus"));
    const otherArticle = await screen.findByText("YouTube").then((el) => el.closest("article")!);
    await waitFor(() => expect(otherArticle.getAttribute("aria-current")).toBe("true"));
    expect(article.getAttribute("aria-current")).toBeNull();
  });

  it("shows per-session status, last error and transition receipts in Diagnostyka", async () => {
    const session: ManagedSession = {
      ...baseSession,
      state: "exited",
      lifecycle: "exited",
      canResume: false,
      canClose: false,
      lastFailure: "Sesja zakończona nieoczekiwanie.",
      transitionReceipts: [
        { seq: 1, sessionId: "cinema-1", from: "idle", to: "launching", cause: "launchRequested", atMs: 10 },
        { seq: 2, sessionId: "cinema-1", from: "launching", to: "active", cause: "processReady", atMs: 20 },
        { seq: 3, sessionId: "cinema-1", from: "active", to: "exited", cause: "exitObserved", atMs: 30 },
      ],
      lastTransition: { seq: 3, sessionId: "cinema-1", from: "active", to: "exited", cause: "exitObserved", atMs: 30 },
    };
    mocks.get.mockResolvedValue({ supported: true, sessions: [session], applications: [] });
    render(<SessionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Diagnostyka Netflix" }));
    expect(await screen.findByText(/Właściciel sesji: VELORA \(launch cinema-1\), generacja 1/)).toBeDefined();
    expect(screen.getByText(/Ostatni błąd: Sesja zakończona nieoczekiwanie\./)).toBeDefined();
    expect(screen.getByText(/Ostatnie przejście: active → exited — aplikacja zakończyła sesję sama/)).toBeDefined();
    expect(screen.getByText(/#1 idle → launching — uruchomienie rozpoczęte przez VELORA/)).toBeDefined();
    // Explicit limitation is surfaced in the diagnostics, honestly.
    expect(screen.getByText(/nie odczytuje ani nie przywraca stanu odtwarzania/)).toBeDefined();
  });

  it("sanitizes injected receipt fields instead of trusting the wire", async () => {
    const session: ManagedSession = {
      ...baseSession,
      lifecycle: "active; rm -rf /" as never,
      transitionReceipts: [
        { seq: 1, sessionId: "cinema-1", from: "idle", to: "launching", cause: "hacked" as never, atMs: 10 },
        "garbage" as never,
      ],
    };
    mocks.get.mockResolvedValue({ supported: true, sessions: [session], applications: [] });
    render(<SessionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Diagnostyka Netflix" }));
    // Injected cause is dropped (no receipt rendered); lifecycle falls back to the whitelist default.
    expect(screen.queryByText(/hacked/)).toBeNull();
    expect(await screen.findByText(/Netflix/)).toBeDefined();
  });
});
