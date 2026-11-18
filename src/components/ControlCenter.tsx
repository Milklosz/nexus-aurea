import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { messageFromUnknown, veloraError, type VeloraError } from "../contracts/errors";
import {
  disabledControlServiceStatus, getControlServiceStatus, listenForControlServiceStatus,
  type ControlServiceStatus,
} from "../services/controlService";
import type { CinemaProfile } from "../services/cinemaMode";
import type { AmbientSettings } from "../services/ambient";
import { nextAmbientDelay, AMBIENT_IDLE_OPTIONS } from "../services/ambient";
import type { SystemVolumeAction } from "../services/musicBridge";
import { GamingHub } from "./GamingHub";
import { AutostartPanel } from "./AutostartPanel";
import { AudioControls } from "./AudioControls";
import { SessionsPanel } from "./SessionsPanel";
import { DesktopRecoveryControls } from "./DesktopRecoveryControls";
import { TvModePanel } from "./TvModePanel";
import { TvNavigationSettings } from "./TvNavigationSettings";
import { PlayniteLibrary } from "./PlayniteLibrary";
import { AppSearchPanel } from "./AppSearchPanel";
import type { SearchEntry } from "../services/appSearch";
import { STATUS_READ_TIMEOUT_MS, withTimeout } from "../services/withTimeout";
import { nativeControllerStore } from "../services/nativeControllerStore";
import { useNativeControllerStatus } from "../hooks/useNativeController";
import {
  configureControllerFallback, configureStreamingControl,
  disabledFallbackHomeStatus, disabledStreamingControlStatus,
  getControllerFallbackStatus, getStreamingControlStatus,
  type FallbackHomeConfig, type FallbackHomeStatus, type StreamingControlStatus,
} from "../services/livingRoom";
import {
  beginRemotePairing,
  beginRemoteTrustProfileApproval,
  cleanupRemoteTrustArtifacts,
  disabledRemoteAccessStatus,
  getRemoteAccessStatus,
  inspectRemoteRecovery,
  inspectRemoteTrustProfile,
  listenForRemoteAccessStatus,
  prepareRemoteTrustProfile,
  REMOTE_ACCESS_DISABLED_REASON,
  revokeAllRemoteDevices,
  revokeRemoteDevice,
  runRemoteRecovery,
  startRemoteAccess,
  stopRemoteAccess,
  type RemoteAccessStatus,
  type RemoteRecoveryMode,
  type RemoteRecoveryPlan,
  type RemoteTrustProfilePreview,
} from "../services/remoteAccess";
import {
  buildPairingBootstrapUrl,
  encodeQrMatrix,
  formatPairingCountdown,
  pairingRemainingSeconds,
} from "../services/remoteReliability";

const STORE_STATE_LABELS: Record<string, string> = {
  unavailable: "niedostępny",
  locked: "zajęty przez inny proces VELORA",
  damaged: "uszkodzony lub niekompletny",
  "rolled-back": "cofnięty do starszego stanu",
  "recovery-pending": "odzyskiwanie nie zostało dokończone",
};

type ControlCenterProps = {
  profile: CinemaProfile;
  onProfileChange: (profile: CinemaProfile) => Promise<boolean>;
  onShowDesktop: () => void;
  onSystemVolume: (action: SystemVolumeAction) => Promise<void>;
  ambientSettings: AmbientSettings;
  onAmbientSettingsChange: (settings: AmbientSettings) => void;
  mediaPlaying: boolean;
  onOpenDiagnostics: () => void;
  onReturnToNexus: () => void;
  onSwitchApplications?: () => void;
  onClose: () => void;
  /** When present, the Szukaj tab is shown. Launching a result goes through onLaunch. */
  appSearch?: { entries: readonly SearchEntry[]; onLaunch: (entryId: string) => void };
  /** Tab shown first. Home entries (Szukaj, Pilot) open Control Center directly on their tab. */
  initialPanel?: ControlPanelId;
  /** Living Room Home: Polish section names, "Ustawienia" heading, and focus starts on the open section tab. */
  livingRoom?: boolean;
};

const profiles: Array<{ id: CinemaProfile; label: string }> = [
  { id: "cinema", label: "Cinema" },
  { id: "gaming", label: "Gaming" },
  { id: "desktop", label: "Desktop" },
];

const livingRoomPanelLabels: Record<string, string> = { cinema: "Kino", gaming: "Gry", remote: "Pilot", search: "Szukaj", sessions: "Sesje" };

const controlPanels = [
  { id: "cinema", label: "Cinema" },
  { id: "gaming", label: "Gaming" },
  { id: "remote", label: "iPhone Remote" },
  { id: "search", label: "Szukaj" },
  { id: "sessions", label: "Sesje" },
] as const;

export type ControlPanelId = (typeof controlPanels)[number]["id"];

function delayLabel(seconds: number): string {
  return Math.round(seconds / 60) + " min";
}

type StatusReadState = "loading" | "ready" | "unknown";

/** Keeps the stable "Nie udało się odczytać stanu Windows" text, but appends the real cause. */
function classifyStatusReadError(cause: unknown): VeloraError {
  const raw = messageFromUnknown(cause) ?? "";
  const reason = raw.slice(0, 160);
  if (reason.includes("brak odpowiedzi")) {
    return veloraError(
      "remote-timeout",
      `Nie udało się odczytać stanu Windows. Brak odpowiedzi w ciągu ${STATUS_READ_TIMEOUT_MS / 1000} s — stan jest nieznany; ponów odczyt.`,
      true,
      raw,
    );
  }
  return veloraError(
    "unavailable",
    `Nie udało się odczytać stanu Windows.${reason ? ` Powód: ${reason}.` : ""} Stan jest nieznany; ponów odczyt.`,
    true,
    raw,
  );
}

/** Renders the QR module matrix produced by the self-contained encoder. */
function PairingQrCode({ modules, label }: { modules: boolean[][]; label: string }) {
  const size = modules.length;
  const quiet = 4;
  const total = size + quiet * 2;
  return (
    <svg className="remote-pairing-qr" viewBox={`0 0 ${total} ${total}`}
      width={152} height={152} role="img" aria-label={label}
      style={{ width: 152, height: 152, background: "#fff", borderRadius: 8 }}>
      <rect x={0} y={0} width={total} height={total} fill="#ffffff" />
      {modules.map((row, y) => row.map((dark, x) => dark
        ? <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#000000" />
        : null))}
    </svg>
  );
}

/** Native session settings stay local-only; the paired remote cannot opt into input synthesis. */
export function SessionControllerControls({ homeEnabled, nativeRunning }: { homeEnabled: boolean; nativeRunning: boolean }) {
  const [streaming, setStreaming] = useState<StreamingControlStatus>(disabledStreamingControlStatus);
  const [fallback, setFallback] = useState<FallbackHomeStatus>(disabledFallbackHomeStatus);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const refreshRequestId = useRef(0);

  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestId = ++refreshRequestId.current;
    setBusy(true);
    const pending = Promise.allSettled([getStreamingControlStatus(), getControllerFallbackStatus()]).then(results => {
      const [streamingResult, fallbackResult] = results;
      if (streamingResult.status === "rejected") throw streamingResult.reason;
      if (fallbackResult.status === "rejected") throw fallbackResult.reason;
      return [streamingResult.value, fallbackResult.value] as const;
    });
    // Do NOT release the reservation from `pending.finally`: a timed-out IPC may never settle,
    // and a late settlement must not release a newer request's reservation. The epoch below
    // releases it for this request as soon as the bounded race settles.
    try {
      const [nextStreaming, nextFallback] = await withTimeout(pending, STATUS_READ_TIMEOUT_MS, "Sterowanie z kanapy");
      if (mounted.current && requestId === refreshRequestId.current) {
        setStreaming(nextStreaming); setFallback(nextFallback); setReady(true); setNotice(""); setError("");
      }
    } catch {
      if (mounted.current && requestId === refreshRequestId.current) {
        setReady(false); setNotice("Stan sterowania z kanapy jest niedostępny. Odśwież po odzyskaniu połączenia.");
      }
    } finally {
      if (requestId === refreshRequestId.current) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { mounted.current = false; window.removeEventListener("focus", onFocus); };
  }, []);

  const configure = async (operation: () => Promise<void>) => {
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setBusy(true); setError(""); setNotice("");
    // Mutations are never retried automatically: a late reply must not enable a second mutation.
    try {
      await operation();
      if (mounted.current) setNotice("Ustawienie zapisane na tę sesję VELORA.");
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Nie udało się zmienić sterowania.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const setFallbackConfig = (config: FallbackHomeConfig) => configure(async () => {
    const next = await configureControllerFallback(config);
    if (mounted.current) setFallback(next);
  });
  const setStreamingConfig = (enabled: boolean, pointerMode: boolean) => configure(async () => {
    const next = await configureStreamingControl(enabled, pointerMode);
    if (mounted.current) setStreaming(next);
  });
  const disabled = busy || !ready;
  return <section className="cc-card cc-card-wide" aria-label="Sterowanie z kanapy" aria-busy={busy} data-remote-admin="">
    <div className="cc-card-heading"><span className="cc-card-index">10</span><div><h3>Sterowanie z kanapy</h3><p>Ustawienia lokalne, tylko na bieżącą sesję.</p></div></div>
    <p>Gest zastępczy Home: {!ready ? "stan nieznany" : fallback.enabled ? `L1 + R1 + Options, przytrzymaj ${fallback.holdMs / 1000} s` : "wyłączony"}. Po użyciu zwolnij wszystkie przyciski.</p>
    {!fallback.physicalMappingValidated && <p>Ten gest wymaga jeszcze potwierdzenia na fizycznym padzie. {fallback.primaryChordSuppressed ? "PS + Options jest wyłączone podczas używania gestu zastępczego." : "PS + Options pozostaje podstawowym skrótem."}</p>}
    <div className="cc-actions">
      <button type="button" data-remote-admin="" disabled={disabled || ((!homeEnabled || !nativeRunning) && !fallback.enabled)} aria-pressed={fallback.enabled}
        onClick={() => void setFallbackConfig({ enabled: !fallback.enabled, gesture: fallback.enabled ? "disabled" : "l1R1Options", holdMs: fallback.holdMs })}>
        {fallback.enabled ? "Wyłącz gest zastępczy Home" : "Włącz gest zastępczy Home"}
      </button>
      <button type="button" data-remote-admin="" disabled={disabled || !fallback.enabled}
        onClick={() => void setFallbackConfig({ enabled: fallback.enabled, gesture: fallback.gesture, holdMs: fallback.holdMs === 1500 ? 2000 : fallback.holdMs === 2000 ? 3000 : 1500 })}>
        Przytrzymanie: {fallback.holdMs / 1000} s — zmień
      </button>
    </div>
    <p role="status">Streaming: {!ready ? "stan nieznany" : !streaming.windows ? "niedostępny" : streaming.enabled ? "sterowanie włączone" : "sterowanie wyłączone"} · wskaźnik: {!ready ? "stan nieznany" : streaming.enabled && streaming.pointerMode ? "AKTYWNY" : "wyłączony"}{ready && streaming.activeService ? ` · serwis: ${streaming.activeService}` : ""}.</p>
    <div className="cc-actions">
      <button type="button" data-remote-admin="" disabled={disabled || !streaming.windows || ((!homeEnabled || !nativeRunning) && !streaming.enabled)} aria-pressed={streaming.enabled}
        onClick={() => void setStreamingConfig(!streaming.enabled, streaming.pointerMode)}>
        {streaming.enabled ? "Wyłącz sterowanie streamingiem" : "Włącz sterowanie streamingiem"}
      </button>
      <button type="button" data-remote-admin="" disabled={disabled || !streaming.enabled || ((!homeEnabled || !nativeRunning) && !streaming.pointerMode)} aria-pressed={streaming.pointerMode}
        onClick={() => void setStreamingConfig(streaming.enabled, !streaming.pointerMode)}>
        {streaming.pointerMode ? "Wyłącz tryb wskaźnika" : "Włącz tryb wskaźnika"}
      </button>
      <button type="button" data-remote-admin="" disabled={busy} onClick={() => void refresh()}>Odśwież stan sterowania</button>
    </div>
    <TvNavigationSettings revision={`${streaming.enabled}:${streaming.pointerMode}`} />
    {!homeEnabled && <p>Najpierw włącz powrót Home na tę sesję.</p>}
    <p>D-pad i lewy analog: nawigacja · Cross: wybór · Circle: wstecz · Square: odtwórz/pauza po uzbrojeniu · Triangle: tryb wskaźnika · prawy analog: wskaźnik lub przewijanie · L2/R2: przewijanie. Options otwiera Control Center po zwolnieniu, jeśli nie użyto gestu Home. L1/R1 pozostają zarezerwowane dla dotychczasowego gestu zastępczego Home.</p>
    <p className="cc-card-note">Sterowanie obejmuje wyłącznie aktywne okno streamingowe uruchomione i rozpoznane przez VELORA. Obsługa stron wymaga testów; w trybie wskaźnika nad własnym oknem pojawia się oznaczenie.</p>
    <button type="button" data-remote-admin="" aria-expanded={showDiagnostics} aria-controls="cc-couch-diagnostics"
      onClick={() => setShowDiagnostics(!showDiagnostics)}>Wynik sterowania i gestu Home</button>
    {showDiagnostics && <div id="cc-couch-diagnostics">
      <p>Ostatni wynik: {streaming.lastResult ?? "brak"} · wysłane/odrzucone akcje: {streaming.acceptedActions}/{streaming.rejectedActions}.</p>
      <p>Gest: {fallback.armed ? "uzbrojony" : "czeka na zwolnienie przycisków"} · ostatni Home: {fallback.lastTriggeredAtMs === null ? "brak" : "zarejestrowany"}.</p>
    </div>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

export function ControlCenter(props: ControlCenterProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The Szukaj tab exists only when the app passes search entries.
  const panels = controlPanels.filter((panel) => panel.id !== "search" || props.appSearch !== undefined);
  const [activePanel, setActivePanel] = useState<ControlPanelId>(() =>
    props.initialPanel !== undefined && (props.initialPanel !== "search" || props.appSearch !== undefined) ? props.initialPanel : "cinema");
  const [status, setStatus] = useState<ControlServiceStatus>(disabledControlServiceStatus);
  const [loading, setLoading] = useState(true);
  const [statusReadState, setStatusReadState] = useState<StatusReadState>("loading");
  const [statusError, setStatusError] = useState<VeloraError | null>(null);
  const nativeController = useNativeControllerStatus();
  const [homeBusy, setHomeBusy] = useState(false);
  const [homeNotice, setHomeNotice] = useState("");
  const [homeError, setHomeError] = useState("");
  const [homeDiagnostics, setHomeDiagnostics] = useState(false);
  const controlStatusRequestId = useRef(0);
  const controlStatusRequestInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus>(disabledRemoteAccessStatus);
  const [pairingNowMs, setPairingNowMs] = useState(() => Date.now());
  const [remoteStatusReady, setRemoteStatusReady] = useState(false);
  const [remoteStatusLoading, setRemoteStatusLoading] = useState(true);
  const [remoteStatusError, setRemoteStatusError] = useState("");
  const remoteStatusRequestId = useRef(0);
  const remoteStatusRequestInFlight = useRef(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [trustConfirmed, setTrustConfirmed] = useState(false);
  // Explicit, unchecked-by-default consent for the one-time profile write and
  // for the rollback. Both are local-only and require a fresh approval token.
  const [profileApproved, setProfileApproved] = useState(false);
  const [cleanupAcknowledged, setCleanupAcknowledged] = useState(false);
  const [trustPreview, setTrustPreview] = useState<RemoteTrustProfilePreview | null>(null);
  const [remoteError, setRemoteError] = useState("");
  const [remoteNotice, setRemoteNotice] = useState("");
  const [recoveryPlan, setRecoveryPlan] = useState<RemoteRecoveryPlan | null>(null);
  const [recoveryChoice, setRecoveryChoice] = useState<RemoteRecoveryMode | null>(null);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const readRemoteStatus = async (isActive: () => boolean = () => true) => {
    if (remoteStatusRequestInFlight.current) return;
    remoteStatusRequestInFlight.current = true;
    const requestId = ++remoteStatusRequestId.current;
    setRemoteStatusLoading(true);
    setRemoteStatusError("");
    try {
      const next = await withTimeout(getRemoteAccessStatus(), STATUS_READ_TIMEOUT_MS, "Status iPhone Remote");
      if (isActive() && requestId === remoteStatusRequestId.current) {
        setRemoteStatus(next);
        setRemoteStatusReady(true);
      }
    } catch {
      if (isActive() && requestId === remoteStatusRequestId.current) {
        setRemoteStatusReady(false);
        setRemoteStatusError("Nie udało się odczytać bezpiecznego stanu iPhone Remote. Sterowanie pozostaje wyłączone.");
      }
    } finally {
      if (isActive() && requestId === remoteStatusRequestId.current) {
        setRemoteStatusLoading(false);
        remoteStatusRequestInFlight.current = false;
      }
    }
  };

  const readControlStatus = async (isActive: () => boolean = () => true) => {
    if (controlStatusRequestInFlight.current) return;
    controlStatusRequestInFlight.current = true;
    const requestId = ++controlStatusRequestId.current;
    setLoading(true);
    setError("");
    try {
      const next = await withTimeout(getControlServiceStatus(), STATUS_READ_TIMEOUT_MS, "Status Windows");
      if (isActive() && requestId === controlStatusRequestId.current) {
        setStatus(next);
        setStatusReadState("ready");
        setStatusError(null);
      }
    } catch (cause) {
      if (isActive() && requestId === controlStatusRequestId.current) {
        // Keep the last known status; a failed read means "unknown", not "backend unavailable".
        setStatusReadState("unknown");
        setStatusError(classifyStatusReadError(cause));
      }
    } finally {
      if (isActive() && requestId === controlStatusRequestId.current) {
        setLoading(false);
        controlStatusRequestInFlight.current = false;
      }
    }
  };

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open && typeof element.showModal === "function") element.showModal();
    // showModal focuses the first control (the close button). In the Living Room the open section tab is the natural start.
    const focusFrame = props.livingRoom
      ? window.requestAnimationFrame(() => element?.querySelector<HTMLElement>('.cc-tabs [aria-selected="true"]')?.focus({ preventScroll: true }))
      : window.requestAnimationFrame(() => element?.querySelector<HTMLElement>(".cc-close")?.focus({ preventScroll: true }));
    let active = true;
    void readControlStatus(() => active);
    // Event-driven recovery only: the backend already publishes every 750 ms. No polling is added.
    // A good snapshot clears a degraded read, but is ignored while a read is in flight so it can
    // never clobber a fresher response (the request id invalidates any stale read's guards).
    let stopStatusListener: (() => void) | undefined;
    void listenForControlServiceStatus((next) => {
      if (!active || controlStatusRequestInFlight.current) return;
      controlStatusRequestId.current += 1;
      setStatus(next);
      setStatusReadState("ready");
      setStatusError(null);
    }).then((unlisten) => {
      if (active) stopStatusListener = unlisten;
      else unlisten();
    }).catch(() => {});
    return () => {
      window.cancelAnimationFrame(focusFrame);
      active = false;
      controlStatusRequestId.current += 1;
      controlStatusRequestInFlight.current = false;
      stopStatusListener?.();
      if (element?.open) element.close();
    };
  }, []);

  useEffect(() => {
    const release = nativeControllerStore.acquire();
    const reconcile = () => {
      if (nativeControllerStore.getStatusReadInFlight()) return;
      void withTimeout(nativeControllerStore.reconcile(), STATUS_READ_TIMEOUT_MS, "Odczyt kontrolera")
        .catch(() => nativeControllerStore.invalidateStatusRead());
    };
    reconcile();
    const timer = window.setInterval(reconcile, 1_000);
    return () => { window.clearInterval(timer); release(); };
  }, []);

  const setSessionHome = async () => {
    if (!nativeController.supported || !nativeController.running || homeBusy) return;
    setHomeBusy(true);
    setHomeError("");
    setHomeNotice("");
    try {
      const enabled = !nativeController.homeEnabled;
      const next = await nativeControllerStore.setHomeEnabled(enabled);
      if (!next.running || next.homeEnabled !== enabled) {
        setHomeError("Nie udało się ustawić powrotu na tę sesję.");
      } else {
        setHomeNotice(enabled
          ? "Powrót padem jest włączony do zamknięcia VELORA. Obowiązuje wybrany poniżej gest."
          : "Powrót padem jest wyłączony na tę sesję.");
      }
    } catch (cause) {
      setHomeError(cause instanceof Error ? cause.message : "Nie udało się ustawić powrotu pada.");
    } finally {
      setHomeBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void readRemoteStatus(() => active);
    void listenForRemoteAccessStatus((next) => {
      if (active) {
        remoteStatusRequestId.current += 1;
        remoteStatusRequestInFlight.current = false;
        setRemoteStatus(next);
        setRemoteStatusReady(true);
        setRemoteStatusLoading(false);
        setRemoteStatusError("");
      }
    }).then((stopListening) => {
      if (active) unlisten = stopListening;
      else stopListening();
    }).catch(() => {});
    return () => {
      active = false;
      remoteStatusRequestId.current += 1;
      remoteStatusRequestInFlight.current = false;
      unlisten?.();
    };
  }, []);

  // A real 1-second ticker only while a pairing code is live. No tight render
  // loop: the interval is created once per expiry value and cleaned up on
  // unmount / when the code is consumed or expires.
  useEffect(() => {
    const expiry = remoteStatus.pairingExpiresAtMs ?? 0;
    if (!expiry || expiry <= Date.now()) return;
    setPairingNowMs(Date.now());
    const timer = window.setInterval(() => setPairingNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [remoteStatus.pairingExpiresAtMs]);

  const pairingRemaining = pairingRemainingSeconds(remoteStatus.pairingExpiresAtMs ?? 0, pairingNowMs);
  const pairingCountdown = formatPairingCountdown(pairingRemaining);
  const pairingQr = useMemo(() => {
    if (!remoteStatus.pairingCode || !remoteStatus.origin || !remoteStatus.pairingExpiresAtMs) return null;
    try {
      const url = buildPairingBootstrapUrl(
        remoteStatus.origin,
        remoteStatus.pairingCode,
        remoteStatus.pairingExpiresAtMs,
      );
      return { url, modules: encodeQrMatrix(url) };
    } catch {
      return null;
    }
  }, [remoteStatus.pairingCode, remoteStatus.origin, remoteStatus.pairingExpiresAtMs]);

  const runRemoteAction = async (
    action: () => Promise<RemoteAccessStatus>,
    success: string,
  ) => {
    if (!remoteStatusReady || remoteStatusLoading || remoteBusy) return;
    setRemoteBusy(true);
    setRemoteError("");
    setRemoteNotice("");
    try {
      setRemoteStatus(await action());
      setRemoteNotice(success);
    } catch (cause) {
      setRemoteError(cause instanceof Error ? cause.message : "Nie udało się zmienić ustawień iPhone Remote.");
    } finally {
      setRemoteBusy(false);
    }
  };

  const openRecovery = async () => {
    if (!remoteStatusReady || remoteBusy) return;
    setRemoteBusy(true);
    setRemoteError("");
    setRemoteNotice("");
    try {
      setRecoveryPlan(await inspectRemoteRecovery());
      setRecoveryChoice(null);
      setRecoveryAcknowledged(false);
    } catch (cause) {
      setRemoteError(cause instanceof Error ? cause.message : "Nie udało się odczytać stanu odzyskiwania.");
    } finally {
      setRemoteBusy(false);
    }
  };

  const executeRecovery = async () => {
    if (!recoveryPlan || !recoveryChoice || !recoveryAcknowledged || remoteBusy) return;
    setRemoteBusy(true);
    setRemoteError("");
    setRemoteNotice("");
    try {
      setRemoteStatus(await runRemoteRecovery(recoveryChoice, recoveryPlan.confirmation));
      setRemoteNotice(recoveryChoice === "reset-trust"
        ? "Odzyskiwanie zakończone. Certyfikat zaufania usunięto: przygotuj nowy profil, zainstaluj go na iPhonie i sparuj urządzenia ponownie."
        : "Odzyskiwanie zakończone. Wszystkie urządzenia odwołano; sparuj je ponownie.");
      setRecoveryPlan(null);
      setRecoveryChoice(null);
      setRecoveryAcknowledged(false);
    } catch (cause) {
      setRemoteError(cause instanceof Error ? cause.message : "Odzyskiwanie nie zostało ukończone. Serwer pozostaje wyłączony.");
      setRecoveryPlan(null);
      void readRemoteStatus();
    } finally {
      setRemoteBusy(false);
    }
  };

  const chooseProfile = async (profile: CinemaProfile) => {
    if (profile === props.profile || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!await props.onProfileChange(profile)) setError("Nie udało się zastosować profilu.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zastosować profilu.");
    } finally {
      setBusy(false);
    }
  };

  const changeVolume = async (action: SystemVolumeAction) => {
    if (statusReadState !== "ready" || !status.windows || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await props.onSystemVolume(action);
      setNotice(action === "mute" ? "Wysłano polecenie wyciszenia Windows." : "Wysłano polecenie zmiany głośności Windows.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Regulacja głośności Windows jest niedostępna.");
    } finally {
      setBusy(false);
    }
  };

  const cycleDelay = () => {
    props.onAmbientSettingsChange({
      ...props.ambientSettings,
      idleSeconds: nextAmbientDelay(props.ambientSettings.idleSeconds),
    });
  };

  const selectPanel = (panel: ControlPanelId, focusTab = false) => {
    setActivePanel(panel);
    if (focusTab) {
      const index = panels.findIndex((item) => item.id === panel);
      tabRefs.current[index]?.focus({ preventScroll: true });
    }
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    event.stopPropagation();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? panels.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + panels.length) % panels.length;
    selectPanel(panels[nextIndex].id, true);
  };

  return <dialog ref={dialog} className="control-center" aria-labelledby="control-center-title"
    onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <header className="control-center-header">
      <div>
        <span className="control-center-eyebrow">VELORA · GRAND CINEMA</span>
        <h2 id="control-center-title">{props.livingRoom ? "Ustawienia" : "Control Center"}</h2>
        <p>Ustawienia konsoli multimedialnej</p>
      </div>
      <button className="cc-close" type="button" data-remote-allow="" onClick={props.onClose} aria-label={props.livingRoom ? "Zamknij ustawienia" : "Zamknij Control Center"}>×</button>
    </header>

    <nav className="cc-tabs" role="tablist" aria-label="Sekcje Control Center">
      {panels.map((panel, index) => <button
        key={panel.id}
        ref={(element) => { tabRefs.current[index] = element; }}
        id={`cc-tab-${panel.id}`}
        type="button"
        data-remote-allow=""
        role="tab"
        aria-selected={activePanel === panel.id}
        aria-controls={`cc-panel-${panel.id}`}
        tabIndex={activePanel === panel.id ? 0 : -1}
        onClick={() => selectPanel(panel.id)}
        onKeyDown={(event) => handleTabKeyDown(event, index)}
      >{props.livingRoom ? livingRoomPanelLabels[panel.id] ?? panel.label : panel.label}</button>)}
    </nav>

    <div className="cc-stage">
      <section id="cc-panel-cinema" className="cc-panel cc-cinema-panel" role="tabpanel"
        aria-labelledby="cc-tab-cinema" tabIndex={0} hidden={activePanel !== "cinema"}>
        <div className="cc-card-grid">
          <section className="cc-card" aria-label="Profil kina">
            <div className="cc-card-heading"><span className="cc-card-index">01</span><div><h3>Profil kina</h3><p>{props.livingRoom ? "Profil obrazu i sterowania." : "Wybierz nastrój dla tej sesji."}</p></div></div>
            <div className="cc-actions cc-profile-actions">
              {profiles.map((profile) => <button key={profile.id} type="button" data-remote-allow=""
                className={props.profile === profile.id ? "profile-active" : ""}
                aria-pressed={props.profile === profile.id} disabled={busy}
                onClick={() => void chooseProfile(profile.id)}>{profile.label}</button>)}
            </div>
            <p>Gaming steruje trybem gry tylko wtedy, gdy Control Service działa. Inne ustawienia Windows nie są zmieniane.</p>
          </section>

          <section className="cc-card" aria-label="Dźwięk systemu">
            <div className="cc-card-heading"><span className="cc-card-index">02</span><div><h3>Dźwięk</h3><p>Głośność systemowa Windows.</p></div></div>
            {statusReadState === "ready" && status.windows
              ? <div className="cc-actions cc-volume-actions">
                <button type="button" data-remote-allow="" disabled={busy} onClick={() => void changeVolume("down")} aria-label="Głośność −">−</button>
                <button type="button" data-remote-allow="" disabled={busy} onClick={() => void changeVolume("mute")}>Wycisz</button>
                <button type="button" data-remote-allow="" disabled={busy} onClick={() => void changeVolume("up")} aria-label="Głośność +">+</button>
              </div>
              : <p>{statusReadState !== "ready"
                ? "Stan systemu jest nieznany — ponów odczyt w sekcji „Stan systemu”."
                : props.livingRoom ? "Regulacja głośności jest niedostępna." : "Regulacja głośności wymaga natywnego backendu Windows."}</p>}
          </section>

          <section className="cc-card cc-card-wide" aria-label="VELORA Ambient">
            <div className="cc-card-heading"><span className="cc-card-index">03</span><div><h3>VELORA Ambient</h3><p>Przyciemnienie ekranu po okresie bezczynności.</p></div></div>
            <div className="cc-actions cc-ambient-actions">
              <button type="button" data-remote-allow="" aria-pressed={props.ambientSettings.enabled}
                onClick={() => props.onAmbientSettingsChange({ ...props.ambientSettings, enabled: !props.ambientSettings.enabled })}>
                {props.ambientSettings.enabled ? "Wyłącz Ambient" : "Włącz Ambient"}
              </button>
              <button type="button" data-remote-allow="" onClick={cycleDelay}>Bezczynność: {delayLabel(props.ambientSettings.idleSeconds)} · zmień</button>
            </div>
            <p>{props.mediaPlaying
              ? "Wykryto odtwarzanie Apple Music przez Windows SMTC. Ambient jest wstrzymany."
              : "Ambient wstrzymuje się, gdy VELORA traci fokus lub wykryje odtwarzanie Apple Music."}</p>
            <p className="cc-card-note">Dostępne czasy: {AMBIENT_IDLE_OPTIONS.map(delayLabel).join(" · ")}. Ambient nie zmienia ustawień zasilania Windows.</p>
          </section>

          <section className="cc-card cc-card-wide cc-system-card" aria-label="Stan systemu">
            <div className="cc-card-heading"><span className="cc-card-index">04</span><div><h3>Stan systemu</h3><p>Windows i kontroler.</p></div></div>
            <div className="cc-system-status">
              {statusReadState === "loading"
                ? <p role="status">Odczytuję stan backendu…</p>
                : statusReadState === "unknown"
                  ? <p role="status"><span className="cc-status-dot" />Backend Windows: nieznany</p>
                  : <p role="status"><span className={`cc-status-dot ${status.windows ? "is-ready" : ""}`} />Backend Windows: {status.windows ? "dostępny" : "niedostępny"}</p>}
              {statusReadState === "ready" && status.windows && <p>Control Service: {status.running ? status.gameMode ? "tryb Gaming" : "aktywny" : "wyłączony"}
                {status.running
                  ? " · kontrolery HID: " + status.controllerCount + " · Sony: " + status.playstationControllerCount
                  : " · monitoring urządzeń jest wyłączony"}
              </p>}
              {statusReadState === "ready" && status.foregroundProcess && <p>Aktywne okno: {status.foregroundProcess}</p>}
              {statusReadState === "ready" && status.lastError && <p role="alert">{status.lastError}</p>}
              {statusError && <p className="cc-feedback cc-error" role="alert">{statusError.message}</p>}
            </div>
            {statusReadState === "unknown" && <button type="button" data-remote-allow="" aria-busy={loading} disabled={loading} onClick={() => void readControlStatus()}>
              {loading ? "Odczytuję…" : "Ponów odczyt statusu Windows"}
            </button>}
          </section>
          <section className="cc-card cc-card-wide" aria-label="Powrót do VELORA padem" data-remote-admin="">
            <div className="cc-card-heading"><span className="cc-card-index">09</span><div><h3>Powrót do VELORA</h3><p>Sesyjny powrót na lokalnym DualShock 4.</p></div></div>
            <p role="status">Natywny odczyt: {!nativeController.supported ? "niedostępny" : nativeController.running ? `${nativeController.pads.length} pad(y) podłączone` : "zatrzymany"} · powrót: {nativeController.homeEnabled ? "włączony" : "wyłączony"}{nativeController.homeOverride === null ? " · podąża za Control Service" : " · ustawienie na tę sesję"}</p>
            <p>To ustawienie działa tylko do zamknięcia VELORA. Gdy gest zastępczy jest wyłączony, naciśnij PS + Options niemal jednocześnie (w ciągu około 250 ms), a potem zwolnij oba. Wybrany gest zastępczy zastępuje PS + Options. Nie zmienia mapowania Steam ani Windows.</p>
            <button type="button" data-remote-admin="" aria-expanded={homeDiagnostics} aria-controls="cc-home-diagnostics"
              onClick={() => setHomeDiagnostics(!homeDiagnostics)}>Diagnostyka raportu pada</button>
            {homeDiagnostics && <div id="cc-home-diagnostics">
              <p>Ostatni raport: {nativeController.lastHomeButtons ? `PS ${nativeController.lastHomeButtons.ps ? "wciśnięty" : "zwolniony"} · Options ${nativeController.lastHomeButtons.options ? "wciśnięty" : "zwolniony"}` : "brak"}.</p>
              <p>Wykryte naciśnięcia PS/Options: {nativeController.psRisingCount}/{nativeController.optionsRisingCount} · raporty poprawne/tło: {nativeController.validReports}/{nativeController.backgroundReports}.</p>
              {nativeController.lastChord && <p>Ostatni chord: {nativeController.lastChord.outcome} · powrót uzbrojony: {nativeController.lastChord.homeEnabled ? "tak" : "nie"} · wysłano żądanie: {nativeController.lastChord.actionRequested ? "tak" : "nie"}.</p>}
              {nativeController.lastRestore && <p>Ostatnia próba fokusu: {nativeController.lastRestore.outcome} · HWND VELORA: {nativeController.lastRestore.ownWindow ?? "brak"} · HWND przed/po: {nativeController.lastRestore.foregroundBeforeHwnd ?? "brak"}/{nativeController.lastRestore.foregroundAfterHwnd ?? "brak"} · kod Win32: {nativeController.lastRestore.errorCode ?? "brak"}.</p>}
            </div>}
            <button type="button" data-remote-admin="" aria-pressed={nativeController.homeEnabled}
              disabled={!nativeController.supported || !nativeController.running || homeBusy}
              aria-busy={homeBusy} onClick={() => void setSessionHome()}>
              {homeBusy ? "Aktualizuję…" : nativeController.homeEnabled ? "Wyłącz powrót na tę sesję" : "Włącz powrót na tę sesję"}
            </button>
            {homeError && <p role="alert">{homeError}</p>}
            {homeNotice && <p role="status">{homeNotice}</p>}
          </section>
          <SessionControllerControls homeEnabled={nativeController.homeEnabled} nativeRunning={nativeController.supported && nativeController.running} />
          <AutostartPanel />
          <AudioControls />
          <DesktopRecoveryControls />
          {activePanel === "cinema" && <TvModePanel />}
        </div>
        {error && <p className="cc-feedback cc-error" role="alert">{error}</p>}
        {notice && <p className="cc-feedback" role="status">{notice}</p>}
      </section>

      <section id="cc-panel-sessions" className="cc-panel" role="tabpanel" aria-labelledby="cc-tab-sessions" tabIndex={0} hidden={activePanel !== "sessions"}>
        {activePanel === "sessions" && <SessionsPanel />}
      </section>
      <section id="cc-panel-gaming" className="cc-panel cc-gaming-panel" role="tabpanel"
        aria-labelledby="cc-tab-gaming" tabIndex={0} hidden={activePanel !== "gaming"}>
        <div className="cc-card cc-gaming-card">
          <div className="cc-card-heading"><span className="cc-card-index">05</span><div><h3>Gaming Hub</h3><p>Gry i launchery zainstalowane na tym komputerze.</p></div></div>
          <GamingHub onActivateGaming={() => props.onProfileChange("gaming")} />
        </div>
        <section className="cc-card cc-playnite-card" aria-label="Biblioteka gier Playnite">
          <div className="cc-card-heading"><span className="cc-card-index">08</span><div><h3>Biblioteka gier</h3><p>Okładki, ulubione i ostatnio grane z bezpiecznego źródła Playnite.</p></div></div>
          <PlayniteLibrary />
        </section>
      </section>

      {props.appSearch && <section id="cc-panel-search" className="cc-panel cc-search-panel" role="tabpanel"
        aria-labelledby="cc-tab-search" tabIndex={0} hidden={activePanel !== "search"}>
        <AppSearchPanel entries={props.appSearch.entries} onLaunch={props.appSearch.onLaunch} />
      </section>}
      <section id="cc-panel-remote" className="cc-panel cc-remote-panel" role="tabpanel"
        aria-labelledby="cc-tab-remote" tabIndex={0} hidden={activePanel !== "remote"}>
        <div className="cc-card cc-remote-card" data-remote-admin="">
          <div className="cc-card-heading"><span className="cc-card-index">06</span><div><h3>{props.livingRoom ? "Pilot iPhone" : "iPhone Remote"}</h3><p>Pilot pozostaje wyłączony do czasu ręcznego, bezpiecznego sparowania.</p></div></div>
          <ul className="remote-access-status" aria-label="Stan iPhone Remote">
            <li><span>Serwer LAN</span><strong>{remoteStatusReady ? remoteStatus.enabled ? "włączony" : "wyłączony" : "stan nieznany"}</strong></li>
            <li><span>HTTPS</span><strong>{remoteStatusReady ? remoteStatus.secureOriginAvailable ? "aktywny · wymaga zaufanego certyfikatu" : "wyłączony" : "stan nieznany"}</strong></li>
            <li><span>Parowanie</span><strong>{!remoteStatusReady ? "stan nieznany" : remoteStatus.pairingCode
              ? `kod jednorazowy · ${pairingCountdown}`
              : remoteStatus.pairingAvailable ? "gotowe po wygenerowaniu kodu" : "wyłączone"}</strong></li>
            <li><span>Sparowane urządzenia</span><strong>{remoteStatusReady ? remoteStatus.pairedDeviceCount : "?"}</strong></li>
          </ul>
          {remoteStatusReady && remoteStatus.storeState && STORE_STATE_LABELS[remoteStatus.storeState] && <div className="cc-remote-actions" role="alert">
            <p>Magazyn poświadczeń iPhone Remote: {STORE_STATE_LABELS[remoteStatus.storeState]}. Pilot pozostaje wyłączony.</p>
            {remoteStatus.storeMessage && <p>{remoteStatus.storeMessage}</p>}
            {!remoteStatus.recoveryRequired && <p className="cc-card-note">Ten stan nie wymaga kasowania danych. Zamknij drugi proces VELORA lub napraw dostęp do Magazynu poświadczeń Windows i ponów odczyt.</p>}
            {remoteStatus.recoveryRequired && !recoveryPlan && <button type="button" disabled={remoteBusy} onClick={() => void openRecovery()}>Odzyskiwanie zaufania…</button>}
            {recoveryPlan && <>
              <p>Odzyskiwanie działa wyłącznie lokalnie: zatrzymuje serwer LAN, odwołuje urządzenia i usuwa tylko wpisy VELORA iPhone Remote. Nic nie jest rotowane ani zastępowane automatycznie.</p>
              {recoveryPlan.options.map((option) => <label className="remote-trust-confirmation" key={option.mode}>
                <input type="radio" name="remote-recovery-mode" checked={recoveryChoice === option.mode}
                  onChange={() => { setRecoveryChoice(option.mode); setRecoveryAcknowledged(false); }} />
                {option.summary}
              </label>)}
              {recoveryChoice && <label className="remote-trust-confirmation">
                <input type="checkbox" checked={recoveryAcknowledged} onChange={(event) => setRecoveryAcknowledged(event.target.checked)} />
                Rozumiem, że wybrane wpisy zostaną trwale usunięte, a urządzenia trzeba sparować ponownie.
              </label>}
              <button type="button" disabled={remoteBusy || !recoveryChoice || !recoveryAcknowledged} onClick={() => void executeRecovery()}>Wykonaj odzyskiwanie</button>
            </>}
          </div>}
          {!remoteStatusReady && <p className={remoteStatusError ? "cc-feedback cc-error" : "cc-feedback"} role={remoteStatusError ? "alert" : "status"}>
            {remoteStatusLoading ? "Odczytuję bezpieczny stan iPhone Remote…" : remoteStatusError}
          </p>}
          {!remoteStatusReady && (remoteStatusLoading || remoteStatusError) && <button type="button" aria-busy={remoteStatusLoading} disabled={remoteStatusLoading} onClick={() => void readRemoteStatus()}>
            {remoteStatusLoading ? "Odczytuję…" : "Ponów odczyt statusu"}
          </button>}
          {remoteStatusReady && !remoteStatus.enabled && <div className="cc-remote-actions">
            <p>Ścieżka profilu (podgląd): <code>{trustPreview?.path ?? remoteStatus.trustProfilePath ?? "jeszcze nieprzygotowany"}</code></p>
            <p>Odcisk CA SHA-256 (podgląd): <code className="remote-fingerprint">{trustPreview?.fingerprint ?? remoteStatus.caFingerprint ?? "brak"}</code></p>
            {trustPreview?.portable && <p className="cc-card-note">Wersja przenośna: profil jest zapisywany wyłącznie w katalogu danych przenośnych, nigdy w folderze Pobrane.</p>}
            <label className="remote-trust-confirmation">
              <input type="checkbox" checked={profileApproved} onChange={(event) => {
                const checked = event.target.checked;
                setProfileApproved(checked);
                if (checked) void inspectRemoteTrustProfile().then(setTrustPreview).catch((cause: unknown) => {
                  setProfileApproved(false);
                  setRemoteError(cause instanceof Error ? cause.message : "Nie udało się odczytać podglądu profilu.");
                });
              }} />
              Rozumiem, że jednorazowe zatwierdzenie zapisze plik .mobileconfig w podanym katalogu i że muszę ręcznie przenieść go na iPhone'a.
            </label>
            <button type="button" disabled={!remoteStatusReady || remoteBusy || !profileApproved} onClick={() => void runRemoteAction(async () => {
              const approvalToken = await beginRemoteTrustProfileApproval();
              return prepareRemoteTrustProfile(approvalToken);
            }, "Profil zaufania jest gotowy do bezpiecznego przeniesienia na iPhone'a.")}>Przygotuj profil zaufania iPhone'a</button>
            {remoteStatus.trustProfilePath && <>
              <p>Profil: <code>{remoteStatus.trustProfilePath}</code></p>
              <p>SHA-256 certyfikatu: <code className="remote-fingerprint">{remoteStatus.caFingerprint}</code></p>
              <p>Przenieś profil z MSI na iPhone'a zaufanym kanałem. Zainstaluj go w Ustawienia &gt; Ogólne &gt; VPN i zarządzanie urządzeniem, a następnie ręcznie zaufaj certyfikatowi.</p>
              <p role="note">Pełne zaufanie obejmuje certyfikaty TLS wystawiane przez ten urząd certyfikacji na całym iPhonie. Klucz prywatny zostaje w Magazynie poświadczeń Windows.</p>
              <label className="remote-trust-confirmation">
                <input type="checkbox" checked={trustConfirmed} onChange={(event) => setTrustConfirmed(event.target.checked)} />
                Profil został przeniesiony zaufanym kanałem, zainstalowany na iPhonie i ręcznie oznaczony jako zaufany.
              </label>
              <button type="button" disabled={!remoteStatusReady || remoteBusy || !trustConfirmed} onClick={() => void runRemoteAction(
                () => startRemoteAccess(trustConfirmed),
                "Serwer HTTPS został włączony tylko dla prywatnego interfejsu sieciowego.",
              )}>Uruchom serwer HTTPS</button>
            </>}
            <label className="remote-trust-confirmation">
              <input type="checkbox" checked={cleanupAcknowledged} onChange={(event) => setCleanupAcknowledged(event.target.checked)} />
              Rozumiem, że cofnięcie zatrzyma serwer, usunie wygenerowany profil z katalogu przenośnego i odwoła wszystkie urządzenia.
            </label>
            <button type="button" disabled={!remoteStatusReady || remoteBusy || !cleanupAcknowledged} onClick={() => {
              if (!remoteStatusReady || remoteBusy) return;
              setRemoteBusy(true);
              setRemoteError("");
              setRemoteNotice("");
              void (async () => {
                try {
                  const approvalToken = await beginRemoteTrustProfileApproval();
                  const report = await cleanupRemoteTrustArtifacts(approvalToken);
                  setRemoteStatus(await getRemoteAccessStatus());
                  setProfileApproved(false);
                  setCleanupAcknowledged(false);
                  setTrustPreview(null);
                  setRemoteNotice(`Cofnięcie: serwer zatrzymany=${report.serverStopped}, profil usunięty=${report.profileRemoved}, urządzenia odwołane=${report.devicesRevoked}. ${report.note}`);
                } catch (cause) {
                  setRemoteError(cause instanceof Error ? cause.message : "Nie udało się cofnąć danych zaufania.");
                } finally {
                  setRemoteBusy(false);
                }
              })();
            }}>Wyczyść dane zaufania (cofnij)</button>
            <p className="cc-card-note">{REMOTE_ACCESS_DISABLED_REASON} Serwer domyślnie nie nasłuchuje w sieci.</p>
          </div>}
          {remoteStatusReady && remoteStatus.enabled && <div className="cc-remote-actions">
            <p>Adres iPhone'a: <code>{remoteStatus.origin}</code></p>
            <button type="button" disabled={!remoteStatusReady || remoteBusy} onClick={() => void runRemoteAction(
              beginRemotePairing,
              "Kod jednorazowy wygasa po 60 sekundach.",
            )}>Wygeneruj kod parowania</button>
            {remoteStatus.pairingCode && <div className="remote-pairing-bootstrap">
              <p className="remote-pairing-code" role="status">Kod iPhone: {remoteStatus.pairingCode} · {pairingCountdown}</p>
              {pairingQr && <>
                <PairingQrCode modules={pairingQr.modules} label="Kod QR jednorazowego parowania iPhone Remote" />
                <p className="cc-card-note">Zeskanuj kod QR i otwórz dokładny adres HTTPS. Kod zawiera tylko jednorazowy numer, adres serwera i krótki czas ważności — bez żadnego sekretu, tokenu ani klucza.</p>
              </>}
              <p className="cc-card-note">Kod jednorazowy wygasa po 60 sekundach i nie może być użyty ponownie. Ręczne wpisanie kodu w PWA pozostaje zawsze dostępne.</p>
            </div>}
            <button type="button" disabled={!remoteStatusReady || remoteBusy} onClick={() => void runRemoteAction(
              stopRemoteAccess,
              "Serwer LAN został wyłączony.",
            )}>Wyłącz serwer LAN</button>
          </div>}
          {remoteStatusReady && remoteStatus.pairedDevices.map((device) => <div className="remote-device-row" key={device.id}>
            <span>{device.name}</span>
            <button type="button" disabled={!remoteStatusReady || remoteBusy} onClick={() => void runRemoteAction(
              () => revokeRemoteDevice(device.id),
              `Dostęp dla ${device.name} został odwołany.`,
            )}>Odwołaj</button>
          </div>)}
          {remoteStatusReady && remoteStatus.pairedDeviceCount > 0 && <button type="button" disabled={!remoteStatusReady || remoteBusy} onClick={() => void runRemoteAction(
            revokeAllRemoteDevices,
            "Dostęp wszystkich sparowanych urządzeń został odwołany.",
          )}>Odwołaj wszystkie urządzenia</button>}
          {remoteError && <p className="cc-feedback cc-error" role="alert">{remoteError}</p>}
          {remoteNotice && <p className="cc-feedback" role="status">{remoteNotice}</p>}
          <p className="cc-card-note">Pilot obsługuje nawigację VELORA, wybór, Wstecz, Home, panel, wybór aplikacji, głośność i profile. Nie omijaj ostrzeżeń TLS w Safari.</p>
        </div>
      </section>
    </div>

    <footer className="cc-footer">
      <span className="cc-footer-hint">{props.livingRoom
        ? <>Zamknij · Esc / <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /></svg></>
        : "F3 otwiera panel · Esc wraca · ← → przełączają sekcję"}</span>
      <div className="cc-footer-actions">
        {props.onSwitchApplications && <div className="cc-footer-group" role="group" aria-label="Aplikacje">
          <button type="button" data-remote-allow="" onClick={props.onSwitchApplications}>Przełącz aplikację</button>
        </div>}
        <div className="cc-footer-group" role="group" aria-label="Wyjście">
          <button type="button" data-remote-allow="" onClick={props.onShowDesktop}>{props.livingRoom ? "Pulpit Windows" : "Pokaż pulpit"}</button>
          <button type="button" data-remote-allow="" onClick={props.onReturnToNexus}>{props.livingRoom ? "Ekran główny" : "Wróć do VELORA"}</button>
        </div>
        <div className="cc-footer-group cc-footer-group-help" role="group" aria-label="Pomoc">
          <button type="button" data-remote-allow="" onClick={props.onOpenDiagnostics}>Diagnostyka</button>
        </div>
      </div>
    </footer>
    <p className="cc-hint">Sterowanie z kanapy: strzałki wybierają · Enter zatwierdza · Escape wraca</p>
  </dialog>;
}
