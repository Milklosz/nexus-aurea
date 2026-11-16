import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { AudioEndpointInfo } from "../services/displayAudio";
import { getSystemAudio, setSystemAudioMute, setSystemAudioVolume } from "../services/audioControl";
import "./AudioControls.css";

/** Core Audio writes occur only from deliberate user button actions. */
export function AudioControls() {
  const native = isTauri();
  const [audio, setAudio] = useState<AudioEndpointInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const inFlight = useRef(false);

  const perform = async (operation: () => Promise<AudioEndpointInfo>) => {
    if (!native || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await operation();
      if (alive.current) setAudio(next);
    } catch (cause) {
      if (alive.current) {
        setAudio(null);
        setError(typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "Nie można odczytać dźwięku.");
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    if (!native) return () => { alive.current = false; };
    void perform(getSystemAudio);
    const refresh = () => { if (document.visibilityState === "visible") void perform(getSystemAudio); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [native]);

  const changeVolume = (delta: number) => {
    if (audio?.volumePercent == null) return;
    const percent = Math.max(0, Math.min(100, audio.volumePercent + delta));
    void perform(() => setSystemAudioVolume(percent, audio.id));
  };

  return <section className="audio-controls" aria-label="Dźwięk systemowy" data-remote-allow="">
    <div className="audio-controls-heading"><strong>Dźwięk</strong><span>{audio?.name ?? "Wyjście niedostępne"}</span></div>
    <p aria-live="polite">{!native ? "Podgląd przeglądarkowy — sterowanie dźwiękiem wymaga aplikacji Windows." : audio?.volumePercent == null ? "Głośność niedostępna" : `${audio.volumePercent}%`}{audio?.muted ? " · wyciszone" : ""}</p>
    <div className="audio-controls-actions" aria-busy={busy}>
      <button type="button" disabled={busy || audio?.volumePercent == null || audio.volumePercent <= 0} onClick={() => changeVolume(-5)} aria-label="Ciszej o 5 procent">Ciszej</button>
      <button type="button" disabled={busy || audio?.volumePercent == null || audio.volumePercent >= 100} onClick={() => changeVolume(5)} aria-label="Głośniej o 5 procent">Głośniej</button>
      <button type="button" disabled={busy || audio?.muted == null} aria-pressed={audio?.muted ?? false}
        onClick={() => { if (audio?.muted != null) void perform(() => setSystemAudioMute(!audio.muted, audio.id)); }}>
        {audio?.muted ? "Włącz dźwięk" : "Wycisz"}
      </button>
      <button type="button" disabled={!native || busy} onClick={() => void perform(getSystemAudio)}>Odśwież dźwięk</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
