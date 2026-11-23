// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { findConfirmTrigger, useConfirmGate } from "../components/ConfirmDialog";
import { RecoveryActionsPanel } from "../components/RecoveryActionsPanel";
import { canRemoteSelect, REMOTE_CONFIRM_ATTRIBUTE } from "../services/remotePermissions";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({})),
  revokeAll: vi.fn(async () => ({})),
  stopRemote: vi.fn(async () => ({})),
  inspectRecovery: vi.fn(async () => ({
    storeState: "damaged",
    message: "Magazyn uszkodzony.",
    recoveryRequired: true,
    options: [{ mode: "revoke-all-devices" as const, summary: "Odwołaj wszystkie urządzenia." }],
    confirmation: "TOKEN123",
    confirmationExpiresInSeconds: 120,
  })),
  runRecovery: vi.fn(async () => ({})),
  resetCinema: vi.fn(async () => ({})),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
}));

vi.mock("../services/remoteAccess", () => ({
  disabledRemoteAccessStatus: {},
  REMOTE_ACCESS_DISABLED_REASON: "off",
  getRemoteAccessStatus: vi.fn(async () => ({})),
  listenForRemoteAccessStatus: vi.fn(async () => () => {}),
  revokeAllRemoteDevices: mocks.revokeAll,
  stopRemoteAccess: mocks.stopRemote,
  inspectRemoteRecovery: mocks.inspectRecovery,
  runRemoteRecovery: mocks.runRecovery,
  revokeRemoteDevice: vi.fn(async () => ({})),
}));

vi.mock("../services/edgeCinemaLifecycle", () => ({
  resetEdgeCinemaSession: mocks.resetCinema,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Harness({ onAction }: { onAction: () => void }) {
  const gate = useConfirmGate();
  return <section onClickCapture={gate.captureClick}>
    <button type="button" data-velora-confirm="RYZYKOWNE: trwałe usunięcie danych." onClick={onAction}>
      Wykonaj ryzykowną akcję
    </button>
    <button type="button" onClick={onAction}>Zwykła akcja</button>
    {gate.dialog}
  </section>;
}

describe("genesis C — reusable confirm gate (data-velora-confirm)", () => {
  it("blocks the risky action on the first click and shows an accessible alertdialog", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Wykonaj ryzykowną akcję" }));
    expect(onAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("velora-confirm-title");
    expect(dialog.getAttribute("aria-describedby")).toBe("velora-confirm-warning");
    expect(document.getElementById("velora-confirm-warning")?.textContent).toContain("RYZYKOWNE");
    expect(screen.getByText(/Akcja: Wykonaj ryzykowną akcję/)).toBeTruthy();
    // safe default focus on Anuluj
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Anuluj" }));
  });

  it("runs the action exactly once after Potwierdź and closes the dialog", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Wykonaj ryzykowną akcję" }));
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Anuluj and Escape drop the action without running it", () => {
    const onAction = vi.fn();
    const { rerender } = render(<Harness onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Wykonaj ryzykowną akcję" }));
    fireEvent.click(screen.getByRole("button", { name: "Anuluj" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    rerender(<Harness onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Wykonaj ryzykowną akcję" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("leaves non-gated buttons untouched", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Zwykła akcja" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not open the gate for a disabled gated button", () => {
    const onAction = vi.fn();
    function DisabledHarness() {
      const gate = useConfirmGate();
      return <section onClickCapture={gate.captureClick}>
        <button type="button" disabled data-velora-confirm="x" onClick={onAction}>Wyłączone</button>
        {gate.dialog}
      </section>;
    }
    render(<DisabledHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Wyłączone" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("pure helpers: findConfirmTrigger resolves nested targets and ignores the dispatch marker", () => {
    const button = document.createElement("button");
    button.setAttribute(REMOTE_CONFIRM_ATTRIBUTE, "warn");
    const span = document.createElement("span");
    button.append(span);
    document.body.append(button);
    expect(findConfirmTrigger(span)).toBe(button);
    expect(findConfirmTrigger(document.body)).toBeNull();
    button.setAttribute("data-velora-confirmed-dispatch", "");
    expect(findConfirmTrigger(span)).toBeNull();
    button.remove();
  });

  it("canRemoteSelect denies confirm-gated controls everywhere (fail-closed)", () => {
    const dialog = document.createElement("dialog");
    dialog.open = true;
    dialog.innerHTML = `
      <button id="gated" data-velora-confirm="warn">Ryzykowna</button>
      <button id="safe" data-remote-allow="">Bezpieczna</button>
      <section data-remote-allow=""><button id="gated-in-allow" data-velora-confirm="warn">Ryzykowna w dozwolonej sekcji</button></section>
    `;
    document.body.append(dialog);
    expect(canRemoteSelect(dialog.querySelector("#gated"))).toBe(false);
    expect(canRemoteSelect(dialog.querySelector("#safe"))).toBe(true);
    expect(canRemoteSelect(dialog.querySelector("#gated-in-allow"))).toBe(false);
    const outside = document.createElement("button");
    outside.setAttribute(REMOTE_CONFIRM_ATTRIBUTE, "warn");
    document.body.append(outside);
    expect(canRemoteSelect(outside)).toBe(false);
    dialog.remove();
    outside.remove();
  });
});

describe("genesis C — RecoveryActionsPanel gated risky actions", () => {
  function renderPanel(onShowDesktop = vi.fn()) {
    render(<RecoveryActionsPanel onShowDesktop={onShowDesktop} />);
    return onShowDesktop;
  }

  it("requires confirmation before exit_velora / restart_velora", async () => {
    renderPanel();
    const exit = screen.getByRole("button", { name: "Zakończ VELORA (z potwierdzeniem)" });
    expect(exit.hasAttribute(REMOTE_CONFIRM_ATTRIBUTE)).toBe(true);
    expect(canRemoteSelect(exit)).toBe(false);
    fireEvent.click(exit);
    expect(mocks.invoke).not.toHaveBeenCalledWith("exit_velora");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect(mocks.invoke).toHaveBeenCalledWith("exit_velora");
    await act(async () => {});

    const restart = screen.getByRole("button", { name: "Uruchom ponownie VELORA (z potwierdzeniem)" });
    fireEvent.click(restart);
    expect(mocks.invoke).not.toHaveBeenCalledWith("restart_velora");
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect(mocks.invoke).toHaveBeenCalledWith("restart_velora");
    await act(async () => {});
  });

  it("gates revoke-all, stop-remote, cinema reset and restore-desktop behind the same dialog", async () => {
    const showDesktop = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Odwołaj wszystkie urządzenia zdalne" }));
    expect(mocks.revokeAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect(mocks.revokeAll).toHaveBeenCalledTimes(1);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Zatrzymaj dostęp zdalny (serwer LAN)" }));
    expect(mocks.stopRemote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Anuluj" }));
    expect(mocks.stopRemote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Zresetuj sesję Edge Cinema" }));
    expect(mocks.resetCinema).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect(mocks.resetCinema).toHaveBeenCalledTimes(1);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Przywróć pulpit Windows (z potwierdzeniem)" }));
    expect(showDesktop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect(showDesktop).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });

  it("gates the remote-recovery execution behind choice + acknowledgement + confirm", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Przygotuj odzyskiwanie zaufania…" }));
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect(mocks.inspectRecovery).toHaveBeenCalledTimes(1);

    const execute = await screen.findByRole("button", { name: "Wykonaj odzyskiwanie (z potwierdzeniem)" });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Odwołaj wszystkie urządzenia."));
    fireEvent.click(screen.getByLabelText(/trwale usunięte/));
    expect((execute as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(execute);
    expect(mocks.runRecovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect(mocks.runRecovery).toHaveBeenCalledWith("revoke-all-devices", "TOKEN123");
  });

  it("exposes an accessible labelled section and status feedback", async () => {
    renderPanel();
    expect(screen.getByRole("region", { name: "Akcje odzyskiwania" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Odwołaj wszystkie urządzenia zdalne" }));
    fireEvent.click(screen.getByRole("button", { name: "Potwierdź" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/odwołany/);
  });
});
