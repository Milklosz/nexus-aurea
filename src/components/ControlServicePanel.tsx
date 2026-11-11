import { useEffect, useState } from "react";
import {
  disabledControlServiceStatus,
  getControlServiceStatus,
  listenForControlServiceStatus,
  listenForControlServiceStop,
  setControlGameMode,
  startControlService,
  stopControlService,
  type ControlServiceStatus,
} from "../services/controlService";
import { classifyForegroundProcess } from "../services/controllerOwnership";

const foregroundProcessLabels = {
  velora: "VELORA na pierwszym planie",
  steam: "proces Steam na pierwszym planie",
  external: "inna aplikacja na pierwszym planie",
  unknown: "brak sygnału",
} as const;

export function ControlServicePanel() {
  const [status, setStatus] = useState<ControlServiceStatus>(disabledControlServiceStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const foregroundClass = status.running
    ? classifyForegroundProcess(status.foregroundProcess)
    : "unknown";

  useEffect(() => {
    let active = true;
    let stopStatusListener: (() => void) | undefined;
    let stopServiceListener: (() => void) | undefined;

    void getControlServiceStatus().then((next) => {
      if (active) setStatus(next);
    }).catch(() => {
      if (active) setError("Nie udało się odczytać stanu usługi.");
    });
    void listenForControlServiceStatus((next) => {
      if (active) setStatus(next);
    }).then((unlisten) => {
      if (active) stopStatusListener = unlisten;
      else unlisten();
    }).catch(() => {});
    void listenForControlServiceStop((reason) => {
      if (!active) return;
      setStatus((current) => ({
        ...current,
        running: false,
        gameMode: false,
        returnHotkeyRegistered: false,
      }));
      if (reason === "keyboard-emergency") setNotice("Usługa wyłączona skrótem awaryjnym.");
      else setError("Usługa została wyłączona po błędzie; uruchom ją ponownie z diagnostyki.");
    }).then((unlisten) => {
      if (active) stopServiceListener = unlisten;
      else unlisten();
    }).catch(() => {});

    return () => {
      active = false;
      stopStatusListener?.();
      stopServiceListener?.();
    };
  }, []);

  const runAction = async (action: () => Promise<ControlServiceStatus>) => {
    setBusy(true);
    setError("");
    setNotice("Aktualizuję Control Service…");
    try {
      const nextStatus = await action();
      setStatus(nextStatus);
      setNotice(nextStatus.gameMode
        ? "Control Service: tryb gry włączony."
        : nextStatus.running ? "Control Service jest aktywny." : "Control Service jest wyłączony.");
    } catch (cause) {
      setNotice("");
      setError(cause instanceof Error ? cause.message : "Control Service nie wykonał polecenia.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="control-service" aria-label="VELORA Control Service">
    <h3>VELORA Control Service · prototyp Windows</h3>
    {!status.windows
      ? <p>Ta funkcja wymaga natywnej aplikacji VELORA w Windows.</p>
      : <>
        <p role="status">
          Stan: {status.running ? (status.gameMode ? "tryb gry" : "aktywny") : "wyłączony"}
          {status.lastError ? ` · ${status.lastError}` : ""}
        </p>
        <p>
          HID gamepad: {status.controllerCount} · kontrolery Sony: {status.playstationControllerCount}
          {" · Aktywne okno: "}{status.foregroundProcess ?? "niedostępne"}
        </p>
        <p role="status">Sygnał aktywnego okna: {foregroundProcessLabels[foregroundClass]}</p>
        {foregroundClass === "steam" && <p role="note">To sygnał procesu na pierwszym planie; nie potwierdza, że Steam Input przejął kontroler.</p>}
        {foregroundClass === "external" && <p role="note">Lokalne sterowanie VELORA pozostaje wstrzymane, dopóki jej okno nie wróci na pierwszy plan.</p>}
        <div className="launcher-actions">
          <button
            type="button"
            aria-busy={busy}
            disabled={busy}
            onClick={() => void runAction(status.running ? stopControlService : startControlService)}
          >
            {busy ? "Aktualizuję…" : status.running ? "Wyłącz usługę" : "Włącz monitoring sesji"}
          </button>
          <button
            type="button"
            aria-busy={busy}
            disabled={busy || !status.running}
            onClick={() => void runAction(() => setControlGameMode(!status.gameMode))}
          >
            {status.gameMode ? "Wyłącz tryb gry" : "Włącz tryb gry"}
          </button>
        </div>
        <p>Ctrl+Alt+N wraca do VELORA. Ctrl+Alt+F12 natychmiast wyłącza usługę. Tryb gry zwalnia skrót powrotu i pozostawia wyłącznie awaryjne wyłączenie.</p>
        <p>Globalne mapowanie przycisków, ruch kursora i głośność są wyłączone w tym prototypie. Nie odczytujemy raportów pada.</p>
        {error && <p role="alert">{error}</p>}
        <p className="control-service-notice" role="status" aria-live="polite">{notice}</p>
      </>}
  </section>;
}
