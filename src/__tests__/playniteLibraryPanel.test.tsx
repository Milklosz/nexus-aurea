// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayniteLibrary } from "../components/PlayniteLibrary";
import { moveGridFocus, sanitizeCoverSource } from "../services/playniteLibrary";

const mocks = vi.hoisted(() => ({
  snapshot: null as any,
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
  readLibrary: vi.fn(async () => mocks.snapshot),
  readFavorites: vi.fn(() => [] as string[]),
  toggleFavorite: vi.fn((_id: string) => [] as string[]),
  readRecents: vi.fn(() => [] as string[]),
  noteRecentlyPlayed: vi.fn((_id: string) => [] as string[]),
  launchGame: vi.fn(async (gameId: string) => ({ gameId, launched: true, playniteLaunchId: null })),
}));

// Moduł natywny jest mockowany (importOriginal ładuje prawdziwy moduł usługi).
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

// Mockujemy tylko stan wejściowy/lokalny; moveGridFocus i sanitizeCoverSource
// pozostają PRAWDZIWYMI funkcjami z modułu usługi i są ćwiczone w panelu i w testach.
vi.mock("../services/playniteLibrary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/playniteLibrary")>();
  return {
    ...actual,
    readPlayniteLibrary: mocks.readLibrary,
    readFavorites: mocks.readFavorites,
    toggleFavorite: mocks.toggleFavorite,
    readRecentlyPlayed: mocks.readRecents,
    noteRecentlyPlayed: mocks.noteRecentlyPlayed,
    launchPlayniteGame: mocks.launchGame,
  };
});

const UNAVAILABLE = {
  source: "unavailable",
  available: false,
  reason: "Brak bezpiecznego, udokumentowanego API Playnite. VELORA nie odczytuje plików bazy danych Playnite ani nie zgaduje jej struktury.",
  games: [],
  readOnly: true,
};

const GAMES_SNAPSHOT = {
  source: "playnite-api",
  available: true,
  reason: null,
  games: [
    { id: "g1", name: "Cyberpunk 2077", cover: null, source: "Playnite", lastPlayed: null },
    { id: "g2", name: "Hollow Knight", cover: "data:image/png;base64,AAAA", source: "Playnite", lastPlayed: "2026-05-01T12:00:00Z" },
    { id: "g3", name: "Stardew Valley", cover: "javascript:alert(1)", source: "Playnite", lastPlayed: null },
    { id: "g4", name: "DOOM", cover: "asset://localhost/covers/doom.png", source: "Playnite", lastPlayed: null },
    { id: "g5", name: "Portal 2", cover: null, source: "Playnite", lastPlayed: null },
  ],
  readOnly: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot = UNAVAILABLE;
  mocks.readFavorites.mockReturnValue([]);
  mocks.readRecents.mockReturnValue([]);
  mocks.toggleFavorite.mockImplementation((id: string) => [id]);
  mocks.noteRecentlyPlayed.mockImplementation((id: string) => [id]);
});

afterEach(cleanup);

describe("PlayniteLibrary panel", () => {
  it("renders the explicit unavailable reason, the read-only notice and no invented games", async () => {
    render(<PlayniteLibrary />);
    expect(await screen.findByText(/Brak bezpiecznego, udokumentowanego API Playnite/)).toBeTruthy();
    expect(screen.getByText(/VELORA wyświetli okładki/)).toBeTruthy();
    expect(screen.getByText(/Dane gier są tylko do odczytu/)).toBeTruthy();
    expect(screen.getByText(/Logowanie do GOG, Epic, EA i Ubisoft/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Biblioteka Playnite" })).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("heading", { name: "Ulubione" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ostatnio grane" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cyberpunk 2077" })).toBeNull();
  });

  it("renders the cover grid with AUREA placeholders, sanitized covers and a favorite toggle", async () => {
    mocks.snapshot = GAMES_SNAPSHOT;
    render(<PlayniteLibrary />);

    const cyberpunk = await screen.findByRole("button", { name: "Cyberpunk 2077" });
    expect(cyberpunk.querySelector(".playnite-initials")?.textContent).toBe("C2");
    expect(cyberpunk.getAttribute("data-aurea-focus")).toBe("true");
    expect(cyberpunk.getAttribute("aria-current")).toBe("true");
    expect(cyberpunk.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("button", { name: "Hollow Knight" }).getAttribute("tabindex")).toBe("-1");

    // Niebezpieczne źródło okładki jest odrzucane przez PRAWDZIWY sanitizeCoverSource.
    const stardew = screen.getByRole("button", { name: "Stardew Valley" });
    expect(stardew.querySelector("img")).toBeNull();
    expect(stardew.querySelector(".playnite-initials")).toBeTruthy();
    // Bezpieczne źródła (data: i asset:) są renderowane jako obrazy.
    expect(screen.getByRole("button", { name: "Hollow Knight" }).querySelector("img")?.getAttribute("src"))
      .toBe("data:image/png;base64,AAAA");
    expect(screen.getByRole("button", { name: "DOOM" }).querySelector("img")?.getAttribute("src"))
      .toBe("asset://localhost/covers/doom.png");

    const favorite = screen.getByRole("button", { name: "Ulubione: Cyberpunk 2077" });
    expect(favorite.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(favorite);
    await waitFor(() => expect(favorite.getAttribute("aria-pressed")).toBe("true"));
    expect(mocks.toggleFavorite).toHaveBeenCalledWith("g1");
    expect(screen.getByRole("region", { name: "Ulubione" }).textContent).toContain("Cyberpunk 2077");
  });

  it("builds the recently-played section from local helpers and records a selection", async () => {
    mocks.snapshot = GAMES_SNAPSHOT;
    mocks.readRecents.mockReturnValue(["g1"]);
    render(<PlayniteLibrary />);

    await screen.findByRole("button", { name: "Cyberpunk 2077" });
    expect(screen.getByRole("region", { name: "Ostatnio grane" }).textContent).toContain("Cyberpunk 2077");

    fireEvent.click(screen.getByRole("button", { name: "Portal 2" }));
    await waitFor(() => expect(mocks.launchGame).toHaveBeenCalledWith("g5"));
    await waitFor(() => expect(mocks.noteRecentlyPlayed).toHaveBeenCalledWith("g5"));
    expect(screen.getByRole("region", { name: "Ostatnio grane" }).textContent).toContain("Portal 2");
  });

  it("exposes a11y roles, labels and roving tabIndex on the cover grid", async () => {
    mocks.snapshot = GAMES_SNAPSHOT;
    render(<PlayniteLibrary />);
    expect(await screen.findByRole("list", { name: "Siatka okładek gier" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getAllByRole("button", { name: /Ulubione:/ })).toHaveLength(5);
    expect(screen.getByRole("region", { name: "Biblioteka Playnite" }).getAttribute("aria-label")).toBe("Biblioteka Playnite");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("supports 2D arrow-key focus through the real moveGridFocus", async () => {
    mocks.snapshot = GAMES_SNAPSHOT;
    render(<PlayniteLibrary />);
    const first = await screen.findByRole("button", { name: "Cyberpunk 2077" });
    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hollow Knight" }));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Portal 2" }));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cyberpunk 2077" }));

    // Nieznany klawisz nie zmienia fokusu.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cyberpunk 2077" }));
  });

  it("exercises the real moveGridFocus and sanitizeCoverSource helpers", () => {
    expect(moveGridFocus(4, "ArrowUp", 4, 5)).toBe(0);
    expect(moveGridFocus(0, "ArrowDown", 4, 5)).toBe(4);
    expect(moveGridFocus(2, "Home", 4, 5)).toBe(2);
    expect(sanitizeCoverSource("javascript:alert(1)")).toBeNull();
    expect(sanitizeCoverSource("file:///tmp/cover.png")).toBeNull();
    expect(sanitizeCoverSource("https://cdn.example.com/cover.png")).toBeNull();
    expect(sanitizeCoverSource("asset://localhost/c.png")).toBe("asset://localhost/c.png");
    expect(sanitizeCoverSource("data:image/webp;base64,UklGRg==")).toBe("data:image/webp;base64,UklGRg==");
  });

  it("announces loading through a polite live region", async () => {
    let resolve!: (value: unknown) => void;
    mocks.readLibrary.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<PlayniteLibrary />);
    expect(screen.getByRole("status").textContent).toContain("Odczytuję bibliotekę Playnite");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");

    resolve(UNAVAILABLE);
    expect(await screen.findByText(/Brak bezpiecznego, udokumentowanego API Playnite/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toContain("Odczytuję");
  });

  it("surfaces an adapter error in the status region without inventing games", async () => {
    mocks.readLibrary.mockRejectedValueOnce(new Error("Most Tauri niedostępny."));
    render(<PlayniteLibrary />);
    expect(await screen.findByText(/Most Tauri niedostępny/)).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("button", { name: "Cyberpunk 2077" })).toBeNull();
  });
});
