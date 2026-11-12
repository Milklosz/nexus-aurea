import { useCallback, useEffect, useState } from "react";
import {
  emptyAppManagerSnapshot,
  getAppManagerStatus,
  launchManagedApp,
  managedAppErrorMessage,
  type AppManagerSnapshot,
  type ManagedAppId,
} from "../services/appManager";

const appIds: ManagedAppId[] = ["steamBigPicture", "appleMusic", "playniteFullscreen", "chrome", "edge", "firefox"];

export function AppManagerPanel() {
  const [snapshot, setSnapshot] = useState<AppManagerSnapshot>(emptyAppManagerSnapshot);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    setError("");
    try {
      setSnapshot(await getAppManagerStatus());
    } catch {
      setError("Nie udało się odczytać instalacji i procesów.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const launch = async (id: ManagedAppId) => {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      const receipt = await launchManagedApp(id);
      const app = snapshot.apps.find(candidate => candidate.id === id);
      if (receipt.alreadyRunning) {
        setNotice(`${app?.name ?? id} już działa. Przejdź do niego przez Alt+Tab; VELORA nie wymusza fokusu.`);
      } else if (receipt.focusRestoreSupported) {
        setNotice(`${app?.name ?? id} uruchomiono. Powrót fokusu będzie możliwy po zakończeniu monitorowanego procesu.`);
      } else {
        setNotice(`${app?.name ?? id} uruchomiono. Zamykanie tej aplikacji nie jest wiarygodnie monitorowane.`);
      }
      await refresh();
    } catch (cause) {
      setError(managedAppErrorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const byId = new Map(snapshot.apps.map(app => [app.id, app]));
  return <section className="app-manager" aria-label="VELORA App Manager" data-remote-allow="">
    <h3>VELORA App Manager</h3>
    {!snapshot.windows
      ? <p>Wykrywanie i uruchamianie aplikacji wymaga natywnej wersji Windows.</p>
      : <>
        <p>Aktywne okno: <strong>{snapshot.foregroundProcess ?? "niedostępne"}</strong> · odczytywana jest wyłącznie nazwa procesu.</p>
        <div className="managed-app-list">
          {appIds.map(id => {
            const app = byId.get(id);
            const name = app?.name ?? id;
            return <div className="managed-app-row" key={id}>
              <div>
                <strong>{name}</strong>
                <span>{!app?.installed ? "Nie wykryto" : app.runningInstances > 0 ? `Działa · ${app.runningInstances}` : "Zainstalowana · nie działa"}</span>
              </div>
              <button type="button" disabled={!app?.installed || Boolean(app.lastError) || busyId !== null} onClick={() => void launch(id)}>
                {busyId === id ? "Uruchamiam…" : app?.runningInstances ? "Już działa" : "Otwórz"}
              </button>
            </div>;
          })}
        </div>
        <button type="button" onClick={() => void refresh()}>Odśwież diagnostykę</button>
        <p>Steam, Apple Music i przeglądarki mogą przekazać uruchomienie do już istniejącego procesu. Automatyczny powrót fokusu jest deklarowany tylko dla monitorowanego Playnite Fullscreen. Procesów użytkownika VELORA nie kończy.</p>
      </>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {snapshot.apps.some(app => app.lastError) && <p role="status">Diagnostyka częściowo niedostępna: {snapshot.apps.filter(app => app.lastError).map(app => `${app.name}: ${app.lastError}`).join("; ")}</p>}
  </section>;
}
