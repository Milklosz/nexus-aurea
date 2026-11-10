import { useEffect, useRef, useState } from "react";
import type { AppleMusicAction, AppleMusicStatus, SystemVolumeAction } from "../services/musicBridge";
import type { CinemaProfile } from "../services/cinemaMode";

type Props = {
  status: AppleMusicStatus;
  profile: CinemaProfile;
  backgroundMode: boolean;
  onBackgroundModeChange: (enabled: boolean) => void;
  onRefresh: () => Promise<void>;
  onControl: (action: AppleMusicAction) => Promise<void>;
  onVolume: (action: SystemVolumeAction) => Promise<void>;
  onOpenAppleMusic: () => Promise<void>;
};

function timeLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function MusicPanel(props: Props) {
  const [musicMode, setMusicMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstModeButton = useRef<HTMLButtonElement>(null);
  const { status, profile } = props;
  const inGameMode = profile === "gaming";

  useEffect(() => {
    if (musicMode) firstModeButton.current?.focus({ preventScroll: true });
  }, [musicMode]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Polecenie audio nie powiodło się."); }
    finally { setBusy(false); }
  };

  const controls = (mode: "panel" | "full") => <div className={`music-controls ${mode}`} role="group" aria-label="Sterowanie Apple Music">
    <button type="button" disabled={busy || inGameMode || !status.appleSessionFound || !status.canPrevious} onClick={() => void run(() => props.onControl("previous"))}>⏮ Poprzedni</button>
    <button type="button" disabled={busy || inGameMode || !status.appleSessionFound || !status.canTogglePlayPause} onClick={() => void run(() => props.onControl("toggle"))}>
      {status.playbackState === "playing" ? "⏸ Pauza" : "▶ Odtwórz"}
    </button>
    <button type="button" disabled={busy || inGameMode || !status.appleSessionFound || !status.canNext} onClick={() => void run(() => props.onControl("next"))}>Następny ⏭</button>
  </div>;

  return <section className="music-panel" aria-label="VELORA Music">
    <h3>VELORA Music · Apple Music</h3>
    <p role="status">{status.appleSessionFound
      ? `Sesja Apple Music · ${status.playbackState ?? "stan niedostępny"}`
      : status.message ?? "Nie znaleziono aktywnej sesji Apple Music."}</p>
    {status.appleSessionFound && <>
      <p><strong>{status.title ?? "Tytuł niedostępny"}</strong>{status.artist ? ` · ${status.artist}` : " · wykonawca niedostępny"}</p>
      <p>Album: {status.album ?? "niedostępny"}</p>
      {status.positionSeconds !== null && status.durationSeconds !== null && status.durationSeconds > 0
        ? <div className="music-progress"><progress max={status.durationSeconds} value={Math.min(status.positionSeconds, status.durationSeconds)} aria-label="Postęp utworu" /><span>{timeLabel(status.positionSeconds)} / {timeLabel(status.durationSeconds)}</span></div>
        : <p>Pozycja utworu: niedostępna.</p>}
    </>}
    <p>Okładka albumu: {status.artworkSupported ? "dostępna przez SMTC" : "niedostępna w tym prototypie"}.</p>
    {controls("panel")}
    <div className="launcher-actions" role="group" aria-label="Tryby VELORA Music">
      <button type="button" onClick={() => setMusicMode(true)}>Otwórz Music Mode</button>
      <button type="button" aria-pressed={props.backgroundMode} onClick={() => props.onBackgroundModeChange(!props.backgroundMode)}>
        {props.backgroundMode ? "Wyłącz Background Mode" : "Włącz Background Mode"}
      </button>
      <button type="button" disabled={busy} onClick={() => void run(props.onOpenAppleMusic)}>Otwórz oficjalną aplikację Apple Music</button>
      <button type="button" disabled={busy} onClick={() => void run(props.onRefresh)}>Odśwież sesję SMTC</button>
    </div>
    {inGameMode && <p role="status">Tryb Gaming: VELORA nie wysyła poleceń odtwarzania, aby nie zakłócać gry. Muzyka już odtwarzana może grać dalej.</p>}
    <section className="system-audio" aria-label="System audio">
      <h4>System audio</h4>
      <p>Wyjście: domyślne urządzenie Windows · nazwa urządzenia i opóźnienie Bluetooth niedostępne. Zmiany urządzenia w Windows są respektowane; VELORA nie paruje ani nie przełącza JBL.</p>
      <div className="launcher-actions" role="group" aria-label="Głośność Windows">
        <button type="button" disabled={busy} onClick={() => void run(() => props.onVolume("down"))}>Głośność −</button>
        <button type="button" disabled={busy} onClick={() => void run(() => props.onVolume("up"))}>Głośność +</button>
        <button type="button" disabled={busy} onClick={() => void run(() => props.onVolume("mute"))}>Wycisz / włącz</button>
      </div>
    </section>
    {status.message && status.appleSessionFound && <p>{status.message}</p>}
    {error && <p role="alert">{error}</p>}
    {musicMode && <section
      className="music-mode"
      aria-label="Music Mode — pełnoekranowy odtwarzacz"
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setMusicMode(false);
        }
      }}
    >
      <div className="music-mode-art" aria-hidden="true"><span>♪</span></div>
      <button className="music-mode-close" type="button" onClick={() => setMusicMode(false)}>Zamknij Music Mode</button>
      <p className="music-mode-eyebrow">VELORA MUSIC · APPLE MUSIC</p>
      <h2>{status.title ?? (status.appleSessionFound ? "Tytuł niedostępny" : "Apple Music")}</h2>
      <p className="music-mode-artist">{status.artist ?? (status.appleSessionFound ? "Wykonawca niedostępny" : "Brak aktywnej sesji SMTC")}</p>
      <p className="music-mode-album">{status.album ? `Album · ${status.album}` : "Album i okładka niedostępne"}</p>
      {status.positionSeconds !== null && status.durationSeconds !== null && status.durationSeconds > 0
        ? <div className="music-progress"><progress max={status.durationSeconds} value={Math.min(status.positionSeconds, status.durationSeconds)} aria-label="Postęp utworu" /><span>{timeLabel(status.positionSeconds)} / {timeLabel(status.durationSeconds)}</span></div>
        : <p className="music-mode-unavailable">Metadane pojawią się, jeśli Apple Music udostępni sesję w Windows SMTC.</p>}
      {controls("full")}
      <p className="music-mode-footer">Okładka albumu: niedostępna w tym prototypie · Escape / ◯ zamyka</p>
      <button ref={firstModeButton} className="music-mode-background" type="button" onClick={() => { props.onBackgroundModeChange(true); setMusicMode(false); }}>Przełącz do Background Mode</button>
    </section>}
  </section>;
}

type MiniProps = {
  status: AppleMusicStatus;
  profile: CinemaProfile;
  onControl: (action: AppleMusicAction) => Promise<void>;
};

export function MusicMiniPlayer({ status, profile, onControl }: MiniProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = status.appleSessionFound && profile !== "gaming";
  const run = async (action: AppleMusicAction) => {
    setBusy(true);
    setError("");
    try { await onControl(action); }
    catch { setError("Nie udało się sterować Apple Music. Sprawdź sesję w diagnostyce."); }
    finally { setBusy(false); }
  };
  return <aside className="music-mini-player" aria-label="Apple Music Background Mode">
    <span className="music-mini-label">BACKGROUND MODE · APPLE MUSIC</span>
    <strong>{status.title ?? (status.appleSessionFound ? "Tytuł niedostępny" : "Brak sesji Apple Music")}</strong>
    <span>{status.artist ?? "Otwórz diagnostykę, aby uruchomić Apple Music"}</span>
    {error && <span role="alert">{error}</span>}
    <div>
      <button type="button" aria-label="Poprzedni utwór" disabled={busy || !available || !status.canPrevious} onClick={() => void run("previous")}>⏮</button>
      <button type="button" aria-label={status.playbackState === "playing" ? "Pauza" : "Odtwórz"} disabled={busy || !available || !status.canTogglePlayPause} onClick={() => void run("toggle")}>{status.playbackState === "playing" ? "⏸" : "▶"}</button>
      <button type="button" aria-label="Następny utwór" disabled={busy || !available || !status.canNext} onClick={() => void run("next")}>⏭</button>
    </div>
  </aside>;
}

