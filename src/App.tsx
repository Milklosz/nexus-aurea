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
import { useToast } from "./hooks/useToast";
import { useWeather } from "./hooks/useWeather";
import { openStreamingService } from "./services/openStreamingService";
import { launchPlatform, type PlatformLauncherId } from "./services/platformLaunchers";
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
      setDiagnostics(false);
      navigation.focusApp(activeServiceRef.current);
      return;
    }
    navigation.focusApp(0);
  }, [navigation.focusApp]);
  const toggleDiagnostics = useCallback(() => setDiagnostics((open) => !open), []);
  const updateControllerProfile = useCallback((profile: ControllerProfile) => {
    setControllerProfile(profile);
    try {
      localStorage.setItem("nexus.controllerProfile", profile);
    } catch {
      // The selected mapping remains active for this session.
    }
  }, []);
  const handlePlatformLaunch = useCallback(async (launcher: PlatformLauncherId) => {
    try {
      await launchPlatform(launcher);
      showToast(launcher === "steamBigPicture" ? "Uruchamiam Steam Big Picture." : "Uruchamiam Playnite Fullscreen.");
    } catch {
      showToast("Nie udało się uruchomić tej aplikacji. Sprawdź, czy jest zainstalowana.");
    }
  }, [showToast]);
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
        onLaunch={handlePlatformLaunch}
        onClose={() => { setDiagnostics(false); navigation.focusApp(activeServiceRef.current); }}
      />}
      <Toast message={message} />
    </main>
  );
}
