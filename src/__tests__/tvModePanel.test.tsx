// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TvModePanel } from "../components/TvModePanel";
const mocks = vi.hoisted(() => ({ get: vi.fn(), apply: vi.fn() }));
vi.mock("../services/tvMode", () => ({
  unsupportedTvMode: { supported: false, displays: [], selectedDisplayId: null, fullscreen: false, selectionAvailable: false, error: null },
  getTvModeStatus: mocks.get,
  applyTvMode: mocks.apply,
}));
const ready = { supported: true, displays: [{ id: "a".repeat(64), name: "Native screen", width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 1, primary: true, current: true }], selectedDisplayId: null, fullscreen: false, selectionAvailable: false, error: null };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe("TV selection UI", () => {
  it("reads without changing a display and keeps settings local-only", async () => {
    mocks.get.mockResolvedValue(ready);
    render(<TvModePanel />);
    const screenChoice = await screen.findByRole("button", { name: "Pełny ekran: Native screen" });
    expect(screenChoice.closest("section")?.hasAttribute("data-remote-admin")).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("only applies a native opaque identity after explicit selection", async () => {
    mocks.get.mockResolvedValue(ready);
    mocks.apply.mockResolvedValue({ ...ready, fullscreen: true });
    render(<TvModePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Pełny ekran: Native screen" }));
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledWith("a".repeat(64), true));
    expect(await screen.findByRole("status")).toBeTruthy();
  });
  it("reports a disconnected screen without claiming success", async () => {
    mocks.get.mockResolvedValue(ready);
    mocks.apply.mockRejectedValue(Error("gone"));
    render(<TvModePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Pełny ekran: Native screen" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("shows only the refresh rate and transport reported by native Windows data", async () => {
    mocks.get.mockResolvedValue({ ...ready, displays: [{ ...ready.displays[0], refreshHz: 60, connectionType: "HDMI" }] });
    render(<TvModePanel />);
    expect(await screen.findByText(/1920 × 1080 · 60 Hz · HDMI/)).toBeTruthy();
  });
  it("keeps unavailable transport and refresh metadata explicitly unknown", async () => {
    mocks.get.mockResolvedValue({ ...ready, displays: [{ ...ready.displays[0], refreshHz: null, connectionType: null }] });
    render(<TvModePanel />);
    expect(await screen.findByText(/odświeżanie nieznane · połączenie nieznane/)).toBeTruthy();
    expect(screen.queryByText(/HDMI/)).toBeNull();
  });
});
