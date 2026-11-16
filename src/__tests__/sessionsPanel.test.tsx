// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionsPanel } from "../components/SessionsPanel";
import type { ManagedSession } from "../services/veloraSessionManager";

const mocks = vi.hoisted(() => ({ get: vi.fn(), resume: vi.fn(), close: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("../services/veloraSessionManager", async () => ({
  ...await vi.importActual<typeof import("../services/veloraSessionManager")>("../services/veloraSessionManager"),
  getManagedSessions: mocks.get, resumeManagedSession: mocks.resume, closeManagedSession: mocks.close,
  listenForManagedSessionUpdate: mocks.listen,
}));

const session: ManagedSession = { sessionId: "cinema-1", appId: "netflix", applicationType: "cinema", name: "Netflix",
  launchMethod: "ownedBrowserWindow", state: "background", launchedAtMs: 1, lastObservedAtMs: 2,
  lastActivationAtMs: null, canResume: true, canClose: true, lastFailure: null };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("offers resume for an existing session and reports Windows denial honestly", async () => {
  mocks.get.mockResolvedValue({ supported: true, sessions: [session] });
  mocks.resume.mockRejectedValue("foreground denied");
  render(<SessionsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Wznów Netflix" }));
  await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith("cinema-1"));
  expect((await screen.findByRole("alert")).textContent).toContain("Nie przywrócono");
  expect(screen.queryByRole("status")).toBeNull();
});

it("requires a second explicit close action and reports request rather than termination", async () => {
  mocks.get.mockResolvedValue({ supported: true, sessions: [session] });
  mocks.close.mockResolvedValue({ accepted: true, activated: false, message: "Wysłano prośbę o zamknięcie" });
  render(<SessionsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Zamknij Netflix" }));
  expect(mocks.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Potwierdź zamknięcie Netflix" }));
  await waitFor(() => expect(mocks.close).toHaveBeenCalledWith("cinema-1", true));
  expect((await screen.findByRole("status")).textContent).toContain("Wysłano prośbę");
});

it("does not offer stale resume or close controls for exited or foreign sessions", async () => {
  mocks.get.mockResolvedValue({ supported: true, sessions: [{ ...session, state: "exited", canResume: false, canClose: false }] });
  render(<SessionsPanel />);
  const resume = await screen.findByRole("button", { name: "Wznów Netflix" }) as HTMLButtonElement;
  expect(resume.disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Zamknij Netflix" })).toBeNull();
  expect(screen.getByText("Zakończona")).toBeDefined();
});

it("discloses applications without managed sessions without fabricating a Resume action", async () => {
  mocks.get.mockResolvedValue({ supported: true, sessions: [], applications: [
    { appId: "youtube", name: "YouTube", state: "notRunning", sessionId: null },
  ] });
  render(<SessionsPanel />);
  const showApps = await screen.findByRole("button", { name: "Pozostałe aplikacje" });
  expect(showApps.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(/YouTube —/)).toBeNull();
  fireEvent.click(showApps);
  expect(showApps.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText(/YouTube — Nie uruchomiono przez VELORA/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Wznów YouTube" })).toBeNull();
  expect(mocks.resume).not.toHaveBeenCalled();
});
