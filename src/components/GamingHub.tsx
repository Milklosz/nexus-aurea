import { useEffect, useMemo, useRef, useState } from "react";
import {
  emptyAppManagerSnapshot,
  getGamingDiagnostics,
  getAppManagerStatus,
  launchManagedApp,
  launchManagedGame,
  managedAppErrorMessage,
  type AppManagerSnapshot,
  type GamingDiagnostics,
  type ManagedAppId,
  type ManagedGame,
  type LaunchEventPayload,
} from "../services/appManager";
import * as appManagerBridge from "../services/appManager";
import {
  getGameProcessState,
  launchSteamGame,
  playniteGuidFromGameId,
  readSteamLibrary,
  steamAppIdFromGameId,
  type SteamLibrarySnapshot,
} from "../services/steamLibrary";
import { launchPlayniteGame } from "../services/playniteLibrary";
import { returnVeloraHome } from "../services/sessionOrchestrator";
import { PLAYNITE_DOWNLOAD_URL, openOfficialPlayniteDownload } from "../services/playniteSupport";
import { favoriteGame, gameCollection, gameCollectionKey, readGamingCollections, recordGameLaunch, saveGamingCollections, type GamingCollections } from "../services/gamingCollections";
import "./GamingCollections.css";

type GamingHubProps = { onActivateGaming: () => Promise<boolean> };

type GameLauncher = "steam" | "playnite" | "other";

function launcherOf(game: ManagedGame): GameLauncher {
  const normalized = game.launcher.trim().toLowerCase();
  if (normalized === "steam") return "steam";
  if (normalized === "playnite") return "playnite";
  if (steamAppIdFromGameId(game.id) !== null) return "steam";
  if (playniteGuidFromGameId(game.id) !== null) return "playnite";
  return "other";
}

function launcherLabel(launcher: GameLauncher, raw: string): string {
  if (launcher === "steam") return "Steam";
  if (launcher === "playnite") return "Playnite";
  return raw;
}

export function GamingHub({ onActivateGaming }: GamingHubProps) {
  const [snapshot, setSnapshot] = useState<AppManagerSnapshot>(emptyAppManagerSnapshot);
  const [steamLibrary, setSteamLibrary] = useState<SteamLibrarySnapshot>(() => readSteamLibraryFallback());
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const refreshRequestInFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [diagnostics, setDiagnostics] = useState<GamingDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState("");
  const [collections, setCollections] = useState(readGamingCollections);
  const [collectionView, setCollectionView] = useState<"all" | "favorites" | "recent">("all");
  const [launchedGameId, setLaunchedGameId] = useState<string | null>(null);
  const launchedGameRef = useRef<string | null>(null);
  const [exitNotice, setExitNotice] = useState("");
  const [gameEnded, setGameEnded] = useState(false);
  const updateCollections = (next: GamingCollections) => {
    setCollections(next);
    if (!saveGamingCollections(next)) setError("Nie udało się zapisać kolekcji gier. Zmiany pozostają dostępne do zamknięcia VELORA.");
  };

  const refresh = async () => {
    if (refreshRequestInFlight.current) return;
    refreshRequestInFlight.current = true;
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const [status, steam] = await Promise.all([getAppManagerStatus(), readSteamLibrary()]);
      setSnapshot(status);
      setSteamLibrary(steam);
      setStatusUnavailable(false);
    } catch (cause) {
      setSnapshot((current) => current.windows ? current : emptyAppManagerSnapshot);
      setStatusUnavailable(true);
      setError(managedAppErrorMessage(cause, "Nie udało się odczytać Steam i Playnite."));
    } finally {
      setLoading(false);
      setRetrying(false);
      refreshRequestInFlight.current = false;
    }
  };

  const retryLibraries = () => {
    if (loading || retrying) return;
    setRetrying(true);
    void refresh();
  };

  useEffect(() => { void refresh(); }, []);

  // Observation-only game lifecycle: the native launch_registry watch emits
  // velora-launch-event on start/exit/crash. We only show a truthful notice
  // and offer Return-to-Home — the game process is NEVER killed.
  useEffect(() => {
    const listen = safeLaunchEventListener();
    if (!listen) return;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      unsubscribe = await listen((event) => {
        const session = event?.session;
        if (!session || session.kind !== "game") return;
        const current = launchedGameRef.current;
        if (!current) return;
        const currentAppId = steamAppIdFromGameId(current) ?? current;
        const eventAppId = typeof session.appId === "string" ? session.appId : "";
        const eventBare = steamAppIdFromGameId(eventAppId) ?? eventAppId;
        if (eventBare !== currentAppId && eventAppId !== current) return;
        if (session.phase === "ended" || session.phase === "failed" || session.phase === "cancelled") {
          const crashed = session.phase === "failed";
          setExitNotice(
            crashed
              ? `${session.displayName}: sesja zakończyła się nieoczekiwanie. VELORA nie zamyka gry — możesz wrócić do Home.`
              : `${session.displayName} zakończył grę. Możesz wrócić do Home.`,
          );
          setGameEnded(true);
        }
      });
    })();
    return () => { if (unsubscribe) unsubscribe(); };
  }, []);

  // Read-only process-table polling while a game launched from this hub is
  // tracked; detects exit/crash even if an event was missed.
  useEffect(() => {
    if (!launchedGameId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const state = await getGameProcessState(launchedGameId);
        if (cancelled) return;
        if (
          state.tracked
          && !state.running
          && (state.phase === "ended" || state.phase === "failed" || state.phase === "cancelled" || state.crashed)
        ) {
          setExitNotice(
            state.crashed || state.phase === "failed"
              ? "Gra zakończyła sesję nieoczekiwanie. VELORA nie zamyka gry — możesz wrócić do Home."
              : "Gra zakończyła działanie. Możesz wrócić do Home.",
          );
          setGameEnded(true);
        }
      } catch {
        // Read-only best effort: a failed status read never fabricates state.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [launchedGameId]);

  const handleReturnHome = async () => {
    setGameEnded(false);
    setExitNotice("");
    launchedGameRef.current = null;
    setLaunchedGameId(null);
    try {
      await returnVeloraHome();
    } catch (cause) {
      setError(managedAppErrorMessage(cause, "Nie udało się wrócić do Home."));
    }
  };

  const apps = snapshot.apps ?? [];
  const steam = apps.find((app) => app.id === "steamBigPicture");
  const playnite = apps.find((app) => app.id === "playniteFullscreen");
  // Merged, read-only library: App Manager snapshot games (steam:<appid> /
  // playnite:<guid> / legacy numeric Steam ids) plus anything the standalone
  // Steam adapter reports. Never fabricated: only confirmed entries render.
  const games = useMemo(() => {
    const merged = new Map<string, ManagedGame>();
    for (const game of snapshot.games ?? []) {
      if (gameCollectionKey(game.id) !== null && !merged.has(game.id)) merged.set(game.id, game);
    }
    if (steamLibrary.available) {
      for (const entry of steamLibrary.games) {
        const id = `steam:${entry.appid}`;
        if (!merged.has(id)) merged.set(id, { id, name: entry.name, launcher: "steam" });
      }
    }
    return [...merged.values()].slice(0, 4096);
  }, [snapshot, steamLibrary]);
  const visibleGames = collectionView === "all" ? games : gameCollection(games, collections[collectionView === "favorites" ? "favorites" : "recent"]);

  const launchLauncher = async (id: ManagedAppId) => {
    if (busy) return;
    setBusy(id);
    setError("");
    setNotice(id === "steamBigPicture" ? "Uruchamiam Steam Big Picture…" : "Uruchamiam Playnite Fullscreen…");
    try {
      if (!await onActivateGaming()) throw new Error("Nie udało się wybrać profilu Gaming.");
      const receipt = await launchManagedApp(id);
      const launchNotice = receipt.alreadyRunning
        ? id === "playniteFullscreen"
          ? "Wysłano do działającego Playnite żądanie przejścia do trybu Fullscreen."
          : "Wysłano do działającego Steam żądanie przejścia do Big Picture."
        : "Wysłano żądanie uruchomienia " + (id === "steamBigPicture" ? "Steam Big Picture." : "Playnite Fullscreen.");
      await refresh();
      setNotice(launchNotice);
    } catch (cause) {
      setNotice("");
      setError(managedAppErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const launchGame = async (game: ManagedGame) => {
    if (busy) return;
    const launcher = launcherOf(game);
    if (launcher === "other") {
      setError("Nieobsługiwany launcher gry: " + game.launcher);
      return;
    }
    const through = launcher === "playnite" ? "Playnite" : "Steam";
    setBusy(game.id);
    setError("");
    setGameEnded(false);
    setExitNotice("");
    setNotice("Uruchamiam " + game.name + " przez " + through + "…");
    try {
      if (!await onActivateGaming()) throw new Error("Nie udało się wybrać profilu Gaming.");
      if (launcher === "playnite") {
        const guid = playniteGuidFromGameId(game.id);
        if (!guid) throw new Error("Nieprawidłowy identyfikator gry Playnite.");
        const receipt = await launchPlayniteGame(guid);
        if (!receipt.launched) throw new Error("Playnite nie potwierdził uruchomienia gry.");
      } else {
        const appid = steamAppIdFromGameId(game.id);
        if (!appid) throw new Error("Nieprawidłowy identyfikator gry Steam.");
        // steam://run/<appid> for canonical `steam:<appid>` ids; the legacy
        // verified numeric path stays for pre-3.0 ids.
        const receipt = game.id.startsWith("steam:")
          ? await launchSteamGame(appid)
          : await launchManagedGame(game.id);
        if (!receipt.launched) throw new Error("Steam nie potwierdził uruchomienia gry.");
      }
      const key = gameCollectionKey(game.id) ?? game.id;
      updateCollections(recordGameLaunch(collections, key));
      launchedGameRef.current = game.id;
      setLaunchedGameId(game.id);
      setNotice("Wysłano żądanie uruchomienia " + game.name + " przez " + through + ".");
    } catch (cause) {
      setNotice("");
      setError(managedAppErrorMessage(cause, through + " nie uruchomił gry."));
    } finally {
      setBusy(null);
    }
  };

  const openPlayniteDownload = async () => {
    setError("");
    try {
      await openOfficialPlayniteDownload();
    } catch {
      setError(`Nie udało się otworzyć strony Playnite. Otwórz ją ręcznie: ${PLAYNITE_DOWNLOAD_URL}`);
    }
  };

  const runDiagnostics = async () => {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    setDiagnosticsError("");
    try {
      setDiagnostics(await getGamingDiagnostics());
    } catch (cause) {
      setDiagnosticsError(managedAppErrorMessage(cause, "Nie udało się wykonać diagnostyki komputera."));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} GB`;

  if (loading && !snapshot.windows && !retrying) return <section className="gaming-hub" aria-label="VELORA Gaming Hub" data-remote-allow=""><p role="status">Odczytuję stan App Managera…</p></section>;

  if (!snapshot.windows) return <section className="gaming-hub" aria-label="VELORA Gaming Hub" data-remote-allow="">
    <p>Wykrywanie bibliotek gier wymaga natywnego App Managera Windows. Podgląd webowy pozostaje tylko do odczytu.</p>
    {loading && <p role="status">Odczytuję stan App Managera…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status" aria-live="polite">{notice}</p>}
    <button key="app-manager-refresh" type="button" aria-busy={loading} onClick={retryLibraries}>
      {loading ? "Odczytuję…" : "Spróbuj ponownie"}
    </button>
  </section>;

  return <section className="gaming-hub" aria-label="VELORA Gaming Hub" data-remote-allow="">
    <div className="gaming-launchers">
      <div className="gaming-launcher">
        <div><strong>Steam</strong><span>{steam?.installed ? "Wykryto" : "Nie wykryto"}</span></div>
        <button type="button" aria-busy={busy === "steamBigPicture"} disabled={!steam?.installed || Boolean(steam.lastError) || statusUnavailable || busy !== null}
          onClick={() => void launchLauncher("steamBigPicture")}>
          {busy === "steamBigPicture" ? "Uruchamiam…" : "Big Picture"}
        </button>
      </div>
      <div className="gaming-launcher">
        <div><strong>Playnite</strong><span>{playnite?.installed ? "Wykryto" : "Nie wykryto"}</span></div>
        <button type="button" aria-busy={busy === "playniteFullscreen"} disabled={!playnite?.installed || Boolean(playnite.lastError) || statusUnavailable || busy !== null}
          onClick={() => void launchLauncher("playniteFullscreen")}>
          {busy === "playniteFullscreen" ? "Uruchamiam…" : "Fullscreen"}
        </button>
      </div>
    </div>

    {!playnite?.installed && <div className="gaming-hub-guidance">
      <p>Playnite nie jest wykryty. Możesz zainstalować go samodzielnie z oficjalnej strony; VELORA nie pobiera ani nie uruchamia instalatora.</p>
      <button type="button" onClick={() => void openPlayniteDownload()}>Oficjalna strona Playnite</button>
    </div>}

    {steam?.lastError && <p role="alert">Steam: {steam.lastError}</p>}
    {playnite?.lastError && <p role="alert">Playnite: {playnite.lastError}</p>}
    {snapshot.gamesError && <p role="alert">Biblioteka Steam: {snapshot.gamesError}</p>}
    {!steamLibrary.available && steamLibrary.reason && snapshot.windows && (
      <p className="gaming-library-note">Biblioteka Steam: {steamLibrary.reason}</p>
    )}

    {gameEnded && exitNotice && <div className="gaming-exit-notice" role="status" aria-live="polite">
      <p>{exitNotice}</p>
      <button type="button" onClick={() => void handleReturnHome()}>Wróć do Home</button>
    </div>}

    <h4>Wykryte gry</h4>
    <div className="gaming-collection-tabs" role="group" aria-label="Kolekcja gier">
      <button type="button" aria-pressed={collectionView === "all"} onClick={() => setCollectionView("all")}>Zainstalowane ({games.length})</button>
      <button type="button" aria-pressed={collectionView === "favorites"} onClick={() => setCollectionView("favorites")}>Ulubione gry</button>
      <button type="button" aria-pressed={collectionView === "recent"} onClick={() => setCollectionView("recent")}>Ostatnio uruchamiane</button>
    </div>
    {collectionView !== "all" && visibleGames.length === 0 && <p>Ta kolekcja nie zawiera dostępnych gier.</p>}
    {games.length > 0
      ? <div className="gaming-game-list">
        {visibleGames.map((game) => {
          const launcher = launcherOf(game);
          const label = launcherLabel(launcher, game.launcher);
          const launchDisabled = launcher === "playnite"
            ? !playnite?.installed || statusUnavailable || busy !== null
            : !steam?.installed || Boolean(snapshot.gamesError) || statusUnavailable || busy !== null;
          return <div className="gaming-game-row" key={game.id}>
            <div>
              <span className={`gaming-launcher-badge gaming-launcher-badge--${launcher}`} data-launcher={launcher}>{label}</span>
              <strong>{game.name}</strong>
              <span>{launcher === "steam" ? `Steam · App ID ${steamAppIdFromGameId(game.id) ?? game.id}` : launcher === "playnite" ? "Playnite" : game.launcher}</span>
            </div>
            <button type="button" aria-busy={busy === game.id} disabled={launchDisabled}
              onClick={() => void launchGame(game)}>
              {busy === game.id ? "Uruchamiam…" : "Uruchom"}
            </button>
            <button type="button" aria-label={`${collections.favorites.includes(gameCollectionKey(game.id) ?? game.id) ? "Odepnij" : "Przypnij"} ${game.name}`} aria-pressed={collections.favorites.includes(gameCollectionKey(game.id) ?? game.id)} disabled={busy !== null}
              onClick={() => updateCollections(favoriteGame(collections, gameCollectionKey(game.id) ?? game.id))}>
              {collections.favorites.includes(gameCollectionKey(game.id) ?? game.id) ? "Odepnij" : "Przypnij"}
            </button>
          </div>;
        })}
      </div>
      : steam?.installed && !snapshot.gamesError
        ? <p>Nie znaleziono zainstalowanych gier w odczytanych bibliotekach Steam.</p>
        : <p>Brak listy gier. Wyświetlamy wyłącznie dane zwrócone przez bibliotekę Steam.</p>}

    <div className="gaming-platform-guidance">
      <h4>GOG i Cyberpunk 2077</h4>
      <p>W Playnite wybierz integrację GOG podczas pierwszego uruchomienia albo w menu Add-ons → Browse → Libraries. Zaloguj się i sprawdź stan instalacji w Playnite lub oficjalnym kliencie, jeśli integracja tego wymaga; tam dokończ też ewentualną aktualizację lub instalację.</p>
      <p className="gaming-hub-note">VELORA nie zgaduje, czy Cyberpunk 2077 jest na koncie, zainstalowany lub gotowy, i nie pobiera gry. Ta lista obejmuje tylko gry Steam potwierdzone lokalnymi plikami instalacji. W Playnite możesz skonfigurować dostępne integracje Epic, EA App, Ubisoft Connect, Battle.net oraz Xbox/PC Game Pass; logowanie i wymagane launchery zależą od integracji.</p>
      <div className="gaming-diagnostics">
        <p>Sprawdza znane lokalizacje Playnite, GOG Galaxy i Cyberpunka oraz wolne miejsce na dyskach lokalnych. Nie skanuje całych dysków ani kont.</p>
        <button type="button" aria-busy={diagnosticsBusy} disabled={diagnosticsBusy || busy !== null} onClick={() => void runDiagnostics()}>
          {diagnosticsBusy ? "Sprawdzam…" : diagnostics ? "Sprawdź ponownie" : "Diagnostyka tego komputera"}
        </button>
        {diagnosticsError && <p role="alert">{diagnosticsError}</p>}
        {diagnostics && <div className="gaming-diagnostics-results" aria-live="polite">
          <p>Playnite: {diagnostics.playniteDetected ? "wykryto w sprawdzonych lokalizacjach" : "nie wykryto w sprawdzonych lokalizacjach"}</p>
          <p>GOG Galaxy: {diagnostics.gogGalaxyDetected ? "wykryto" : "nie wykryto w sprawdzonych lokalizacjach"}{diagnostics.gogGalaxyRunningInstances === null ? " · nie można odczytać stanu procesu" : diagnostics.gogGalaxyRunningInstances > 0 ? ` · działa (${diagnostics.gogGalaxyRunningInstances})` : " · nie działa"}</p>
          <p>Cyberpunk 2077: {diagnostics.cyberpunkInstallDetected ? "wykryto pliki instalacji w sprawdzonych lokalizacjach" : "nie wykryto plików instalacji w sprawdzonych lokalizacjach"}</p>
          <p>Własność gry, logowanie GOG i gotowość do uruchomienia nie są sprawdzane.</p>
          {diagnostics.diskSpace.map((disk) => <p key={disk.drive}>{disk.drive} {disk.availableBytes === null || disk.totalBytes === null ? disk.error : `${formatGiB(disk.availableBytes)} wolne z ${formatGiB(disk.totalBytes)}`}</p>)}
          {diagnostics.diskSpaceError && <p role="alert">{diagnostics.diskSpaceError}</p>}
          {diagnostics.gogGalaxyProcessError && <p role="alert">GOG Galaxy: {diagnostics.gogGalaxyProcessError}</p>}
          {!diagnostics.diskSpaceError && diagnostics.diskSpace.length === 0 && <p>Nie znaleziono lokalnych dysków stałych.</p>}
        </div>}
      </div>
    </div>
    <button key="app-manager-refresh" type="button" aria-busy={loading} onClick={() => void refresh()} disabled={busy !== null}>
      {loading ? "Odświeżanie…" : "Odśwież biblioteki"}
    </button>
    {error && <p role="alert">{error}</p>}
    <p role="status" aria-live="polite">{loading ? "Odświeżam biblioteki gier…" : notice}</p>
  </section>;
}

/** Synchronous initial value matching the browser-preview fallback. */
function readSteamLibraryFallback(): SteamLibrarySnapshot {
  return {
    windows: false,
    source: "browser-preview",
    available: false,
    reason: "Biblioteka Steam wymaga natywnej aplikacji Windows; podgląd webowy pozostaje tylko do odczytu.",
    games: [],
  };
}

/**
 * Reads the optional launch-event listener defensively: test mocks of the
 * appManager bridge may not define it, and a missing export must never break
 * rendering (observation is best-effort).
 */
function safeLaunchEventListener(): ((callback: (event: LaunchEventPayload) => void) => Promise<() => void>) | undefined {
  try {
    const candidate = (appManagerBridge as unknown as Record<string, unknown>)["listenForLaunchEvent"];
    return typeof candidate === "function"
      ? (candidate as (callback: (event: LaunchEventPayload) => void) => Promise<() => void>)
      : undefined;
  } catch {
    return undefined;
  }
}
