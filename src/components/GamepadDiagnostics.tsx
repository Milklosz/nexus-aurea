import { useEffect, useRef, useState } from "react";
import { gamepadSnapshot } from "../services/gamepadSnapshot";
import {
  resolveControllerProfile,
  type ControllerProfile,
} from "../services/controllerEngine";
import {
  getPlatformLauncherStatus,
  type PlatformLauncherId,
  type PlatformLauncherStatus,
} from "../services/platformLaunchers";

type GamepadDiagnosticsProps = {
  profile: ControllerProfile;
  onProfileChange: (profile: ControllerProfile) => void;
  onLaunch: (launcher: PlatformLauncherId) => Promise<void>;
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
  onLaunch,
  onClose,
}: GamepadDiagnosticsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pads, setPads] = useState<ReturnType<typeof gamepadSnapshot>>([]);
  const [focused, setFocused] = useState(false);
  const [launcherStatus, setLauncherStatus] = useState<PlatformLauncherStatus | null>(null);
  const [launcherError, setLauncherError] = useState(false);
  const [launching, setLaunching] = useState<PlatformLauncherId | null>(null);
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
  useEffect(() => {
    let active = true;
    void getPlatformLauncherStatus().then((status) => {
      if (active) setLauncherStatus(status);
    }).catch(() => {
      if (active) setLauncherError(true);
    });
    return () => { active = false; };
  }, []);

  const cycleProfile = () => {
    const index = profiles.indexOf(profile);
    onProfileChange(profiles[(index + 1) % profiles.length]);
  };

  const launch = async (launcher: PlatformLauncherId) => {
    setLaunching(launcher);
    try {
      await onLaunch(launcher);
    } finally {
      setLaunching(null);
    }
  };

  return <dialog ref={dialog} className="diagnostics" onCancel={onClose} aria-labelledby="pad-title">
    <h2 id="pad-title">Diagnostyka pada PlayStation</h2>
    <p>{supported ? "Gamepad API dostępne" : "Gamepad API niedostępne"} · Połączone: {pads.length} · Fokus NEXUS: {focused ? "aktywny" : "nieaktywny"}</p>
    <p>Naciśnij przycisk pada, gdy NEXUS ma fokus. Windows może wykrywać urządzenie, zanim udostępni je Gamepad API.</p>
    <p>← / → lub lewy analog porusza fokusem. ✕ wybiera, ◯ wraca, Options otwiera lub zamyka ten panel. Przytrzymanie kierunku powtarza ruch.</p>
    <button type="button" onClick={cycleProfile}>Mapowanie: {profileLabels[profile]} · zmień</button>
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
    <section className="launcher-panel" aria-label="Launchery opcjonalne">
      <h3>Launchery Windows</h3>
      <p>NEXUS nie instaluje ani nie zmienia ustawień tych aplikacji. Po uruchomieniu pozostaje dostępny po powrocie fokusu.</p>
      {launcherError && <p role="status">Nie udało się sprawdzić instalacji.</p>}
      {!launcherError && !launcherStatus && <p role="status">Sprawdzam dostępność…</p>}
      {launcherStatus && !launcherStatus.windows && <p role="status">Uruchamianie dostępne tylko w aplikacji Windows. Kafelki usług NEXUS działają bez zmian.</p>}
      {launcherStatus?.windows && (
        <>
          <div className="launcher-actions">
            <button type="button" disabled={!launcherStatus.steamAvailable || launching !== null} onClick={() => void launch("steamBigPicture")}>
              {launching === "steamBigPicture" ? "Uruchamiam Steam…" : "Steam Big Picture"}
            </button>
            <button type="button" disabled={!launcherStatus.playniteAvailable || launching !== null} onClick={() => void launch("playniteFullscreen")}>
              {launching === "playniteFullscreen" ? "Uruchamiam Playnite…" : "Playnite Fullscreen"}
            </button>
          </div>
          <p role="status">
            {!launcherStatus.steamAvailable && !launcherStatus.playniteAvailable
              ? "Nie wykryto Steam ani Playnite w typowych folderach instalacji. Możesz zamknąć panel i korzystać z NEXUS."
              : (!launcherStatus.steamAvailable ? "Steam niewykryty. " : "") + (!launcherStatus.playniteAvailable ? "Playnite niewykryty." : "")}
          </p>
        </>
      )}
    </section>
    <button type="button" onClick={onClose} autoFocus>Zamknij (Esc / ◯)</button>
  </dialog>;
}
