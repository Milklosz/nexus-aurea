import { useEffect, useRef, useState } from "react";
import { getTvNavigationStatus, setTvNavigationMediaControls, setTvNavigationMode, type TvNavigationMode, type TvNavigationStatus } from "../services/tvNavigation";
import { getManagedSessions, type ManagedSession } from "../services/veloraSessionManager";

const modes: Record<TvNavigationMode, string> = { automatic: "Automatyczny", keyboard: "Klawiatura", spatial: "Przestrzenny · UI Automation", pointer: "Wskaźnik" };

/** Local production preferences only: no simulator or arbitrary input surface. */
export function TvNavigationSettings({ revision }: { revision: string }) {
  const [status, setStatus] = useState<TvNavigationStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [selectedSession, setSelectedSession] = useState("");
  const active = useRef(true);
  const inFlight = useRef(false);
  const read = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const [statusResult, sessionsResult] = await Promise.allSettled([getTvNavigationStatus(), getManagedSessions()]);
      if (statusResult.status === "rejected") throw statusResult.reason;
      if (active.current) {
        setStatus(statusResult.value);
        const availableSessions = sessionsResult.status === "fulfilled"
          ? sessionsResult.value.sessions.filter(session => session.applicationType === "cinema" && session.canResume) : [];
        setSessions(availableSessions);
        setSelectedSession(previous => statusResult.value.mediaControlSession?.sessionId
          ?? (availableSessions.some(session => session.sessionId === previous) ? previous : ""));
        setError(sessionsResult.status === "rejected" ? "Nie odczytano sesji do uzbrojenia skrótów. Odśwież stan." : "");
      }
    } catch { if (active.current) { setStatus(null); setError("Tryb nawigacji TV jest chwilowo niedostępny."); } }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  useEffect(() => {
    active.current = true;
    void read();
    const onFocus = () => { void read(); };
    window.addEventListener("focus", onFocus);
    return () => { active.current = false; window.removeEventListener("focus", onFocus); };
  }, [revision]);
  const change = async (operation: () => Promise<TvNavigationStatus>) => {
    if (inFlight.current || !status) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try { const next = await operation(); if (active.current) setStatus(next); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Nie zmieniono trybu nawigacji TV."); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  const available = status !== null && status.windows !== false && status.activeStrategy !== "unavailable";
  return <section aria-label="Tryb nawigacji TV" data-remote-admin="">
    <h4>TV Navigation Engine</h4>
    <p role="status">Tryb: {status ? modes[status.mode] : "stan nieznany"} · aktywna strategia: {status?.activeStrategy ?? "stan nieznany"}.</p>
    <label>Strategia nawigacji <select value={status?.mode ?? "automatic"} disabled={busy || !available} onChange={event => void change(() => setTvNavigationMode(event.target.value as TvNavigationMode))}>
      {Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <button type="button" disabled={busy || !available} onClick={() => { const order = Object.keys(modes) as TvNavigationMode[]; const next = order[(order.indexOf(status?.mode ?? "automatic") + 1) % order.length]; void change(() => setTvNavigationMode(next)); }}>Zmień tryb nawigacji TV</button>
    <label>Sesja odtwarzacza <select value={selectedSession} disabled={busy || !available || Boolean(status?.mediaControlsArmed)} onChange={event => setSelectedSession(event.target.value)}>
      <option value="">Wybierz własną sesję odtwarzacza</option>
      {sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.name} · {session.state}</option>)}
    </select></label>
    <div role="group" aria-label="Sesje odtwarzacza">{sessions.map(session => <button type="button" key={session.sessionId} disabled={busy || Boolean(status?.mediaControlsArmed)} aria-pressed={selectedSession === session.sessionId} onClick={() => setSelectedSession(session.sessionId)}>Odtwarzacz: {session.name}</button>)}</div>
    <button type="button" disabled={busy || !available || (!status?.mediaControlsArmed && !selectedSession)} aria-pressed={status?.mediaControlsArmed ?? false} onClick={() => void change(() => setTvNavigationMediaControls(!status?.mediaControlsArmed, selectedSession || undefined))}>
      {status?.mediaControlsArmed ? "Zablokuj skróty odtwarzania TV" : "Uzbrój skróty odtwarzania TV"}
    </button>
    <button type="button" disabled={busy} onClick={() => void read()}>Odśwież tryb nawigacji TV</button>
    <p>Skróty odtwarzania uzbrajaj na ekranie odtwarzacza. Square: odtwórz/pauza; działanie strony pozostaje niepotwierdzone, dopóki nie widać efektu. Gest Home działa niezależnie.</p>
    {status?.mediaControlsArmed && <p>Uzbrojona sesja: {status.mediaControlSession?.label ?? "wybrana wcześniej sesja"}. Zablokuj skróty przed wybraniem innej sesji.</p>}
    <p>Tryb automatyczny sprawdza kierunki przez Windows UI Automation. Jeśli strona nie udostępnia użytecznych kontrolek, router może przełączyć się na wskaźnik i zatrzymać bieżącą akcję. Sprawdź ekran, przesuń wskaźnik prawym analogiem i dopiero wtedy zatwierdź. Triangle zmienia tryb; klawiaturę możesz wybrać ręcznie. Home działa niezależnie.</p>
    {status?.lastResult && <p role="status">Ostatni wynik nawigacji: {status.lastResult}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
