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
import { MAX_SIMULATION_STEPS, needsSimulationReview, parseSimulationSequence, readControllerSimulationMemory, rememberControllerSimulationHomeBoundary, rememberControllerSimulationReceipts, rememberControllerSimulationRecording, simulationAnalog, simulationHold, simulationSequenceJson, simulationService, type SimulationHomeBoundary, type SimulationStep } from "../services/controllerSimulation";

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
  const [receipts, setReceipts] = useState<TvNavigationReceipt[]>(() => readControllerSimulationMemory().receipts);
  const [report, setReport] = useState("");
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<SimulationStep[]>(() => readControllerSimulationMemory().recorded);
  const [homeBoundary, setHomeBoundary] = useState<SimulationHomeBoundary | null>(() => readControllerSimulationMemory().homeBoundary);
  const [sequenceReport, setSequenceReport] = useState("");
  const [sequenceImport, setSequenceImport] = useState("");
  const [checkpoint, setCheckpoint] = useState<string | null>(null);
  const [repeatAction, setRepeatAction] = useState<TvNavigationAction>("down");
  const [holdMs, setHoldMs] = useState(1000);
  const [intervalMs, setIntervalMs] = useState(200);
  const [analogX, setAnalogX] = useState(0.5);
  const [analogY, setAnalogY] = useState(0);
  const [precision, setPrecision] = useState(false);
  const lease = useRef(0);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const activeRun = useRef(false);
  const cancelledLease = useRef(-1);
  const cancellation = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const pendingDelay = useRef<{ timer: number; resolve: (value: boolean) => void } | null>(null);
  const pendingReview = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => { rememberControllerSimulationRecording(recorded); }, [recorded]);
  useEffect(() => { rememberControllerSimulationReceipts(receipts); }, [receipts]);
  const retainHomeBoundary = (boundary: SimulationHomeBoundary | null) => {
    rememberControllerSimulationHomeBoundary(boundary);
    if (mounted.current) setHomeBoundary(boundary);
  };

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
    const memory = readControllerSimulationMemory();
    setReceipts(memory.receipts);
    if (memory.homeBoundary?.accepted === true && next.simulatorHomeReady === true) {
      let foundHome = false;
      const updated = [...memory.receipts].reverse().map(receipt => {
        if (!foundHome && receipt.action === "home") { foundHome = true; return { ...receipt, homeTransitionReady: true }; }
        return receipt;
      }).reverse();
      rememberControllerSimulationReceipts(updated);
      setReceipts(updated);
    }
    setHomeBoundary(memory.homeBoundary);
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
      pendingReview.current?.(false); pendingReview.current = null;
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

  const run = async (steps: SimulationStep[], replay = false) => {
    if (busyRef.current || !status?.simulatorAvailable || !status.enabled) return;
    if (steps.some(step => step.action !== "home" && step.action !== "openControlCenter" && !(replay && step.serviceId)) && !targetSession) {
      setError("Wybierz własną sesję streamingową. Najpierw otwórz usługę i odśwież sesje.");
      return;
    }
    busyRef.current = true;
    activeRun.current = true;
    setBusy(true);
    setRunning(true);
    setError("");
    retainHomeBoundary(null);
    const currentLease = ++lease.current;
    let dispatchGeneration = status.generation;
    let selectedSession = targetSession;
    try {
      for (const [index, step] of steps.slice(0, MAX_SIMULATION_STEPS).entries()) {
        if (replay && step.serviceId && step.action !== "home" && step.action !== "openControlCenter") {
          const matches = sessions.filter(session => simulationService(session.appId) === step.serviceId);
          if (matches.length !== 1) throw new Error(`Sekwencja zatrzymana: wybierz dokładnie jedną dostępną sesję ${step.serviceId} i odśwież sesje.`);
          if (selectedSession !== matches[0].sessionId) {
            selectedSession = matches[0].sessionId;
            const next = await captureTvNavigationTarget(selectedSession);
            if (!mounted.current || lease.current !== currentLease) break;
            dispatchGeneration = next.generation;
            sequence.current = Math.max(sequence.current, next.lastSimulatorSequence ?? 0);
            setStatus(next); setMode(next.mode); setTargetSession(selectedSession);
          }
        }
        if (replay && needsSimulationReview(step.action)) {
          setCheckpoint(`Krok ${index + 1}: ${step.action}. Sprawdź ekran usługi. Nie zatwierdzaj zakupu, wynajmu ani zmiany konta.`);
          const approved = await new Promise<boolean>(resolve => { pendingReview.current = resolve; });
          pendingReview.current = null;
          if (mounted.current) setCheckpoint(null);
          if (!approved || lease.current !== currentLease || !mounted.current) break;
        }
        const waitMs = Math.max(100, Math.min(1000, step.delayMs ?? 600));
        setNotice(`Krok ${index + 1}/${Math.min(steps.length, MAX_SIMULATION_STEPS)} · za ${waitMs} ms: ${step.action}. Wybrana sesja zostanie przywrócona przed poleceniem.`);
        if (!await delay(waitMs) || lease.current !== currentLease || !mounted.current) break;
        if (step.action === "home") {
          // Real Home closes diagnostics. Retain only a reviewed continuation; no hidden runner.
          retainHomeBoundary({ remaining: steps.slice(index + 1, MAX_SIMULATION_STEPS), accepted: null });
          activeRun.current = false;
        }
        const receipt = await simulateTvNavigationAction({
          action: step.action, deltaX: step.deltaX, deltaY: step.deltaY,
          sequence: ++sequence.current, generation: dispatchGeneration, targetSession: selectedSession || null,
        });
        const selectedService = simulationService(sessions.find(session => session.sessionId === selectedSession)?.appId) ?? status.targetSession?.serviceId;
        const nextReceipts = [...readControllerSimulationMemory().receipts.slice(-63), { ...receipt, action: step.action, serviceId: selectedService }];
        rememberControllerSimulationReceipts(nextReceipts);
        if (mounted.current) setReceipts(nextReceipts);
        if (recording && !replay && receipt.accepted) {
          const previous = readControllerSimulationMemory().recorded;
          const nextRecorded = previous.length >= MAX_SIMULATION_STEPS ? previous : [...previous, { ...step, delayMs: waitMs, serviceId: simulationService(selectedService) }];
          rememberControllerSimulationRecording(nextRecorded);
          if (mounted.current) setRecorded(nextRecorded);
        }
        if (step.action === "home") retainHomeBoundary(receipt.accepted && cancelledLease.current !== currentLease ? { remaining: steps.slice(index + 1, MAX_SIMULATION_STEPS), accepted: true } : null);
        if (!mounted.current) break;
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
        if (step.action === "home") {
          // Home is an explicit sequence boundary even if an isolated test keeps this component mounted.
          selectedSession = "";
          setTargetSession("");
          setStatus(previous => previous ? { ...previous, targetSession: null, mediaControlsArmed: false, mediaControlSession: null } : previous);
          setStatus(previous => previous ? { ...previous, simulatorHomeReady: false } : previous);
          setNotice("Sekwencja zatrzymana na Home. Otwórz diagnostykę ponownie i odśwież status; pozostałe kroki wymagają jawnego wznowienia po potwierdzeniu gotowości Home.");
          break;
        }
      }
    } catch (cause) { retainHomeBoundary(null); if (mounted.current) setError(errorMessage(cause)); }
    finally {
      if (cancellation.current) await cancellation.current;
      busyRef.current = false; activeRun.current = false;
      if (mounted.current) { setBusy(false); setRunning(false); setCheckpoint(null); }
    }
  };
  const cancel = () => {
    if (cancellation.current) return;
    cancelledLease.current = lease.current;
    lease.current++;
    cancelDelay();
    pendingReview.current?.(false); pendingReview.current = null; setCheckpoint(null);
    setRunning(false);
    retainHomeBoundary(null);
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
    <p>Tryb diagnostyczny Windows. Każda akcja przechodzi przez natywny router kontrolera. Test fizycznego DS4 pozostaje niewykonany; symulacja Home nie dowodzi dostarczenia PS przez Bluetooth.</p>
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
      <fieldset className="tv-simulator-sequences" disabled={busy}>
        <legend>Powtarzanie i przytrzymanie · akcje semantyczne</legend>
        <label>Powtarzana akcja <select value={repeatAction} onChange={event => setRepeatAction(event.target.value as TvNavigationAction)}>
          {(["up", "down", "left", "right", "scrollUp", "scrollDown"] as const).map(action => <option key={action} value={action}>{action}</option>)}
        </select></label>
        <label>Czas przytrzymania (ms) <input type="number" min={100} max={5000} step={100} value={holdMs} onChange={event => setHoldMs(Number(event.target.value))} /></label>
        <label>Odstęp powtórzeń (ms) <input type="number" min={100} max={1000} step={50} value={intervalMs} onChange={event => setIntervalMs(Number(event.target.value))} /></label>
        <button type="button" disabled={!targetSession} onClick={() => void run(simulationHold({ action: repeatAction }, holdMs, intervalMs))}>Symuluj przytrzymanie</button>
        <p>Powtórzenia są ograniczone do 5 s, po jednym wyniku natywnym naraz. Nie symulują surowego raportu HID ani gestu PS.</p>
      </fieldset>
      <fieldset className="tv-simulator-sequences" disabled={busy}>
        <legend>Analog · ograniczone impulsy wskaźnika</legend>
        <label>Analog X <input type="range" min={-1} max={1} step={0.05} value={analogX} onChange={event => setAnalogX(Number(event.target.value))} />{analogX.toFixed(2)}</label>
        <label>Analog Y <input type="range" min={-1} max={1} step={0.05} value={analogY} onChange={event => setAnalogY(Number(event.target.value))} />{analogY.toFixed(2)}</label>
        <label><input type="checkbox" checked={precision} onChange={event => setPrecision(event.target.checked)} />Precyzja · ¼ kroku</label>
        <button type="button" disabled={!targetSession || (Math.abs(analogX) <= 0.18 && Math.abs(analogY) <= 0.18)} onClick={() => void run(simulationHold(simulationAnalog(analogX, analogY, precision), holdMs, intervalMs))}>Symuluj analog</button>
        <p>Martwa strefa 0,18; maksymalnie 32 jednostki na impuls. Natywny router sprawdza tryb i granice własnego okna.</p>
      </fieldset>
      <p>Fizyczne L1/R1 pozostają zarezerwowane dla dotychczasowego gestu Home. Przyciski testu sekcji przechodzą przez Tab / Shift+Tab; touchpad pada przechodzi do następnego fokusu.</p>
      <button type="button" disabled={busy || !targetSession} onClick={() => void run(scenario.map(action => ({ action })))}>Scenariusz: ↓ → Wstecz Home</button>
      <div className="tv-simulator-sequences" role="group" aria-label="Nagrywanie sekwencji">
        <button type="button" disabled={busy} aria-pressed={recording} onClick={() => setRecording(value => !value)}>{recording ? "Zatrzymaj nagrywanie" : "Nagrywaj akcje symulatora"}</button>
        <button type="button" disabled={busy || recorded.length === 0} onClick={() => { setRecorded([]); setSequenceReport(""); }}>Wyczyść nagranie</button>
        <button type="button" disabled={busy || recorded.length === 0 || !targetSession} onClick={() => void run(recorded, true)}>Odtwórz nagranie</button>
        <button type="button" disabled={recorded.length === 0} onClick={() => setSequenceReport(simulationSequenceJson(recorded))}>Eksportuj sekwencję · JSON</button>
        <p>Zapisano {recorded.length}/{MAX_SIMULATION_STEPS} przyjętych akcji. Ograniczony zapis pozostaje w pamięci procesu po zamknięciu diagnostyki; nie jest zapisywany na dysku. Home kończy bieżący segment. Dalsze kroki wymagają jawnego wznowienia. Odtwarzanie zatrzymuje się też przed zatwierdzeniem treści lub skrótem odtwarzania.</p>
        <ol>{recorded.map((step, index) => <li key={index}>{step.serviceId ?? "bieżąca sesja"} · {step.action} · {step.delayMs ?? 600} ms{needsSimulationReview(step.action) ? " · przegląd ekranu" : ""}</li>)}</ol>
        <label>Import sekwencji JSON <textarea maxLength={32768} rows={4} disabled={busy} value={sequenceImport} onChange={event => setSequenceImport(event.target.value)} /></label>
        <button type="button" disabled={busy || !sequenceImport.trim()} onClick={() => {
          try { const steps = parseSimulationSequence(sequenceImport); setRecorded(steps); setRecording(false); setError(""); setSequenceReport(""); setNotice("Wczytano sekwencję do przeglądu. Żadna akcja nie została wysłana."); }
          catch (cause) { setError(errorMessage(cause)); }
        }}>Wczytaj sekwencję do przeglądu</button>
      </div>
      {homeBoundary && <div role="group" aria-label="Wznowienie po Home" className="tv-simulator-sequences">
        <p>Home jest granicą segmentu. Pozostało {homeBoundary.remaining.length} kroków. Przyjęcie Home: {homeBoundary.accepted === true ? "potwierdzone" : "oczekiwanie na wynik"}. Zakończenie i fokus VELORA: {status.simulatorHomeReady === true ? "potwierdzone natywnie" : "niepotwierdzone — odśwież status po powrocie"}. Automatyczna sekwencja między usługami pozostaje częściowa.</p>
        <button type="button" disabled={busy || homeBoundary.accepted !== true || status.simulatorHomeReady !== true || homeBoundary.remaining.length === 0} onClick={() => void run(homeBoundary.remaining, true)}>Wznów pozostałe kroki po Home</button>
        <button type="button" disabled={busy} onClick={() => retainHomeBoundary(null)}>Usuń pozostałe kroki</button>
      </div>}
      <button type="button" disabled={!running} onClick={cancel}>Anuluj sekwencję</button>
      {checkpoint && <div role="alert"><p>{checkpoint}</p><button type="button" onClick={() => { pendingReview.current?.(true); pendingReview.current = null; }}>Wykonaj sprawdzony krok</button></div>}
      <p>Scenariusz nie zatwierdza treści ani zakupu. Używaj go wyłącznie na ekranie testowym; nie w formularzu konta.</p>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {last && <dl className="tv-simulator-receipt">
      <dt>Akcja symulowana / źródło</dt><dd>{last.action} / simulator</dd>
      <dt>Cel</dt><dd>{last.targetSession ? "wybrana sesja zarządzana" : "brak / Home"}</dd>
      <dt>Strategia</dt><dd>{last.activeStrategy}</dd><dt>Własność okna</dt><dd>{last.ownership ?? "brak odczytu"}</dd>
      <dt>Wysłanie natywne</dt><dd>{last.accepted ? "przyjęte" : "odrzucone"}</dd><dt>Efekt zgłoszony przez router</dt><dd>{last.effect}</dd>
      <dt>Test fizycznego DS4</dt><dd>NOT TESTED</dd>
      {last.action === "home" && <><dt>Zakończenie Home i fokus VELORA</dt><dd>{last.homeTransitionReady === true ? "potwierdzone przez status natywny" : last.homeTransitionReady === false ? "niepotwierdzone · sekwencja zatrzymana" : "oczekiwanie / nie sprawdzono"}</dd></>}
      <dt>Obserwacja operatora</dt><dd>{last.effectObservation ?? "notChecked"} · oddzielna od wyniku natywnego</dd>
      <dt>Czas wysłania</dt><dd>{last.dispatchElapsedMs ?? "nie zmierzono"} ms</dd>
      <dt>UI Automation</dt><dd>{last.spatialQueryMs === null || last.spatialQueryMs === undefined ? "brak zapytania" : `${last.spatialQueryMs} ms · ${last.spatialCandidateCount ?? 0} kandydatów`}</dd>
      {last.spatialDiagnostics && <>
        <dt>Dostawca / fokus w zakresie</dt><dd>{last.spatialDiagnostics.providerAvailable ? "dostępny" : "niedostępny"} / {last.spatialDiagnostics.focusInScope === null ? "nieustalony" : last.spatialDiagnostics.focusInScope ? "tak" : "nie"}</dd>
        <dt>Przeszukanie UIA</dt><dd>{last.spatialDiagnostics.visitedCount} węzłów · {last.spatialDiagnostics.candidateCount} kandydatów · {last.spatialDiagnostics.queryMs} ms · limit {last.spatialDiagnostics.budgetExhausted ? "osiągnięty" : "nieosiągnięty"} · pamięć podręczna {last.spatialDiagnostics.cacheHit ? "tak" : "nie"}</dd>
        <dt>Odrzucone kontrolki</dt><dd>wyłączone {last.spatialDiagnostics.rejected.disabled} · poza ekranem {last.spatialDiagnostics.rejected.offscreen} · hasło {last.spatialDiagnostics.rejected.password} · brak fokusu {last.spatialDiagnostics.rejected.notKeyboardFocusable} · geometria {last.spatialDiagnostics.rejected.invalidBounds} · poza zakresem {last.spatialDiagnostics.rejected.outsideScope} · niedostępne właściwości {last.spatialDiagnostics.rejected.propertyUnavailable}</dd>
      </>}
      {last.fallbackReason && <><dt>Ścieżka zastępcza</dt><dd>{last.fallbackActivated ? "włączono stały tryb wskaźnika · pierwotnej akcji nie powtórzono" : "nie przełączono trybu ani nie powtórzono polecenia"} · {last.fallbackReason}</dd></>}
    </dl>}
    {last && <div role="group" aria-label="Ocena zaobserwowanego efektu">
      <p>Po sprawdzeniu ekranu oceń ostatnią akcję. To ręczna obserwacja operatora, niezależna od przyjęcia polecenia przez Windows.</p>
      {([['observed', 'Efekt widoczny'], ['notObserved', 'Brak widocznego efektu'], ['notChecked', 'Efekt niesprawdzony']] as const).map(([value, label]) =>
        <button type="button" key={value} disabled={busy} aria-pressed={(last.effectObservation ?? "notChecked") === value} onClick={() => setReceipts(previous => previous.map((receipt, index) => index === previous.length - 1 ? { ...receipt, effectObservation: value } : receipt))}>{label}</button>)}
    </div>}
    <button type="button" disabled={receipts.length === 0} onClick={() => setReport(navigationEvidenceJson(receipts))}>Eksportuj zgodność TV · JSON</button>
    {report && <textarea aria-label="Bezpieczny raport zgodności TV JSON" readOnly rows={10} value={report} />}
    {sequenceReport && <textarea aria-label="Bezpieczna sekwencja symulatora JSON" readOnly rows={10} value={sequenceReport} />}
    <p>Eksport zawiera do 64 wyników poleceń; pomija identyfikatory sesji i szczegóły błędów. Przyjęcie polecenia nie potwierdza pauzy ani odtwarzania.</p>
  </section>;
}
