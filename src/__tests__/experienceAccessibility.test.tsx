// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutostartPanel } from "../components/AutostartPanel";
import { PlayniteLibrary } from "../components/PlayniteLibrary";
import { AppDock } from "../components/AppDock";
import { streamingServices } from "../data/streamingServices";

// Cross-cutting accessibility checks on the REAL integrated components.
// Each service is mocked only at its input boundary; pure helpers such as
// moveGridFocus / sanitizeCoverSource stay real (importOriginal).
const mocks = vi.hoisted(() => ({
  // autostart
  aStatus: null as any,
  aMode: null as any,
  getStatus: vi.fn(async () => mocks.aStatus),
  getMode: vi.fn(async () => mocks.aMode),
  setEnabled: vi.fn(async (_enabled: boolean, _windowed: boolean) => mocks.aStatus),
  aDisabled: {
    windows: false,
    supported: false,
    enabled: false,
    windowed: false,
    lastError: "Autostart jest dostępny tylko w natywnej aplikacji Windows.",
  },
  flag: "--windowed",
  autostartError: (cause: unknown, fallback?: string): string => {
    if (typeof cause === "string" && cause.trim()) return cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return fallback ?? "Błąd autostartu.";
  },
  // playnite
  pSnapshot: null as any,
  readLibrary: vi.fn(async () => mocks.pSnapshot),
  readFavorites: vi.fn(() => [] as string[]),
  toggleFavorite: vi.fn((id: string) => [id]),
  readRecents: vi.fn(() => [] as string[]),
  noteRecentlyPlayed: vi.fn((id: string) => [id]),
  // tauri core (needed by importOriginal of the playnite service)
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

vi.mock("../services/autostart", () => ({
  SAFE_MODE_FLAG: mocks.flag,
  disabledAutostartStatus: mocks.aDisabled,
  getAutostartStatus: mocks.getStatus,
  getStartupMode: mocks.getMode,
  setAutostartEnabled: mocks.setEnabled,
  autostartErrorMessage: mocks.autostartError,
}));

vi.mock("../services/playniteLibrary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/playniteLibrary")>();
  return {
    ...actual,
    readPlayniteLibrary: mocks.readLibrary,
    readFavorites: mocks.readFavorites,
    toggleFavorite: mocks.toggleFavorite,
    readRecentlyPlayed: mocks.readRecents,
    noteRecentlyPlayed: mocks.noteRecentlyPlayed,
  };
});

vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null },
  getAppManagerStatus: vi.fn(async () => ({
    windows: false,
    foregroundProcess: null,
    apps: [],
    games: [],
    gamesError: null,
  })),
}));

function autostartStatus(overrides: Record<string, unknown> = {}) {
  return {
    windows: true,
    supported: true,
    enabled: false,
    windowed: false,
    lastError: null,
    ...overrides,
  };
}

const UNAVAILABLE = {
  source: "unavailable",
  available: false,
  reason:
    "Brak bezpiecznego, udokumentowanego API Playnite. VELORA nie odczytuje plików bazy danych Playnite ani nie zgaduje jej struktury.",
  games: [],
  readOnly: true,
};

// 6 gier -> siatka 4-kolumnowa: indeks 0 (Alpha), 1 (Bravo), 4 (Echo), 5 (Foxtrot).
const GAMES = {
  source: "playnite-api",
  available: true,
  reason: null,
  games: [
    { id: "g1", name: "Alpha", cover: null, source: "Playnite", lastPlayed: null },
    { id: "g2", name: "Bravo", cover: "data:image/png;base64,AAAA", source: "Playnite", lastPlayed: null },
    { id: "g3", name: "Charlie", cover: null, source: "Playnite", lastPlayed: null },
    { id: "g4", name: "Delta", cover: null, source: "Playnite", lastPlayed: null },
    { id: "g5", name: "Echo", cover: null, source: "Playnite", lastPlayed: null },
    { id: "g6", name: "Foxtrot", cover: null, source: "Playnite", lastPlayed: null },
  ],
  readOnly: true,
};

beforeEach(() => {
  mocks.aStatus = autostartStatus();
  mocks.aMode = { windowed: false, autostartEnabled: false };
  mocks.getStatus.mockReset();
  mocks.getMode.mockReset();
  mocks.setEnabled.mockReset();
  mocks.getStatus.mockImplementation(async () => mocks.aStatus);
  mocks.getMode.mockImplementation(async () => mocks.aMode);
  mocks.setEnabled.mockImplementation(async (enabled: boolean, windowed: boolean) => {
    mocks.aStatus = autostartStatus({ enabled, windowed });
    return mocks.aStatus;
  });

  mocks.pSnapshot = UNAVAILABLE;
  mocks.readLibrary.mockReset();
  mocks.readLibrary.mockImplementation(async () => mocks.pSnapshot);
  mocks.readFavorites.mockReset();
  mocks.readFavorites.mockReturnValue([]);
  mocks.toggleFavorite.mockReset();
  mocks.toggleFavorite.mockImplementation((id: string) => [id]);
  mocks.readRecents.mockReset();
  mocks.readRecents.mockReturnValue([]);
  mocks.noteRecentlyPlayed.mockReset();
  mocks.noteRecentlyPlayed.mockImplementation((id: string) => [id]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Experience accessibility — AutostartPanel", () => {
  it("exposes an accessible switch with aria-checked and a named --windowed checkbox", async () => {
    render(<AutostartPanel />);
    const toggle = await screen.findByRole("switch", { name: /autostart/i });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    const checkbox = screen.getByRole("checkbox", { name: /--windowed/ });
    expect(checkbox.getAttribute("aria-label")).toContain("--windowed");
  });

  it("keeps the consent note honest about HKCU and the untouched Windows shell", async () => {
    render(<AutostartPanel />);
    const consent = await screen.findByText(/Włączenie autostartu wymaga Twojej zgody/);
    expect(consent.textContent).toContain("HKCU");
    expect(consent.textContent).toMatch(/Nie zmienia powłoki Windows/);
    expect(consent.textContent).toMatch(/ustawień systemowych/);
  });

  it("uses a polite live status region and an alert when a read fails", async () => {
    mocks.getStatus.mockRejectedValueOnce(new Error("Nie udało się odczytać stanu autostartu."));
    render(<AutostartPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nie udało się odczytać stanu autostartu.");

    // getAllByRole stays correct even when the panel is mounted inside
    // ControlCenter (which renders several role="status" regions).
    const regions = screen.getAllByRole("status");
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions.some((region) => region.getAttribute("aria-live") === "polite")).toBe(true);
  });
});

describe("Experience accessibility — PlayniteLibrary", () => {
  it("labels the region, shows the unavailable reason and the read-only GOG/Epic/EA/Ubisoft notice", async () => {
    render(<PlayniteLibrary />);
    const region = await screen.findByRole("region", { name: "Biblioteka Playnite" });
    expect(region.getAttribute("aria-label")).toBe("Biblioteka Playnite");
    expect(await screen.findByText(/Brak bezpiecznego, udokumentowanego API Playnite/)).toBeTruthy();
    expect(screen.getByText(/Logowanie do GOG, Epic, EA i Ubisoft/)).toBeTruthy();
    // Niedostępne źródło nie może pokazać żadnych wymyślonych gier.
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  });

  it("gives cover buttons accessible names and the favorite toggle aria-pressed", async () => {
    mocks.pSnapshot = GAMES;
    render(<PlayniteLibrary />);

    expect(await screen.findByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bravo" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Ulubione:/ })).toHaveLength(6);

    const favorite = screen.getByRole("button", { name: "Ulubione: Alpha" });
    expect(favorite.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(favorite);
    await waitFor(() => expect(favorite.getAttribute("aria-pressed")).toBe("true"));
  });

  it("moves aria-current and data-aurea-focus in 2D through the real moveGridFocus", async () => {
    mocks.pSnapshot = GAMES;
    render(<PlayniteLibrary />);

    const alpha = await screen.findByRole("button", { name: "Alpha" });
    expect(alpha.getAttribute("aria-current")).toBe("true");
    expect(alpha.getAttribute("data-aurea-focus")).toBe("true");

    // ArrowRight: 0 -> 1 (Bravo) w obrębie wiersza.
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    const bravo = screen.getByRole("button", { name: "Bravo" });
    expect(bravo.getAttribute("aria-current")).toBe("true");
    expect(bravo.getAttribute("data-aurea-focus")).toBe("true");
    expect(alpha.getAttribute("aria-current")).toBeNull();
    expect(alpha.getAttribute("data-aurea-focus")).toBeNull();

    // Powrót do indeksu 0, potem ArrowDown: 0 -> 4 (Echo) — ruch pionowy 2D.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    const echo = screen.getByRole("button", { name: "Echo" });
    expect(echo.getAttribute("aria-current")).toBe("true");
    expect(echo.getAttribute("data-aurea-focus")).toBe("true");
  });
});

describe("Experience accessibility — AppDock", () => {
  it("exposes aria-pressed, aria-current and AUREA focus attributes plus the Edge Cinema hint", async () => {
    const buttonRefs = { current: [] } as RefObject<Array<HTMLButtonElement | null>>;
    render(
      <AppDock
        services={streamingServices}
        activeIndex={0}
        launchingIds={new Set<string>()}
        buttonRefs={buttonRefs}
        onFocus={vi.fn()}
        onActivate={vi.fn()}
        onUnavailable={vi.fn()}
      />,
    );

    const netflix = screen.getByRole("button", { name: "Otwórz Netflix" });
    expect(netflix.getAttribute("aria-pressed")).toBe("true");
    expect(netflix.getAttribute("aria-current")).toBe("true");
    expect(netflix.getAttribute("data-aurea-focus")).toBe("active");
    expect(netflix.hasAttribute("data-aurea-item")).toBe(true);
    expect(netflix.hasAttribute("data-focus-source")).toBe(true);

    const disney = screen.getByRole("button", { name: "Otwórz Disney+" });
    expect(disney.getAttribute("aria-pressed")).toBe("false");
    expect(disney.getAttribute("aria-current")).toBeNull();
    expect(disney.getAttribute("data-aurea-focus")).toBe("idle");
    expect(disney.hasAttribute("data-aurea-item")).toBe(true);

    expect(screen.getByText(/dedykowane okno Edge Cinema/)).toBeTruthy();
  });
});

describe("Experience accessibility — honest, scoped wording", () => {
  it("never claims global/pełna obsługa padem support outside VELORA in the mounted UI", async () => {
    const buttonRefs = { current: [] } as RefObject<Array<HTMLButtonElement | null>>;
    const { container } = render(
      <div>
        <AutostartPanel />
        <PlayniteLibrary />
        <AppDock
          services={streamingServices}
          activeIndex={0}
          launchingIds={new Set<string>()}
          buttonRefs={buttonRefs}
          onFocus={vi.fn()}
          onActivate={vi.fn()}
          onUnavailable={vi.fn()}
        />
      </div>,
    );
    await waitFor(() => {
      expect(mocks.getStatus).toHaveBeenCalled();
      expect(mocks.readLibrary).toHaveBeenCalled();
    });

    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("pełna obsługa padem");
    expect(text).not.toContain("pełną obsługę pada");
    expect(text).not.toContain("globalna obsługa pad");
    expect(text).not.toContain("globalnej obsługi pada");
    expect(text).not.toContain("full gamepad support");
    expect(text).not.toContain("global gamepad support");

    // Obecne są natomiast uczciwe, zawężone komunikaty VELORA.
    expect(container.textContent).toMatch(/Nie zmienia powłoki Windows/);
    expect(container.textContent).toMatch(/Dane gier są tylko do odczytu/);
  });

  it("documents the honest gamepad limitation in the per-area AUREA navigation doc", () => {
    const doc = readFileSync("docs/aurea-navigation-v1.md", "utf8");
    expect(doc).toMatch(/VELORA nie deklaruje globalnej obsługi pada poza własnym interfejsem/);
    expect(doc).toContain("SessionOrchestrator");
    expect(doc).toContain("WindowBroker");
  });
});
