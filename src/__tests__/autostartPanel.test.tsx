// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutostartPanel } from "../components/AutostartPanel";
import type { AutostartStatus, StartupMode } from "../services/autostart";

const mocks = vi.hoisted(() => ({
  status: null as AutostartStatus | null,
  mode: null as StartupMode | null,
  getStatus: vi.fn(async () => mocks.status!),
  getMode: vi.fn(async () => mocks.mode!),
  setEnabled: vi.fn(async (_enabled: boolean, _windowed: boolean) => mocks.status!),
  disabled: {
    windows: false,
    supported: false,
    enabled: false,
    windowed: false,
    lastError: "Autostart jest dostępny tylko w natywnej aplikacji Windows.",
  },
  flag: "--windowed",
  errorMessage: (cause: unknown, fallback?: string) => {
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function status(overrides: Partial<AutostartStatus> = {}): AutostartStatus {
  return {
    windows: true,
    supported: true,
    enabled: false,
    windowed: false,
    lastError: null,
    ...overrides,
  };
}

function mode(overrides: Partial<StartupMode> = {}): StartupMode {
  return { windowed: false, autostartEnabled: false, ...overrides };
}

beforeEach(() => {
  mocks.status = status();
  mocks.mode = mode();
  mocks.getStatus.mockImplementation(async () => mocks.status!);
  mocks.getMode.mockImplementation(async () => mocks.mode!);
  mocks.setEnabled.mockImplementation(async (enabled: boolean, windowed: boolean) => {
    mocks.status = status({ enabled, windowed });
    return mocks.status;
  });
});

async function mountReady(): Promise<HTMLButtonElement> {
  render(<AutostartPanel />);
  const toggle = await screen.findByRole("switch", { name: /autostart/i });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  return toggle as HTMLButtonElement;
}

describe("AutostartPanel", () => {
  it("renders the switch, consent note, safe-mode checkbox and current status", async () => {
    const toggle = await mountReady();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Włączenie autostartu wymaga Twojej zgody/)).toBeTruthy();
    expect(screen.getByText(/HKCU/)).toBeTruthy();
    expect(screen.getByText(/Nie zmienia powłoki Windows/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /--windowed/ })).toBeTruthy();
    expect(screen.getByText(/wyłączony/)).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("never calls setAutostartEnabled on mount — only reads status and mode", async () => {
    render(<AutostartPanel />);
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.getMode).toHaveBeenCalledTimes(1));
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("enables autostart with the current safe-mode value on an explicit switch click", async () => {
    const toggle = await mountReady();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(true, false));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Autostart włączony"));
  });

  it("disables autostart and removes the value when the switch is turned off", async () => {
    mocks.status = status({ enabled: true, windowed: true });
    const toggle = await mountReady();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/włączony/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /--windowed/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false, true));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("applies the safe-mode checkbox to the windowed argument", async () => {
    const toggle = await mountReady();
    const checkbox = screen.getByRole("checkbox", { name: /--windowed/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(true, true));
  });

  it("keeps controls disabled and reports 'niedostępny' when unsupported", async () => {
    mocks.status = status({ windows: false, supported: false });
    render(<AutostartPanel />);
    const toggle = await screen.findByRole("switch", { name: /autostart/i });
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/niedostępny/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("shows an error alert with a retry button and recovers on retry", async () => {
    mocks.getStatus.mockRejectedValueOnce(new Error("Nie udało się odczytać stanu autostartu."));
    render(<AutostartPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain("Nie udało się odczytać stanu autostartu.");
    const retry = screen.getByRole("button", { name: "Spróbuj ponownie" });
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("reports a failed write through the alert and offers a retry", async () => {
    const toggle = await mountReady();
    mocks.setEnabled.mockRejectedValueOnce(new Error("reg.exe odmówił zapisu."));
    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toContain("reg.exe odmówił zapisu.");
    expect(screen.getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
  });

  it("describes the emergency --windowed session reported by getStartupMode", async () => {
    mocks.mode = mode({ windowed: true });
    await mountReady();
    expect(screen.getByText(/awaryjnym trybie/)).toBeTruthy();
  });
});
