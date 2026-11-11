import { useEffect, useRef, useState } from "react";
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
  const [urgentNotice, setUrgentNotice] = useState(false);
  const actionGeneration = useRef(0);
  const foregroundClass = status.running
    ? classifyForegroundProcess(status.foregroundProcess)
    : "unknown";

  useEffect(() => {
    let active = true;
    let stopStatusListener: (() => void) | undefined;
    let stopServiceListener: (() => void) | undefined;
    const initialStatusGeneration = actionGeneration.current;

    void getControlServiceStatus().then((next) => {
      if (active && initialStatusGeneration === actionGeneration.current) setStatus(next);
    }).catch(() => {
      if (active && initialStatusGeneration === actionGeneration.current) {
        setError("Nie udało się odczytać stanu usługi.");
      }
    });
    void listenForControlServiceStatus((next) => {
      if (active) setStatus(next);
    }).then((unlisten) => {
      if (active) stopStatusListener = unlisten;
      else unlisten();
    }).catch(() => {
      if (active) setError("Nie udało się monitorować zmian usługi; stan może być nieaktualny.");
    });
    void listenForControlServiceStop((reason) => {
      if (!active) return;
      actionGeneration.current += 1;
      setBusy(false);
      setStatus((current) => ({
        ...current,
        running: false,
        gameMode: false,
        returnHotkeyRegistered: false,
        gamepadHomeRunning: false,
        gamepadHomeDeviceCount: 0,
        gamepadHomeLastComboAtMs: null,
      }));
      if (reason === "keyboard-emergency") {
        setError("");
        setUrgentNotice(true);
        setNotice("Usługa wyłączona skrótem awaryjnym.");
      } else {
        setUrgentNotice(false);
        setNotice("");
        setError("Usługa została wyłączona po błędzie; uruchom ją ponownie z diagnostyki.");
      }
    }).then((unlisten) => {
      if (active) stopServiceListener = unlisten;
      else unlisten();
    }).catch(() => {
      if (active) setError("Nie udało się monitorować zmian usługi; stan może być nieaktualny.");
    });

    return () => {
      active = false;
      stopStatusListener?.();
      stopServiceListener?.();
    };
  }, []);

  const runAction = async (action: () => Promise<ControlServiceStatus>) => {
    const generation = actionGeneration.current;
    setBusy(true);
    setError("");
    setUrgentNotice(false);
    setNotice("Aktualizuję Control Service…");
    try {
      const nextStatus = await action();
      if (generation !== actionGeneration.current) return;
      setStatus(nextStatus);
      setNotice(nextStatus.gameMode
        ? "Control Service: tryb gry włączony."
        : nextStatus.running ? "Control Service jest aktywny." : "Control Service jest wyłączony.");
    } catch (cause) {
      if (generation !== actionGeneration.current) return;
      setNotice("");
      setError(cause instanceof Error ? cause.message : "Control Service nie wykonał polecenia.");
    } finally {
      if (generation === actionGeneration.current) setBusy(false);
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
        <p role="status">
          DualSense Home: {status.gamepadHomeRunning
            ? `${status.gamepadHomeDeviceCount ?? 0} aktywne · PS + Options`
            : `niedostępny · fallback Ctrl+Alt+N`}
          {status.gamepadHomeLastError ? ` · ${status.gamepadHomeLastError}` : ""}
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
        <p>Ctrl+Alt+N wraca do VELORA. Ctrl+Alt+F12 natychmiast wyłącza usługę. Tryb gry zwalnia skrót klawiaturowy; DualSense PS + Options pozostaje dostępny jako powrót.</p>
        <p>DualSense Home odczytuje wyłącznie raporty Sony, aby wykryć PS + Options. Nie blokuje, nie przechwytuje i nie mapuje inputu gry. Gdy pada lub Win32 nie da odczytu, działa Ctrl+Alt+N.</p>
        <p>Globalne mapowanie przycisków, ruch kursora i głośność są wyłączone w tym prototypie.</p>
        {error && <p role="alert">{error}</p>}
        <p className="control-service-notice" role={urgentNotice ? "alert" : "status"} aria-live={urgentNotice ? "assertive" : "polite"}>{notice}</p>
      </>}
  </section>;
}
