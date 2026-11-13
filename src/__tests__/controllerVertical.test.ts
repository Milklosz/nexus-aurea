import { describe, expect, it } from "vitest";
import { intentFromController } from "../services/navIntent";
import {
  ControllerEngine,
  readControllerSample,
  type ControllerAction,
  type ControllerSample,
} from "../services/controllerEngine";

function pad(mapping: string, id = "Wireless Controller", axes = [0, 0]): Gamepad {
  return {
    connected: true,
    id,
    index: 0,
    mapping,
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    axes,
    timestamp: 0,
    hapticActuators: [],
    vibrationActuator: null,
  } as unknown as Gamepad;
}

function press(source: Gamepad, index: number): Gamepad {
  const buttons = Array.from(source.buttons);
  buttons[index] = { pressed: true, value: 1 } as GamepadButton;
  return { ...source, buttons } as Gamepad;
}

const neutral: ControllerSample = {
  connected: true,
  dpadLeft: false,
  dpadRight: false,
  axisX: 0,
  confirm: false,
  back: false,
  options: false,
  dpadUp: false,
  dpadDown: false,
  axisY: 0,
};

function run(engine: ControllerEngine, sample: ControllerSample, times: number[]): ControllerAction[] {
  return times.flatMap((time) => engine.update(sample, time, true));
}

describe("vertical input in the sample", () => {
  it("reads standard D-pad up and down from buttons 12 and 13", () => {
    const up = readControllerSample(press(pad("standard"), 12), "auto");
    expect(up?.dpadUp).toBe(true);
    expect(up?.dpadDown).toBe(false);
    expect(readControllerSample(press(pad("standard"), 13), "auto")?.dpadDown).toBe(true);
  });

  it("does not read buttons 12 and 13 on the PlayStation profile, where 12 is the PS button", () => {
    expect(readControllerSample(press(pad(""), 12), "playstation")?.dpadUp).toBe(false);
    expect(readControllerSample(press(pad(""), 13), "playstation")?.dpadDown).toBe(false);
  });

  it("reads the left stick Y on both profiles, with a finite fallback", () => {
    expect(readControllerSample(pad("", "Wireless Controller", [0, -0.9]), "playstation")?.axisY).toBeCloseTo(-0.9);
    expect(readControllerSample(pad("standard", "x", [0, 0.8]), "standard")?.axisY).toBeCloseTo(0.8);
    expect(readControllerSample(pad("standard", "x", [0, Number.NaN]), "standard")?.axisY).toBe(0);
  });
});

describe("vertical actions from the engine", () => {
  it("emits one step after the debounce for a D-pad press and then stops", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    const actions = run(engine, { ...neutral, dpadDown: true }, [10, 60]);
    expect(actions).toEqual([{ type: "vertical", delta: 1 }]);
  });

  it("repeats a held stick after the initial delay, then at the repeat rate", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    // Change at 50 ms; first step at 100 ms (after the 40 ms debounce); next at 520 ms
    // (100 + 420); then every 135 ms: 655 ms. Nothing fires between those times.
    const actions = run(engine, { ...neutral, axisY: -0.9 }, [50, 100, 400, 520, 600, 655]);
    expect(actions).toEqual([
      { type: "vertical", delta: -1 },
      { type: "vertical", delta: -1 },
      { type: "vertical", delta: -1 },
    ]);
  });

  it("does not fire for a stick already held at startup until it is released and pressed again", () => {
    const engine = new ControllerEngine();
    const held = { ...neutral, axisY: 0.9 };
    engine.update(held, 0, true);
    expect(run(engine, held, [100, 600])).toEqual([]);
    engine.update(neutral, 700, true);
    expect(run(engine, held, [800])).toEqual([]);
    expect(run(engine, held, [900])).toEqual([{ type: "vertical", delta: 1 }]);
  });

  it("keeps horizontal and vertical moves separate", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    const actions = run(engine, { ...neutral, dpadRight: true, dpadDown: true }, [10, 60]);
    expect(actions).toEqual([
      { type: "move", delta: 1 },
      { type: "vertical", delta: 1 },
    ]);
  });

  it("clears vertical repeat state when the input is reset", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    engine.update({ ...neutral, dpadUp: true }, 10, true);
    engine.reset();
    engine.update(neutral, 100, true);
    expect(run(engine, { ...neutral, dpadUp: true }, [200, 260])).toEqual([{ type: "vertical", delta: -1 }]);
  });
});

describe("vertical controller actions in the intent model", () => {
  it("maps up and down to navigation move intents", () => {
    expect(intentFromController({ type: "vertical", delta: -1 })).toEqual({ kind: "move", direction: "up" });
    expect(intentFromController({ type: "vertical", delta: 1 })).toEqual({ kind: "move", direction: "down" });
  });
});
