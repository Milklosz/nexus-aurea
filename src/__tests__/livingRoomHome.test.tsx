// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LivingRoomHome } from "../components/living-room/LivingRoomHome";
import { streamingServices } from "../data/streamingServices";

const snapshot = vi.hoisted(() => ({
  current: { windows: false, foregroundProcess: null, apps: [] as unknown[], games: [], gamesError: null },
}));

vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null },
  getAppManagerStatus: vi.fn(async () => snapshot.current),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
  snapshot.current = { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderHome(overrides: Partial<Parameters<typeof LivingRoomHome>[0]> = {}) {
  const props = {
    services: streamingServices,
    activeIndex: 0,
    launchingIds: new Set<string>() as ReadonlySet<string>,
    buttonRefs: { current: [] } as RefObject<Array<HTMLButtonElement | null>>,
    weather: { temperatureText: "2°", condition: "Częściowe zachmurzenie", title: "Bieżąca pogoda dla Zabrza.", stale: false },
    onFocus: vi.fn(),
    onActivate: vi.fn(),
    onUnavailable: vi.fn(),
    onSearch: vi.fn(),
    onRemote: vi.fn(),
    onSettings: vi.fn(),
    ...overrides,
  };
  const view = render(<LivingRoomHome {...props} />);
  return { ...view, props };
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe("Living Room Home", () => {
  it("shows the eight dock apps in the designed order with their accessible names", async () => {
    renderHome();
    await settle();
    const names = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-aurea-item")).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Otwórz Netflix", "Otwórz Disney+", "Otwórz HBO Max", "Otwórz Prime Video",
      "Otwórz YouTube", "Otwórz Steam", "Otwórz Playnite", "Otwórz Apple Music",
    ]);
  });

  it("makes the selected app the hero with one functional context line", async () => {
    renderHome({ activeIndex: 2 });
    await settle();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("HBO Max");
    expect(document.querySelector(".lr-context")?.textContent).toBe("Filmy i seriale");
    // The engine that opens an app is a support detail, never Home copy.
    expect(document.body.textContent).not.toMatch(/Edge Cinema|Big Picture/);
  });

  it("shows the Warsaw clock in 24-hour format and a weather reading when there is one", async () => {
    renderHome();
    await settle();
    expect(screen.getByLabelText("Godzina 11:00").textContent).toBe("11:00");
    expect(document.querySelector(".lr-weather")?.textContent).toBe("2°Częściowe zachmurzenie");
  });

  it("invents no weather: nothing is rendered without a reading", async () => {
    renderHome({ weather: { temperatureText: "", condition: "", title: "Pobieranie", stale: false } });
    await settle();
    expect(document.querySelector(".lr-weather")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Pogoda niedostępna|Pobieranie|--/);
  });

  it("marks a stale weather reading instead of hiding it", async () => {
    renderHome({ weather: { temperatureText: "3°", condition: "Mgła", title: "Ostatni odczyt", stale: true } });
    await settle();
    expect(document.querySelector(".lr-weather.is-stale")).not.toBeNull();
  });

  it("offers Szukaj, Pilot and Ustawienia as real buttons that call their handlers", async () => {
    const { props } = renderHome();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Szukaj aplikacji" }));
    fireEvent.click(screen.getByRole("button", { name: "Pilot iPhone" }));
    fireEvent.click(screen.getByRole("button", { name: "Otwórz ustawienia" }));
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    expect(props.onRemote).toHaveBeenCalledTimes(1);
    expect(props.onSettings).toHaveBeenCalledTimes(1);
  });

  it("launches through onActivate when an app is clicked", async () => {
    const { props } = renderHome();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Otwórz YouTube" }));
    expect(props.onActivate).toHaveBeenCalledWith(4);
  });

  it("reports a missing managed app instead of launching it, and keeps the tile focusable", async () => {
    snapshot.current = { windows: true, foregroundProcess: null, apps: [{ id: "playniteFullscreen", installed: false }], games: [], gamesError: null };
    const { props } = renderHome({ activeIndex: 6 });
    await settle();
    expect(document.querySelector(".lr-context")?.textContent).toContain("Nie wykryto instalacji");
    const tile = screen.getByRole("button", { name: "Otwórz Playnite" });
    expect(tile.classList.contains("is-missing")).toBe(true);
    expect((tile as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(tile);
    expect(props.onUnavailable).toHaveBeenCalledWith("Playnite");
    expect(props.onActivate).not.toHaveBeenCalled();
  });

  it("announces launching with aria-busy and an 'Otwieranie…' context line", async () => {
    renderHome({ activeIndex: 5, launchingIds: new Set(["steam"]) });
    await settle();
    expect(screen.getByRole("button", { name: "Otwórz Steam" }).getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector(".lr-context")?.textContent).toBe("Otwieranie…");
  });

  it("starts with the selected tile focused, so Home never opens without a visible focus", async () => {
    renderHome({ activeIndex: 1 });
    await settle();
    const tile = screen.getByRole("button", { name: "Otwórz Disney+" });
    expect(tile.classList.contains("is-focused")).toBe(true);
    expect(tile.classList.contains("is-selected")).toBe(false);
    expect(document.querySelectorAll(".lr-tile.is-focused")).toHaveLength(1);
  });

  it("distinguishes focused from selected: a tile is only 'selected' while focus is on a top action or an overlay", async () => {
    renderHome({ activeIndex: 1 });
    await settle();
    const tile = screen.getByRole("button", { name: "Otwórz Disney+" });
    act(() => { screen.getByRole("button", { name: "Szukaj aplikacji" }).focus(); });
    expect(tile.classList.contains("is-focused")).toBe(false);
    expect(tile.classList.contains("is-selected")).toBe(true);
    act(() => { tile.focus(); });
    expect(tile.classList.contains("is-focused")).toBe(true);
    expect(tile.classList.contains("is-selected")).toBe(false);
  });

  it("keeps the dock tile focused when the window loses and regains focus (return from an app)", async () => {
    renderHome({ activeIndex: 3 });
    await settle();
    const tile = screen.getByRole("button", { name: "Otwórz Prime Video" });
    act(() => { tile.focus(); });
    act(() => { tile.blur(); window.dispatchEvent(new Event("blur")); });
    expect(tile.classList.contains("is-focused")).toBe(true);
  });

  it("marks the focused top action and remembers it for the zone", async () => {
    renderHome();
    await settle();
    const remote = screen.getByRole("button", { name: "Pilot iPhone" });
    act(() => { remote.focus(); });
    expect(remote.classList.contains("is-focused")).toBe(true);
    expect(remote.getAttribute("data-remembered")).toBe("true");
    expect(screen.getByRole("button", { name: "Szukaj aplikacji" }).hasAttribute("data-remembered")).toBe(false);
  });

  it("shows a pressed state for a short moment after a confirm, for keyboard, gamepad and remote alike", async () => {
    const { props } = renderHome({ activeIndex: 3 });
    await settle();
    const tile = screen.getByRole("button", { name: "Otwórz Prime Video" });
    expect(tile.classList.contains("is-pressed")).toBe(false);
    fireEvent.click(tile);
    expect(tile.classList.contains("is-pressed")).toBe(true);
    expect(props.onActivate).toHaveBeenCalledWith(3);
    act(() => { vi.advanceTimersByTime(200); });
    expect(tile.classList.contains("is-pressed")).toBe(false);
  });

  it("does not present the dock apps as toggles (aria-current marks the selected one)", async () => {
    renderHome({ activeIndex: 2 });
    await settle();
    const tiles = screen.getAllByRole("button").filter((button) => button.hasAttribute("data-aurea-item"));
    expect(tiles.every((tile) => !tile.hasAttribute("aria-pressed"))).toBe(true);
    expect(tiles.filter((tile) => tile.getAttribute("aria-current") === "true")).toHaveLength(1);
  });

  it("keeps the old Home chrome out of the new Home", async () => {
    renderHome();
    await settle();
    expect(document.querySelector(".quick-settings-trigger, .diagnostics-trigger, .controls, .hero, .focus-panel, .dock-caption")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Wybierz rozrywkę|TWOJE APLIKACJE|GRAND CINEMA/);
  });
});
