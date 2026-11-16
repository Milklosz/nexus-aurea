import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeManagedSession, emptyManagedSessions, getManagedSessions, listenForManagedSessionUpdate,
  managedSessionLabels, resumeManagedSession, type ManagedSession, type ManagedSessionsSnapshot,
} from "../services/veloraSessionManager";
import "./SessionsPanel.css";
import { recordSmartHomeLaunch } from "../services/smartHome";

/** Application-level sessions only: never promises a video timestamp or private account metadata. */
export function SessionsPanel() {
  const [snapshot, setSnapshot] = useState<ManagedSessionsSnapshot>(emptyManagedSessions);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState(true);
  const alive = useRef(false);
  const busy = useRef(false);
  const readingRef = useRef(false);
  const dirty = useRef(false);

  const refresh = useCallback(async () => {
    // Coalesce watcher bursts; retain one follow-up read if an event arrived during IPC.
    dirty.current = true;
    if (readingRef.current) return;
    readingRef.current = true;
    if (alive.current) setReading(true);
    try {
      do {
        dirty.current = false;
        const next = await getManagedSessions();
        if (!alive.current) return;
        setSnapshot(next);
        setConfirmClose(current => next.sessions.some(session => session.sessionId === current && session.canClose) ? current : null);
      } while (dirty.current && alive.current);
    } catch {
      if (alive.current) setError("Nie udało się odczytać sesji. Odśwież przed kolejną akcją.");
    } finally {
      readingRef.current = false;
      if (alive.current) setReading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let stop: (() => void) | undefined;
    void refresh();
    void listenForManagedSessionUpdate(() => { void refresh(); }).then(unlisten => {
      if (!disposed) stop = unlisten;
      else unlisten();
    }).catch(() => {});
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { disposed = true; alive.current = false; stop?.(); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  const act = async (session: ManagedSession, action: "resume" | "close") => {
    if (busy.current) return;
    busy.current = true;
    setPending(session.sessionId);
    setMessage("");
    setError("");
    try {
      const result = action === "resume"
        ? await resumeManagedSession(session.sessionId)
        : await closeManagedSession(session.sessionId, confirmClose === session.sessionId);
      if (!alive.current) return;
      if (!result.accepted || (action === "resume" && !result.activated)) {
        setError("Windows nie potwierdził przywrócenia okna. Sesja pozostaje śledzona.");
      } else {
        setMessage(result.message);
        if (action === "resume" && result.activated) recordSmartHomeLaunch(session.appId);
      }
      setConfirmClose(null);
      await refresh();
    } catch {
      if (alive.current) setError(action === "resume"
        ? "Nie przywrócono okna. Windows mógł odmówić fokusu lub sesja została zakończona."
        : "Nie zamknięto okna. Nie udało się potwierdzić własności tej sesji.");
      await refresh();
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  };

  return <section className="velora-sessions" aria-label="Sesje aplikacji" data-remote-allow="">
    <header><div><h3>Wróć do aplikacji</h3><p>Otwarte okna zarządzane przez VELORA</p></div>
      <button type="button" disabled={reading || pending !== null} aria-busy={reading} onClick={() => { setError(""); void refresh(); }}>Odśwież sesje</button>
    </header>
    {!snapshot.supported && !reading && <p>Sesje aplikacji są dostępne w natywnej wersji Windows.</p>}
    {snapshot.supported && snapshot.sessions.length === 0 && !reading && <p>Brak sesji. Otwórz usługę z ekranu głównego.</p>}
    {snapshot.sessions.map(session => <article className="velora-session" key={session.sessionId}>
      <div><strong>{session.name}</strong><span>{managedSessionLabels[session.state]}</span></div>
      <div className="velora-session-actions">
        <button type="button" disabled={!session.canResume || pending !== null || reading} onClick={() => void act(session, "resume")}
          aria-label={`Wznów ${session.name}`} aria-busy={pending === session.sessionId}>Wznów</button>
        {session.canClose && <button type="button" disabled={pending !== null || reading}
          onClick={() => setConfirmClose(session.sessionId)} aria-label={`Zamknij ${session.name}`}>Zamknij okno</button>}
      </div>
      {confirmClose === session.sessionId && <div className="velora-session-confirm" role="group" aria-label={`Potwierdzenie zamknięcia ${session.name}`}>
        <p>Zamknąć okno {session.name}? Odtwarzanie może zostać przerwane.</p>
        <button type="button" disabled={pending !== null} onClick={() => void act(session, "close")}>Potwierdź zamknięcie {session.name}</button>
        <button type="button" disabled={pending !== null} onClick={() => setConfirmClose(null)}>Anuluj zamknięcie</button>
      </div>}
    </article>)}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status" aria-live="polite">{message}</p>}
  </section>;
}
