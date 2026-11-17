// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { ControllerSimulator } from "../components/ControllerSimulator";
import { clearControllerSimulationMemory, readControllerSimulationMemory } from "../services/controllerSimulation";
import { useReturnHomeListener } from "../hooks/useReturnHomeFocus";
import type { ReturnHomeEvent } from "../services/sessionOrchestrator";
import { canRemoteSelect } from "../services/remotePermissions";
import type { TvNavigationStatus } from "../services/tvNavigation";

const mocks = vi.hoisted(() => ({
  status: { simulatorAvailable: true, enabled: true, mode: "keyboard", activeStrategy: "keyboard", generation: 3, mediaControlsArmed: false, lastResult: null } as TvNavigationStatus,
  getStatus: vi.fn(), configure: vi.fn(), capture: vi.fn(), simulate: vi.fn(), arm: vi.fn(), cancel: vi.fn(), launch: vi.fn(),
}));
vi.mock("../services/tvNavigation", async importOriginal => ({
  ...await importOriginal<typeof import("../services/tvNavigation")>(),
  getTvNavigationStatus: mocks.getStatus,
  configureTvNavigation: mocks.configure,
  captureTvNavigationTarget: mocks.capture,
  simulateTvNavigationAction: mocks.simulate,
  setTvNavigationMediaControls: mocks.arm,
  cancelTvNavigationSimulation: mocks.cancel,
}));
vi.mock("../services/veloraSessionManager", () => ({ getManagedSessions: vi.fn(async () => ({ sessions: [
  { sessionId: "owned-session", appId: "edge-cinema:youtube", applicationType: "cinema", name: "YouTube", state: "background", canResume: true },
  { sessionId: "netflix-session", appId: "edge-cinema:netflix", applicationType: "cinema", name: "Netflix", state: "background", canResume: true },
  { sessionId: "game-session", applicationType: "game", name: "Game", state: "background", canResume: true },
] })) }));
vi.mock("../services/openStreamingService", () => ({ openStreamingService: mocks.launch }));

beforeEach(() => {
  clearControllerSimulationMemory();
  vi.useFakeTimers();
  mocks.status = { simulatorAvailable: true, enabled: true, mode: "keyboard", activeStrategy: "keyboard", generation: 3, mediaControlsArmed: false, lastResult: null, simulatorHomeReady: true };
  mocks.getStatus.mockImplementation(async () => mocks.status);
  mocks.capture.mockImplementation(async () => mocks.status);
  mocks.configure.mockImplementation(async enabled => ({ ...mocks.status, enabled }));
  mocks.simulate.mockImplementation(async input => ({ accepted: true, effect: "unverified", sequence: input.sequence, generation: input.generation,
    mode: "keyboard", activeStrategy: "keyboard", targetSession: input.targetSession, lastResult: null }));
  mocks.arm.mockImplementation(async armed => ({ ...mocks.status, mediaControlsArmed: armed }));
  mocks.cancel.mockImplementation(async () => ({ ...mocks.status, generation: mocks.status.generation + 1 }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const selectTarget = async () => {
  fireEvent.change(screen.getByRole("combobox", { name: "Sesja docelowa" }), { target: { value: "owned-session" } });
  await flush();
};

describe("Controller Simulator", () => {
  it("hides diagnostic controls when backend denies availability even in a frontend test build", async () => {
    mocks.status.simulatorAvailable = false;
    render(<ControllerSimulator />); await flush();
    expect(screen.queryByRole("region", { name: "Controller Simulator" })).toBeNull();
    expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("requires explicit enable and denies every control through the LAN remote selector", async () => {
    mocks.status.enabled = false;
    render(<ControllerSimulator />); await flush();
    const enable = screen.getByRole("button", { name: "Włącz symulator diagnostyczny" });
    expect(canRemoteSelect(enable)).toBe(false);
    expect(screen.queryByRole("button", { name: "D-pad ↓" })).toBeNull();
    fireEvent.click(enable); await flush();
    expect(mocks.configure).toHaveBeenCalledWith(true, "keyboard");
    expect(canRemoteSelect(screen.getByRole("button", { name: "D-pad ↓" }))).toBe(false);
  });
  it("dispatches one delayed native action with captured session and current generation", async () => {
    render(<ControllerSimulator />); await flush(); await selectTarget();
    expect(mocks.capture).toHaveBeenCalledWith("owned-session");
    expect(screen.queryByRole("option", { name: /Game/ })).toBeNull();
    const down = screen.getByRole("button", { name: "D-pad ↓" });
    fireEvent.click(down); fireEvent.click(down);
    expect(mocks.simulate).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(mocks.simulate).toHaveBeenCalledTimes(1);
    expect(mocks.simulate).toHaveBeenCalledWith(expect.objectContaining({ action: "down", sequence: 1, generation: 3, targetSession: "owned-session" }));
    expect(screen.getByText("unverified")).toBeTruthy();
  });
  it("cancels pending scenario actions and on unmount never dispatches queued input", async () => {
    const view = render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Scenariusz: ↓ → Wstecz Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Anuluj sekwencję" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.simulate).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "D-pad ↓" }));
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mocks.simulate).not.toHaveBeenCalled();
  });
  it("stops a deterministic sequence on native rejection rather than repeating input", async () => {
    mocks.simulate.mockResolvedValue({ accepted: false, effect: "unverified", sequence: 1, generation: 3,
      mode: "keyboard", activeStrategy: "keyboard", targetSession: "owned-session", lastResult: "Odmowa fokusu" });
    render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Scenariusz: ↓ → Wstecz Home" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.simulate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("Odmowa fokusu");
  });
  it("does not arm media shortcuts implicitly on catalog screens", async () => {
    render(<ControllerSimulator />); await flush(); await selectTarget();
    expect((screen.getByRole("button", { name: "Square · Odtwórz / pauza" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Uzbrój skróty odtwarzania" })); await flush();
    expect(mocks.arm).toHaveBeenCalledWith(true, "owned-session");
    expect((screen.getByRole("button", { name: "Square · Odtwórz / pauza" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("continues the backend sequence after reopening diagnostics instead of replaying sequence 1", async () => {
    mocks.status.lastSimulatorSequence = 23;
    render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "D-pad ↓" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(mocks.simulate).toHaveBeenCalledWith(expect.objectContaining({ sequence: 24 }));
  });
  it("updates displayed mode and generation from the authoritative receipt after pointer toggle", async () => {
    mocks.simulate.mockResolvedValue({ accepted: true, effect: "unverified", sequence: 1, generation: 4,
      mode: "pointer", activeStrategy: "pointer", targetSession: "owned-session", lastResult: "Tryb wskaźnika" });
    render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Triangle · Wskaźnik" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect((screen.getByRole("combobox", { name: "Tryb nawigacji" }) as HTMLSelectElement).value).toBe("pointer");
    expect(screen.getByText(/Symulator: włączony · strategia: pointer · generacja: 4/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "D-pad ↓" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(mocks.simulate).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 4 }));
  });
  it("records portable actions and replays navigation while pausing activation until local review", async () => {
    render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Nagrywaj akcje symulatora" }));
    fireEvent.click(screen.getByRole("button", { name: "D-pad ↓" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    fireEvent.click(screen.getByRole("button", { name: "X · Potwierdź" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    fireEvent.click(screen.getByRole("button", { name: "Eksportuj sekwencję · JSON" }));
    const raw = (screen.getByRole("textbox", { name: "Bezpieczna sekwencja symulatora JSON" }) as HTMLTextAreaElement).value;
    const exported = JSON.parse(raw);
    expect(exported.steps.map((step: { action: string }) => step.action)).toEqual(["down", "confirm"]);
    expect(exported.steps[0].serviceId).toBe("youtube");
    expect(raw).not.toContain("owned-session");
    fireEvent.click(screen.getByRole("button", { name: "Odtwórz nagranie" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.simulate).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Wykonaj sprawdzony krok" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wykonaj sprawdzony krok" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(mocks.simulate).toHaveBeenCalledTimes(4);
    expect(mocks.simulate).toHaveBeenLastCalledWith(expect.objectContaining({ action: "confirm", sequence: 4 }));
    expect(screen.getByText(/Zapisano 2\/64/)).toBeTruthy();
  });
  it("cancels an activation checkpoint without dispatching the pending action", async () => {
    render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Nagrywaj akcje symulatora" }));
    fireEvent.click(screen.getByRole("button", { name: "X · Potwierdź" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    fireEvent.click(screen.getByRole("button", { name: "Odtwórz nagranie" })); await flush();
    expect(screen.getByRole("button", { name: "Wykonaj sprawdzony krok" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Anuluj sekwencję" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.simulate).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Wykonaj sprawdzony krok" })).toBeNull();
  });
  it("captures each recorded service at a replay boundary and propagates the new generation", async () => {
    render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Nagrywaj akcje symulatora" }));
    fireEvent.click(screen.getByRole("button", { name: "D-pad ↓" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    fireEvent.change(screen.getByRole("combobox", { name: "Sesja docelowa" }), { target: { value: "netflix-session" } }); await flush();
    fireEvent.click(screen.getByRole("button", { name: "D-pad →" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    mocks.capture.mockImplementation(async () => ({ ...mocks.status, generation: 9 }));
    fireEvent.click(screen.getByRole("button", { name: "Odtwórz nagranie" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mocks.capture.mock.calls.slice(-2).map(call => call[0])).toEqual(["owned-session", "netflix-session"]);
    expect(mocks.simulate.mock.calls.slice(-2).map(call => call[0])).toMatchObject([
      { action: "down", targetSession: "owned-session", generation: 9 }, { action: "right", targetSession: "netflix-session", generation: 9 },
    ]);
  });
  it("holds only the selected repeatable action and stops all future repeats after a rejection", async () => {
    mocks.simulate.mockResolvedValue({ accepted: false, effect: "notDispatched", sequence: 1, generation: 3,
      mode: "keyboard", activeStrategy: "keyboard", targetSession: "owned-session", lastResult: "focus denied" });
    render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Symuluj przytrzymanie" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.simulate).toHaveBeenCalledTimes(1);
    expect(mocks.simulate).toHaveBeenCalledWith(expect.objectContaining({ action: "down" }));
  });
  it("imports a reviewed semantic sequence without dispatching or admitting remote administration", async () => {
    render(<ControllerSimulator />); await flush();
    const input = screen.getByRole("textbox", { name: "Import sekwencji JSON" });
    expect(canRemoteSelect(input)).toBe(false);
    fireEvent.change(input, { target: { value: JSON.stringify({ schemaVersion: 1, steps: [{ action: "confirm", delayMs: 100, serviceId: "youtube", requiresReview: false }] }) } });
    fireEvent.click(screen.getByRole("button", { name: "Wczytaj sekwencję do przeglądu" })); await flush();
    expect(mocks.simulate).not.toHaveBeenCalled();
    expect(screen.getByText(/youtube · confirm · 100 ms · przegląd ekranu/)).toBeTruthy();
    fireEvent.change(input, { target: { value: JSON.stringify({ schemaVersion: 1, steps: [{ action: "nativeCommand", delayMs: 100 }] }) } });
    fireEvent.click(screen.getByRole("button", { name: "Wczytaj sekwencję do przeglądu" })); await flush();
    expect(screen.getByRole("alert").textContent).toContain("Nieprawidłowa sekwencja");
    expect(mocks.simulate).not.toHaveBeenCalled();
  });
  it("survives the real Home-listener unmount boundary without hidden input and resumes only explicitly after readiness", async () => {
    let emitHome: (event: ReturnHomeEvent) => void = () => {};
    const listen = async (callback: (event: ReturnHomeEvent) => void) => { emitHome = callback; return () => {}; };
    function HomeOverlayHarness() {
      const [open, setOpen] = useState(true);
      useReturnHomeListener(() => setOpen(false), listen);
      return open ? <ControllerSimulator /> : <button onClick={() => setOpen(true)}>Otwórz diagnostykę po Home</button>;
    }
    render(<HomeOverlayHarness />); await flush(); await selectTarget();
    const steps = [{ action: "down", delayMs: 100, serviceId: "youtube" }, { action: "home", delayMs: 100, serviceId: "youtube" }, { action: "right", delayMs: 100, serviceId: "youtube" }];
    fireEvent.change(screen.getByRole("textbox", { name: "Import sekwencji JSON" }), { target: { value: JSON.stringify({ schemaVersion: 1, steps }) } });
    fireEvent.click(screen.getByRole("button", { name: "Wczytaj sekwencję do przeglądu" }));
    mocks.status.simulatorHomeReady = false;
    mocks.simulate.mockImplementation(async input => {
      if (input.action === "home") flushSync(() => emitHome({ restore: { restored: true, outcome: "restored", message: "" } } as ReturnHomeEvent));
      return { accepted: true, effect: "unverified", sequence: input.sequence, generation: input.generation,
        mode: "keyboard", activeStrategy: "keyboard", targetSession: input.targetSession, lastResult: "private error must not persist" };
    });
    fireEvent.click(screen.getByRole("button", { name: "Odtwórz nagranie" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.simulate.mock.calls.map(call => call[0].action)).toEqual(["down", "home"]);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Controller Simulator" })).toBeNull();
    expect(JSON.stringify(readControllerSimulationMemory())).not.toContain("owned-session");
    expect(JSON.stringify(readControllerSimulationMemory())).not.toContain("private error");
    fireEvent.click(screen.getByRole("button", { name: "Otwórz diagnostykę po Home" })); await flush();
    expect(screen.getByText(/Zapisano 3\/64/)).toBeTruthy();
    const resume = screen.getByRole("button", { name: "Wznów pozostałe kroki po Home" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(screen.getByText(/Pozostało 1 kroków/)).toBeTruthy();
    mocks.status.simulatorHomeReady = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.simulate).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Odśwież sesje symulatora" })); await flush();
    expect(resume.disabled).toBe(false);
    mocks.capture.mockImplementation(async () => ({ ...mocks.status, generation: 9 }));
    fireEvent.click(resume);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenLastCalledWith("owned-session");
    expect(mocks.simulate).toHaveBeenLastCalledWith(expect.objectContaining({ action: "right", generation: 9 }));
    fireEvent.click(screen.getByRole("button", { name: "Eksportuj zgodność TV · JSON" }));
    const raw = (screen.getByRole("textbox", { name: "Bezpieczny raport zgodności TV JSON" }) as HTMLTextAreaElement).value;
    expect(JSON.parse(raw).actions.find((item: { action: string }) => item.action === "home").homeTransitionReady).toBe(true);
  });
  it("keeps later steps paused when Home completion/focus is not confirmed, without claiming failure", async () => {
    render(<ControllerSimulator />); await flush(); await selectTarget();
    fireEvent.change(screen.getByRole("textbox", { name: "Import sekwencji JSON" }), { target: { value: JSON.stringify({ schemaVersion: 1, steps: [
      { action: "home", delayMs: 100, serviceId: "youtube" }, { action: "down", delayMs: 100, serviceId: "youtube" },
    ] }) } });
    fireEvent.click(screen.getByRole("button", { name: "Wczytaj sekwencję do przeglądu" }));
    mocks.status.simulatorHomeReady = false;
    fireEvent.click(screen.getByRole("button", { name: "Odtwórz nagranie" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.simulate).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Wznów pozostałe kroki po Home" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/niepotwierdzone — odśwież status/)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Sesja docelowa" }) as HTMLSelectElement).value).toBe("");
  });
});

it("offers direct session and mode buttons without a native select popup", async () => {
 render(<ControllerSimulator />); await flush();
 const target=screen.getByRole("button", {name:"Cel: YouTube"});
 expect(canRemoteSelect(target)).toBe(false);
 fireEvent.click(target); await flush();
 expect(mocks.capture).toHaveBeenCalledExactlyOnceWith("owned-session");
 fireEvent.click(screen.getByRole("button", {name:"Tryb: pointer"})); await flush();
 expect(mocks.configure).toHaveBeenCalledWith(true,"pointer");
});
