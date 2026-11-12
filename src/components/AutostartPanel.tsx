import { useEffect, useState } from "react";
import {
  autostartErrorMessage,
  disabledAutostartStatus,
  getAutostartStatus,
  getStartupMode,
  SAFE_MODE_FLAG,
  setAutostartEnabled,
  type AutostartStatus,
  type StartupMode,
} from "../services/autostart";
import "./AutostartPanel.css";

/**
 * Opcjonalny autostart VELORA (B. Autostart).
 * Karta AUREA montowana przez integratora w ControlCenter — sama nigdzie się nie montuje.
 * Montaż wykonuje wyłącznie odczyt; zapis do systemu jest możliwy tylko po
 * świadomym kliknięciu przełącznika (opt-in).
 */
export function AutostartPanel() {
  const [status, setStatus] = useState<AutostartStatus>(disabledAutostartStatus);
  const [mode, setMode] = useState<StartupMode | null>(null);
  const [windowed, setWindowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  // Odczyt stanu przy montażu (i po ponowieniu). Strażnik `active` chroni przed
  // aktualizacją stanu po odmontowaniu. To JEDYNE wywołania przy montażu —
  // setAutostartEnabled nie jest tu nigdy wywoływane.
  useEffect(() => {
    let active = true;
    const load = async () => {
      setBusy(true);
      try {
        const [nextStatus, nextMode] = await Promise.all([
          getAutostartStatus(),
          getStartupMode(),
        ]);
        if (!active) return;
        setStatus(nextStatus);
        setMode(nextMode);
        setWindowed(nextStatus.windowed);
        setError("");
        setNotice("");
      } catch (cause) {
        if (!active) return;
        setNotice("");
        setError(autostartErrorMessage(cause, "Nie udało się odczytać stanu autostartu."));
      } finally {
        if (active) setBusy(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [reloadToken]);

  const supported = status.supported;
  const statusLabel = !supported ? "niedostępny" : status.enabled ? "włączony" : "wyłączony";

  // Jedyna ścieżka zapisu: jawne kliknięcie przełącznika opt-in.
  const applyChange = async (nextEnabled: boolean, nextWindowed: boolean) => {
    if (busy || !supported) return;
    setBusy(true);
    setError("");
    setNotice("Zapisuję ustawienia autostartu…");
    try {
      const next = await setAutostartEnabled(nextEnabled, nextWindowed);
      setStatus(next);
      setNotice(
        nextEnabled
          ? nextWindowed
            ? `Autostart włączony w awaryjnym trybie ${SAFE_MODE_FLAG}.`
            : "Autostart włączony po zalogowaniu do Windows."
          : "Autostart wyłączony. Wpis VELORA został usunięty.",
      );
    } catch (cause) {
      setNotice("");
      setError(autostartErrorMessage(cause, "Nie udało się zmienić ustawień autostartu."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cc-card autostart-panel" aria-label="Autostart VELORA" aria-busy={busy}>
      <div className="cc-card-heading">
        <span className="cc-card-index">07</span>
        <div>
          <h3>Autostart</h3>
          <p>Uruchom VELORA po zalogowaniu do Windows — tylko za Twoją zgodą.</p>
        </div>
      </div>

      <p className="autostart-status">{`Stan autostartu: ${statusLabel}${status.lastError ? ` · ${status.lastError}` : ""}`}</p>

      <p className="autostart-consent">
        Włączenie autostartu wymaga Twojej zgody. VELORA dodaje jeden wpis HKCU\Software\Microsoft\Windows\CurrentVersion\Run dla bieżącego użytkownika. Nie zmienia powłoki Windows ani innych ustawień systemowych.
      </p>

      {mode?.windowed && (
        <p className="autostart-session-note" role="note">
          {`Ta sesja VELORA działa w awaryjnym trybie ${SAFE_MODE_FLAG} (okno zamiast pełnego ekranu).`}
        </p>
      )}

      <div className="cc-actions autostart-actions">
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          aria-label="Autostart VELORA po zalogowaniu do Windows"
          aria-busy={busy}
          disabled={busy || !supported}
          onClick={() => void applyChange(!status.enabled, windowed)}
        >
          {status.enabled ? "Wyłącz autostart" : "Włącz autostart"}
        </button>

        <label className="autostart-safe-mode">
          <input
            type="checkbox"
            aria-label={`Tryb awaryjny ${SAFE_MODE_FLAG}`}
            checked={windowed}
            disabled={busy || !supported}
            onChange={(event) => setWindowed(event.target.checked)}
          />
          {`Tryb bezpieczny `}<code>{SAFE_MODE_FLAG}</code>
        </label>

        {error && (
          <button
            type="button"
            className="autostart-retry"
            aria-busy={busy}
            disabled={busy}
            onClick={() => setReloadToken((token) => token + 1)}
          >
            {busy ? "Odczytuję…" : "Spróbuj ponownie"}
          </button>
        )}
      </div>

      <p className="autostart-explainer">
        {`Tryb awaryjny `}<code>{SAFE_MODE_FLAG}</code>{` to start awaryjny już obsługiwany przez konfigurację Tauri (setup w lib.rs): wyłącza pełny ekran i przywraca dekoracje okna. Zostanie zapisany przy włączeniu autostartu.`}
      </p>

      {error && <p className="cc-feedback cc-error" role="alert">{error}</p>}
      <p className={notice ? "cc-feedback" : "autostart-live"} role="status" aria-live="polite">{notice}</p>
    </section>
  );
}
