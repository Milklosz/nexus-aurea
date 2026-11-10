import { useEffect, useState } from "react";
import {
  emptyAppManagerSnapshot,
  getAppManagerStatus,
  launchManagedApp,
  launchManagedGame,
  managedAppErrorMessage,
  type AppManagerSnapshot,
  type ManagedAppId,
  type ManagedGame,
} from "../services/appManager";

type GamingHubProps = { onActivateGaming: () => Promise<boolean> };

export function GamingHub({ onActivateGaming }: GamingHubProps) {
  const [snapshot, setSnapshot] = useState<AppManagerSnapshot>(emptyAppManagerSnapshot);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    setError("");
    setLoading(true);
    try {
      setSnapshot(await getAppManagerStatus());
    } catch (cause) {
      setSnapshot(emptyAppManagerSnapshot);
      setError(managedAppErrorMessage(cause, "Nie udało się odczytać Steam i Playnite."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const apps = snapshot.apps ?? [];
  const steam = apps.find((app) => app.id === "steamBigPicture");
  const playnite = apps.find((app) => app.id === "playniteFullscreen");
  const games = snapshot.games ?? [];

  const launchLauncher = async (id: ManagedAppId) => {
    if (busy) return;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      if (!await onActivateGaming()) throw new Error("Nie udało się wybrać profilu Gaming.");
      const receipt = await launchManagedApp(id);
      setNotice(receipt.alreadyRunning
        ? "Aplikacja już działa. VELORA nie wymusza przełączenia fokusu."
        : "Wysłano żądanie uruchomienia " + (id === "steamBigPicture" ? "Steam Big Picture." : "Playnite Fullscreen."));
      await refresh();
    } catch (cause) {
      setError(managedAppErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const launchGame = async (game: ManagedGame) => {
    if (busy) return;
    setBusy(game.id);
    setError("");
    setNotice("");
    try {
      if (!await onActivateGaming()) throw new Error("Nie udało się wybrać profilu Gaming.");
      await launchManagedGame(game.id);
      setNotice("Wysłano żądanie uruchomienia " + game.name + " przez Steam.");
    } catch (cause) {
      setError(managedAppErrorMessage(cause, "Steam nie uruchomił gry."));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <section className="gaming-hub" aria-label="VELORA Gaming Hub"><p role="status">Odczytuję stan App Managera…</p></section>;

  if (!snapshot.windows) return <section className="gaming-hub" aria-label="VELORA Gaming Hub">
    <p>Wykrywanie bibliotek gier wymaga natywnego App Managera Windows. Podgląd webowy pozostaje tylko do odczytu.</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" onClick={() => void refresh()}>Spróbuj ponownie</button>
  </section>;

  return <section className="gaming-hub" aria-label="VELORA Gaming Hub">
    <div className="gaming-launchers">
      <div className="gaming-launcher">
        <div><strong>Steam</strong><span>{steam?.installed ? "Wykryto" : "Nie wykryto"}</span></div>
        <button type="button" disabled={!steam?.installed || Boolean(steam.lastError) || busy !== null}
          onClick={() => void launchLauncher("steamBigPicture")}>
          {busy === "steamBigPicture" ? "Uruchamiam…" : "Big Picture"}
        </button>
      </div>
      <div className="gaming-launcher">
        <div><strong>Playnite</strong><span>{playnite?.installed ? "Wykryto" : "Nie wykryto"}</span></div>
        <button type="button" disabled={!playnite?.installed || Boolean(playnite.lastError) || busy !== null}
          onClick={() => void launchLauncher("playniteFullscreen")}>
          {busy === "playniteFullscreen" ? "Uruchamiam…" : "Fullscreen"}
        </button>
      </div>
    </div>

    {steam?.lastError && <p role="alert">Steam: {steam.lastError}</p>}
    {playnite?.lastError && <p role="alert">Playnite: {playnite.lastError}</p>}
    {snapshot.gamesError && <p role="alert">Biblioteka Steam: {snapshot.gamesError}</p>}

    <h4>Wykryte gry Steam</h4>
    {games.length > 0
      ? <div className="gaming-game-list">
        {games.map((game) => <div className="gaming-game-row" key={game.id}>
          <div><strong>{game.name}</strong><span>{game.launcher} · App ID {game.id}</span></div>
          <button type="button" disabled={!steam?.installed || Boolean(snapshot.gamesError) || busy !== null}
            onClick={() => void launchGame(game)}>
            {busy === game.id ? "Uruchamiam…" : "Uruchom"}
          </button>
        </div>)}
      </div>
      : steam?.installed && !snapshot.gamesError
        ? <p>Nie znaleziono zainstalowanych gier w odczytanych bibliotekach Steam.</p>
        : <p>Brak listy gier. Wyświetlamy wyłącznie dane zwrócone przez bibliotekę Steam.</p>}

    <p className="gaming-hub-note">Lista gier pochodzi z lokalnych plików appmanifest Steam. Playnite jest wykrywany i może być otwarty, ale jego biblioteka nie jest jeszcze odczytywana.</p>
    <button type="button" onClick={() => void refresh()} disabled={busy !== null}>Odśwież biblioteki</button>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}