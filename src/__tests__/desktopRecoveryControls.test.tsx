// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopRecoveryControls } from "../components/DesktopRecoveryControls";
import { canRemoteSelect } from "../services/remotePermissions";
const native = vi.hoisted(() => ({ enabled: true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled, invoke: native.invoke }));
afterEach(() => { cleanup(); native.enabled = true; native.invoke.mockReset(); });
describe("explicit desktop recovery", () => {
  it("blocks repeated requests while the native exit is pending and denies remote activation", async () => {
    native.invoke.mockReturnValue(new Promise(() => {}));
    render(<DesktopRecoveryControls />);
    const button = screen.getByRole("button", { name: "Zakończ VELORA" });
    expect(canRemoteSelect(button)).toBe(false);
    fireEvent.click(button); fireEvent.click(button);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("exit_velora");
  });
  it("reports native restart failures and permits retry", async () => {
    native.invoke.mockRejectedValue(new Error("private detail"));
    render(<DesktopRecoveryControls />);
    fireEvent.click(screen.getByRole("button", { name: "Uruchom ponownie VELORA" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nie udało"));
    expect(screen.getByRole("alert").textContent).not.toContain("private detail");
  });
  it("keeps browser previews inert", () => {
    native.enabled = false;
    render(<DesktopRecoveryControls />);
    fireEvent.click(screen.getByRole("button", { name: "Zakończ VELORA" }));
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
