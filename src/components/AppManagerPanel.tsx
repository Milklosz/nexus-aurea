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
      if (receipt.resumed) {
        setNotice(`Przywrócono okno ${app?.name ?? id}. Powrót do VELORA: skonfigurowany gest Home.`);
      } else if (receipt.alreadyRunning) {
        setNotice(`Przekazano polecenie otwarcia ${app?.name ?? id} do istniejącego klienta. Sprawdź wynik; powrót do VELORA: gest Home.`);
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
                {busyId === id ? "Uruchamiam…" : app?.runningInstances ? "Wznów" : "Otwórz"}
              </button>
            </div>;
          })}
        </div>
        <button type="button" onClick={() => void refresh()}>Odśwież diagnostykę</button>
        <p>Wznawianie wymaga okna i tożsamości procesu przechwyconych przez VELORA. Usługi streamingowe otwieraj przez ich kafelki. Steam i Playnite mogą przekazać polecenie własnemu istniejącemu klientowi. Powrót z aplikacji: skonfigurowany gest Home.</p>
      </>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {snapshot.apps.some(app => app.lastError) && <p role="status">Diagnostyka częściowo niedostępna: {snapshot.apps.filter(app => app.lastError).map(app => `${app.name}: ${app.lastError}`).join("; ")}</p>}
  </section>;
}
