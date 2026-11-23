// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ControlCenter } from "../components/ControlCenter";
import { canRemoteSelect } from "../services/remotePermissions";
import type { AmbientSettings } from "../services/ambient";
import type { CinemaProfile } from "../services/cinemaMode";

/* Control Center 4.0 accessibility: the new overview + recovery cards must be
   reachable and labelled like every other panel, and the existing tab model
   must keep working (keyboard/controller order, aria attributes). */

function setupDialog() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
}

function renderCenter(overrides: Partial<{ livingRoom: boolean }> = {}) {
  const props = {
    profile: "cinema" as CinemaProfile,
    onProfileChange: vi.fn(async () => true),
    onShowDesktop: vi.fn(),
    onSystemVolume: vi.fn(async () => {}),
    ambientSettings: { enabled: false, idleSeconds: 300 } as AmbientSettings,
    onAmbientSettingsChange: vi.fn(),
    mediaPlaying: false,
    onOpenDiagnostics: vi.fn(),
    onReturnToNexus: vi.fn(),
    onClose: vi.fn(),
    livingRoom: overrides.livingRoom,
  };
  return render(<ControlCenter {...props} />);
}

afterEach(() => { cleanup(); });

describe("genesis C — Control Center 4.0 accessibility", () => {
  it("exposes the unified system overview as a labelled region with a live list and a named refresh button", async () => {
    setupDialog();
    renderCenter();
    const overview = screen.getByRole("region", { name: "Przegląd systemu" });
    expect(overview).toBeTruthy();
    const list = screen.getByRole("list", { name: "Stan źródeł systemowych" });
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.querySelectorAll("li")).toHaveLength(5);
    const refresh = screen.getByRole("button", { name: /Odśwież przegląd systemu|Odświeżam/ });
    expect(refresh.hasAttribute("data-remote-allow")).toBe(true);
    await waitFor(() => {
      // browser preview: display read resolves truthfully, audio read reports unknown
      expect(Array.from(list.querySelectorAll("li")).some((li) => li.textContent?.includes("podgląd przeglądarki"))).toBe(true);
    });
  });

  it("exposes the recovery actions as a labelled admin region whose gated buttons the remote cannot select", () => {
    setupDialog();
    renderCenter();
    const recovery = screen.getByRole("region", { name: "Akcje odzyskiwania" });
    expect(recovery.getAttribute("data-remote-admin")).toBe("");
    const gated = [
      "Odwołaj wszystkie urządzenia zdalne",
      "Zatrzymaj dostęp zdalny (serwer LAN)",
      "Zresetuj sesję Edge Cinema",
      "Uruchom ponownie VELORA (z potwierdzeniem)",
      "Zakończ VELORA (z potwierdzeniem)",
      "Przywróć pulpit Windows (z potwierdzeniem)",
    ];
    for (const name of gated) {
      const button = screen.getByRole("button", { name });
      expect(button.hasAttribute("data-velora-confirm")).toBe(true);
      expect(canRemoteSelect(button)).toBe(false);
    }
  });

  it("opens the confirm dialog from a gated recovery button and returns focus to a safe control", () => {
    setupDialog();
    renderCenter();
    fireEvent.click(screen.getByRole("button", { name: "Przywróć pulpit Windows (z potwierdzeniem)" }));
    const dialog = screen.getByRole("alertdialog", { name: "Potwierdź ryzykowną akcję" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById("velora-confirm-warning")?.textContent).toContain("pulpitu Windows");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Anuluj" }));
    fireEvent.click(screen.getByRole("button", { name: "Anuluj" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps the tab model accessible: tablist, aria-selected, arrow-key roving and labelled tabpanels", async () => {
    setupDialog();
    renderCenter();
    const tablist = screen.getByRole("tablist", { name: "Sekcje Control Center" });
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
    expect(tabs.length).toBeGreaterThanOrEqual(4);
    const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toBeTruthy();
    expect(selected?.getAttribute("aria-controls")).toBe(`cc-panel-${selected?.id.replace("cc-tab-", "")}`);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBeTruthy();

    await act(async () => {}); // flush the initial focus rAF
    await act(async () => { fireEvent.keyDown(selected as HTMLButtonElement, { key: "ArrowRight" }); });
    const nextSelected = Array.from(tablist.querySelectorAll('[role="tab"]')).find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(nextSelected).not.toBe(selected);
    expect(document.activeElement).toBe(nextSelected);
  });

  it("keeps every panel reachable in the Living Room labels too", () => {
    setupDialog();
    renderCenter({ livingRoom: true });
    expect(screen.getByRole("tab", { name: "Kino" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Pilot" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Przegląd systemu" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Akcje odzyskiwania" })).toBeTruthy();
  });
});
