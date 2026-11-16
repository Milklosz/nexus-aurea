// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { RemoteCommand } from "../services/remoteCommand";

// The native command handler has already authorized and attempted remote Home.
// This tests real App event handling, not Windows activation or physical hardware.
const remote = vi.hoisted(() => ({
  emit: null as ((command: RemoteCommand) => void) | null,
  returnHome: vi.fn(async () => undefined),
}));
vi.mock("../services/remoteAccess", async importOriginal => {
  const original = await importOriginal<typeof import("../services/remoteAccess")>();
  return {
    ...original,
    listenForRemoteCommand: vi.fn(async (listener: (command: RemoteCommand) => void) => {
      remote.emit = listener;
      return () => { if (remote.emit === listener) remote.emit = null; };
    }),
  };
});
vi.mock("../services/sessionOrchestrator", async importOriginal => {
  const original = await importOriginal<typeof import("../services/sessionOrchestrator")>();
  return { ...original, returnVeloraHome: remote.returnHome };
});
vi.mock("../hooks/useWeather", () => ({
  useWeather: () => ({ label: "Zabrze", title: "Brak odczytu", temperatureText: "", condition: "", stale: false }),
}));

beforeEach(() => {
  remote.emit = null;
  remote.returnHome.mockClear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function emit(command: RemoteCommand) {
  expect(remote.emit).not.toBeNull();
  await act(async () => { remote.emit?.(command); });
}

describe("App receives authorized remote commands", () => {
  it("closes an overlay and restores the selected dock tile without a second native Home request", async () => {
    render(<App />);
    await waitFor(() => expect(remote.emit).not.toBeNull());
    // Wait for useNavigation's startup animation frame before moving off tile zero.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Otwórz Netflix" })));
    await emit("right");
    const selectedTile = document.activeElement;
    expect(selectedTile?.getAttribute("data-aurea-item")).not.toBeNull();
    await emit("menu");
    expect(document.querySelector("dialog[open]")).not.toBeNull();

    await emit("home");
    await waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(selectedTile));
    expect(remote.returnHome).not.toHaveBeenCalled();
  });

  it("keeps an explicit local Home action on the native restoration path", async () => {
    render(<App />);
    await waitFor(() => expect(remote.emit).not.toBeNull());
    await emit("menu");
    fireEvent.click(screen.getByRole("button", { name: /^(Ekran główny|Wróć do VELORA)$/ }));
    await waitFor(() => expect(remote.returnHome).toHaveBeenCalledTimes(1));
  });

  it("opens application switching on the search tab through the accepted remote event", async () => {
    render(<App />);
    await waitFor(() => expect(remote.emit).not.toBeNull());
    await emit("switch-apps");
    const tab = screen.getByRole("tab", { name: "Szukaj" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Szukaj" }).hidden).toBe(false);
    expect(remote.returnHome).not.toHaveBeenCalled();
  });

  it("does not let remote menu plus select activate local controller administration", async () => {
    render(<App />);
    await waitFor(() => expect(remote.emit).not.toBeNull());
    await emit("menu");
    await waitFor(() => expect(document.activeElement?.closest(".cc-tabs")).not.toBeNull());
    const diagnosticButton = screen.getByRole("button", { name: "Diagnostyka raportu pada" });
    act(() => diagnosticButton.focus());
    await emit("select");
    expect(diagnosticButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Pilot nie ma uprawnień do tej operacji administracyjnej.")).toBeTruthy();
  });
});
