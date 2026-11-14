import { useCallback, useEffect, useRef } from "react";
import type { ControllerAction } from "../services/controllerEngine";
import {
  FocusOwnershipGuard,
  resolveFocusOwner,
  type FocusOwner,
  type FocusOwnerInput,
} from "../services/focusOwnership";

export type FocusOwnerState = Omit<FocusOwnerInput, "veloraFocused" | "activeElement">;

/**
 * Single focus owner for controller input. The state flags come from the app shell; the
 * window focus and the active element are read live. `allows` is the one gate every
 * controller source passes through before an action reaches a handler.
 */
export function useFocusOwner(state: FocusOwnerState) {
  const guardRef = useRef<FocusOwnershipGuard | null>(null);
  if (guardRef.current === null) guardRef.current = new FocusOwnershipGuard();
  const stateRef = useRef(state);

  const currentOwner = useCallback((): FocusOwner => resolveFocusOwner({
    ...stateRef.current,
    veloraFocused: document.hasFocus() && document.visibilityState === "visible",
    activeElement: document.activeElement,
  }), []);

  const sync = useCallback(() => {
    guardRef.current?.observe(currentOwner(), performance.now());
  }, [currentOwner]);

  // Layer changes (panel opened or closed, keyboard, ambient) are observed when they
  // happen, not when the next button press arrives, so the settle window starts on time.
  useEffect(() => {
    stateRef.current = state;
    sync();
  }, [state.ambientActive, state.keyboardOpen, state.diagnosticsOpen, state.controlCenterOpen, state.controlCenterPanel, sync]);

  useEffect(() => {
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [sync]);

  const allows = useCallback((action: ControllerAction): boolean => {
    const now = performance.now();
    guardRef.current?.observe(currentOwner(), now);
    return guardRef.current?.allows(action, now) ?? true;
  }, [currentOwner]);

  return { owner: currentOwner, allows };
}
