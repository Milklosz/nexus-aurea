import { GamepadDiagnostics } from "./components/GamepadDiagnostics";
import { ControlCenter } from "./components/ControlCenter";
import { AmbientScreen } from "./components/AmbientScreen";
import { useAmbient } from "./hooks/useAmbient";
import { readAmbientSettings, saveAmbientSettings, type AmbientSettings } from "./services/ambient";
import { useAppVersion } from "./hooks/useAppVersion";
import { minimizeWindowToDesktop, windowMode } from "./services/windowMode";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppDock } from "./components/AppDock";
import { HeroPanel } from "./components/HeroPanel";
import { StatusBar } from "./components/StatusBar";
import { Toast } from "./components/Toast";
import { streamingServices } from "./data/streamingServices";
import { useClock } from "./hooks/useClock";
import { useGamepad } from "./hooks/useGamepad";
import { useControllerOwnershipSuspension } from "./hooks/useControllerOwnershipSuspension";
import { isTextEntryTarget, useNavigation } from "./hooks/useNavigation";
import { useFocusRestoreOnClose } from "./hooks/useFocusRestoreOnClose";
import { useLaunchGuard } from "./hooks/useLaunchGuard";
import { getDialogNavigationControls, shouldUseNativeDialogArrowKey } from "./services/dialogNavigation";
import { useToast } from "./hooks/useToast";
import { useWeather } from "./hooks/useWeather";
import { focusWindowSafely } from "./services/focusWindowSafely";
import { openStreamingService, streamingServiceErrorMessage } from "./services/openStreamingService";
import { getControlServiceStatus, setControlGameMode } from "./services/controlService";
import { launchManagedApp, listenForManagedAppExit, managedAppErrorMessage } from "./services/appManager";
import { listenForReturnHome, requestSessionTransition, returnVeloraHome, type SessionId } from "./services/sessionOrchestrator";
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
import { listenForRemoteCommand } from "./services/remoteAccess";
import { dispatchRemoteCommand } from "./services/remoteCommand";
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
  const [controlCenterOpen, setControlCenterOpen] = useState(false);
  const [controllerProfile, setControllerProfile] = useState<ControllerProfile>(savedControllerProfile);
  const [cinemaProfile, setCinemaProfile] = useState<CinemaProfile>(readCinemaProfile);
  const [musicBackgroundMode, setMusicBackgroundMode] = useState(readMusicBackgroundMode);
  const [musicStatus, setMusicStatus] = useState<AppleMusicStatus>(unavailableAppleMusicStatus);
  const [ambientSettings, setAmbientSettings] = useState<AmbientSettings>(readAmbientSettings);
  const mediaIsPlaying = musicStatus.appleSessionFound && musicStatus.playbackState === "playing";
  const ambient = useAmbient(ambientSettings, mediaIsPlaying);
  const suspendForForegroundOwner = useControllerOwnershipSuspension();
  const { now, time } = useClock();
  const { label: weatherLabel, title: weatherTitle } = useWeather();
  const { message, showToast } = useToast();
  const { launchingIds, run: runServiceLaunch } = useLaunchGuard();
  const activeServiceRef = useRef(0);
  const ambientSessionActive = useRef(false);
  const recordSession = useCallback((target: SessionId, cause: "user" | "system" = "user") => {
    void (async () => {
      try {
        await requestSessionTransition({ target, cause });
      } catch {
        // Desktop/Ambient only leave through Home. Recover explicitly instead
        // of silently letting the local UI and native session diverge.
        try {
          await requestSessionTransition({ target: "veloraHome", cause: "system" });
          await requestSessionTransition({ target, cause });
        } catch {
          // The local profile remains usable; the native error event is authoritative.
        }
      }
    })();
  }, []);
  useEffect(() => {
    if (ambient.active === ambientSessionActive.current) return;
    ambientSessionActive.current = ambient.active;
    recordSession(ambient.active ? "ambient" : "veloraHome", "system");
  }, [ambient.active, recordSession]);
  const showMenu = useCallback(() => { setControlCenterOpen(false); setDiagnostics(true); }, []);
  const openService = useCallback(
    async (index: number) => {
      const service = streamingServices[index];
      if (!service) return;
      await runServiceLaunch(service.id, async () => {
        try {
          if (service.kind === "web") {
            await openStreamingService(service);
            return;
          }
          const receipt = await launchManagedApp(service.managedAppId);
          showToast(receipt.alreadyRunning
            ? `${service.name} już działa.`
            : `Uruchamiam ${service.name}${service.id === "steam" ? " Big Picture" : ""}.`);
        } catch (cause) {
          showToast(service.kind === "web"
            ? streamingServiceErrorMessage(cause, service.name)
            : managedAppErrorMessage(cause, `Nie udało się otworzyć ${service.name}.`));
        }
      });
    },
    [runServiceLaunch, showToast],
  );
  const activateSelected = useCallback(() => void openService(activeServiceRef.current), [openService]);
  const navigation = useNavigation(streamingServices.length, activateSelected, showMenu);
  const closeControlCenter = useCallback(() => setControlCenterOpen(false), []);
  const toggleControlCenter = useCallback(() => {
    if (controlCenterOpen) {
      closeControlCenter();
      return;
    }
    setDiagnostics(false);
    setControlCenterOpen(true);
  }, [closeControlCenter, controlCenterOpen]);
  const returnToNexus = useCallback(() => {
    setControlCenterOpen(false);
    setDiagnostics(false);
    navigation.focusApp(0);
    void returnVeloraHome().catch(() => {
      void focusWindowSafely(getCurrentWindow(), () => {
        showToast("Windows zablokował powrót do VELORA. Wróć do aplikacji przez Alt+Tab.");
      });
    });
  }, [navigation.focusApp, showToast]);
  const openDiagnosticsFromCenter = useCallback(() => {
    setControlCenterOpen(false);
    setDiagnostics(true);
  }, []);
  const restoreSelectedFocus = useCallback(
    () => navigation.focusApp(activeServiceRef.current),
    [navigation.focusApp],
  );
  useFocusRestoreOnClose(diagnostics, restoreSelectedFocus, !controlCenterOpen);
  useFocusRestoreOnClose(controlCenterOpen, restoreSelectedFocus, !diagnostics);
  const closeDiagnostics = useCallback(() => setDiagnostics(false), []);
  const moveControllerFocus = useCallback((delta: -1 | 1) => {
    const dialog = document.querySelector("dialog[open]");
    if (!dialog) {
      navigation.moveApp(delta);
      return;
    }
    const controls = getDialogNavigationControls(dialog);
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
    if (controlCenterOpen) {
      closeControlCenter();
      return;
    }
    if (diagnostics) {
      closeDiagnostics();
      return;
    }
    navigation.focusApp(0);
  }, [closeControlCenter, closeDiagnostics, controlCenterOpen, diagnostics, navigation.focusApp]);
  const updateControllerProfile = useCallback((profile: ControllerProfile) => {
    setControllerProfile(profile);
    try {
      localStorage.setItem("nexus.controllerProfile", profile);
    } catch {
      // The selected mapping remains active for this session.
    }
  }, []);
  const changeCinemaProfile = useCallback(async (nextProfile: CinemaProfile): Promise<boolean> => {
    const previous = cinemaProfile;
    let controlServiceRunning = false;
    try {
      if (nextProfile === "cinema") await windowMode(true);
      if (nextProfile === "desktop") await windowMode(false);
      if ((nextProfile === "gaming" || previous === "gaming") && nextProfile !== previous) {
        const status = await getControlServiceStatus();
        controlServiceRunning = status.running;
        if (status.running) await setControlGameMode(nextProfile === "gaming");
      }
    } catch {
      showToast("Nie udało się zastosować całego profilu. Sprawdź tryb okna i Control Service.");
      return false;
    }
    setCinemaProfile(nextProfile);
    saveCinemaProfile(nextProfile);
    recordSession(
      nextProfile === "cinema" ? "cinema" : nextProfile === "gaming" ? "game" : "desktop",
    );
    showToast(nextProfile === "desktop"
      ? "Profil Desktop · pulpit Windows."
      : nextProfile === "gaming" && !controlServiceRunning
        ? "Profil Gaming wybrany. Control Service jest wyłączony; ustawienia systemowe nie zostały zmienione."
        : nextProfile === "cinema" ? "Profil Cinema aktywny." : "Profil Gaming aktywny.");
    return true;
  }, [cinemaProfile, recordSession, showToast]);
  const showDesktop = useCallback(async () => {
    setControlCenterOpen(false);
    setDiagnostics(false);
    if (!await changeCinemaProfile("desktop")) return;
    try {
      await minimizeWindowToDesktop();
    } catch {
      showToast("Nie udało się pokazać pulpitu Windows.");
    }
  }, [changeCinemaProfile, showToast]);
  const refreshMusicStatus = useCallback(async () => {
    setMusicStatus(await getAppleMusicStatus());
  }, []);
  useEffect(() => {
    if (!diagnostics && !musicBackgroundMode && !ambientSettings.enabled) return;
    let active = true;
    const refresh = () => void getAppleMusicStatus().then(status => { if (active) setMusicStatus(status); }).catch(() => {
      if (active) setMusicStatus({ ...unavailableAppleMusicStatus, windows: true, message: "Nie udało się odczytać sesji Windows SMTC." });
    });
    refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [ambientSettings.enabled, diagnostics, musicBackgroundMode]);
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
  const updateAmbientSettings = useCallback((next: AmbientSettings) => {
    setAmbientSettings(next);
    saveAmbientSettings(next);
  }, []);
  const openAppleMusic = useCallback(async () => {
    const receipt = await launchManagedApp("appleMusic");
    showToast(receipt.alreadyRunning ? "Apple Music już działa." : "Uruchamiam oficjalną aplikację Apple Music.");
    window.setTimeout(() => void refreshMusicStatus().catch(() => showToast("Nie udało się odczytać sesji Windows SMTC.")), 1800);
  }, [refreshMusicStatus, showToast]);
  const shouldSuspendControllerInput = useCallback(
    () => ambient.controllerSuppressedRef.current || suspendForForegroundOwner(),
    [ambient.controllerSuppressedRef, suspendForForegroundOwner],
  );
  useGamepad({
    move: moveControllerFocus,
    confirm: confirmControllerFocus,
    back: backControllerFocus,
    options: toggleControlCenter,
  }, !ambient.active && !ambient.controllerSuppressed, controllerProfile, shouldSuspendControllerInput);
  useEffect(() => {
    const recover = (event: KeyboardEvent) => {
      const openDialog = document.querySelector("dialog[open]");
      if (event.key === "Escape" && openDialog) {
        event.preventDefault();
        if (controlCenterOpen) closeControlCenter();
        else closeDiagnostics();
        return;
      }
      if (
        openDialog &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) &&
        !shouldUseNativeDialogArrowKey(event.target)
      ) {
        event.preventDefault();
        moveControllerFocus(event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (event.key === "Backspace" && isTextEntryTarget(event.target)) return;
      if ((event.key === "Backspace" || event.key === "BrowserBack") && openDialog) {
        event.preventDefault();
        if (controlCenterOpen) closeControlCenter();
        else closeDiagnostics();
        return;
      }
      if (event.key === "Backspace" || event.key === "BrowserBack") {
        event.preventDefault();
        navigation.focusApp(0);
        return;
      }
      if (event.key === "Escape" || event.key === "F11") {
        event.preventDefault();
        void windowMode(event.key === "Escape" ? false : undefined)
          .catch(() => showToast("Nie udało się zmienić trybu okna. Uruchom z --windowed."));
      }
      if (event.key === "F2") showMenu();
      if (event.key === "F3") { setDiagnostics(false); setControlCenterOpen(true); }
    };
    const restore = () => {
      if (!diagnostics) navigation.focusApp(activeServiceRef.current);
    };
    window.addEventListener("keydown", recover);
    window.addEventListener("focus", restore);
    return () => { window.removeEventListener("keydown", recover); window.removeEventListener("focus", restore); };
  }, [closeControlCenter, closeDiagnostics, controlCenterOpen, diagnostics, moveControllerFocus, navigation.focusApp, showMenu, showToast]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForRemoteCommand((command) => {
      if (!active) return;
      dispatchRemoteCommand(command, {
        navigate: moveControllerFocus,
        select: confirmControllerFocus,
        back: backControllerFocus,
        home: returnToNexus,
        volume: (action) => {
          void handleSystemVolume(action).catch(() => showToast("Nie udało się zmienić głośności Windows."));
        },
        profile: (profile) => { void changeCinemaProfile(profile); },
      });
    }).then((stopListening) => {
      if (active) unlisten = stopListening;
      else stopListening();
    }).catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [backControllerFocus, changeCinemaProfile, confirmControllerFocus, handleSystemVolume, moveControllerFocus, returnToNexus, showToast]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForReturnHome((event) => {
      if (!active) return;
      setControlCenterOpen(false);
      setDiagnostics(false);
      navigation.focusApp(0);
      if (!event.restore.restored && event.restore.outcome !== "alreadyFocused") {
        showToast(event.restore.message || "Windows zablokował powrót do VELORA. Użyj Alt+Tab.");
      }
    }).then((stopListening) => {
      if (active) unlisten = stopListening;
      else stopListening();
    }).catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [navigation.focusApp, showToast]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForManagedAppExit((exit) => {
      if (!active || exit.id !== "playniteFullscreen") return;
      // Native WindowBroker already performed the single focus attempt. This
      // event only supplies the UI notice; retrying focus here would duplicate
      // the attempt and could show a misleading failure after a success.
      if (exit.shouldFocus) {
        showToast("Playnite został zamknięty. Wrócono do VELORA. Profil Gaming jest gotowy.");
      }
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
  const handleUnavailable = useCallback((name: string) => {
    showToast(`Nie wykryto aplikacji ${name}. Zainstaluj ją w Windows i spróbuj ponownie.`);
  }, [showToast]);

  return (
    <main className="screen" aria-label="VELORA — ekran główny">
      <div className="sun" aria-hidden="true" />
      <div className="ridge" aria-hidden="true" />
      <div className="ridge back" aria-hidden="true" />
      <StatusBar now={now} time={time} weatherLabel={weatherLabel} weatherTitle={weatherTitle} />
      <button type="button" className="quick-settings-trigger" onClick={toggleControlCenter} aria-label="Otwórz Control Center">Control Center <kbd>F3</kbd></button>
      <HeroPanel />
      <AppDock
        services={streamingServices}
        activeIndex={navigation.activeIndex}
        launchingIds={launchingIds}
        buttonRefs={navigation.buttonRefs}
        onFocus={handleFocus}
        onActivate={handleActivate}
        onUnavailable={handleUnavailable}
      />
      {musicBackgroundMode && <MusicMiniPlayer status={musicStatus} profile={cinemaProfile} onControl={handleMusicControl} />}
      <footer className="controls">
        <span>
          ◯ / <kbd>←</kbd> <kbd>→</kbd> &nbsp;PORUSZAJ &nbsp;·&nbsp; ✕ / <kbd>ENTER</kbd> &nbsp;WYBIERZ
          &nbsp;·&nbsp; OPTIONS / F2 &nbsp;PAD · F11 &nbsp;EKRAN · ESC &nbsp;OKNO
        </span>
        <span className="version">VELORA · BY MILKLOSH STUDIO &nbsp;/&nbsp; V{version}</span>
      </footer>
      <button className="diagnostics-trigger" onClick={showMenu}>Diagnostyka pada</button>
      {controlCenterOpen && <ControlCenter
        profile={cinemaProfile}
        onProfileChange={changeCinemaProfile}
        onShowDesktop={showDesktop}
        onSystemVolume={handleSystemVolume}
        ambientSettings={ambientSettings}
        onAmbientSettingsChange={updateAmbientSettings}
        mediaPlaying={mediaIsPlaying}
        onOpenDiagnostics={openDiagnosticsFromCenter}
        onReturnToNexus={returnToNexus}
        onClose={closeControlCenter}
      />}
      {ambient.active && <AmbientScreen now={now} />}
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

