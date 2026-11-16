import { useEffect, useRef, useState } from "react";
import { applyTvMode, getTvModeStatus, unsupportedTvMode, type TvModeStatus } from "../services/tvMode";
import "./TvModePanel.css";

/** Changes only VELORA placement. Display topology and the default audio device stay user-controlled. */
export function TvModePanel() {
  const [status, setStatus] = useState<TvModeStatus>(unsupportedTvMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { const next = await getTvModeStatus(); if (mounted.current) { setStatus(next); setError(""); } }
    catch { if (mounted.current) setError("Nie udało się odczytać ekranów VELORA."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  const apply = async (displayId: string | null, fullscreen: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const next = await applyTvMode(displayId, fullscreen);
      if (mounted.current) { setStatus(next); setNotice(fullscreen ? "VELORA wyświetla wybrany ekran pełnoekranowo." : "Przywrócono tryb okienkowy VELORA."); }
    } catch { if (mounted.current) setError("Nie udało się zmienić ekranu. Odśwież listę; wybrany ekran mógł zostać odłączony."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className="tv-mode-panel" aria-label="Tryb telewizora" data-remote-admin="">
    <h4>Tryb telewizora</h4>
    <p>Wybierz ekran, na którym chcesz korzystać z VELORA.</p>
    {!status.supported && <p>Natywne wykrywanie ekranów jest niedostępne.</p>}
    {status.error && <p role="alert">{status.error}</p>}
    {status.selectedDisplayId && !status.selectionAvailable && <p>Zapamiętany ekran jest odłączony. Wybierz dostępny ekran.</p>}
    {status.displays.map(display => <div key={display.id} className="tv-mode-display">
      <span>{display.name} · {display.width} × {display.height}{display.refreshHz ? ` · ${display.refreshHz} Hz` : " · odświeżanie nieznane"}{display.connectionType ? ` · ${display.connectionType === "internal" ? "wbudowany" : display.connectionType}` : " · połączenie nieznane"}{display.primary ? " · główny" : ""}{display.current ? " · VELORA" : ""}</span>
      <button type="button" disabled={busy} onClick={() => void apply(display.id, true)}>Pełny ekran: {display.name}</button>
    </div>)}
    <div className="tv-mode-actions">
      <button type="button" disabled={busy} onClick={() => void refresh()}>Odśwież ekrany</button>
      <button type="button" disabled={busy || !status.supported} onClick={() => void apply(null, false)}>Tryb okienkowy</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
