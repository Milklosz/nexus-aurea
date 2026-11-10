import { GamepadDiagnostics } from "./components/GamepadDiagnostics";
import { useAppVersion } from "./hooks/useAppVersion";
import { windowMode } from "./services/windowMode";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppDock } from "./components/AppDock";
import { HeroPanel } from "./components/HeroPanel";
import { StatusBar } from "./components/StatusBar";
import { Toast } from "./components/Toast";
import { streamingServices } from "./data/streamingServices";
import { useClock } from "./hooks/useClock";
import { useGamepad } from "./hooks/useGamepad";
import { useNavigation } from "./hooks/useNavigation";
import { useFocusRestoreOnClose } from "./hooks/useFocusRestoreOnClose";
import { useToast } from "./hooks/useToast";
import { useWeather } from "./hooks/useWeather";
import { openStreamingService } from "./services/openStreamingService";
import { getControlServiceStatus, listenForNexusControlReturn, setControlGameMode } from "./services/controlService";
import { launchManagedApp, listenForManagedAppExit } from "./services/appManager";
import { readCinemaProfile, saveCinemaProfile, type CinemaProfile } from "./services/cinemaMode";
import {
  adjustSystemVolume,
  controlAppleMusic,
  getAppleMusicStatus,
  readMusicBackgroundMode,
  saveMusicBackgroundMode,
  unavailableAppleMusicStatus,
  type AppleMusicAction,
  type AppleMusicStatus,
  type SystemVolumeAction,
} from "./services/musicBridge";
import { MusicMiniPlayer } from "./components/MusicPanel";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ControllerProfile } from "./services/controllerEngine";
import "./styles.css";

function savedControllerProfile(): ControllerProfile {
  try {
    const value = localStorage.getItem("nexus.controllerProfile");
    if (value === "standard" || value === "playstation") return value;
  } catch {
    // Storage can be unavailable in restricted webviews; automatic mapping still works.
  }
  return "auto";
}

export default function App() {
  const version = useAppVersion();
  const [diagnostics, setDiagnostics] = useState(false);
  const [controllerProfile, setControllerProfile] = useState<ControllerProfile>(savedControllerProfile);
  const [cinemaProfile, setCinemaProfile] = useState<CinemaProfile>(readCinemaProfile);
  const [musicBackgroundMode, setMusicBackgroundMode] = useState(readMusicBackgroundMode);
  const [musicStatus, setMusicStatus] = useState<AppleMusicStatus>(unavailableAppleMusicStatus);
  const { now, time } = useClock();
  const { label: weatherLabel, title: weatherTitle } = useWeather();
  const { message, showToast } = useToast();
  const activeServiceRef = useRef(0);
  const showMenu = useCallback(() => setDiagnostics(true), []);
  const showRecommendation = useCallback(
    () => showToast("„Nocna zmiana” to karta demonstracyjna. Wybierz usługę z docka."),
    [showToast],
  );

  const openService = useCallback(
    async (index: number) => {
      const service = streamingServices[index];
      try {
        await openStreamingService(service);
      } catch {
        showToast(`Nie udało się otworzyć ${service.name}. Spróbuj ponownie.`);
      }
    },
    [showToast],
  );
  const activateSelected = useCallback(() => void openService(activeServiceRef.current), [openService]);
  const navigation = useNavigation(streamingServices.length, activateSelected, showMenu);
  const restoreSelectedFocus = useCallback(
    () => navigation.focusApp(activeServiceRef.current),
    [navigation.focusApp],
  );
  useFocusRestoreOnClose(diagnostics, restoreSelectedFocus);
  const closeDiagnostics = useCallback(() => setDiagnostics(false), []);
  const moveControllerFocus = useCallback((delta: -1 | 1) => {
    const dialog = document.querySelector("dialog[open]");
    if (!dialog) {
      navigation.moveApp(delta);
      return;
    }
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
      "button:not(:disabled), select:not(:disabled)",
    ));
    const index = controls.indexOf(document.activeElement as HTMLElement);
    const nextIndex = index < 0
      ? (delta > 0 ? 0 : controls.length - 1)
      : (index + delta + controls.length) % controls.length;
    controls[nextIndex]?.focus({ preventScroll: true });
  }, [navigation.moveApp]);
  const confirmControllerFocus = useCallback(() => {
    const dialog = document.querySelector("dialog[open]");
    const active = document.activeElement;
    if (dialog && active instanceof HTMLElement && dialog.contains(active)) {
      active.click();
      return;
    }
    activateSelected();
  }, [activateSelected]);
  const backControllerFocus = useCallback(() => {
    if (document.querySelector("dialog[open]")) {
      closeDiagnostics();
      return;
    }
    navigation.focusApp(0);
  }, [closeDiagnostics, navigation.focusApp]);
  const toggleDiagnostics = useCallback(() => setDiagnostics((open) => !open), []);
  const updateControllerProfile = useCallback((profile: ControllerProfile) => {
    setControllerProfile(profile);
    try {
      localStorage.setItem("nexus.controllerProfile", profile);
    } catch {
      // The selected mapping remains active for this session.
    }
  }, []);
  const changeCinemaProfile = useCallback(async (nextProfile: CinemaProfile) => {
    const previous = cinemaProfile;
    try {
      if (nextProfile === "cinema") await windowMode(true);
      if (nextProfile === "desktop") await windowMode(false);
      if ((nextProfile === "gaming" || previous === "gaming") && nextProfile !== previous) {
        const status = await getControlServiceStatus();
        if (status.running) await setControlGameMode(nextProfile === "gaming");
      }
    } catch {
      showToast("Nie udało się zastosować całego profilu. Sprawdź tryb okna i Control Service.");
      return;
    }
    setCinemaProfile(nextProfile);
    saveCinemaProfile(nextProfile);
    showToast(nextProfile === "desktop" ? "Profil Desktop · pulpit Windows." : `Profil ${nextProfile === "cinema" ? "Cinema" : "Gaming"} aktywny.`);
  }, [cinemaProfile, showToast]);
  const showDesktop = useCallback(() => void changeCinemaProfile("desktop"), [changeCinemaProfile]);
  const refreshMusicStatus = useCallback(async () => {
    setMusicStatus(await getAppleMusicStatus());
  }, []);
  useEffect(() => {
    if (!diagnostics && !musicBackgroundMode) return;
    let active = true;
    const refresh = () => void getAppleMusicStatus().then(status => { if (active) setMusicStatus(status); }).catch(() => {
      if (active) setMusicStatus({ ...unavailableAppleMusicStatus, windows: true, message: "Nie udało się odczytać sesji Windows SMTC." });
    });
    refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [diagnostics, musicBackgroundMode]);
  const changeMusicBackgroundMode = useCallback((enabled: boolean) => {
    setMusicBackgroundMode(enabled);
    saveMusicBackgroundMode(enabled);
    showToast(enabled ? "Apple Music Background Mode włączony." : "Apple Music Background Mode wyłączony.");
  }, [showToast]);
  const handleMusicControl = useCallback(async (action: AppleMusicAction) => {
    await controlAppleMusic(action);
    await refreshMusicStatus();
  }, [refreshMusicStatus]);
  const handleSystemVolume = useCallback((action: SystemVolumeAction) => adjustSystemVolume(action), []);
  const openAppleMusic = useCallback(async () => {
    const receipt = await launchManagedApp("appleMusic");
    showToast(receipt.alreadyRunning ? "Apple Music już działa." : "Uruchamiam oficjalną aplikację Apple Music.");
    window.setTimeout(() => void refreshMusicStatus().catch(() => showToast("Nie udało się odczytać sesji Windows SMTC.")), 1800);
  }, [refreshMusicStatus, showToast]);
  useGamepad({
    move: moveControllerFocus,
    confirm: confirmControllerFocus,
    back: backControllerFocus,
    options: toggleDiagnostics,
  }, true, controllerProfile);
  useEffect(() => {
    const recover = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "F11") {
        event.preventDefault();
        void windowMode(event.key === "Escape" ? false : undefined)
          .catch(() => showToast("Nie udało się zmienić trybu okna. Uruchom z --windowed."));
      }
      if (event.key === "F2") setDiagnostics(true);
    };
    const restore = () => { if (!diagnostics) navigation.focusApp(activeServiceRef.current); };
    window.addEventListener("keydown", recover);
    window.addEventListener("focus", restore);
    return () => { window.removeEventListener("keydown", recover); window.removeEventListener("focus", restore); };
  }, [diagnostics, navigation.focusApp, showToast]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForNexusControlReturn(() => {
      if (!active) return;
      void getCurrentWindow().setFocus().catch(() => {
        showToast("Windows zablokował powrót do NEXUS. Wróć do aplikacji przez Alt+Tab.");
      });
    }).then((stopListening) => {
      if (active) unlisten = stopListening;
      else stopListening();
    }).catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [showToast]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForManagedAppExit((id) => {
      if (!active || id !== "playniteFullscreen") return;
      void getCurrentWindow().setFocus().catch(() => {
        showToast("Playnite został zamknięty. Wróć do NEXUS przez Alt+Tab.");
      });
    }).then((stopListening) => {
      if (active) unlisten = stopListening;
      else stopListening();
    }).catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [showToast]);

  const handleFocus = useCallback(
    (index: number) => {
      activeServiceRef.current = index;
      navigation.noteFocus(index);
    },
    [navigation.noteFocus],
  );
  const handleActivate = useCallback(
    (index: number) => {
      activeServiceRef.current = index;
      void openService(index);
    },
    [openService],
  );

  return (
    <main className="screen" aria-label="NEXUS AUREA — ekran główny">
      <div className="sun" aria-hidden="true" />
      <div className="ridge" aria-hidden="true" />
      <div className="ridge back" aria-hidden="true" />
      <StatusBar now={now} time={time} weatherLabel={weatherLabel} weatherTitle={weatherTitle} />
      <HeroPanel onWatch={showRecommendation} />
      <AppDock
        services={streamingServices}
        activeIndex={navigation.activeIndex}
        buttonRefs={navigation.buttonRefs}
        onFocus={handleFocus}
        onActivate={handleActivate}
      />
      {musicBackgroundMode && <MusicMiniPlayer status={musicStatus} profile={cinemaProfile} onControl={handleMusicControl} />}
      <footer className="controls">
        <span>
          ◯ / <kbd>←</kbd> <kbd>→</kbd> &nbsp;PORUSZAJ &nbsp;·&nbsp; ✕ / <kbd>ENTER</kbd> &nbsp;WYBIERZ
          &nbsp;·&nbsp; OPTIONS / F2 &nbsp;PAD · F11 &nbsp;EKRAN · ESC &nbsp;OKNO
        </span>
        <span className="version">AUREA &nbsp;/&nbsp; V{version}</span>
      </footer>
      <button className="diagnostics-trigger" onClick={showMenu}>Diagnostyka pada</button>
      {diagnostics && <GamepadDiagnostics
        profile={controllerProfile}
        onProfileChange={updateControllerProfile}
        cinemaProfile={cinemaProfile}
        onCinemaProfileChange={(profile) => void changeCinemaProfile(profile)}
        onShowDesktop={showDesktop}
        musicStatus={musicStatus}
        musicBackgroundMode={musicBackgroundMode}
        onMusicBackgroundModeChange={changeMusicBackgroundMode}
        onMusicRefresh={refreshMusicStatus}
        onMusicControl={handleMusicControl}
        onSystemVolume={handleSystemVolume}
        onOpenAppleMusic={openAppleMusic}
        onClose={closeDiagnostics}
      />}
      <Toast message={message} />
    </main>
  );
}

