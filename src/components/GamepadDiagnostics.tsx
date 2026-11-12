import { useEffect, useRef, useState } from "react";
import { gamepadSnapshot } from "../services/gamepadSnapshot";
import { ControlServicePanel } from "./ControlServicePanel";
import { SystemDiagnosticsPanel } from "./SystemDiagnosticsPanel";
import { AppManagerPanel } from "./AppManagerPanel";
import { CinemaPanel } from "./CinemaPanel";
import { MusicPanel } from "./MusicPanel";
import type { CinemaProfile } from "../services/cinemaMode";
import type { AppleMusicAction, AppleMusicStatus, SystemVolumeAction } from "../services/musicBridge";
import {
  resolveControllerProfile,
  type ControllerProfile,
} from "../services/controllerEngine";

type GamepadDiagnosticsProps = {
  profile: ControllerProfile;
  onProfileChange: (profile: ControllerProfile) => void;
  cinemaProfile: CinemaProfile;
  onCinemaProfileChange: (profile: CinemaProfile) => void;
  onShowDesktop: () => void;
  musicStatus: AppleMusicStatus;
  musicBackgroundMode: boolean;
  onMusicBackgroundModeChange: (enabled: boolean) => void;
  onMusicRefresh: () => Promise<void>;
  onMusicControl: (action: AppleMusicAction) => Promise<void>;
  onSystemVolume: (action: SystemVolumeAction) => Promise<void>;
  onOpenAppleMusic: () => Promise<void>;
  onClose: () => void;
};

const profileLabels: Record<ControllerProfile, string> = {
  auto: "Auto",
  standard: "Standard",
  playstation: "PlayStation (surowe)",
};

const profiles: ControllerProfile[] = ["auto", "standard", "playstation"];

export function GamepadDiagnostics({
  profile,
  onProfileChange,
  cinemaProfile,
  onCinemaProfileChange,
  onShowDesktop,
  musicStatus,
  musicBackgroundMode,
  onMusicBackgroundModeChange,
  onMusicRefresh,
  onMusicControl,
  onSystemVolume,
  onOpenAppleMusic,
  onClose,
}: GamepadDiagnosticsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pads, setPads] = useState<ReturnType<typeof gamepadSnapshot>>([]);
  const [focused, setFocused] = useState(false);
  const supported = typeof navigator.getGamepads === "function";
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const update = () => {
      let connected: ReturnType<typeof gamepadSnapshot> = [];
      try {
        connected = supported ? gamepadSnapshot(navigator.getGamepads()) : [];
      } catch {
        connected = [];
      }
      setPads(connected);
      setFocused(document.hasFocus() && document.visibilityState === "visible");
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => { window.clearInterval(timer); element?.close(); };
  }, [supported]);
  const cycleProfile = () => {
    const index = profiles.indexOf(profile);
    onProfileChange(profiles[(index + 1) % profiles.length]);
  };

  return <dialog ref={dialog} className="diagnostics" onCancel={onClose} aria-labelledby="pad-title">
    <h2 id="pad-title">Diagnostyka pada PlayStation</h2>
    <p>{supported ? "Gamepad API dostępne" : "Gamepad API niedostępne"} · Połączone: {pads.length} · Fokus VELORA: {focused ? "aktywny" : "nieaktywny"}</p>
    <p>Naciśnij przycisk pada, gdy VELORA ma fokus. Windows może wykrywać urządzenie, zanim udostępni je Gamepad API.</p>
    <p>← / → lub lewy analog porusza fokusem. ✕ wybiera, ◯ wraca, Options otwiera Control Center. F2 otwiera diagnostykę. Przytrzymanie kierunku powtarza ruch.</p>
    <button type="button" data-remote-allow="" onClick={cycleProfile}>Mapowanie: {profileLabels[profile]} · zmień</button>
    {pads.map(pad => {
      const resolvedProfile = resolveControllerProfile(pad, profile);
      const confirmButton = resolvedProfile === "playstation" ? 1 : 0;
      const backButton = resolvedProfile === "playstation" ? 2 : 1;
      return <section key={pad.index}>
        <h3>#{pad.index} {pad.id}</h3>
        <p>Mapowanie API: {pad.mapping || "niestandardowe"} · Profil wejścia: {resolvedProfile ?? "nierozpoznany"}</p>
        {resolvedProfile
          ? <p>✕ B{confirmButton} · ◯ B{backButton} · Options B9 · D-pad B14/B15 · lewy analog A0</p>
          : <p>Surowe wartości poniżej; auto nie mapuje tego pada.</p>}
        <div className="pad-values">{pad.buttons.map((button, i) => <span key={i} data-pressed={button.pressed}>B{i}: {button.value.toFixed(2)} {button.pressed ? "●" : "○"}</span>)}</div>
        <p>Osie: {pad.axes.map((value, i) => "A" + i + ": " + value.toFixed(3)).join(" · ")}</p>
      </section>;
    })}
    <CinemaPanel profile={cinemaProfile} onChange={onCinemaProfileChange} onDesktop={onShowDesktop} />
    <AppManagerPanel />
    <MusicPanel
      status={musicStatus}
      profile={cinemaProfile}
      backgroundMode={musicBackgroundMode}
      onBackgroundModeChange={onMusicBackgroundModeChange}
      onRefresh={onMusicRefresh}
      onControl={onMusicControl}
      onVolume={onSystemVolume}
      onOpenAppleMusic={onOpenAppleMusic}
    />
    <ControlServicePanel />
    <SystemDiagnosticsPanel />
    <button type="button" data-remote-allow="" onClick={onClose} autoFocus>Zamknij (Esc / ◯)</button>
  </dialog>;
}
