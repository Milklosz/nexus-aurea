import { afterEach, expect, it, vi } from "vitest";
import { closeManagedSession, getManagedSessions, resumeManagedSession } from "../services/veloraSessionManager";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => mocks);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
afterEach(() => { vi.clearAllMocks(); mocks.isTauri.mockReturnValue(true); });

it("routes native actions by session ID without accepting raw windows or processes", async () => {
  mocks.invoke.mockResolvedValue({ accepted: true, activated: true, message: "Przywrócono" });
  await resumeManagedSession("cinema-2");
  expect(mocks.invoke).toHaveBeenCalledWith("resume_managed_session", { sessionId: "cinema-2" });
  await closeManagedSession("cinema-2", true);
  expect(mocks.invoke).toHaveBeenCalledWith("close_managed_session", { sessionId: "cinema-2", confirm: true });
});

it("rejects unconfirmed destructive actions and malformed IDs before native IPC", async () => {
  await expect(closeManagedSession("cinema-1", false)).rejects.toThrow("Potwierdź");
  for (const id of ["", "bad\nID", "x".repeat(129)]) await expect(resumeManagedSession(id)).rejects.toThrow("identyfikator");
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("never invents sessions or performs native actions in web preview", async () => {
  mocks.isTauri.mockReturnValue(false);
  expect(await getManagedSessions()).toEqual({ supported: false, sessions: [], applications: [] });
  await expect(resumeManagedSession("cinema-1")).rejects.toThrow("natywnej");
  expect(mocks.invoke).not.toHaveBeenCalled();
});
