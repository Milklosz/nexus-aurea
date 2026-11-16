import { GamepadDiagnostics } from "./components/GamepadDiagnostics";
import { SmartHomePanel } from "./components/SmartHomePanel";
import { recordSmartHomeLaunch } from "./services/smartHome";
import { isTauri } from "@tauri-apps/api/core";
import { ControlCenter, type ControlPanelId } from "./components/ControlCenter";
import { ControllerHomePreflight } from "./components/ControllerHomePreflight";
import { LivingRoomHome } from "./components/living-room/LivingRoomHome";
import { readHomeTheme } from "./services/homeTheme";
import { activateHomeAction, closeHomeDisclosure, moveWithinHomeActions } from "./services/homeActions";
import { AmbientScreen } from "./components/AmbientScreen";
import { useAmbient } from "./hooks/useAmbient";
import { readAmbientSettings, saveAmbientSettings, type AmbientSettings } from "./services/ambient";
import { useAppVersion } from "./hooks/useAppVersion";
import { minimizeWindowToDesktop, windowMode } from "./services/windowMode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppDock } from "./components/AppDock";
import { HeroPanel } from "./components/HeroPanel";
import { StatusBar } from "./components/StatusBar";
import { Toast } from "./components/Toast";
import { streamingServices } from "./data/streamingServices";
import { useMusicStatusPolling } from "./hooks/useMusicStatusPolling";
import { returnHomeFocusTarget, useReturnHomeListener } from "./hooks/useReturnHomeFocus";
import { useGamepad, type ControllerActions } from "./hooks/useGamepad";
import { useNativeController } from "./hooks/useNativeController";
import { useFocusOwner } from "./hooks/useFocusOwner";
import { canRestoreFocusTo, focusOpenerFrom } from "./services/focusOwnership";
import { nativeControllerOwnsGamepadApi } from "./services/nativeController";
import { nativeControllerStore } from "./services/nativeControllerStore";
import { shouldBlockControllerLaunchWithoutNativeHome, shouldPreflightControllerHome } from "./services/controllerHomePreflight";
import { dispatchControllerAction, intentFromKeyboard, intentFromRemote, isIgnoredShortcutEvent, type NavIntentHandlers } from "./services/navIntent";
import { shouldRestoreDockFocus } from "./services/windowFocusRestore";
import { offerIntentToKeyboard, textEntryTargetFromFocus, withKeyboardFirst } from "./services/virtualKeyboardRouting";
import { useVirtualKeyboardHost } from "./hooks/useVirtualKeyboardHost";
import { VirtualKeyboard } from "./components/VirtualKeyboard";
import { moveAureaFocus } from "./services/aureaNavigation";
import { focusHomeZone, homeZoneAvailability, homeZoneOfElement, nextHomeZone } from "./services/homeZones";
import { useControllerOwnershipSuspension } from "./hooks/useControllerOwnershipSuspension";
import { isTextEntryTarget, useNavigation } from "./hooks/useNavigation";
import { useFocusRestoreOnClose } from "./hooks/useFocusRestoreOnClose";
import { useLaunchGuard } from "./hooks/useLaunchGuard";
import { getDialogNavigationControls, shouldUseNativeDialogArrowKey } from "./services/dialogNavigation";
import { useToast } from "./hooks/useToast";
import { withTimeout } from "./services/withTimeout";
import { useWeather } from "./hooks/useWeather";
import { openStreamingService, streamingServiceErrorMessage } from "./services/openStreamingService";
import { getControlServiceStatus, setControlGameMode } from "./services/controlService";
import { launchManagedApp, listenForLaunchEvent, listenForManagedAppExit, managedAppErrorMessage } from "./services/appManager";
import { getSessionState, requestSessionTransition, returnVeloraHome, type ReturnHomeEvent, type SessionId } from "./services/sessionOrchestrator";
import { useStartupRecoveryNotice } from "./hooks/useStartupRecoveryNotice";
import { sessionTransitionFailureNotice } from "./services/sessionTransitionNotice";
import { collectSearchEntries, tileSearchEntries } from "./services/appSearch";
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
import { listenForRemoteCommand } from "./services/remoteAccess";
import { dispatchRemoteCommand } from "./services/remoteCommand";
import { canRemoteSelect } from "./services/remotePermissions";
import type { ControllerAction, ControllerProfile } from "./services/controllerEngine";
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

const focusReturnLabels: Record<string, string> = {
  controlCenter: "górne akcje Home",
  music: "odtwarzacz",
  diagnostics: "przycisk diagnostyki",
};

type LaunchOrigin = "controller" | "remote" | "keyboard" | "pointer";

/** Names the Home zone focus returns to when an overlay closes, for the diagnostics panel. */
function focusReturnLabel(opener: HTMLElement | null): string {
  const zone = opener?.isConnected ? homeZoneOfElement(opener) : null;
  return (zone && focusReturnLabels[zone]) || "dok Home";
}

export default function App() {
  const version = useAppVersion();
  const [diagnostics, setDiagnostics] = useState(false);
  const [controlCenterOpen, setControlCenterOpen] = useState(false);
  const [homePreflightIndex, setHomePreflightIndex] = useState<number | null>(null);
  const [homePreflightBusy, setHomePreflightBusy] = useState(false);
  const homePreflightIndexRef = useRef<number | null>(null);
  const homePreflightOperationRef = useRef(0);
  const homePreflightOpenerRef = useRef<HTMLElement | null>(null);
  // Which Home look is shown; "grand-cinema" is the previous design, kept as a fallback (see services/homeTheme.ts).
  const [homeTheme] = useState(readHomeTheme);
  const livingRoom = homeTheme === "living-room";
  const [controlCenterPanel, setControlCenterPanel] = useState<ControlPanelId | undefined>(undefined);
  // The Home control (top-bar action, music, diagnostics trigger) that opened an overlay, so closing it returns focus there.
  const homeOpenerRef = useRef<HTMLElement | null>(null);
  const overlayOpenRef = useRef(false);
  // Remembered only when no overlay is open yet: hopping Control Center -> Diagnostics keeps the original opener.
  const captureOpener = useCallback(() => {
    if (overlayOpenRef.current) return;
    const opener = focusOpenerFrom(document.activeElement);
    // The dock is restored through its selected index, so only the other zones are remembered.
    homeOpenerRef.current = opener && homeZoneOfElement(opener) !== "dock" ? opener : null;
  }, []);
  const [controllerProfile, setControllerProfile] = useState<ControllerProfile>(savedControllerProfile);
  const [cinemaProfile, setCinemaProfile] = useState<CinemaProfile>(readCinemaProfile);
  const [musicBackgroundMode, setMusicBackgroundMode] = useState(readMusicBackgroundMode);
  const [musicStatus, setMusicStatus] = useState<AppleMusicStatus>(unavailableAppleMusicStatus);
  const [ambientSettings, setAmbientSettings] = useState<AmbientSettings>(readAmbientSettings);
  const mediaIsPlaying = musicStatus.appleSessionFound && musicStatus.playbackState === "playing";
  const ambient = useAmbient(ambientSettings, mediaIsPlaying);
  const suspendForForegroundOwner = useControllerOwnershipSuspension();
  const { label: weatherLabel, title: weatherTitle, temperatureText, condition: weatherCondition, stale: weatherStale } = useWeather();
  useEffect(() => {
    document.documentElement.classList.toggle("lr-theme", livingRoom);
    return () => document.documentElement.classList.remove("lr-theme");
  }, [livingRoom]);
  const { message, showToast } = useToast();
  // The recovery notice after an unclean exit or corrupt state is read from the snapshot; the native event fires before the WebView can listen.
  useStartupRecoveryNotice(getSessionState, showToast);
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
        } catch (error) {
          // The local profile remains usable, but the user must learn that the native session did not change.
          showToast(sessionTransitionFailureNotice(error));
        }
      }
    })();
  }, [showToast]);
  useEffect(() => {
    if (ambient.active === ambientSessionActive.current) return;
    ambientSessionActive.current = ambient.active;
    recordSession(ambient.active ? "ambient" : "veloraHome", "system");
  }, [ambient.active, recordSession]);
  const showMenu = useCallback(() => {
    if (homePreflightIndexRef.current !== null) return;
    captureOpener();
    setControlCenterOpen(false);
    setDiagnostics(true);
  }, [captureOpener]);
  const launchServiceNow = useCallback(
    async (index: number) => {
      const service = streamingServices[index];
      if (!service) return;
      await runServiceLaunch(service.id, async () => {
        try {
          if (service.kind === "web") {
            await openStreamingService(service);
            if (isTauri()) recordSmartHomeLaunch(service.id);
            return;
          }
          const receipt = await launchManagedApp(service.managedAppId);
          recordSmartHomeLaunch(service.id);
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
  const openService = useCallback(async (index: number, origin: LaunchOrigin = "pointer") => {
    const service = streamingServices[index];
    if (!service) return;
    try {
      await withTimeout(nativeControllerStore.reconcile(), 2_000, "Odczyt kontrolera");
    } catch {
      nativeControllerStore.invalidateStatusRead();
    }
    const status = nativeControllerStore.getStatusSnapshot();
    if (origin === "controller" && shouldBlockControllerLaunchWithoutNativeHome(
      service,
      status,
      nativeControllerStore.getStatusKnown(),
    )) {
      showToast("Nie wykryto pewnego powrotu lokalnym padem. Pozostań w VELORA lub użyj myszy albo klawiatury.");
      return;
    }
    if (shouldPreflightControllerHome(service, status)) {
      homePreflightIndexRef.current = index;
      homePreflightOperationRef.current += 1;
      homePreflightOpenerRef.current = focusOpenerFrom(document.activeElement);
      setHomePreflightIndex(index);
      return;
    }
    await launchServiceNow(index);
  }, [launchServiceNow, showToast]);
  const activateSelected = useCallback((origin: LaunchOrigin) => void openService(activeServiceRef.current, origin), [openService]);
  // Rejestruje dock jako siatkę AUREA dla 2D poleceń iPhone Remote; bez `columns`
  // klawiatura zachowuje dotychczasowe skróty (ArrowUp -> Control Center).
  // Up/down on the home screen go through the zone handler. It is set below, once
  // the focus helpers exist, so the keyboard hook always calls the current version.
  const verticalZoneRef = useRef<(delta: -1 | 1) => boolean>(() => false);
  const handleVerticalZone = useCallback((delta: -1 | 1) => verticalZoneRef.current(delta), []);
  // Left/right inside the Home top-bar actions stay in that row; everywhere else they move through the dock.
  const handleHorizontalZone = useCallback(
    (delta: -1 | 1) => document.querySelector("dialog[open]") === null && moveWithinHomeActions(document.activeElement, delta),
    [],
  );
  const navigation = useNavigation(streamingServices.length, activateSelected, showMenu, {
    gridId: "home-dock",
    onVerticalZone: handleVerticalZone,
    onHorizontalZone: handleHorizontalZone,
  });
  const cancelHomePreflight = useCallback(() => {
    if (homePreflightIndexRef.current === null) return;
    const wasBusy = homePreflightBusy;
    homePreflightOperationRef.current += 1;
    homePreflightIndexRef.current = null;
    setHomePreflightIndex(null);
    setHomePreflightBusy(false);
    if (wasBusy) {
      showToast("Otwarcie anulowano. Powrót na tę sesję może już być włączony do zamknięcia VELORA.");
    }
    const opener = homePreflightOpenerRef.current;
    homePreflightOpenerRef.current = null;
    window.requestAnimationFrame(() => {
      if (canRestoreFocusTo(opener)) {
        opener.focus({ preventScroll: true });
        if (document.activeElement === opener) return;
      }
      navigation.focusApp(activeServiceRef.current);
    });
  }, [homePreflightBusy, navigation.focusApp, showToast]);
  const confirmHomePreflight = useCallback(async () => {
    const index = homePreflightIndexRef.current;
    if (index === null || homePreflightBusy) return;
    const operation = ++homePreflightOperationRef.current;
    setHomePreflightBusy(true);
    try {
      const status = await withTimeout(
        nativeControllerStore.setHomeEnabled(true),
        8_000,
        "Powrót lokalnym padem",
      );
      if (operation !== homePreflightOperationRef.current || homePreflightIndexRef.current !== index) return;
      if (!status.supported || !status.running || !status.homeEnabled) {
        showToast("Nie udało się włączyć powrotu pada. Aplikacja pozostała w VELORA.");
        return;
      }
      homePreflightIndexRef.current = null;
      homePreflightOpenerRef.current = null;
      setHomePreflightIndex(null);
      await launchServiceNow(index);
    } catch {
      if (operation === homePreflightOperationRef.current && homePreflightIndexRef.current === index) {
        showToast("Nie udało się potwierdzić powrotu pada. Aplikacja pozostała w VELORA.");
      }
    } finally {
      if (operation === homePreflightOperationRef.current) setHomePreflightBusy(false);
    }
  }, [homePreflightBusy, launchServiceNow, showToast]);
  const closeControlCenter = useCallback(() => setControlCenterOpen(false), []);
  // Native search over the home tiles. Games (Steam, Playnite) will join as more providers.
  const searchEntriesList = useMemo(() => collectSearchEntries([() => tileSearchEntries(streamingServices)]), []);
  const appSearch = useMemo(() => ({
    entries: searchEntriesList,
    onLaunch: (entryId: string) => {
      const index = streamingServices.findIndex((service) => `tile:${service.id}` === entryId);
      if (index < 0) return;
      closeControlCenter();
      void openService(index);
    },
  }), [closeControlCenter, openService, searchEntriesList]);
  const toggleControlCenter = useCallback(() => {
    if (homePreflightIndexRef.current !== null) {
      cancelHomePreflight();
      return;
    }
    if (controlCenterOpen) {
      closeControlCenter();
      return;
    }
    captureOpener();
    setDiagnostics(false);
    setControlCenterPanel(undefined);
    setControlCenterOpen(true);
  }, [cancelHomePreflight, captureOpener, closeControlCenter, controlCenterOpen]);
  // Home entries (Szukaj, Pilot, Ustawienia) open Control Center directly on their tab.
  const openControlCenterAt = useCallback((panel?: ControlPanelId) => {
    if (homePreflightIndexRef.current !== null) {
      cancelHomePreflight();
      return;
    }
    captureOpener();
    setDiagnostics(false);
    setControlCenterPanel(panel);
    setControlCenterOpen(true);
  }, [cancelHomePreflight, captureOpener]);
  const openSearch = useCallback(() => openControlCenterAt("search"), [openControlCenterAt]);
  const openRemote = useCallback(() => openControlCenterAt("remote"), [openControlCenterAt]);
  const openSettings = useCallback(() => openControlCenterAt(undefined), [openControlCenterAt]);
  const returnToNexus = useCallback(() => {
    if (homePreflightIndex !== null) {
      cancelHomePreflight();
      return;
    }
    setControlCenterOpen(false);
    setDiagnostics(false);
    navigation.focusApp(0);
    void returnVeloraHome().catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "supersededHome"
      ) {
        // A newer launch won the race; do not report a false Windows denial.
        return;
      }
      // Do not retry focus from the WebView: Tauri's setFocus can fall back to an
      // injected Alt keypress to get past the Windows foreground lock. A failed
      // transaction is reported instead; a denied focus is described by the
      // native restore result in velora-return-home.
      showToast("VELORA nie mogła wrócić do ekranu głównego. Użyj skrótu powrotu albo Alt+Tab.");
    });
  }, [cancelHomePreflight, homePreflightIndex, navigation.focusApp, showToast]);
  const openDiagnosticsFromCenter = useCallback(() => {
    setControlCenterOpen(false);
    setDiagnostics(true);
  }, []);
  const restoreSelectedFocus = useCallback(() => {
    const opener = homeOpenerRef.current;
    homeOpenerRef.current = null;
    if (canRestoreFocusTo(opener)) {
      opener.focus({ preventScroll: true });
      // A hidden or otherwise unfocusable opener silently ignores focus(): fall back to the dock.
      if (document.activeElement === opener) return;
    }
    navigation.focusApp(activeServiceRef.current);
  }, [navigation.focusApp]);
  useFocusRestoreOnClose(diagnostics, restoreSelectedFocus, !controlCenterOpen);
  useFocusRestoreOnClose(controlCenterOpen, restoreSelectedFocus, !diagnostics);
  useEffect(() => { overlayOpenRef.current = controlCenterOpen || diagnostics; }, [controlCenterOpen, diagnostics]);
  const closeDiagnostics = useCallback(() => setDiagnostics(false), []);
  // On-screen keyboard: opens only for VELORA text fields marked data-velora-text-entry.
  const keyboard = useVirtualKeyboardHost();
  const openKeyboardFor = keyboard.openFor;
  const moveControllerFocus = useCallback((delta: -1 | 1) => {
    const dialog = document.querySelector("dialog[open]");
    if (!dialog) {
      if (moveWithinHomeActions(document.activeElement, delta)) return;
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
  // Up/down on the home screen move between zones: Control Center, music, dock, Diagnostics.
  const moveHomeZone = useCallback((delta: -1 | 1): boolean => {
    const current = homeZoneOfElement(document.activeElement) ?? "dock";
    const next = nextHomeZone(current, delta, homeZoneAvailability(document));
    if (next === null) return false;
    if (next === "dock") navigation.focusApp(activeServiceRef.current);
    else focusHomeZone(document, next);
    return true;
  }, [navigation.focusApp]);
  // Inside an open dialog, up/down move through its controls, just as left/right do.
  const moveVerticalFocus = useCallback((delta: -1 | 1): boolean => {
    if (document.querySelector("dialog[open]")) {
      moveControllerFocus(delta);
      return true;
    }
    return moveHomeZone(delta);
  }, [moveControllerFocus, moveHomeZone]);
  useEffect(() => {
    verticalZoneRef.current = moveVerticalFocus;
  }, [moveVerticalFocus]);
  const confirmControllerFocus = useCallback(() => {
    const dialog = document.querySelector("dialog[open]");
    const active = document.activeElement;
    if (dialog && (!(active instanceof HTMLElement) || !dialog.contains(active))) return;
    const textField = textEntryTargetFromFocus(active);
    if (textField) {
      openKeyboardFor(textField);
      return;
    }
    if (dialog && active instanceof HTMLElement && dialog.contains(active)) {
      const entryId = active.dataset.appLaunchEntry;
      if (entryId) {
        const index = streamingServices.findIndex((service) => `tile:${service.id}` === entryId);
        if (index >= 0) {
          closeControlCenter();
          void openService(index, "controller");
        }
        return;
      }
      active.click();
      return;
    }
    if (!dialog && active instanceof HTMLElement && active.dataset.smartHomeApp) {
      const index = streamingServices.findIndex(service => service.id === active.dataset.smartHomeApp);
      if (index >= 0) void openService(index, "controller");
      return;
    }
    if (!dialog && activateHomeAction(active)) return;
    activateSelected("controller");
  }, [activateSelected, closeControlCenter, openKeyboardFor, openService]);
  // The paired remote must not reach administrative dialog controls through a
  // generic active.click(). Dialog actions require an explicit allow marker.
  const confirmRemoteFocus = useCallback(() => {
    const dialog = document.querySelector("dialog[open]");
    const active = document.activeElement;
    if (dialog && (!(active instanceof HTMLElement) || !dialog.contains(active))) return;
    const textField = textEntryTargetFromFocus(active);
    if (textField) {
      if (dialog && !canRemoteSelect(textField)) {
        showToast("Pilot nie ma uprawnień do tej operacji administracyjnej.");
        return;
      }
      openKeyboardFor(textField);
      return;
    }
    if (dialog && active instanceof HTMLElement && dialog.contains(active)) {
      if (!canRemoteSelect(active)) {
        showToast("Pilot nie ma uprawnień do tej operacji administracyjnej.");
        return;
      }
      const entryId = active.dataset.appLaunchEntry;
      if (entryId) {
        const index = streamingServices.findIndex((service) => `tile:${service.id}` === entryId);
        if (index >= 0) {
          closeControlCenter();
          void openService(index, "remote");
        }
        return;
      }
      active.click();
      return;
    }
    if (!dialog && active instanceof HTMLElement && active.dataset.smartHomeApp) {
      const index = streamingServices.findIndex(service => service.id === active.dataset.smartHomeApp);
      if (index >= 0) void openService(index, "remote");
      return;
    }
    if (!dialog && activateHomeAction(active)) return;
    activateSelected("remote");
  }, [activateSelected, closeControlCenter, openKeyboardFor, openService, showToast]);
  const backControllerFocus = useCallback(() => {
    if (homePreflightIndex !== null) {
      cancelHomePreflight();
      return;
    }
    if (controlCenterOpen) {
      closeControlCenter();
      return;
    }
    if (diagnostics) {
      closeDiagnostics();
      return;
    }
    if (closeHomeDisclosure(document.activeElement)) return;
    navigation.focusApp(0);
  }, [cancelHomePreflight, closeControlCenter, closeDiagnostics, controlCenterOpen, diagnostics, homePreflightIndex, navigation.focusApp]);
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
  useMusicStatusPolling(Boolean(diagnostics || musicBackgroundMode || ambientSettings.enabled), setMusicStatus);
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
  // DualSense actions become shared navigation intents; the handlers below are the
  // only place that decides what each intent does on the home screen and in dialogs.
  const homeIntentHandlers = useMemo<NavIntentHandlers>(() => ({
    move: (direction) => {
      if (direction === "up" || direction === "down") {
        moveVerticalFocus(direction === "up" ? -1 : 1);
        return;
      }
      moveControllerFocus(direction === "left" ? -1 : 1);
    },
    select: confirmControllerFocus,
    back: backControllerFocus,
    menu: toggleControlCenter,
    home: returnToNexus,
  }), [backControllerFocus, confirmControllerFocus, moveControllerFocus, moveVerticalFocus, returnToNexus, toggleControlCenter]);
  // An open on-screen keyboard claims the intent first; otherwise the home handlers run unchanged.
  const controllerIntentHandlers = useMemo<NavIntentHandlers>(
    () => withKeyboardFirst(homeIntentHandlers, () => keyboard.sinkRef.current),
    [homeIntentHandlers, keyboard.sinkRef],
  );
  // One owner decides whether a controller action is interpreted at all (and swallows a confirm that
  // lands in the hand-over gap after a panel closes). Both input sources pass through it.
  const focusOwner = useFocusOwner({
    ambientActive: ambient.active,
    keyboardOpen: keyboard.field !== null,
    controllerPreflightOpen: homePreflightIndex !== null,
    diagnosticsOpen: diagnostics,
    controlCenterOpen,
    controlCenterPanel,
  });
  const allowControllerAction = focusOwner.allows;
  const controllerActions = useMemo<ControllerActions>(() => {
    const send = (action: ControllerAction) => {
      if (allowControllerAction(action)) dispatchControllerAction(action, controllerIntentHandlers);
    };
    return {
      move: (delta) => send({ type: "move", delta }),
      vertical: (delta) => send({ type: "vertical", delta }),
      confirm: () => send({ type: "confirm" }),
      back: () => send({ type: "back" }),
      options: () => send({ type: "options" }),
      section: (delta) => {
        // L1/R1 switch Control Center sections. Anywhere else they do nothing, and an open on-screen keyboard owns the pad.
        if (keyboard.sinkRef.current || !allowControllerAction({ type: "move", delta })) return;
        const dialog = document.querySelector("dialog.control-center[open]");
        const tabs = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('.cc-tabs [role="tab"]')) : [];
        if (tabs.length < 2) return;
        const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
        const next = tabs[(current + delta + tabs.length) % tabs.length];
        next.click();
        next.focus({ preventScroll: true });
      },
    };
  }, [allowControllerAction, controllerIntentHandlers, keyboard.sinkRef]);
  const inputEnabled = !ambient.active && !ambient.controllerSuppressed;
  // A connected native DS4 owns controller input exclusively. Browser XInput can
  // be a delayed virtual echo of this pad, so accepting any browser pad here is
  // ambiguous; the browser source resumes as soon as native ownership ends.
  const nativeOwnsPad = useCallback((pad: Gamepad) => {
    const model = nativeControllerStore.getModel();
    void pad;
    return nativeControllerOwnsGamepadApi(model);
  }, []);
  useNativeController(controllerActions, inputEnabled, shouldSuspendControllerInput);
  useGamepad(controllerActions, inputEnabled, controllerProfile, shouldSuspendControllerInput, nativeOwnsPad);
  useEffect(() => {
    const recover = (event: KeyboardEvent) => {
      // OS/browser combinations (Ctrl+Escape, Alt+…) and auto-repeat of one-shot
      // keys (F11 fullscreen toggle, Escape, F2, F3) must not trigger app actions.
      if (isIgnoredShortcutEvent(event)) return;
      const openDialog = document.querySelector("dialog[open]");
      if (event.key === "Escape" && openDialog) {
        event.preventDefault();
        if (homePreflightIndex !== null) cancelHomePreflight();
        else if (controlCenterOpen) closeControlCenter();
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
      // Back is one shared intent: the same handler serves Backspace, DualSense and the iPhone remote.
      if (intentFromKeyboard(event)?.kind === "back") {
        event.preventDefault();
        dispatchControllerAction({ type: "back" }, controllerIntentHandlers);
        return;
      }
      if (event.key === "Escape" || event.key === "F11") {
        event.preventDefault();
        void windowMode(event.key === "Escape" ? false : undefined)
          .catch(() => showToast("Nie udało się zmienić trybu okna. Uruchom z --windowed."));
      }
      if (event.key === "F2") showMenu();
      if (event.key === "F3") openControlCenterAt();
    };
    const restore = () => {
      // Window focus returns while an overlay may be open; the dock must not take the highlight under it.
      const dialogOpen = document.querySelector("dialog[open]") !== null;
      if (shouldRestoreDockFocus({ diagnosticsOpen: diagnostics, controlCenterOpen, dialogOpen })) {
        navigation.focusApp(activeServiceRef.current);
      }
    };
    window.addEventListener("keydown", recover);
    window.addEventListener("focus", restore);
    return () => { window.removeEventListener("keydown", recover); window.removeEventListener("focus", restore); };
  }, [cancelHomePreflight, closeControlCenter, closeDiagnostics, controlCenterOpen, controllerIntentHandlers, diagnostics, homePreflightIndex, moveControllerFocus, navigation.focusApp, openControlCenterAt, showMenu, showToast]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForRemoteCommand((command) => {
      if (!active) return;
      // An open on-screen keyboard claims navigation first; Home still reaches the handler below after cancelling it.
      const remoteIntent = intentFromRemote(command);
      if (remoteIntent && offerIntentToKeyboard(remoteIntent, keyboard.sinkRef.current)) return;
      dispatchRemoteCommand(command, {
        navigate: moveControllerFocus,
        // Up/down are zone moves; left/right keep the dock grid, then the linear fallback.
        navigateDirection: (direction) => {
          if (direction === "up" || direction === "down") {
            moveVerticalFocus(direction === "up" ? -1 : 1);
            return;
          }
          if (!document.querySelector("dialog[open]") && (direction === "left" || direction === "right") &&
            moveWithinHomeActions(document.activeElement, direction === "left" ? -1 : 1)) return;
          if (!document.querySelector("dialog[open]") && moveAureaFocus(direction)) return;
          moveControllerFocus(direction === "left" ? -1 : 1);
        },
        select: confirmControllerFocus,
        selectRemote: confirmRemoteFocus,
        back: backControllerFocus,
        // The authenticated native endpoint already restored Home using its
        // conservative Device policy. Never issue another local restore here.
        home: () => {
          cancelHomePreflight();
          setControlCenterOpen(false);
          setDiagnostics(false);
          navigation.focusApp(returnHomeFocusTarget(activeServiceRef.current, streamingServices.length));
        },
        menu: () => openControlCenterAt(),
        switchApplications: () => openControlCenterAt("sessions"),
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
  }, [backControllerFocus, cancelHomePreflight, changeCinemaProfile, confirmControllerFocus, confirmRemoteFocus, handleSystemVolume, keyboard.sinkRef, moveControllerFocus, moveVerticalFocus, navigation.focusApp, openControlCenterAt, showToast]);

  useReturnHomeListener(useCallback((event: ReturnHomeEvent) => {
    homePreflightOperationRef.current += 1;
    homePreflightIndexRef.current = null;
    homePreflightOpenerRef.current = null;
    setHomePreflightIndex(null);
    setHomePreflightBusy(false);
    setControlCenterOpen(false);
    setDiagnostics(false);
    // Restore the tile the user launched from, not always the first one.
    navigation.focusApp(returnHomeFocusTarget(activeServiceRef.current, streamingServices.length));
    if (!event.restore.restored && event.restore.outcome !== "alreadyFocused") {
      showToast(event.restore.message || "Windows zablokował powrót do VELORA. Użyj Alt+Tab.");
    }
  }, [navigation.focusApp, showToast]));

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

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForLaunchEvent((event) => {
      if (!active) return;
      // A successful spawn receipt is not proof that the app window appeared.
      // Surface only a real terminal failure from the authoritative registry.
      if (event.session.phase === "windowAppeared" || event.session.phase === "sessionActive") {
        const id = event.session.appId;
        const service = streamingServices.find(service => service.kind === "managed" ? service.managedAppId === id : `edge-cinema:${service.id}` === id);
        if (service) recordSmartHomeLaunch(service.id);
      }
      if (event.session.phase === "failed" && (event.session.appId === "edge-cinema" || event.session.appId?.startsWith("edge-cinema:"))) {
        showToast(event.session.error || "Nie udało się otworzyć okna Edge Cinema.");
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
    <main className={livingRoom ? "lr" : "screen"} aria-label="VELORA — ekran główny">
      {livingRoom ? (
        <LivingRoomHome
          services={streamingServices}
          activeIndex={navigation.activeIndex}
          launchingIds={launchingIds}
          buttonRefs={navigation.buttonRefs}
          weather={{ temperatureText, condition: weatherCondition, title: weatherTitle, stale: weatherStale }}
          onFocus={handleFocus}
          onActivate={handleActivate}
          onUnavailable={handleUnavailable}
          onSearch={openSearch}
          onRemote={openRemote}
          onSettings={openSettings}
          aside={<>
            <SmartHomePanel onSessions={() => openControlCenterAt("sessions")} onLaunch={id => { const index = streamingServices.findIndex(service => service.id === id); if (index >= 0) void openService(index); }} />
            {musicBackgroundMode && <MusicMiniPlayer status={musicStatus} profile={cinemaProfile} onControl={handleMusicControl} />}
          </>}
        />
      ) : (
        <>
          <div className="sun" aria-hidden="true" />
          <div className="ridge" aria-hidden="true" />
          <div className="ridge back" aria-hidden="true" />
          <StatusBar weatherLabel={weatherLabel} weatherTitle={weatherTitle} />
          <button type="button" className="quick-settings-trigger" onClick={toggleControlCenter} aria-label="Otwórz Control Center">Control Center <kbd>F3</kbd></button>
          <HeroPanel />
          <SmartHomePanel onSessions={() => openControlCenterAt("sessions")} onLaunch={id => { const index = streamingServices.findIndex(service => service.id === id); if (index >= 0) void openService(index); }} />
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
        </>
      )}
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
        onSwitchApplications={() => openControlCenterAt("sessions")}
        onClose={closeControlCenter}
        appSearch={appSearch}
        initialPanel={controlCenterPanel}
        livingRoom={livingRoom}
      />}
      {homePreflightIndex !== null && <ControllerHomePreflight
        serviceName={streamingServices[homePreflightIndex]?.name ?? "ten serwis"}
        busy={homePreflightBusy}
        onConfirm={() => void confirmHomePreflight()}
        onCancel={cancelHomePreflight}
      />}
      {ambient.active && <AmbientScreen />}
      {diagnostics && <GamepadDiagnostics
        profile={controllerProfile}
        onProfileChange={updateControllerProfile}
        getFocusOwner={focusOwner.owner}
        focusReturnTo={focusReturnLabel(homeOpenerRef.current)}
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
      {keyboard.field && <VirtualKeyboard
        field={keyboard.field}
        sinkRef={keyboard.sinkRef}
        onDone={keyboard.commit}
        onCancel={keyboard.cancel}
      />}
      <Toast message={message} />
    </main>
  );
}

