import { useEffect, useRef, useState } from "react";
import { streamingServices, type WebStreamingService } from "../data/streamingServices";
import { openStreamingService } from "../services/openStreamingService";
import { getManagedSessions, type ManagedSession } from "../services/veloraSessionManager";
import {
  cancelTvNavigationSimulation, captureTvNavigationTarget, configureTvNavigation, getTvNavigationStatus, navigationEvidenceJson, simulateTvNavigationAction,
  setTvNavigationMediaControls,
  type TvNavigationAction, type TvNavigationMode, type TvNavigationReceipt, type TvNavigationStatus,
} from "../services/tvNavigation";
import "./ControllerSimulator.css";

const services = streamingServices.filter((service): service is WebStreamingService => service.kind === "web");
const controls: Array<{ label: string; action: TvNavigationAction; deltaX?: number; deltaY?: number }> = [
  { label: "D-pad ↑", action: "up" }, { label: "D-pad ↓", action: "down" },
  { label: "D-pad ←", action: "left" }, { label: "D-pad →", action: "right" },
  { label: "X · Potwierdź", action: "confirm" }, { label: "Circle · Wstecz", action: "back" },
  { label: "Square · Odtwórz / pauza", action: "playPause" }, { label: "Triangle · Wskaźnik", action: "pointerToggle" },
  { label: "L1 · test poprzedniej sekcji", action: "previousSection" }, { label: "R1 · test następnej sekcji", action: "nextSection" },
  { label: "Options · Control Center", action: "openControlCenter" }, { label: "Home · VELORA", action: "home" },
  { label: "Przewiń w górę", action: "scrollUp" }, { label: "Przewiń w dół", action: "scrollDown" },
  { label: "Przewiń odtwarzanie wstecz", action: "seekBackward" }, { label: "Przewiń odtwarzanie naprzód", action: "seekForward" },
  { label: "Lewy analog ↑", action: "up" }, { label: "Lewy analog ↓", action: "down" },
  { label: "Lewy analog ←", action: "left" }, { label: "Lewy analog →", action: "right" },
  { label: "Prawy analog ↑", action: "pointerMove", deltaX: 0, deltaY: -32 },
  { label: "Prawy analog ↓", action: "pointerMove", deltaX: 0, deltaY: 32 },
  { label: "Prawy analog ←", action: "pointerMove", deltaX: -32, deltaY: 0 },
  { label: "Prawy analog →", action: "pointerMove", deltaX: 32, deltaY: 0 },
  { label: "Wskaźnik · Kliknij", action: "click" },
  { label: "Napisy", action: "captions" },
  { label: "Pełny ekran", action: "fullscreen" },
  { label: "Wycisz odtwarzacz", action: "playerMute" },
  { label: "Wycisz Windows", action: "mute" },
  { label: "Głośniej w Windows", action: "volumeUp" },
  { label: "Ciszej w Windows", action: "volumeDown" },
];
const mediaActions = new Set<TvNavigationAction>(["playPause", "seekBackward", "seekForward", "captions", "fullscreen", "playerMute"]);
// No Confirm, click, purchases or account interaction in automatic scenarios.
const scenario: TvNavigationAction[] = ["down", "right", "back", "home"];
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Nie udało się wykonać polecenia nawigacji.";

export function ControllerSimulator() {
  const [status, setStatus] = useState<TvNavigationStatus | null>(null);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [targetSession, setTargetSession] = useState("");
  const [serviceId, setServiceId] = useState("youtube");
  const [mode, setMode] = useState<TvNavigationMode>("automatic");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [receipts, setReceipts] = useState<TvNavigationReceipt[]>([]);
  const [report, setReport] = useState("");
  const lease = useRef(0);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const activeRun = useRef(false);
  const cancellation = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const pendingDelay = useRef<{ timer: number; resolve: (value: boolean) => void } | null>(null);

  const cancelDelay = () => {
    if (pendingDelay.current) {
      window.clearTimeout(pendingDelay.current.timer);
      pendingDelay.current.resolve(false);
      pendingDelay.current = null;
    }
  };
  const delay = (ms: number) => new Promise<boolean>(resolve => {
    const timer = window.setTimeout(() => { pendingDelay.current = null; resolve(true); }, ms);
    pendingDelay.current = { timer, resolve };
  });
  const refresh = async () => {
    const next = await getTvNavigationStatus();
    if (!mounted.current) return;
    setStatus(next);
    setMode(next.mode);
    sequence.current = Math.max(sequence.current, next.lastSimulatorSequence ?? 0);
    if (next.simulatorAvailable) {
      const snapshot = await getManagedSessions();
      if (!mounted.current) return;
      setSessions(snapshot.sessions.filter(session => session.applicationType === "cinema" && session.canResume));
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) setError("Nie udało się odczytać dostępności symulatora."); });
    return () => {
      mounted.current = false; lease.current++; cancelDelay();
      if (activeRun.current) void cancelTvNavigationSimulation().catch(() => {});
    };
    // Status is read on entry and after explicit operations, without another polling loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configure = async (enabled: boolean, nextMode = mode) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await configureTvNavigation(enabled, nextMode);
      sequence.current = Math.max(sequence.current, next.lastSimulatorSequence ?? 0);
      if (mounted.current) { setStatus(next); setMode(next.mode); }
      lease.current++;
      cancelDelay();
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };

  const run = async (steps: Array<{ action: TvNavigationAction; deltaX?: number; deltaY?: number }>) => {
    if (busyRef.current || !status?.simulatorAvailable || !status.enabled) return;
    if (steps.some(step => step.action !== "home" && step.action !== "openControlCenter") && !targetSession) {
      setError("Wybierz własną sesję streamingową. Najpierw otwórz usługę i odśwież sesje.");
      return;
    }
    busyRef.current = true;
    activeRun.current = true;
    setBusy(true);
    setRunning(true);
    setError("");
    const currentLease = ++lease.current;
    let dispatchGeneration = status.generation;
    try {
      for (const step of steps.slice(0, 16)) {
        setNotice(`Za 0,6 s: ${step.action}. Wybrana sesja zostanie przywrócona przed poleceniem.`);
        if (!await delay(600) || lease.current !== currentLease || !mounted.current) break;
        const receipt = await simulateTvNavigationAction({
          action: step.action, deltaX: step.deltaX, deltaY: step.deltaY,
          sequence: ++sequence.current, generation: dispatchGeneration, targetSession: targetSession || null,
        });
        if (!mounted.current) break;
        setReceipts(previous => [...previous.slice(-63), { ...receipt, action: step.action, serviceId: status.targetSession?.serviceId }]);
        if (lease.current !== currentLease) break;
        dispatchGeneration = receipt.generation;
        setStatus(previous => previous ? {
          ...previous, mode: receipt.mode, activeStrategy: receipt.activeStrategy, generation: receipt.generation,
          lastResult: receipt.lastResult, lastSimulatorSequence: Math.max(previous.lastSimulatorSequence ?? 0, receipt.sequence),
        } : previous);
        setMode(receipt.mode);
        setNotice(`${step.action}: ${receipt.accepted ? "przyjęte" : "odrzucone"} · efekt: ${receipt.effect}`);
        if (!receipt.accepted) {
          setError(receipt.lastResult ?? "Router odrzucił polecenie. Sekwencja została zatrzymana.");
          break;
        }
      }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally {
      if (cancellation.current) await cancellation.current;
      busyRef.current = false; activeRun.current = false;
      if (mounted.current) { setBusy(false); setRunning(false); }
    }
  };
  const cancel = () => {
    if (cancellation.current) return;
    lease.current++;
    cancelDelay();
    setRunning(false);
    setNotice("Anulowano niewysłane akcje. Wysłane polecenie mogło już zostać przyjęte przez Windows.");
    const pending = cancelTvNavigationSimulation().then(next => {
      sequence.current = Math.max(sequence.current, next.lastSimulatorSequence ?? 0);
      if (mounted.current) { setStatus(next); setMode(next.mode); }
    }).catch(() => { if (mounted.current) setError("Nie potwierdzono odwołania natywnego polecenia. Dalsze kroki sekwencji zatrzymano."); });
    cancellation.current = pending;
    void pending.finally(() => { cancellation.current = null; });
  };
  const capture = async (selected: string) => {
    if (busyRef.current) return;
    setTargetSession("");
    if (!selected) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const next = await captureTvNavigationTarget(selected);
      sequence.current = Math.max(sequence.current, next.lastSimulatorSequence ?? 0);
      if (mounted.current) { setStatus(next); setMode(next.mode); setTargetSession(selected); }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const armMedia = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const next = await setTvNavigationMediaControls(!status?.mediaControlsArmed, targetSession || undefined);
      sequence.current = Math.max(sequence.current, next.lastSimulatorSequence ?? 0);
      if (mounted.current) setStatus(next);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const launch = async () => {
    if (busyRef.current) return;
    const service = services.find(candidate => candidate.id === serviceId);
    if (!service) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await openStreamingService(service); setNotice("Otwarto usługę. Wróć do diagnostyki i odśwież sesje."); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };

  if (!status?.simulatorAvailable) return error ? <p role="status">{error}</p> : null;
  const last = receipts[receipts.length - 1];
  return <section className="tv-simulator" aria-label="Controller Simulator" data-remote-admin="">
    <h3>Controller Simulator · TV Navigation Engine</h3>
    <p>Tryb diagnostyczny Windows. Każda akcja przechodzi przez natywny router kontrolera. Test fizycznego DS4 pozostaje niewykonany.</p>
    <button type="button" disabled={busy} onClick={() => void configure(!status.enabled)}>
      {status.enabled ? "Wyłącz symulator" : "Włącz symulator diagnostyczny"}
    </button>
    <p role="status">Symulator: {status.enabled ? "włączony" : "wyłączony"} · strategia: {status.activeStrategy} · generacja: {status.generation}</p>
    {status.enabled && <>
      <div className="tv-simulator-setup">
        <label>Usługa <select value={serviceId} disabled={busy} onChange={event => setServiceId(event.target.value)}>
          {services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}
        </select></label>
        <button type="button" disabled={busy} onClick={() => void launch()}>Otwórz usługę testową</button>
        <label>Sesja docelowa <select value={targetSession} disabled={busy} onChange={event => void capture(event.target.value)}>
          <option value="">Wybierz własną sesję</option>
          {sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.name} · {session.state}</option>)}
        </select></label>
        <button type="button" disabled={busy} onClick={() => void refresh().catch(cause => setError(errorMessage(cause)))}>Odśwież sesje symulatora</button>
        <label>Tryb nawigacji <select value={mode} disabled={busy} onChange={event => void configure(true, event.target.value as TvNavigationMode)}>
          <option value="automatic">Automatyczny</option><option value="keyboard">Klawiatura</option>
          <option value="spatial">Przestrzenny · UI Automation</option><option value="pointer">Wskaźnik</option>
        </select></label>
      </div>
      <div role="group" aria-label="Przyciski wyboru sesji">{sessions.map(session => <button type="button" key={session.sessionId} disabled={busy} aria-pressed={targetSession === session.sessionId} onClick={() => void capture(session.sessionId)}>Cel: {session.name}</button>)}</div>
      <div role="group" aria-label="Przyciski trybu nawigacji">{(["automatic", "keyboard", "spatial", "pointer"] as const).map(value => <button type="button" key={value} disabled={busy} aria-pressed={mode === value} onClick={() => void configure(true, value)}>Tryb: {value}</button>)}</div>
      <button type="button" disabled={busy || (!status.mediaControlsArmed && !targetSession)} onClick={() => void armMedia()}>
        {status.mediaControlsArmed ? "Zablokuj skróty odtwarzania" : "Uzbrój skróty odtwarzania"}
      </button>
      <p>Skróty odtwarzania wymagają świadomego uzbrojenia na ekranie odtwarzacza. Na ekranie katalogu mogą mieć inne znaczenie.</p>
      <div className="tv-simulator-buttons">
        {controls.map(control => <button type="button" key={control.label} disabled={busy || (mediaActions.has(control.action) && !status.mediaControlsArmed)} onClick={() => void run([control])}>{control.label}</button>)}
      </div>
      <p>Analog przesuwa wskaźnik jednym ograniczonym krokiem. D-pad używa wybranej strategii. X może uruchomić wskazaną kontrolkę: sprawdź ekran przed użyciem.</p>
      <p>Fizyczne L1/R1 pozostają zarezerwowane dla dotychczasowego gestu Home. Przyciski testu sekcji przechodzą przez Tab / Shift+Tab; touchpad pada przechodzi do następnego fokusu.</p>
      <button type="button" disabled={busy || !targetSession} onClick={() => void run(scenario.map(action => ({ action })))}>Scenariusz: ↓ → Wstecz Home</button>
      <button type="button" disabled={!running} onClick={cancel}>Anuluj sekwencję</button>
      <p>Scenariusz nie zatwierdza treści ani zakupu. Używaj go wyłącznie na ekranie testowym; nie w formularzu konta.</p>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {last && <dl className="tv-simulator-receipt">
      <dt>Akcja / źródło</dt><dd>{last.action} / simulator</dd>
      <dt>Cel</dt><dd>{last.targetSession ? "wybrana sesja zarządzana" : "brak / Home"}</dd>
      <dt>Strategia</dt><dd>{last.activeStrategy}</dd><dt>Własność okna</dt><dd>{last.ownership ?? "brak odczytu"}</dd>
      <dt>Wysłanie</dt><dd>{last.accepted ? "przyjęte" : "odrzucone"}</dd><dt>Efekt zaobserwowany</dt><dd>{last.effect}</dd>
      <dt>Czas wysłania</dt><dd>{last.dispatchElapsedMs ?? "nie zmierzono"} ms</dd>
      <dt>UI Automation</dt><dd>{last.spatialQueryMs === null || last.spatialQueryMs === undefined ? "brak zapytania" : `${last.spatialQueryMs} ms · ${last.spatialCandidateCount ?? 0} kandydatów`}</dd>
    </dl>}
    <button type="button" disabled={receipts.length === 0} onClick={() => setReport(navigationEvidenceJson(receipts))}>Eksportuj zgodność TV · JSON</button>
    {report && <textarea aria-label="Bezpieczny raport zgodności TV JSON" readOnly rows={10} value={report} />}
    <p>Eksport zawiera do 64 wyników poleceń; pomija identyfikatory sesji i szczegóły błędów. Przyjęcie polecenia nie potwierdza pauzy ani odtwarzania.</p>
  </section>;
}
