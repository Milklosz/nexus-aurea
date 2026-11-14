import { useCallback, useEffect, useRef, useState } from "react";
import { idleDeadlineReached, type AmbientSettings } from "../services/ambient";
import { nativeControllerStore } from "../services/nativeControllerStore";

type GamepadState = { signature: string; active: boolean };

function readGamepadState(): GamepadState | null {
  if (typeof navigator.getGamepads !== "function") return null;
  try {
    const pads = Array.from(navigator.getGamepads() ?? []).filter((pad): pad is Gamepad => Boolean(pad?.connected));
    const activeValues: string[] = [];
    let active = false;
    for (const pad of pads) {
      const buttons = pad.buttons.map((button, index) => {
        const pressed = button.pressed || button.value > 0.35;
        if (pressed) active = true;
        return pressed ? String(index) : "";
      }).filter(Boolean).join(",");
      const axes = pad.axes.map((value, index) => {
        if (value < -0.45) { active = true; return index + "L"; }
        if (value > 0.45) { active = true; return index + "R"; }
        return "";
      }).filter(Boolean).join(",");
      activeValues.push(pad.index + ":" + pad.id + ":" + buttons + ":" + axes);
    }
    return { signature: activeValues.join("|"), active };
  } catch {
    return null;
  }
}

export function useAmbient(settings: AmbientSettings, mediaPlaying: boolean) {
  const [active, setActive] = useState(false);
  const [controllerSuppressed, setControllerSuppressed] = useState(false);
  const activeRef = useRef(false);
  const controllerSuppressedRef = useRef(false);
  const lastActivityAt = useRef(Date.now());

  const setActiveNow = useCallback((next: boolean) => {
    activeRef.current = next;
    setActive(next);
  }, []);
  const setControllerSuppressedNow = useCallback((next: boolean) => {
    controllerSuppressedRef.current = next;
    setControllerSuppressed(next);
  }, []);
  const wake = useCallback(() => {
    lastActivityAt.current = Date.now();
    setActiveNow(false);
  }, [setActiveNow]);

  useEffect(() => {
    let previousGamepadSignature: string | null = null;
    let previousGamepadActive = false;
    // Native DualShock 4 input counts as activity too. If the browser Gamepad API cannot see the
    // pad (for example after it was switched to another report mode), native input is the only
    // signal that keeps Ambient from starting mid-use and that can wake it.
    let previousNativeInputAt: number | null = null;

    const recordActivity = (event?: Event, cameFromController = false) => {
      lastActivityAt.current = Date.now();
      if (activeRef.current) {
        if (cameFromController) setControllerSuppressedNow(true);
        setActiveNow(false);
        event?.preventDefault();
        event?.stopImmediatePropagation();
      }
    };
    const onInput = (event: Event) => recordActivity(event);
    const onBlur = () => {
      lastActivityAt.current = Date.now();
      setActiveNow(false);
      setControllerSuppressedNow(false);
    };
    const onFocus = () => { lastActivityAt.current = Date.now(); };

    if (!settings.enabled || mediaPlaying) {
      lastActivityAt.current = Date.now();
      setActiveNow(false);
      setControllerSuppressedNow(false);
      return;
    }

    window.addEventListener("keydown", onInput, true);
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("pointermove", onInput, true);
    window.addEventListener("touchstart", onInput, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);

    // Held only while the listeners below are installed (not in the disabled early return).
    const releaseNative = nativeControllerStore.acquire();
    const timer = window.setInterval(() => {
      const visible = document.visibilityState !== "hidden" && document.hasFocus();
      if (!visible) {
        lastActivityAt.current = Date.now();
        setActiveNow(false);
        setControllerSuppressedNow(false);
        return;
      }

      const nativeInputAt = nativeControllerStore.getModel().lastInputAt;
      if (nativeInputAt !== null && nativeInputAt !== previousNativeInputAt) {
        previousNativeInputAt = nativeInputAt;
        // Not a controller wake: suppression is cleared by the Gamepad API path, which may not see this pad.
        // The focus-owner settle guard swallows the press that woke us instead.
        recordActivity(undefined, false);
      }

      const gamepad = readGamepadState();
      if (gamepad) {
        if (gamepad.active && (!previousGamepadActive || gamepad.signature !== previousGamepadSignature)) {
          recordActivity(undefined, activeRef.current);
        } else if (!gamepad.active && previousGamepadActive) {
          lastActivityAt.current = Date.now();
          setControllerSuppressedNow(false);
        }
        previousGamepadActive = gamepad.active;
        previousGamepadSignature = gamepad.signature;
      }

      if (!controllerSuppressedRef.current && idleDeadlineReached(lastActivityAt.current, Date.now(), settings.idleSeconds)) {
        setActiveNow(true);
      }
    }, 250);

    return () => {
      releaseNative();
      window.clearInterval(timer);
      window.removeEventListener("keydown", onInput, true);
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("pointermove", onInput, true);
      window.removeEventListener("touchstart", onInput, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [mediaPlaying, setActiveNow, setControllerSuppressedNow, settings.enabled, settings.idleSeconds]);

  return { active, activeRef, controllerSuppressed, controllerSuppressedRef, wake };
}