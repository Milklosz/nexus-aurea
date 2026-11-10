import { useEffect, useRef } from "react";
import {
  ControllerEngine,
  readControllerSample,
  type ControllerAction,
  type ControllerProfile,
} from "../services/controllerEngine";

export type ControllerActions = {
  move: (delta: -1 | 1) => void;
  confirm: () => void;
  back: () => void;
  options: () => void;
};

export function useGamepad(
  actions: ControllerActions,
  enabled = true,
  profile: ControllerProfile = "auto",
) {
  const actionsRef = useRef(actions);

  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== "function") return;

    let frame = 0;
    let selectedPad = "";
    const engine = new ControllerEngine();
    const dispatch = (action: ControllerAction) => {
      if (action.type === "move") actionsRef.current.move(action.delta);
      else actionsRef.current[action.type]();
    };
    const poll = () => {
      const focused = document.hasFocus() && document.visibilityState === "visible";
      let pads: Gamepad[] = [];
      try {
        pads = Array.from(navigator.getGamepads() ?? []).filter(
          (pad): pad is Gamepad => Boolean(pad?.connected),
        );
      } catch {
        engine.reset();
      }
      const pad = focused ? pads.find((candidate) => readControllerSample(candidate, profile)) : undefined;
      const identity = pad ? pad.index + ":" + pad.id : "";
      if (identity !== selectedPad) {
        engine.reset();
        selectedPad = identity;
      }
      const samples = engine.update(pad ? readControllerSample(pad, profile) : null, performance.now(), focused);
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
