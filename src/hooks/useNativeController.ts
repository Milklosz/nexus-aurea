import { useEffect, useRef, useSyncExternalStore } from "react";
import { ControllerEngine, type ControllerAction } from "../services/controllerEngine";
import { crossSourceGate } from "../services/crossSourceGate";
import {
  BumperEdges,
  DEFAULT_DS4_BINDINGS,
  isNeutral,
  sampleFromNative,
  type ControllerBindings,
  type NativeControllerModel,
  type NativeControllerStatus,
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

/** Full native snapshot for the local Control Center and diagnostics. */
export function useNativeControllerStatus(): NativeControllerStatus {
  return useSyncExternalStore(
    nativeControllerStore.subscribe,
    nativeControllerStore.getStatusSnapshot,
    nativeControllerStore.getStatusSnapshot,
  );
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
    const heartbeatExpired = (model: NativeControllerModel, now: number) =>
      model.snapshotAt !== null && now - model.snapshotAt > NATIVE_STALE_MS;
    // Claim activity when the event arrives, before the browser's next RAF can
    // dispatch the virtual Options press. Waiting for our 16 ms tick is too late.
    const noteActivity = () => {
      const model = nativeControllerStore.getModel();
      const now = performance.now();
      if (document.hasFocus() && document.visibilityState === "visible"
        && !suspendRef.current?.() && !model.unavailableReason
        && !heartbeatExpired(model, now) && !isNeutral(model.snapshot)) {
        crossSourceGate.noteNativeActivity(now, sampleFromNative(model.snapshot, bindingsRef.current));
      }
    };
    const unsubscribe = nativeControllerStore.subscribe(noteActivity);
    // Options fires on release and never together with PS, so the Home chord cannot also open a panel.
    const engine = new ControllerEngine({ optionsOnRelease: true });
    const bumpers = new BumperEdges();
    const resetInput = () => {
      engine.reset();
      bumpers.reset();
    };
    let selectedDevice: string | null = null;
    // The connection epoch of the model we last synced to. Any change (pad
    // disconnect/reconnect, native layer unavailable) opens a new cross-source
    // arbitration epoch, so input tagged before the boundary can never fire.
    let modelEpoch = nativeControllerStore.getModel().epoch;
    const syncEpoch = (model: NativeControllerModel) => {
      if (model.epoch === modelEpoch) return;
      modelEpoch = model.epoch;
      crossSourceGate.advanceEpoch();
      resetInput();
    };
    const dispatch = (action: ControllerAction, epochTag: number) => {
      if (!crossSourceGate.accept("native", action, performance.now(), epochTag)) return;
      const handlers = actionsRef.current;
      if (action.type === "move") handlers.move(action.delta);
      else if (action.type === "vertical") handlers.vertical?.(action.delta);
      else handlers[action.type]();
    };
    const tick = () => {
      const model = nativeControllerStore.getModel();
      syncEpoch(model);
      const epochTag = crossSourceGate.currentEpoch;
      const now = performance.now();
      const focused = document.hasFocus() && document.visibilityState === "visible";
      const hasHeldInput = !isNeutral(model.snapshot);
      // Silence while held means input was lost. Reset instead of manufacturing a
      // release, which would open Control Center for a held Options button.
      if (!focused || suspendRef.current?.() || model.unavailableReason || !model.activeDevice
        || (hasHeldInput && heartbeatExpired(model, now))) {
        resetInput();
        selectedDevice = model.activeDevice;
        return;
      }
      if (model.activeDevice !== selectedDevice) {
        // A source/device handoff primes its current held state before dispatch.
        resetInput();
        selectedDevice = model.activeDevice;
      }
      const sample = sampleFromNative(model.snapshot, bindingsRef.current);
      // While the native pad is in use the browser path is secondary (virtual pads, same press).
      if (hasHeldInput) crossSourceGate.noteNativeActivity(now, sample);
      for (const action of engine.update(sample, now, true)) dispatch(action, epochTag);
      const held = new Set(model.snapshot?.buttons ?? []);
      for (const delta of bumpers.update(held.has("l1"), held.has("r1"))) actionsRef.current.section?.(delta);
    };
    const timer = window.setInterval(tick, NATIVE_TICK_MS);
    const reconcile = () => {
      // Regaining foreground is a resync boundary: anything tagged before it is
      // stale (double-activation suppression for the recovery path), and the model
      // epoch is re-synced so the next tick does not advance again.
      resetInput();
      crossSourceGate.advanceEpoch();
      modelEpoch = nativeControllerStore.getModel().epoch;
      void nativeControllerStore.reconcile();
    };
    window.addEventListener("blur", resetInput);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", resetInput);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("blur", resetInput);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", resetInput);
      resetInput();
      unsubscribe();
      release();
    };
  }, [enabled]);
}
