import { useEffect, useRef, useSyncExternalStore } from "react";
import { ControllerEngine, type ControllerAction } from "../services/controllerEngine";
import { crossSourceGate } from "../services/crossSourceGate";
import {
  DEFAULT_DS4_BINDINGS,
  NEUTRAL_SNAPSHOT,
  sampleFromNative,
  type ControllerBindings,
  type NativeControllerModel,
} from "../services/nativeController";
import { nativeControllerStore } from "../services/nativeControllerStore";
import type { ControllerActions } from "./useGamepad";

/** The engine is time based; this only bounds how late a repeat can fire. */
export const NATIVE_TICK_MS = 16;
/** The native side re-sends held input every 250 ms; two missed beats mean the release was lost. */
export const NATIVE_STALE_MS = 700;

/** Live native model for UI such as diagnostics. Re-renders on each native change. */
export function useNativeControllerModel(): NativeControllerModel {
  return useSyncExternalStore(nativeControllerStore.subscribe, nativeControllerStore.getModel, nativeControllerStore.getModel);
}

/**
 * Native DualShock 4 navigation. Feeds the same `ControllerEngine` and the same
 * `ControllerActions` as the Gamepad API hook, so repeat, hysteresis and debounce
 * behave identically for both sources. It holds exactly one store subscription for
 * as long as it is mounted, however often `actions` changes.
 */
export function useNativeController(
  actions: ControllerActions,
  enabled = true,
  suspendInput?: () => boolean,
  bindings: ControllerBindings = DEFAULT_DS4_BINDINGS,
) {
  const actionsRef = useRef(actions);
  const suspendRef = useRef(suspendInput);
  const bindingsRef = useRef(bindings);
  useEffect(() => { actionsRef.current = actions; }, [actions]);
  useEffect(() => { suspendRef.current = suspendInput; }, [suspendInput]);
  useEffect(() => { bindingsRef.current = bindings; }, [bindings]);

  useEffect(() => {
    if (!enabled) return;
    const release = nativeControllerStore.acquire();
    // Options fires on release and never together with PS, so the Home chord cannot also open a panel.
    const engine = new ControllerEngine({ optionsOnRelease: true });
    const dispatch = (action: ControllerAction) => {
      if (!crossSourceGate.accept("native", action, performance.now())) return;
      const handlers = actionsRef.current;
      if (action.type === "move") handlers.move(action.delta);
      else if (action.type === "vertical") handlers.vertical?.(action.delta);
      else handlers[action.type]();
    };
    const tick = () => {
      const model = nativeControllerStore.getModel();
      const focused = document.hasFocus() && document.visibilityState === "visible";
      // Not focused, suspended, or no native pad: release everything. Held inputs are
      // re-primed on return, so a button held across a focus change never fires late.
      if (!focused || suspendRef.current?.() || model.unavailableReason || !model.activeDevice) {
        engine.reset();
        return;
      }
      // Native state is change-only plus a heartbeat while held. Silence while something is
      // pressed means a release was lost, so the snapshot is treated as released, never held forever.
      const stale = model.snapshotAt !== null && performance.now() - model.snapshotAt > NATIVE_STALE_MS;
      const sample = sampleFromNative(stale ? NEUTRAL_SNAPSHOT : model.snapshot, bindingsRef.current);
      for (const action of engine.update(sample, performance.now(), true)) dispatch(action);
    };
    const timer = window.setInterval(tick, NATIVE_TICK_MS);
    const reconcile = () => { void nativeControllerStore.reconcile(); };
    window.addEventListener("focus", reconcile);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reconcile);
      engine.reset();
      release();
    };
  }, [enabled]);
}
