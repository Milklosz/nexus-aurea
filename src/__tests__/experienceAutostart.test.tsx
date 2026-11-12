// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutostartPanel } from "../components/AutostartPanel";

// End-to-end autostart interaction on the REAL AutostartPanel. Only the service
// boundary is mocked, so the opt-in / safe-mode / retry behaviour is real.
const mocks = vi.hoisted(() => ({
  status: null as any,
  mode: null as any,
  getStatus: vi.fn(async () => mocks.status),
  getMode: vi.fn(async () => mocks.mode),
  setEnabled: vi.fn(async (_enabled: boolean, _windowed: boolean) => mocks.status),
  disabled: {
    windows: false,
    supported: false,
    enabled: false,
    windowed: false,
    lastError: "Autostart jest dostępny tylko w natywnej aplikacji Windows.",
  },
  flag: "--windowed",
  errorMessage: (cause: unknown, fallback?: string): string => {
    if (typeof cause === "string" && cause.trim()) return cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return fallback ?? "Błąd autostartu.";
  },
}));

vi.mock("../services/autostart", () => ({
  SAFE_MODE_FLAG: mocks.flag,
  disabledAutostartStatus: mocks.disabled,
  getAutostartStatus: mocks.getStatus,
  getStartupMode: mocks.getMode,
  setAutostartEnabled: mocks.setEnabled,
  autostartErrorMessage: mocks.errorMessage,
}));

function status(overrides: Record<string, unknown> = {}) {
  return {
    windows: true,
    supported: true,
    enabled: false,
    windowed: false,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.status = status();
  mocks.mode = { windowed: false, autostartEnabled: false };
  mocks.getStatus.mockReset();
  mocks.getMode.mockReset();
  mocks.setEnabled.mockReset();
  mocks.getStatus.mockImplementation(async () => mocks.status);
  mocks.getMode.mockImplementation(async () => mocks.mode);
  mocks.setEnabled.mockImplementation(async (enabled: boolean, windowed: boolean) => {
    mocks.status = status({ enabled, windowed });
    return mocks.status;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mountReady(): Promise<HTMLButtonElement> {
  render(<AutostartPanel />);
  const toggle = await screen.findByRole("switch", { name: /autostart/i });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  return toggle as HTMLButtonElement;
}

describe("Experience autostart — opt-in write only on explicit clicks", () => {
  it("performs only read calls on mount and NEVER writes autostart", async () => {
    await mountReady();
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(1));
    expect(mocks.getMode).toHaveBeenCalledTimes(1);
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("enables with windowed=false on the first switch click", async () => {
    const toggle = await mountReady();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(true, false));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("carries the --windowed checkbox into setAutostartEnabled(true, true)", async () => {
    const toggle = await mountReady();
    const checkbox = screen.getByRole("checkbox", { name: /--windowed/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(true, true));
  });

  it("disables with the current windowed value when clicked while enabled", async () => {
    mocks.status = status({ enabled: true, windowed: true });
    const toggle = await mountReady();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false, true));
  });

  it("surfaces a failed write through an alert and offers a retry", async () => {
    const toggle = await mountReady();
    mocks.setEnabled.mockRejectedValueOnce(new Error("reg.exe odmówił zapisu."));
    fireEvent.click(toggle);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("reg.exe odmówił zapisu.");
    expect(screen.getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
  });

  it("keeps the switch disabled for an unsupported autostart status", async () => {
    mocks.status = status({ windows: false, supported: false });
    render(<AutostartPanel />);
    const toggle = (await screen.findByRole("switch", { name: /autostart/i })) as HTMLButtonElement;
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("keeps the notice in an aria-live=polite status region (getAllByRole-safe)", async () => {
    await mountReady();
    // getAllByRole is correct even when the panel is mounted inside
    // ControlCenter, which renders several role="status" regions.
    const regions = screen.getAllByRole("status");
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions.some((region) => region.getAttribute("aria-live") === "polite")).toBe(true);
  });
});
