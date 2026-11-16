import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeManagedSession, emptyManagedSessions, getManagedSessions, listenForManagedSessionUpdate,
  managedSessionLabels, resumeManagedSession, type ManagedSession, type ManagedSessionsSnapshot,
} from "../services/veloraSessionManager";
import "./SessionsPanel.css";
import { recordSmartHomeLaunch } from "../services/smartHome";

const CLOSE_CONFIRMATION_DELAY_MS = 6500;
type CloseObservation = { sessionId: string; name: string; generation: number; deadlineReached: boolean; timer: number | null };

/** Application-level sessions only: never promises a video timestamp or private account metadata. */
export function SessionsPanel() {
  const [snapshot, setSnapshot] = useState<ManagedSessionsSnapshot>(emptyManagedSessions);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState(true);
  const [showIdleApps, setShowIdleApps] = useState(false);
  const [unconfirmedClose, setUnconfirmedClose] = useState<{ sessionId: string; name: string } | null>(null);
  const alive = useRef(false);
  const busy = useRef(false);
  const readingRef = useRef(false);
  const dirty = useRef(false);
  const actionGeneration = useRef(0);
  const closeObservation = useRef<CloseObservation | null>(null);

  const cancelCloseObservation = useCallback(() => {
    const observation = closeObservation.current;
    closeObservation.current = null;
    if (observation?.timer !== null && observation?.timer !== undefined) window.clearTimeout(observation.timer);
  }, []);

  const refresh = useCallback(async () => {
    if (!alive.current) return;
    // Coalesce watcher bursts; retain one follow-up read if an event arrived during IPC.
    dirty.current = true;
    if (readingRef.current) return;
    readingRef.current = true;
    let readGeneration = actionGeneration.current;
    if (alive.current) setReading(true);
    try {
      do {
        dirty.current = false;
        readGeneration = actionGeneration.current;
        const expiredObservation = closeObservation.current?.deadlineReached === true;
        const next = await getManagedSessions();
        if (!alive.current) return;
        if (readGeneration !== actionGeneration.current) { dirty.current = true; continue; }
        setSnapshot(next);
        setConfirmClose(current => next.sessions.some(session => session.sessionId === current && session.canClose) ? current : null);
        const closing = closeObservation.current;
        if (closing && closing.generation === readGeneration) {
          const current = next.sessions.find(session => session.sessionId === closing.sessionId);
          if (next.supported && (!current || current.state === "exited" || current.state === "notRunning")) {
            cancelCloseObservation();
            setUnconfirmedClose(null);
            setError("");
            setMessage(`Potwierdzono zakończenie sesji ${closing.name}.`);
          } else if (expiredObservation) {
            setMessage("");
            setUnconfirmedClose({ sessionId: closing.sessionId, name: closing.name });
          }
        }
      } while (dirty.current && alive.current);
    } catch {
      if (alive.current && readGeneration === actionGeneration.current) {
        setError("Nie udało się odczytać sesji. Odśwież przed kolejną akcją.");
        const closing = closeObservation.current;
        if (closing?.deadlineReached) {
          setMessage("");
          setUnconfirmedClose({ sessionId: closing.sessionId, name: closing.name });
        }
      } else if (alive.current) dirty.current = true;
    } finally {
      readingRef.current = false;
      if (alive.current) setReading(false);
      if (dirty.current && alive.current) void refresh();
    }
  }, [cancelCloseObservation]);

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
    return () => {
      disposed = true; alive.current = false; actionGeneration.current += 1;
      cancelCloseObservation(); stop?.(); window.removeEventListener("focus", onFocus);
    };
  }, [refresh, cancelCloseObservation]);

  const act = async (session: ManagedSession, action: "resume" | "close") => {
    if (busy.current) return;
    busy.current = true;
    const generation = ++actionGeneration.current;
    cancelCloseObservation();
    setUnconfirmedClose(null);
    setPending(session.sessionId);
    setMessage("");
    setError("");
    try {
      const result = action === "resume"
        ? await resumeManagedSession(session.sessionId)
        : await closeManagedSession(session.sessionId, confirmClose === session.sessionId);
      if (!alive.current || generation !== actionGeneration.current) return;
      if (!result.accepted || (action === "resume" && !result.activated)) {
        setError(action === "resume"
          ? "Windows nie potwierdził przywrócenia okna. Sesja pozostaje śledzona."
          : "Windows nie potwierdził przyjęcia prośby o zamknięcie. Sesja pozostaje śledzona.");
      } else {
        setMessage(result.message);
        if (action === "resume" && result.activated) recordSmartHomeLaunch(session.appId);
        if (action === "close") {
          const observation: CloseObservation = { sessionId: session.sessionId, name: session.name, generation, deadlineReached: false, timer: null };
          closeObservation.current = observation;
          observation.timer = window.setTimeout(() => {
            if (!alive.current || closeObservation.current !== observation || actionGeneration.current !== generation) return;
            observation.timer = null;
            observation.deadlineReached = true;
            setMessage("");
            setUnconfirmedClose({ sessionId: observation.sessionId, name: observation.name });
            void refresh();
          }, CLOSE_CONFIRMATION_DELAY_MS);
        }
      }
      setConfirmClose(null);
      await refresh();
    } catch {
      if (!alive.current || generation !== actionGeneration.current) return;
      setError(action === "resume"
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
    {snapshot.supported && (snapshot.applications ?? []).some(app => app.state === "notRunning") && <div>
      <button type="button" aria-expanded={showIdleApps} aria-controls="velora-idle-applications"
        onClick={() => setShowIdleApps(current => !current)}>Pozostałe aplikacje</button>
      {showIdleApps && <div id="velora-idle-applications">
        <p>Uruchom aplikację z ekranu głównego. Ten stan dotyczy wyłącznie sesji zarządzanych przez VELORA.</p>
        <ul>{snapshot.applications.filter(app => app.state === "notRunning").map(app =>
          <li key={app.appId}>{app.name} — {managedSessionLabels.notRunning}</li>)}</ul>
      </div>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {unconfirmedClose && <div role="alert">
      <p>Nie potwierdzono zamknięcia okna {unconfirmedClose.name}. Aplikacja może nadal działać lub oczekiwać na reakcję w swoim oknie. Sprawdź okno przed kolejną próbą.</p>
      {snapshot.sessions.some(session => session.sessionId === unconfirmedClose.sessionId && session.canResume) &&
        <button type="button" disabled={pending !== null || reading} onClick={() => {
          const session = snapshot.sessions.find(session => session.sessionId === unconfirmedClose.sessionId);
          if (session) void act(session, "resume");
        }}>Sprawdź okno {unconfirmedClose.name}</button>}
    </div>}
    {message && <p role="status" aria-live="polite">{message}</p>}
  </section>;
}
