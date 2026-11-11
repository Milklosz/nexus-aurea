import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { disabledControlServiceStatus, getControlServiceStatus, type ControlServiceStatus } from "../services/controlService";
import type { CinemaProfile } from "../services/cinemaMode";
import type { AmbientSettings } from "../services/ambient";
import { nextAmbientDelay, AMBIENT_IDLE_OPTIONS } from "../services/ambient";
import type { SystemVolumeAction } from "../services/musicBridge";
import { GamingHub } from "./GamingHub";
import {
  beginRemotePairing,
  disabledRemoteAccessStatus,
  getRemoteAccessStatus,
  listenForRemoteAccessStatus,
  prepareRemoteTrustProfile,
  REMOTE_ACCESS_DISABLED_REASON,
  revokeAllRemoteDevices,
  revokeRemoteDevice,
  startRemoteAccess,
  stopRemoteAccess,
  type RemoteAccessStatus,
} from "../services/remoteAccess";

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
  onClose: () => void;
};

const profiles: Array<{ id: CinemaProfile; label: string }> = [
  { id: "cinema", label: "Cinema" },
  { id: "gaming", label: "Gaming" },
  { id: "desktop", label: "Desktop" },
];

const controlPanels = [
  { id: "cinema", label: "Cinema" },
  { id: "gaming", label: "Gaming" },
  { id: "remote", label: "iPhone Remote" },
] as const;

type ControlPanelId = (typeof controlPanels)[number]["id"];

function delayLabel(seconds: number): string {
  return Math.round(seconds / 60) + " min";
}

export function ControlCenter(props: ControlCenterProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activePanel, setActivePanel] = useState<ControlPanelId>("cinema");
  const [status, setStatus] = useState<ControlServiceStatus>(disabledControlServiceStatus);
  const [loading, setLoading] = useState(true);
  const [statusReadFailed, setStatusReadFailed] = useState(false);
  const controlStatusRequestId = useRef(0);
  const controlStatusRequestInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus>(disabledRemoteAccessStatus);
  const [remoteStatusReady, setRemoteStatusReady] = useState(false);
  const [remoteStatusLoading, setRemoteStatusLoading] = useState(true);
  const [remoteStatusError, setRemoteStatusError] = useState("");
  const remoteStatusRequestId = useRef(0);
  const remoteStatusRequestInFlight = useRef(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [trustConfirmed, setTrustConfirmed] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [remoteNotice, setRemoteNotice] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const readRemoteStatus = async (isActive: () => boolean = () => true) => {
    if (remoteStatusRequestInFlight.current) return;
    remoteStatusRequestInFlight.current = true;
    const requestId = ++remoteStatusRequestId.current;
    setRemoteStatusLoading(true);
    setRemoteStatusError("");
    try {
      const next = await getRemoteAccessStatus();
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
      const next = await getControlServiceStatus();
      if (isActive() && requestId === controlStatusRequestId.current) {
        setStatus(next);
        setStatusReadFailed(false);
      }
    } catch {
      if (isActive() && requestId === controlStatusRequestId.current) {
        setStatus(disabledControlServiceStatus);
        setStatusReadFailed(true);
        setError("Nie udało się odczytać stanu Windows. Funkcje systemowe są niedostępne.");
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
    let active = true;
    void readControlStatus(() => active);
    return () => {
      active = false;
      controlStatusRequestId.current += 1;
      controlStatusRequestInFlight.current = false;
      if (element?.open) element.close();
    };
  }, []);

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
    if (!status.windows || busy) return;
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
      const index = controlPanels.findIndex((item) => item.id === panel);
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
        ? controlPanels.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + controlPanels.length) % controlPanels.length;
    selectPanel(controlPanels[nextIndex].id, true);
  };

  return <dialog ref={dialog} className="control-center" aria-labelledby="control-center-title"
    onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <header className="control-center-header">
      <div>
        <span className="control-center-eyebrow">VELORA · GRAND CINEMA</span>
        <h2 id="control-center-title">Control Center</h2>
        <p>Ustawienia konsoli multimedialnej</p>
      </div>
      <button className="cc-close" type="button" onClick={props.onClose} aria-label="Zamknij Control Center">×</button>
    </header>

    <nav className="cc-tabs" role="tablist" aria-label="Sekcje Control Center">
      {controlPanels.map((panel, index) => <button
        key={panel.id}
        ref={(element) => { tabRefs.current[index] = element; }}
        id={`cc-tab-${panel.id}`}
        type="button"
        role="tab"
        aria-selected={activePanel === panel.id}
        aria-controls={`cc-panel-${panel.id}`}
        tabIndex={activePanel === panel.id ? 0 : -1}
        onClick={() => selectPanel(panel.id)}
        onKeyDown={(event) => handleTabKeyDown(event, index)}
      >{panel.label}</button>)}
    </nav>

    <div className="cc-stage">
      <section id="cc-panel-cinema" className="cc-panel cc-cinema-panel" role="tabpanel"
        aria-labelledby="cc-tab-cinema" tabIndex={0} hidden={activePanel !== "cinema"}>
        <div className="cc-card-grid">
          <section className="cc-card" aria-label="Profil kina">
            <div className="cc-card-heading"><span className="cc-card-index">01</span><div><h3>Profil kina</h3><p>Wybierz nastrój dla tej sesji.</p></div></div>
            <div className="cc-actions cc-profile-actions">
              {profiles.map((profile) => <button key={profile.id} type="button"
                className={props.profile === profile.id ? "profile-active" : ""}
                aria-pressed={props.profile === profile.id} disabled={busy}
                onClick={() => void chooseProfile(profile.id)}>{profile.label}</button>)}
            </div>
            <p>Gaming steruje trybem gry tylko wtedy, gdy Control Service działa. Inne ustawienia Windows nie są zmieniane.</p>
          </section>

          <section className="cc-card" aria-label="Dźwięk systemu">
            <div className="cc-card-heading"><span className="cc-card-index">02</span><div><h3>Dźwięk</h3><p>Głośność systemowa Windows.</p></div></div>
            {status.windows
              ? <div className="cc-actions cc-volume-actions">
                <button type="button" disabled={busy} onClick={() => void changeVolume("down")} aria-label="Głośność −">−</button>
                <button type="button" disabled={busy} onClick={() => void changeVolume("mute")}>Wycisz</button>
                <button type="button" disabled={busy} onClick={() => void changeVolume("up")} aria-label="Głośność +">+</button>
              </div>
              : <p>Regulacja głośności wymaga natywnego backendu Windows.</p>}
          </section>

          <section className="cc-card cc-card-wide" aria-label="VELORA Ambient">
            <div className="cc-card-heading"><span className="cc-card-index">03</span><div><h3>VELORA Ambient</h3><p>Przyciemnienie ekranu po okresie bezczynności.</p></div></div>
            <div className="cc-actions cc-ambient-actions">
              <button type="button" aria-pressed={props.ambientSettings.enabled}
                onClick={() => props.onAmbientSettingsChange({ ...props.ambientSettings, enabled: !props.ambientSettings.enabled })}>
                {props.ambientSettings.enabled ? "Wyłącz Ambient" : "Włącz Ambient"}
              </button>
              <button type="button" onClick={cycleDelay}>Bezczynność: {delayLabel(props.ambientSettings.idleSeconds)} · zmień</button>
            </div>
            <p>{props.mediaPlaying
              ? "Wykryto odtwarzanie Apple Music przez Windows SMTC. Ambient jest wstrzymany."
              : "Ambient wstrzymuje się, gdy VELORA traci fokus lub wykryje odtwarzanie Apple Music."}</p>
            <p className="cc-card-note">Dostępne czasy: {AMBIENT_IDLE_OPTIONS.map(delayLabel).join(" · ")}. Ambient nie zmienia ustawień zasilania Windows.</p>
          </section>

          <section className="cc-card cc-card-wide cc-system-card" aria-label="Stan systemu">
            <div className="cc-card-heading"><span className="cc-card-index">04</span><div><h3>Stan systemu</h3><p>Windows i kontroler.</p></div></div>
            <div className="cc-system-status">
              {loading
                ? <p role="status">Odczytuję stan backendu…</p>
                : <p role="status"><span className={`cc-status-dot ${status.windows ? "is-ready" : ""}`} />Backend Windows: {status.windows ? "dostępny" : "niedostępny"}</p>}
              {status.windows && <p>Control Service: {status.running ? status.gameMode ? "tryb Gaming" : "aktywny" : "wyłączony"}
                {status.running
                  ? " · kontrolery HID: " + status.controllerCount + " · Sony: " + status.playstationControllerCount
                  : " · monitoring urządzeń jest wyłączony"}
              </p>}
              {status.foregroundProcess && <p>Aktywne okno: {status.foregroundProcess}</p>}
              {status.lastError && <p role="alert">{status.lastError}</p>}
            </div>
            {statusReadFailed && <button type="button" aria-busy={loading} disabled={loading} onClick={() => void readControlStatus()}>
              {loading ? "Odczytuję…" : "Ponów odczyt statusu Windows"}
            </button>}
          </section>
        </div>
        {error && <p className="cc-feedback cc-error" role="alert">{error}</p>}
        {notice && <p className="cc-feedback" role="status">{notice}</p>}
      </section>

      <section id="cc-panel-gaming" className="cc-panel cc-gaming-panel" role="tabpanel"
        aria-labelledby="cc-tab-gaming" tabIndex={0} hidden={activePanel !== "gaming"}>
        <div className="cc-card cc-gaming-card">
          <div className="cc-card-heading"><span className="cc-card-index">05</span><div><h3>Gaming Hub</h3><p>Gry i launchery zainstalowane na tym komputerze.</p></div></div>
          <GamingHub onActivateGaming={() => props.onProfileChange("gaming")} />
        </div>
      </section>

      <section id="cc-panel-remote" className="cc-panel cc-remote-panel" role="tabpanel"
        aria-labelledby="cc-tab-remote" tabIndex={0} hidden={activePanel !== "remote"}>
        <div className="cc-card cc-remote-card">
          <div className="cc-card-heading"><span className="cc-card-index">06</span><div><h3>iPhone Remote</h3><p>Pilot pozostaje wyłączony do czasu ręcznego, bezpiecznego sparowania.</p></div></div>
          <ul className="remote-access-status" aria-label="Stan iPhone Remote">
            <li><span>Serwer LAN</span><strong>{remoteStatusReady ? remoteStatus.enabled ? "włączony" : "wyłączony" : "stan nieznany"}</strong></li>
            <li><span>HTTPS</span><strong>{remoteStatusReady ? remoteStatus.secureOriginAvailable ? "aktywny · wymaga zaufanego certyfikatu" : "wyłączony" : "stan nieznany"}</strong></li>
            <li><span>Parowanie</span><strong>{!remoteStatusReady ? "stan nieznany" : remoteStatus.pairingCode
              ? `kod jednorazowy · ${remoteStatus.pairingExpiresInSeconds}s`
              : remoteStatus.pairingAvailable ? "gotowe po wygenerowaniu kodu" : "wyłączone"}</strong></li>
            <li><span>Sparowane urządzenia</span><strong>{remoteStatusReady ? remoteStatus.pairedDeviceCount : "?"}</strong></li>
          </ul>
          {!remoteStatusReady && <p className={remoteStatusError ? "cc-feedback cc-error" : "cc-feedback"} role={remoteStatusError ? "alert" : "status"}>
            {remoteStatusLoading ? "Odczytuję bezpieczny stan iPhone Remote…" : remoteStatusError}
          </p>}
          {!remoteStatusReady && (remoteStatusLoading || remoteStatusError) && <button type="button" aria-busy={remoteStatusLoading} disabled={remoteStatusLoading} onClick={() => void readRemoteStatus()}>
            {remoteStatusLoading ? "Odczytuję…" : "Ponów odczyt statusu"}
          </button>}
          {remoteStatusReady && !remoteStatus.enabled && <div className="cc-remote-actions">
            <button type="button" disabled={!remoteStatusReady || remoteBusy} onClick={() => void runRemoteAction(
              prepareRemoteTrustProfile,
              "Profil zaufania jest gotowy do bezpiecznego przeniesienia na iPhone'a.",
            )}>Przygotuj profil zaufania iPhone'a</button>
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
            <p className="cc-card-note">{REMOTE_ACCESS_DISABLED_REASON} Serwer domyślnie nie nasłuchuje w sieci.</p>
          </div>}
          {remoteStatusReady && remoteStatus.enabled && <div className="cc-remote-actions">
            <p>Adres iPhone'a: <code>{remoteStatus.origin}</code></p>
            <button type="button" disabled={!remoteStatusReady || remoteBusy} onClick={() => void runRemoteAction(
              beginRemotePairing,
              "Kod jednorazowy wygasa po 60 sekundach.",
            )}>Wygeneruj kod parowania</button>
            {remoteStatus.pairingCode && <p className="remote-pairing-code" role="status">Kod iPhone: {remoteStatus.pairingCode} · {remoteStatus.pairingExpiresInSeconds}s</p>}
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
          <p className="cc-card-note">Pilot obsługuje nawigację, wybór, Wstecz, Home, głośność i profile. Nie omijaj ostrzeżeń TLS w Safari.</p>
        </div>
      </section>
    </div>

    <footer className="cc-footer">
      <span className="cc-footer-hint">F3 otwiera panel · Esc wraca · ← → przełączają sekcję</span>
      <div>
        <button type="button" onClick={props.onOpenDiagnostics}>Diagnostyka</button>
      <button type="button" onClick={props.onShowDesktop}>Pokaż pulpit</button>
      <button type="button" onClick={props.onReturnToNexus}>Wróć do VELORA</button>
      </div>
    </footer>
    <p className="cc-hint">Sterowanie z kanapy: strzałki wybierają · Enter zatwierdza · Escape wraca</p>
  </dialog>;
}
