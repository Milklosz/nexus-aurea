// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TvNavigationSettings } from "../components/TvNavigationSettings";
import { canRemoteSelect } from "../services/remotePermissions";
const mocks = vi.hoisted(() => ({ read: vi.fn(), mode: vi.fn(), arm: vi.fn() }));
vi.mock("../services/tvNavigation", () => ({ getTvNavigationStatus: mocks.read, setTvNavigationMode: mocks.mode, setTvNavigationMediaControls: mocks.arm }));
vi.mock("../services/veloraSessionManager", () => ({ getManagedSessions: vi.fn(async () => ({ sessions: [
  { sessionId: "owned-session", applicationType: "cinema", name: "YouTube", state: "background", canResume: true },
] })) }));
const status = { windows: true, mode: "keyboard", activeStrategy: "keyboard", enabled: true, simulatorAvailable: false, generation: 3, mediaControlsArmed: false };
beforeEach(() => { mocks.read.mockResolvedValue(status); mocks.mode.mockImplementation(async mode => ({ ...status, mode })); mocks.arm.mockImplementation(async armed => ({ ...status, mediaControlsArmed: armed })); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
it("offers production mode selection while simulator is unavailable without exposing it to LAN remote", async () => {
  render(<TvNavigationSettings revision="true:false" />); await flush();
  const mode = screen.getByRole("combobox", { name: "Strategia nawigacji" });
  expect((mode as HTMLSelectElement).disabled).toBe(false);
  expect(canRemoteSelect(mode)).toBe(false);
  fireEvent.change(mode, { target: { value: "pointer" } }); await flush();
  expect(mocks.mode).toHaveBeenCalledExactlyOnceWith("pointer");
  expect(mocks.arm).not.toHaveBeenCalled();
  const arm = screen.getByRole("button", { name: "Uzbrój skróty odtwarzania TV" });
  expect((arm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Sesja odtwarzacza" }), { target: { value: "owned-session" } });
  fireEvent.click(arm); await flush();
  expect(mocks.arm).toHaveBeenCalledExactlyOnceWith(true, "owned-session");
});
it("disables native TV preferences on non-Windows platforms", async () => {
  mocks.read.mockResolvedValue({ ...status, windows: false });
  render(<TvNavigationSettings revision="false:false" />); await flush();
  expect((screen.getByRole("combobox", { name: "Strategia nawigacji" }) as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Uzbrój skróty odtwarzania TV" }) as HTMLButtonElement).disabled).toBe(true);
});
it("leaves settings disabled after a failed read and reports an explicit retry", async () => {
  mocks.read.mockRejectedValue(new Error("unavailable"));
  render(<TvNavigationSettings revision="false:false" />); await flush();
  expect((screen.getByRole("combobox", { name: "Strategia nawigacji" }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("niedostępny");
  mocks.read.mockResolvedValue(status);
  fireEvent.click(screen.getByRole("button", { name: "Odśwież tryb nawigacji TV" })); await flush();
  expect((screen.getByRole("combobox", { name: "Strategia nawigacji" }) as HTMLSelectElement).disabled).toBe(false);
});
