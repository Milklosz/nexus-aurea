import { describe, expect, it } from "vitest";
import {
  ControllerEngine,
  controllerMappingSummary,
  decodeDpadHat,
  readControllerSample,
  resolveControllerProfile,
  type ControllerAction,
  type ControllerSample,
} from "../services/controllerEngine";

/** Hat value for "no direction" in the raw Sony mapping (8 / 3.5 - 1). */
const NEUTRAL_HAT = 8 / 3.5 - 1;
const DS4_RAW_ID = "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)";

function padFor(options: { id?: string; mapping?: string; buttons?: number; axes?: number[] } = {}): Gamepad {
  return {
    connected: true,
    id: options.id ?? DS4_RAW_ID,
    index: 0,
    mapping: options.mapping ?? "",
    buttons: Array.from({ length: options.buttons ?? 14 }, () => ({ pressed: false, value: 0 })),
    axes: options.axes ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, NEUTRAL_HAT],
    timestamp: 0,
    hapticActuators: [],
    vibrationActuator: null,
  } as unknown as Gamepad;
}

function withPressed(source: Gamepad, pressed: number[]): Gamepad {
  const buttons = Array.from(source.buttons, (_, index) => ({
    pressed: pressed.includes(index),
    value: pressed.includes(index) ? 1 : 0,
  })) as unknown as GamepadButton[];
  return { ...source, buttons } as Gamepad;
}

const neutral: ControllerSample = {
  connected: true,
  dpadLeft: false,
  dpadRight: false,
  dpadUp: false,
  dpadDown: false,
  axisX: 0,
  axisY: 0,
  confirm: false,
  back: false,
  options: false,
  home: false,
};

/** Feeds the engine one sample every `step` ms, the way the rAF poll does, and collects actions. */
function frames(engine: ControllerEngine, sample: ControllerSample, from: number, to: number, step = 10): ControllerAction[] {
  const actions: ControllerAction[] = [];
  for (let now = from; now <= to; now += step) actions.push(...engine.update(sample, now, true));
  return actions;
}

describe("DualShock 4 identity and mapping", () => {
  it("recognises DualShock 4 ids as the PlayStation profile unless the mapping is standard", () => {
    expect(resolveControllerProfile({ id: DS4_RAW_ID, mapping: "" }, "auto")).toBe("playstation");
    expect(resolveControllerProfile({ id: "054c-09cc-Wireless Controller", mapping: "" }, "auto")).toBe("playstation");
    expect(resolveControllerProfile({ id: "Sony Interactive Entertainment Wireless Controller", mapping: "" }, "auto")).toBe("playstation");
    expect(resolveControllerProfile({ id: "Wireless Controller", mapping: "standard" }, "auto")).toBe("standard");
    expect(resolveControllerProfile({ id: "Unknown pad", mapping: "" }, "auto")).toBeNull();
  });

  it("raw Sony layout: Cross confirms, Circle backs, Options is B9 and PS is B12", () => {
    const source = padFor();
    expect(readControllerSample(withPressed(source, [1]))?.confirm).toBe(true);
    expect(readControllerSample(withPressed(source, [2]))?.back).toBe(true);
    expect(readControllerSample(withPressed(source, [9]))?.options).toBe(true);
    expect(readControllerSample(withPressed(source, [12]))?.home).toBe(true);
  });

  it("raw Sony layout: B12 is PS, so it must never read as a D-pad direction", () => {
    const sample = readControllerSample(withPressed(padFor(), [12]));
    expect(sample?.dpadUp).toBe(false);
    expect(sample?.dpadDown).toBe(false);
  });

  it("standard mapping keeps the D-pad on B12-B15 and Home on B16", () => {
    const source = padFor({ mapping: "standard", id: "Wireless Controller", buttons: 17 });
    expect(readControllerSample(withPressed(source, [12]))?.dpadUp).toBe(true);
    expect(readControllerSample(withPressed(source, [13]))?.dpadDown).toBe(true);
    expect(readControllerSample(withPressed(source, [16]))?.home).toBe(true);
    expect(readControllerSample(withPressed(source, [0]))?.confirm).toBe(true);
    expect(readControllerSample(withPressed(source, [1]))?.back).toBe(true);
  });

  it("raw Sony D-pad comes from the hat on axis 9", () => {
    const hatPad = (value: number) => padFor({ axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, value] });
    expect(readControllerSample(hatPad(-1))).toMatchObject({ dpadUp: true, dpadDown: false, dpadLeft: false, dpadRight: false });
    expect(readControllerSample(hatPad(1 / 7))).toMatchObject({ dpadDown: true, dpadUp: false });
    expect(readControllerSample(hatPad(-3 / 7))).toMatchObject({ dpadRight: true, dpadLeft: false });
    expect(readControllerSample(hatPad(5 / 7))).toMatchObject({ dpadLeft: true, dpadRight: false });
    expect(readControllerSample(hatPad(NEUTRAL_HAT))).toMatchObject({
      dpadUp: false,
      dpadDown: false,
      dpadLeft: false,
      dpadRight: false,
    });
  });

  it("decodes all eight hat positions and ignores values that are not on the hat grid", () => {
    const positions = [
      { up: true, down: false, left: false, right: false }, // N
      { up: true, down: false, left: false, right: true }, // NE
      { up: false, down: false, left: false, right: true }, // E
      { up: false, down: true, left: false, right: true }, // SE
      { up: false, down: true, left: false, right: false }, // S
      { up: false, down: true, left: true, right: false }, // SW
      { up: false, down: false, left: true, right: false }, // W
      { up: true, down: false, left: true, right: false }, // NW
    ];
    positions.forEach((expected, position) => {
      expect(decodeDpadHat(position / 3.5 - 1)).toEqual(expected);
    });
    const nothing = { up: false, down: false, left: false, right: false };
    expect(decodeDpadHat(NEUTRAL_HAT)).toEqual(nothing);
    expect(decodeDpadHat(0)).toEqual(nothing);
    expect(decodeDpadHat(0.5)).toEqual(nothing);
    expect(decodeDpadHat(undefined)).toEqual(nothing);
    expect(decodeDpadHat(Number.NaN)).toEqual(nothing);
  });

  it("summary for the diagnostics panel names the buttons that are actually read", () => {
    expect(controllerMappingSummary("playstation")).toContain("B12");
    expect(controllerMappingSummary("playstation")).toContain("hat");
    expect(controllerMappingSummary("standard")).toContain("B16");
  });
});

describe("vertical navigation", () => {
  it("D-pad Down emits one move after the debounce, then repeats while held", () => {
    const engine = new ControllerEngine();
    const down = { ...neutral, dpadDown: true };
    engine.update(neutral, 0, true);
    expect(engine.update(down, 10, true)).toEqual([]);
    expect(engine.update(down, 49, true)).toEqual([]);
    expect(engine.update(down, 50, true)).toEqual([{ type: "moveY", delta: 1 }]);
    expect(engine.update(down, 469, true)).toEqual([]);
    expect(engine.update(down, 470, true)).toEqual([{ type: "moveY", delta: 1 }]);
  });

  it("left stick Y uses the same hysteresis as X", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    engine.update({ ...neutral, axisY: -0.6 }, 10, true);
    expect(engine.update({ ...neutral, axisY: -0.6 }, 50, true)).toEqual([{ type: "moveY", delta: -1 }]);
    expect(engine.update({ ...neutral, axisY: -0.4 }, 60, true)).toEqual([]);
  });

  it("a diagonal emits only the horizontal move", () => {
    const engine = new ControllerEngine();
    const diagonal = { ...neutral, dpadLeft: true, dpadUp: true };
    engine.update(neutral, 0, true);
    engine.update(diagonal, 10, true);
    expect(engine.update(diagonal, 50, true)).toEqual([{ type: "move", delta: -1 }]);
  });

  it("Up and Down pressed together do not move vertically", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(frames(engine, { ...neutral, dpadUp: true, dpadDown: true }, 10, 200)).toEqual([]);
  });
});

describe("Home chord (PS + Options)", () => {
  const both = { ...neutral, home: true, options: true };
  const ps = { ...neutral, home: true };

  it("PS pressed first, then Options inside the window: one Home, Options is swallowed", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(frames(engine, ps, 10, 50)).toEqual([]);
    expect(frames(engine, both, 60, 100)).toEqual([{ type: "home" }]);
    expect(frames(engine, both, 110, 500)).toEqual([]);
    expect(frames(engine, neutral, 510, 600)).toEqual([]);
  });

  it("Options first, then PS inside the window: one Home, Options never opens", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(frames(engine, { ...neutral, options: true }, 10, 50)).toEqual([]);
    expect(frames(engine, both, 60, 100)).toEqual([{ type: "home" }]);
    expect(frames(engine, both, 110, 400)).toEqual([]);
    expect(frames(engine, neutral, 410, 500)).toEqual([]);
  });

  it("a lone Options tap still opens Options, on release", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(frames(engine, { ...neutral, options: true }, 10, 50)).toEqual([]);
    expect(frames(engine, neutral, 60, 100)).toEqual([{ type: "options" }]);
  });

  it("a held Options opens after the chord window when no PS arrives", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(frames(engine, { ...neutral, options: true }, 10, 290)).toEqual([]);
    expect(frames(engine, { ...neutral, options: true }, 300, 300)).toEqual([{ type: "options" }]);
  });

  it("PS alone never fires Home", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(frames(engine, ps, 10, 800)).toEqual([]);
    expect(frames(engine, neutral, 810, 900)).toEqual([]);
  });

  it("fires at most once per cooldown and again after it", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(frames(engine, both, 10, 100)).toEqual([{ type: "home" }]);
    expect(frames(engine, neutral, 110, 200)).toEqual([]);
    // A second chord well inside the 750 ms cooldown must not fire Home again.
    expect(frames(engine, both, 210, 400)).not.toContainEqual({ type: "home" });
    expect(frames(engine, neutral, 900, 990)).not.toContainEqual({ type: "home" });
    // After the cooldown, a fresh chord fires again.
    expect(frames(engine, both, 1000, 1100)).toContainEqual({ type: "home" });
  });

  it("does not replay a chord held when the controller reconnects", () => {
    const engine = new ControllerEngine();
    engine.update(both, 0, true);
    expect(frames(engine, both, 10, 500)).toEqual([]);
    expect(frames(engine, neutral, 510, 600)).toEqual([]);
  });
});
