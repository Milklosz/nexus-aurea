import { useEffect, useRef } from "react";
import {
  ControllerEngine,
  readControllerSample,
  type ControllerAction,
  type ControllerProfile,
} from "../services/controllerEngine";

export type ControllerActions = {
  move: (delta: -1 | 1) => void;
  /** Up/Down. Optional so existing callers keep their behaviour. */
  moveY?: (delta: -1 | 1) => void;
  confirm: () => void;
  back: () => void;
  options: () => void;
  /** PS + Options chord. Optional so existing callers keep their behaviour. */
  home?: () => void;
};

export function useGamepad(
  actions: ControllerActions,
  enabled = true,
  profile: ControllerProfile = "auto",
  suspendInput?: () => boolean,
) {
  const actionsRef = useRef(actions);
  const suspendRef = useRef(suspendInput);

  useEffect(() => {
    suspendRef.current = suspendInput;
  }, [suspendInput]);

  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== "function") return;

    let frame = 0;
    let selectedPad = "";
    const engine = new ControllerEngine();
    const dispatch = (action: ControllerAction) => {
      const handlers = actionsRef.current;
      switch (action.type) {
        case "move":
          handlers.move(action.delta);
          return;
        case "moveY":
          handlers.moveY?.(action.delta);
          return;
        case "confirm":
          handlers.confirm();
          return;
        case "back":
          handlers.back();
          return;
        case "options":
          handlers.options();
          return;
        case "home":
          handlers.home?.();
          return;
      }
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
          (pad): pad is Gamepad => Boolean(pad?.connected),
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
