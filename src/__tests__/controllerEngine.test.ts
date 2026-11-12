import { describe, expect, it } from "vitest";
import {
  ControllerEngine,
  readControllerSample,
  resolveControllerProfile,
  type ControllerSample,
} from "../services/controllerEngine";

function pad(mapping: string, id = "Wireless Controller"): Gamepad {
  return {
    connected: true,
    id,
    index: 0,
    mapping,
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0],
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
};

describe("PlayStation and standard controller mappings", () => {
  it("maps standard X, O, D-pad and Options buttons", () => {
    const source = pad("standard");
    expect(resolveControllerProfile(source, "auto")).toBe("standard");
    expect(readControllerSample(press(source, 0))?.confirm).toBe(true);
    expect(readControllerSample(press(source, 1))?.back).toBe(true);
    expect(readControllerSample(press(source, 14))?.dpadLeft).toBe(true);
    expect(readControllerSample(press(source, 15))?.dpadRight).toBe(true);
    expect(readControllerSample(press(source, 9))?.options).toBe(true);
    expect(readControllerSample({ ...source, axes: [-0.8, 0] } as Gamepad)?.axisX).toBe(-0.8);
  });

  it("maps raw Sony layouts and allows forcing either profile", () => {
    const source = pad("", "Wireless Controller (054c)");
    expect(resolveControllerProfile(source, "auto")).toBe("playstation");
    expect(readControllerSample(press(source, 1))?.confirm).toBe(true);
    expect(readControllerSample(press(source, 2))?.back).toBe(true);
    expect(readControllerSample(press(source, 9))?.options).toBe(true);
    expect(resolveControllerProfile({ id: "Unknown pad", mapping: "" }, "auto")).toBeNull();
    expect(resolveControllerProfile({ id: "Unknown pad", mapping: "" }, "standard")).toBe("standard");
    expect(resolveControllerProfile({ id: "Wireless Controller", mapping: "standard" }, "auto")).toBe("standard");
  });
});

describe("controller timing and focus", () => {
  it("debounces D-pad input, repeats a hold, and applies analog hysteresis", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    const left = { ...neutral, dpadLeft: true };
    expect(engine.update(left, 10, true)).toEqual([]);
    expect(engine.update(left, 49, true)).toEqual([]);
    expect(engine.update(left, 50, true)).toEqual([{ type: "move", delta: -1 }]);
    expect(engine.update(left, 469, true)).toEqual([]);
    expect(engine.update(left, 470, true)).toEqual([{ type: "move", delta: -1 }]);
    expect(engine.update(left, 605, true)).toEqual([{ type: "move", delta: -1 }]);

    engine.update(neutral, 620, true);
    expect(engine.update({ ...neutral, axisX: -0.56 }, 630, true)).toEqual([]);
    expect(engine.update({ ...neutral, axisX: -0.56 }, 670, true)).toEqual([{ type: "move", delta: -1 }]);
    expect(engine.update({ ...neutral, axisX: -0.4 }, 680, true)).toEqual([]);
    expect(engine.update({ ...neutral, axisX: -0.3 }, 690, true)).toEqual([]);
    expect(engine.update({ ...neutral, axisX: -0.54 }, 700, true)).toEqual([]);
  });

  it("debounces X, O, and Options and emits each only once per press", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    const allPressed = { ...neutral, confirm: true, back: true, options: true };
    expect(engine.update(allPressed, 10, true)).toEqual([]);
    expect(engine.update(allPressed, 49, true)).toEqual([]);
    // X and O are immediate. Options waits out the Home chord window (250 ms) so a
    // PS + Options chord never also opens the Control Center.
    expect(engine.update(allPressed, 50, true)).toEqual([
      { type: "confirm" },
      { type: "back" },
    ]);
    expect(engine.update(allPressed, 100, true)).toEqual([]);
    expect(engine.update(allPressed, 299, true)).toEqual([]);
    expect(engine.update(allPressed, 300, true)).toEqual([{ type: "options" }]);
    expect(engine.update(allPressed, 350, true)).toEqual([]);
    expect(engine.update(neutral, 360, true)).toEqual([]);
    expect(engine.update(neutral, 400, true)).toEqual([]);
  });

  it("resets input when the window loses focus and suppresses buttons held on return", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(engine.update({ ...neutral, confirm: true }, 10, true)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 20, false)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 30, true)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 100, true)).toEqual([]);
    expect(engine.update(neutral, 110, true)).toEqual([]);
    expect(engine.update(neutral, 150, true)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 160, true)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 200, true)).toEqual([{ type: "confirm" }]);
  });

  it("does not replay a held input after controller disconnect and reconnect", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(engine.update({ ...neutral, confirm: true }, 10, true)).toEqual([]);
    expect(engine.update({ ...neutral, connected: false, confirm: true }, 20, true)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 30, true)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 100, true)).toEqual([]);
    expect(engine.update(neutral, 110, true)).toEqual([]);
    expect(engine.update(neutral, 150, true)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 160, true)).toEqual([]);
    expect(engine.update({ ...neutral, confirm: true }, 200, true)).toEqual([{ type: "confirm" }]);
  });
});
