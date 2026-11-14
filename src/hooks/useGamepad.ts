import { useEffect, useRef } from "react";
import {
  ControllerEngine,
  readControllerSample,
  type ControllerAction,
  type ControllerProfile,
} from "../services/controllerEngine";
import { crossSourceGate } from "../services/crossSourceGate";

export type ControllerActions = {
  move: (delta: -1 | 1) => void;
  /** Up (-1) or down (+1): home zones, or dialog focus while a dialog is open. Optional: absent means no-op. */
  vertical?: (delta: -1 | 1) => void;
  confirm: () => void;
  back: () => void;
  options: () => void;
};

/**
 * Browser Gamepad API source. It stays the path for every pad the native layer does not
 * own (Xbox, DualSense, ...) and the fallback for a DualShock 4 when the native layer is
 * unavailable. `ignorePad` lets the caller hand a specific pad to the native source so one
 * physical press never reaches the handlers twice.
 */
export function useGamepad(
  actions: ControllerActions,
  enabled = true,
  profile: ControllerProfile = "auto",
  suspendInput?: () => boolean,
  ignorePad?: (pad: Gamepad) => boolean,
) {
  const actionsRef = useRef(actions);
  const suspendRef = useRef(suspendInput);
  const ignoreRef = useRef(ignorePad);

  useEffect(() => {
    suspendRef.current = suspendInput;
  }, [suspendInput]);

  useEffect(() => {
    ignoreRef.current = ignorePad;
  }, [ignorePad]);

  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== "function") return;

    let frame = 0;
    let selectedPad = "";
    const engine = new ControllerEngine();
    const dispatch = (action: ControllerAction) => {
      if (!crossSourceGate.accept("gamepad-api", action, performance.now())) return;
      if (action.type === "move") actionsRef.current.move(action.delta);
      else if (action.type === "vertical") actionsRef.current.vertical?.(action.delta);
      else actionsRef.current[action.type]();
    };
    const poll = () => {
      const focused = document.hasFocus() && document.visibilityState === "visible";
      if (!focused || suspendRef.current?.()) {
        engine.reset();
        selectedPad = "";
        frame = window.requestAnimationFrame(poll);
        return;
      }

      let pads: Gamepad[] = [];
      try {
        pads = Array.from(navigator.getGamepads() ?? []).filter(
          (pad): pad is Gamepad => Boolean(pad?.connected) && !ignoreRef.current?.(pad as Gamepad),
        );
      } catch {
        engine.reset();
      }
      const pad = pads.find((candidate) => readControllerSample(candidate, profile));
      const identity = pad ? pad.index + ":" + pad.id : "";
      if (identity !== selectedPad) {
        engine.reset();
        selectedPad = identity;
      }
      const samples = engine.update(pad ? readControllerSample(pad, profile) : null, performance.now(), true);
      for (const action of samples) dispatch(action);
      frame = window.requestAnimationFrame(poll);
    };

    frame = window.requestAnimationFrame(poll);
    return () => {
      window.cancelAnimationFrame(frame);
      engine.reset();
    };
  }, [enabled, profile]);
}
