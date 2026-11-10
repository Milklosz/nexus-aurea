import { useCallback, useEffect, useRef, useState } from "react";
import { idleDeadlineReached, type AmbientSettings } from "../services/ambient";

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

    const timer = window.setInterval(() => {
      const visible = document.visibilityState !== "hidden" && document.hasFocus();
      if (!visible) {
        lastActivityAt.current = Date.now();
        setActiveNow(false);
        setControllerSuppressedNow(false);
        return;
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