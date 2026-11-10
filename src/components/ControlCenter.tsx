import { useEffect, useRef, useState } from "react";
import { disabledControlServiceStatus, getControlServiceStatus, type ControlServiceStatus } from "../services/controlService";
import type { CinemaProfile } from "../services/cinemaMode";
import type { AmbientSettings } from "../services/ambient";
import { nextAmbientDelay, AMBIENT_IDLE_OPTIONS } from "../services/ambient";
import type { SystemVolumeAction } from "../services/musicBridge";
import { GamingHub } from "./GamingHub";
import { REMOTE_ACCESS_DISABLED_REASON } from "../services/remoteAccess";

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

function delayLabel(seconds: number): string {
  return Math.round(seconds / 60) + " min";
}

export function ControlCenter(props: ControlCenterProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<ControlServiceStatus>(disabledControlServiceStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open && typeof element.showModal === "function") element.showModal();
    let active = true;
    setLoading(true);
    void getControlServiceStatus().then((next) => {
      if (active) { setStatus(next); setLoading(false); }
    }).catch(() => {
      if (active) {
        setStatus(disabledControlServiceStatus);
        setError("Nie udało się odczytać stanu Windows. Funkcje systemowe są niedostępne.");
        setLoading(false);
      }
    });
    return () => {
      active = false;
      if (element?.open) element.close();
    };
  }, []);

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

  return <dialog ref={dialog} className="control-center" aria-labelledby="control-center-title"
    onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <header className="control-center-header">
      <div>
        <span className="control-center-eyebrow">NEXUS AUREA</span>
        <h2 id="control-center-title">Control Center</h2>
      </div>
      <button type="button" onClick={props.onClose} aria-label="Zamknij Control Center">Zamknij</button>
    </header>

    <section className="cc-section" aria-label="Profile">
      <h3>Profil</h3>
      <div className="cc-actions">
        {profiles.map((profile) => <button key={profile.id} type="button"
          className={props.profile === profile.id ? "profile-active" : ""}
          aria-pressed={props.profile === profile.id} disabled={busy}
          onClick={() => void chooseProfile(profile.id)}>{profile.label}</button>)}
      </div>
      <p>Gaming steruje trybem gry wyłącznie wtedy, gdy Control Service działa. Inne ustawienia Windows nie są zmieniane.</p>
    </section>

    <section className="cc-section" aria-label="Głośność systemu">
      <h3>Głośność</h3>
      {status.windows
        ? <div className="cc-actions">
          <button type="button" disabled={busy} onClick={() => void changeVolume("down")}>Głośność −</button>
          <button type="button" disabled={busy} onClick={() => void changeVolume("mute")}>Wycisz</button>
          <button type="button" disabled={busy} onClick={() => void changeVolume("up")}>Głośność +</button>
        </div>
        : <p>Regulacja głośności jest niedostępna bez natywnego backendu Windows.</p>}
    </section>

    <section className="cc-section" aria-label="AUREA Ambient">
      <h3>AUREA Ambient</h3>
      <div className="cc-actions">
        <button type="button" aria-pressed={props.ambientSettings.enabled}
          onClick={() => props.onAmbientSettingsChange({ ...props.ambientSettings, enabled: !props.ambientSettings.enabled })}>
          {props.ambientSettings.enabled ? "Wyłącz Ambient" : "Włącz Ambient"}
        </button>
        <button type="button" onClick={cycleDelay}>Bezczynność: {delayLabel(props.ambientSettings.idleSeconds)} · zmień</button>
      </div>
      <p>{props.mediaPlaying
        ? "Wykryto odtwarzanie Apple Music przez Windows SMTC. Ambient jest wstrzymany."
        : "Ambient wstrzymuje się, gdy NEXUS traci fokus, oraz podczas wykrytego odtwarzania Apple Music. Inne gry i odtwarzacze nie mają wiarygodnego wskaźnika aktywności."}</p>
      <p>Czas bezczynności: {AMBIENT_IDLE_OPTIONS.map(delayLabel).join(" · ")}. Wymaga fokusu NEXUS; nie wyłącza ekranu ani nie zmienia zasilania Windows.</p>
    </section>

    <section className="cc-section" aria-label="Stan systemu">
      <h3>Stan systemu</h3>
      {loading
        ? <p role="status">Odczytuję stan backendu…</p>
        : <p role="status">Backend Windows: {status.windows ? "dostępny" : "niedostępny"}</p>}
      {status.windows && <p>Control Service: {status.running ? status.gameMode ? "tryb Gaming" : "aktywny" : "wyłączony"}
        {status.running
          ? " · kontrolery HID: " + status.controllerCount + " · Sony: " + status.playstationControllerCount
          : " · stan urządzeń niedostępny, monitoring jest wyłączony"}
      </p>}
      {status.foregroundProcess && <p>Aktywne okno: {status.foregroundProcess}</p>}
      {status.lastError && <p role="alert">{status.lastError}</p>}
    </section>

    <section className="cc-section" aria-label="Gaming Hub">
      <h3>Gaming Hub</h3>
      <GamingHub onActivateGaming={() => props.onProfileChange("gaming")} />
    </section>

    <section className="cc-section" aria-label="iPhone Remote">
      <h3>iPhone Remote</h3>
      <ul className="remote-access-status" aria-label="Stan iPhone Remote">
        <li>Serwer LAN: wyłączony</li>
        <li>Bezpieczny HTTPS: niedostępny</li>
        <li>Parowanie: niedostępne</li>
        <li>Sparowane urządzenia: brak</li>
      </ul>
      <p>Zdalny serwer jest wyłączony. {REMOTE_ACCESS_DISABLED_REASON}</p>
      <p>Podgląd PWA nie wysyła poleceń ani nie przechowuje sekretów. Nie otwieramy portu sieciowego.</p>
    </section>

    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <footer className="cc-footer">
      <button type="button" onClick={props.onOpenDiagnostics}>Diagnostyka</button>
      <button type="button" onClick={props.onShowDesktop}>Pokaż pulpit</button>
      <button type="button" onClick={props.onReturnToNexus}>Wróć do NEXUS</button>
    </footer>
    <p className="cc-hint">Klawiatura: Tab / Shift+Tab, F3 otwiera panel, Esc wraca. Pad: kierunki wybierają, ✕ zatwierdza, ◯ wraca.</p>
  </dialog>;
}
