// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionsPanel } from "../components/SessionsPanel";
import type { ManagedSession } from "../services/veloraSessionManager";

const mocks = vi.hoisted(() => ({ get: vi.fn(), resume: vi.fn(), close: vi.fn(), listen: vi.fn(async (_callback: () => void) => () => {}) }));
vi.mock("../services/veloraSessionManager", async () => ({
  ...await vi.importActual<typeof import("../services/veloraSessionManager")>("../services/veloraSessionManager"),
  getManagedSessions: mocks.get, resumeManagedSession: mocks.resume, closeManagedSession: mocks.close,
  listenForManagedSessionUpdate: mocks.listen,
}));

const session: ManagedSession = { sessionId: "cinema-1", appId: "netflix", applicationType: "cinema", name: "Netflix",
  launchMethod: "ownedBrowserWindow", state: "background", launchedAtMs: 1, lastObservedAtMs: 2,
  lastActivationAtMs: null, canResume: true, canClose: true, lastFailure: null };
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

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

async function requestClose() {
  vi.useFakeTimers();
  mocks.get.mockResolvedValue({ supported: true, sessions: [session] });
  mocks.close.mockResolvedValue({ accepted: true, activated: false, message: "Wysłano prośbę o zamknięcie" });
  const view = render(<SessionsPanel />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Zamknij Netflix" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Potwierdź zamknięcie Netflix" })); });
  return view;
}

it("confirms a terminal close from the existing watcher and cancels the delayed check", async () => {
  await requestClose();
  mocks.get.mockResolvedValue({ supported: true, sessions: [{ ...session, state: "exited", canResume: false, canClose: false }] });
  const onUpdate = mocks.listen.mock.calls[0][0] as unknown as () => void;
  await act(async () => { onUpdate(); });
  expect(screen.getByRole("status").textContent).toContain("Potwierdzono zakończenie sesji Netflix");
  const reads = mocks.get.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(mocks.get).toHaveBeenCalledTimes(reads);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("warns after one bounded read when WM_CLOSE was accepted but the session remains active", async () => {
  await requestClose();
  expect(screen.getByRole("status").textContent).toContain("Wysłano prośbę");
  const initialReads = mocks.get.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
  expect(screen.getByRole("alert").textContent).toContain("Nie potwierdzono zamknięcia okna Netflix");
  expect(screen.getByRole("button", { name: "Sprawdź okno Netflix" })).toBeDefined();
  expect(screen.queryByRole("status")).toBeNull();
  expect(mocks.get).toHaveBeenCalledTimes(initialReads + 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mocks.get).toHaveBeenCalledTimes(initialReads + 1);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("treats a missing retained session as confirmed only after a supported native read", async () => {
  await requestClose();
  mocks.get.mockResolvedValue({ supported: true, sessions: [] });
  await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
  expect(screen.getByRole("status").textContent).toContain("Potwierdzono zakończenie sesji Netflix");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not infer closure from an unavailable native snapshot or a failed delayed read", async () => {
  await requestClose();
  mocks.get.mockResolvedValue({ supported: false, sessions: [] });
  await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
  expect(screen.getByRole("alert").textContent).toContain("Nie potwierdzono zamknięcia");
  expect(screen.queryByRole("status")).toBeNull();
  mocks.get.mockRejectedValueOnce(new Error("native read failed"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Odśwież sesje" })); });
  expect(screen.getAllByRole("alert").some(alert => alert.textContent?.includes("Nie potwierdzono zamknięcia"))).toBe(true);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("cancels close observation when the user resumes and never overwrites the newer result", async () => {
  await requestClose();
  mocks.resume.mockResolvedValue({ accepted: true, activated: true, message: "Przywrócono okno Netflix" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Wznów Netflix" })); });
  const reads = mocks.get.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(mocks.get).toHaveBeenCalledTimes(reads);
  expect(screen.getByRole("status").textContent).toBe("Przywrócono okno Netflix");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("cleans up its delayed read on unmount and ignores a late read from a previous panel", async () => {
  const first = await requestClose();
  const reads = mocks.get.mock.calls.length;
  first.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
  expect(mocks.get).toHaveBeenCalledTimes(reads);

  const second = await requestClose();
  let complete!: (value: { supported: boolean; sessions: ManagedSession[] }) => void;
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
  expect(screen.getByRole("alert").textContent).toContain("Nie potwierdzono zamknięcia");
  second.unmount();
  mocks.get.mockResolvedValue({ supported: true, sessions: [session] });
  render(<SessionsPanel />);
  await act(async () => {});
  await act(async () => { complete({ supported: true, sessions: [] }); });
  expect(screen.getByRole("button", { name: "Wznów Netflix" })).toBeDefined();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
