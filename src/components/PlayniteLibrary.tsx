import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  launchPlayniteGame,
  moveGridFocus,
  noteRecentlyPlayed,
  playniteLaunchErrorMessage,
  readFavorites,
  readPlayniteLibrary,
  readRecentlyPlayed,
  sanitizeCoverSource,
  toggleFavorite,
  type PlayniteGame,
  type PlayniteLibrarySnapshot,
} from "../services/playniteLibrary";
import "./PlayniteLibrary.css";

const GRID_COLUMNS = 4;
const LOADING_MESSAGE = "Odczytuję bibliotekę Playnite…";
const ARROW_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const READ_ONLY_NOTICE =
  "Dane gier są tylko do odczytu. Logowanie do GOG, Epic, EA i Ubisoft pozostaje w Playnite i jego oficjalnych integracjach.";
const READ_FAILURE_REASON =
  "Nie udało się odczytać biblioteki Playnite przez bezpieczne API. VELORA nie wyświetla danych gier bez potwierdzonego źródła.";

function gameInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
}

function polishError(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Nie udało się odczytać biblioteki Playnite.";
}

function errorSnapshot(message: string): PlayniteLibrarySnapshot {
  return { source: "unavailable", available: false, reason: message, games: [], readOnly: true };
}

/** Zwraca wyłącznie gry potwierdzone przez bieżące źródło — nigdy nie wymyśla nazw. */
function gamesFor(ids: string[], games: PlayniteGame[]): PlayniteGame[] {
  return ids
    .map((id) => games.find((game) => game.id === id))
    .filter((game): game is PlayniteGame => Boolean(game));
}

/**
 * Panel biblioteki Playnite (VELORA 1.0). Nie jest montowany w tym module —
 * integrator wstawia <PlayniteLibrary /> do GamingHub.tsx.
 *
 * Dane gier pochodzą wyłącznie z adaptera (bezpieczne, udokumentowane API).
 * Ulubione i „ostatnio grane" są stanem LOKALNYM VELORA, nie zapisem w Playnite.
 */
export function PlayniteLibrary() {
  const [snapshot, setSnapshot] = useState<PlayniteLibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [launchNotice, setLaunchNotice] = useState("");
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    try {
      setFavorites(readFavorites());
      setRecents(readRecentlyPlayed());
    } catch {
      // Storage WebView może być zablokowany — sekcje lokalne pozostają puste.
    }

    setLoading(true);
    void (async () => {
      try {
        const result = await readPlayniteLibrary();
        if (cancelled) return;
        setSnapshot(result);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        // Szczegół błędu trafia do regionu statusu, a stan biblioteki pozostaje
        // jawnym `unavailable` — bez jakichkolwiek wymyślonych danych gier.
        setError(polishError(cause));
        setSnapshot(errorSnapshot(READ_FAILURE_REASON));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const games = snapshot?.games ?? [];
  const activeIndex = Math.min(focusIndex, Math.max(games.length - 1, 0));
  const favoriteGames = gamesFor(favorites, games);
  const recentGames = gamesFor(recents, games);

  const handleToggleFavorite = (id: string) => {
    let next: string[];
    try {
      next = toggleFavorite(id);
    } catch {
      next = favorites.includes(id) ? favorites.filter((entry) => entry !== id) : [...favorites, id];
    }
    setFavorites(next);
  };

  const handleActivate = async (game: PlayniteGame, index: number) => {
    if (launchingId !== null) return;
    setFocusIndex(index);
    setLaunchingId(game.id);
    setLaunchNotice(`Uruchamiam ${game.name} przez Playnite…`);
    try {
      await launchPlayniteGame(game.id);
      setLaunchNotice(`${game.name}: polecenie przekazane do Playnite Fullscreen.`);
      let next: string[];
      try {
        next = noteRecentlyPlayed(game.id);
      } catch {
        next = [game.id, ...recents.filter((entry) => entry !== game.id)].slice(0, 12);
      }
      setRecents(next);
    } catch (cause) {
      setLaunchNotice(playniteLaunchErrorMessage(cause));
    } finally {
      setLaunchingId(null);
    }
  };

  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!ARROW_KEYS.includes(event.key)) return;
    event.preventDefault();
    const next = moveGridFocus(index, event.key, GRID_COLUMNS, games.length);
    setFocusIndex(next);
    cardRefs.current[next]?.focus();
  };

  return (
    <section className="playnite-library" aria-label="Biblioteka Playnite">
      <header className="playnite-library-header">
        <span className="playnite-eyebrow">VELORA · GRAND CINEMA</span>
        <h3>Biblioteka gier Playnite</h3>
      </header>

      <p className="playnite-status" role="status" aria-live="polite">
        {loading ? LOADING_MESSAGE : error ?? ""}
      </p>
      {launchNotice && <p className="playnite-launch-status" role="status">{launchNotice}</p>}

      {snapshot && !snapshot.available && (
        <div className="playnite-unavailable" data-source={snapshot.source}>
          <p className="playnite-unavailable-reason">{snapshot.reason}</p>
          <p>
            VELORA wyświetli okładki, ulubione i ostatnio grane dopiero, gdy dostępne będzie bezpieczne,
            udokumentowane API Playnite. Do tego czasu nie pokazujemy żadnych wymyślonych danych gier.
          </p>
        </div>
      )}

      {games.length > 0 && (
        <div className="playnite-grid" role="list" aria-label="Siatka okładek gier">
          {games.map((game, index) => {
            const cover = sanitizeCoverSource(game.cover);
            const isActive = index === activeIndex;
            const isFavorite = favorites.includes(game.id);
            return (
              <div className="playnite-card" role="listitem" key={game.id}>
                <button
                  ref={(element) => { cardRefs.current[index] = element; }}
                  className="playnite-cover"
                  type="button"
                  aria-label={game.name}
                  aria-busy={launchingId === game.id}
                  aria-current={isActive ? "true" : undefined}
                  data-aurea-focus={isActive ? "true" : undefined}
                  tabIndex={isActive ? 0 : -1}
                  onFocus={() => setFocusIndex(index)}
                  onClick={() => void handleActivate(game, index)}
                  onKeyDown={(event) => handleGridKeyDown(event, index)}
                >
                  {cover
                    ? <img src={cover} alt="" />
                    : <span className="playnite-initials" aria-hidden="true">{gameInitials(game.name)}</span>}
                </button>
                <div className="playnite-card-footer">
                  <span className="playnite-card-name">{game.name}</span>
                  <button
                    className="playnite-favorite"
                    type="button"
                    aria-pressed={isFavorite}
                    aria-label={`Ulubione: ${game.name}`}
                    onClick={() => handleToggleFavorite(game.id)}
                  >
                    <span aria-hidden="true">{isFavorite ? "★" : "☆"}</span> Ulubione
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="playnite-local-sections">
        <section className="playnite-local-section" aria-label="Ulubione">
          <h4>Ulubione</h4>
          {favoriteGames.length > 0
            ? <ul className="playnite-local-list">
                {favoriteGames.map((game) => <li key={game.id}>{game.name}</li>)}
              </ul>
            : <p className="playnite-local-empty">Brak ulubionych. Oznacz grę przyciskiem „Ulubione".</p>}
        </section>
        <section className="playnite-local-section" aria-label="Ostatnio grane">
          <h4>Ostatnio grane</h4>
          {recentGames.length > 0
            ? <ul className="playnite-local-list">
                {recentGames.map((game) => <li key={game.id}>{game.name}</li>)}
              </ul>
            : <p className="playnite-local-empty">Brak historii wyborów. Wybierz grę z siatki okładek.</p>}
        </section>
      </div>

      <p className="playnite-local-note">
        Ulubione i historia wyborów to ustawienia lokalne VELORA (pamięć WebView). Nie zapisujemy niczego w danych Playnite.
      </p>
      <p className="playnite-readonly-notice">{READ_ONLY_NOTICE}</p>
    </section>
  );
}
