// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppManagerPanel } from "../components/AppManagerPanel";

const mocks = vi.hoisted(() => ({ launch: vi.fn(), status: vi.fn() }));
vi.mock("../services/appManager", async () => {
  const actual = await vi.importActual<typeof import("../services/appManager")>("../services/appManager");
  return { ...actual, launchManagedApp: mocks.launch, getAppManagerStatus: mocks.status };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function runningSnapshot() {
  return { windows: true, foregroundProcess: "nexus-aurea.exe", games: [], gamesError: null, apps: [{
    id: "steamBigPicture", name: "Steam Big Picture", processName: "steam.exe", installed: true,
    runningInstances: 1, focusRestoreSupported: false, lastError: null,
  }] };
}

it("reports an actually restored managed window without requiring a keyboard shortcut", async () => {
  mocks.status.mockResolvedValue(runningSnapshot());
  mocks.launch.mockResolvedValue({ id: "steamBigPicture", alreadyRunning: true, focusRestoreSupported: false, resumed: true });
  render(<AppManagerPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Wznów" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Przywrócono okno Steam Big Picture"));
  expect(screen.getByRole("status").textContent).toContain("Home");
  expect(screen.queryByText(/Alt\+Tab/)).toBeNull();
});

it("keeps a denied foreground request visible instead of claiming the application resumed", async () => {
  mocks.status.mockResolvedValue(runningSnapshot());
  mocks.launch.mockRejectedValue("Windows nie przywrócił fokusu Steam. Sesja pozostaje śledzona.");
  render(<AppManagerPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Wznów" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("nie przywrócił fokusu"));
  expect(screen.queryByText(/Przywrócono okno/)).toBeNull();
});
