import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_MS,
  DEFAULT_DS4_BINDINGS,
  NEUTRAL_SNAPSHOT,
  chooseInputSource,
  initialNativeControllerModel,
  isDualShock4GamepadId,
  nativeLinkState,
  parseNativeControllerEvent,
  reduceNativeController,
  sampleFromNative,
  type Ds4ButtonName,
  type NativeControllerEvent,
  type NativeControllerModel,
} from "../services/nativeController";
import { ControllerEngine } from "../services/controllerEngine";

const connected = (device: string, transport: "usb" | "bluetooth" = "usb"): NativeControllerEvent =>
  ({ kind: "connected", device, revision: "v2", transport });

function state(
  device: string,
  buttons: Ds4ButtonName[] = [],
  dpad: Partial<Record<"up" | "down" | "left" | "right", boolean>> = {},
  leftX = 0,
  leftY = 0,
): NativeControllerEvent {
  return {
    kind: "state", device, revision: "v2", transport: "usb",
    dpad: { up: false, down: false, left: false, right: false, ...dpad },
    leftX, leftY, buttons,
  };
}

function run(events: Array<[NativeControllerEvent, number]>): NativeControllerModel {
  return events.reduce((model, [event, at]) => reduceNativeController(model, event, at), initialNativeControllerModel);
}

describe("parseNativeControllerEvent", () => {
  it("accepts well-formed events and drops unknown button names", () => {
    const parsed = parseNativeControllerEvent({
      kind: "state", device: "abc", revision: "v2", transport: "bluetooth",
      dpad: { up: false, down: false, left: true, right: false }, leftX: -1, leftY: 0.5,
      buttons: ["cross", "bogus", 7, "options"],
    });
    expect(parsed).toMatchObject({ kind: "state", buttons: ["cross", "options"] });
  });

  it("rejects malformed payloads instead of coercing them", () => {
    for (const bad of [
      null, 5, "x", {}, { kind: "state" }, { kind: "connected", device: 3 },
      { kind: "connected", device: "a", revision: "v9", transport: "usb" },
      { kind: "state", device: "a", revision: "v1", transport: "usb", dpad: { up: 1 }, leftX: 0, leftY: 0, buttons: [] },
      { kind: "state", device: "a", revision: "v1", transport: "usb", dpad: { up: false, down: false, left: false, right: false }, leftX: Number.NaN, leftY: 0, buttons: [] },
      { kind: "disconnected" }, { kind: "explode" },
    ]) {
      expect(parseNativeControllerEvent(bad)).toBeNull();
    }
  });
});

describe("sampleFromNative", () => {
  it("maps semantic names to Cross confirm, Circle back, Options menu", () => {
    expect(sampleFromNative({ ...NEUTRAL_SNAPSHOT, buttons: ["cross"] })).toMatchObject({ confirm: true, back: false, options: false });
    expect(sampleFromNative({ ...NEUTRAL_SNAPSHOT, buttons: ["circle"] })).toMatchObject({ confirm: false, back: true });
    expect(sampleFromNative({ ...NEUTRAL_SNAPSHOT, buttons: ["options"] })).toMatchObject({ options: true });
  });

  it("gives Share, PS, Touchpad, Square, Triangle and bumpers no navigation action by default", () => {
    for (const name of ["share", "ps", "touchpad", "square", "triangle", "l1", "r1"] as const) {
      expect(sampleFromNative({ ...NEUTRAL_SNAPSHOT, buttons: [name] })).toMatchObject({ confirm: false, back: false, options: false });
    }
  });

  it("supports remapping through bindings", () => {
    const sample = sampleFromNative({ ...NEUTRAL_SNAPSHOT, buttons: ["square"] }, { ...DEFAULT_DS4_BINDINGS, confirm: ["square"] });
    expect(sample?.confirm).toBe(true);
  });

  it("returns null without a snapshot", () => {
    expect(sampleFromNative(null)).toBeNull();
  });
});

describe("reduceNativeController", () => {
  it("tracks connect, state and disconnect with a neutral snapshot on connect", () => {
    let model = reduceNativeController(initialNativeControllerModel, connected("a"), 1);
    expect(model.activeDevice).toBe("a");
    expect(model.snapshot).toEqual(NEUTRAL_SNAPSHOT);
    model = reduceNativeController(model, state("a", ["cross"]), 2);
    expect(model.snapshot?.buttons).toEqual(["cross"]);
    expect(model.lastButton).toBe("cross");
    model = reduceNativeController(model, { kind: "disconnected", device: "a" }, 3);
    expect(model.pads).toEqual([]);
    expect(model.activeDevice).toBeNull();
    expect(model.snapshot).toBeNull();
  });

  it("treats a state event from an unseen pad as a connection", () => {
    const model = run([[state("late", ["cross"]), 5]]);
    expect(model.pads.map((pad) => pad.device)).toEqual(["late"]);
    expect(model.activeDevice).toBe("late");
  });

  it("does not let a second pad steal control mid-press, but hands over when neutral", () => {
    let model = run([[connected("a"), 1], [connected("b"), 2], [state("a", ["cross"]), 3]]);
    model = reduceNativeController(model, state("b", ["circle"]), 4);
    expect(model.activeDevice).toBe("a");
    expect(model.snapshot?.buttons).toEqual(["cross"]);
    model = reduceNativeController(model, state("a", []), 5);
    model = reduceNativeController(model, state("b", ["circle"]), 6);
    expect(model.activeDevice).toBe("b");
  });

  it("promotes the remaining pad when the active one disconnects and releases all input", () => {
    let model = run([[connected("a"), 1], [connected("b"), 2], [state("a", ["cross"], { left: true }), 3]]);
    model = reduceNativeController(model, { kind: "disconnected", device: "a" }, 4);
    expect(model.activeDevice).toBe("b");
    expect(model.snapshot).toEqual(NEUTRAL_SNAPSHOT);
  });

  it("a duplicate connect for the same device does not create a second pad", () => {
    const model = run([[connected("a"), 1], [connected("a", "bluetooth"), 2]]);
    expect(model.pads).toHaveLength(1);
    expect(model.pads[0]?.transport).toBe("bluetooth");
  });

  it("unavailable clears pads and reports unsupported", () => {
    const model = run([[connected("a"), 1], [{ kind: "unavailable", reason: "no raw input" }, 2]]);
    expect(model.pads).toEqual([]);
    expect(nativeLinkState(model, 3)).toBe("unsupported");
  });

  it("an empty unavailable reason is still unavailable", () => {
    const model = run([[{ kind: "unavailable", reason: "" }, 1]]);
    expect(model.unavailableReason).toBeTruthy();
  });
});

describe("nativeLinkState", () => {
  it("separates disconnected, connected, active, unsupported", () => {
    expect(nativeLinkState(initialNativeControllerModel, 0)).toBe("disconnected");
    const idle = run([[connected("a"), 0]]);
    expect(nativeLinkState(idle, 1)).toBe("connected");
    const pressed = reduceNativeController(idle, state("a", ["cross"]), 100);
    expect(nativeLinkState(pressed, 100 + ACTIVE_WINDOW_MS - 1)).toBe("active");
    expect(nativeLinkState(pressed, 100 + ACTIVE_WINDOW_MS)).toBe("connected");
  });

  it("stick noise below the dead zone is not activity", () => {
    const idle = run([[connected("a"), 0]]);
    const noisy = reduceNativeController(idle, state("a", [], {}, 0.1, -0.1), 50);
    expect(nativeLinkState(noisy, 51)).toBe("connected");
  });
});

describe("isDualShock4GamepadId", () => {
  it("recognises DualShock 4 ids from Chromium", () => {
    expect(isDualShock4GamepadId("Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)")).toBe(true);
    expect(isDualShock4GamepadId("Wireless Controller (Vendor: 054c Product: 05c4)")).toBe(true);
    expect(isDualShock4GamepadId("054c-09cc-Wireless Controller")).toBe(true);
  });

  it("leaves DualSense, Xbox and others on the browser path", () => {
    expect(isDualShock4GamepadId("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)")).toBe(false);
    expect(isDualShock4GamepadId("Xbox 360 Controller (XInput STANDARD GAMEPAD)")).toBe(false);
    expect(isDualShock4GamepadId("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)")).toBe(false);
  });

  it("skips a Sony pad with an unreadable product to avoid double input", () => {
    expect(isDualShock4GamepadId("Vendor: 054c Wireless Controller")).toBe(true);
  });
});

describe("chooseInputSource", () => {
  it("prefers native when it has a pad, falls back to the Gamepad API, else none", () => {
    const withPad = run([[connected("a"), 0]]);
    expect(chooseInputSource(withPad, 1)).toBe("native");
    expect(chooseInputSource(initialNativeControllerModel, 1)).toBe("gamepad-api");
    expect(chooseInputSource(initialNativeControllerModel, 0)).toBe("none");
    const broken = reduceNativeController(withPad, { kind: "unavailable", reason: "x" }, 1);
    expect(chooseInputSource(broken, 1)).toBe("gamepad-api");
  });
});

describe("native snapshots through the shared engine", () => {
  const feed = (engine: ControllerEngine, snapshot: Parameters<typeof sampleFromNative>[0], at: number) =>
    engine.update(sampleFromNative(snapshot), at, true);
  const right = { ...NEUTRAL_SNAPSHOT, dpad: { ...NEUTRAL_SNAPSHOT.dpad, right: true } };

  it("one Cross press is exactly one confirm", () => {
    const engine = new ControllerEngine();
    const down = { ...NEUTRAL_SNAPSHOT, buttons: ["cross" as const] };
    const actions = [
      ...feed(engine, NEUTRAL_SNAPSHOT, 0),
      ...feed(engine, down, 10),
      ...feed(engine, down, 60),
      ...feed(engine, down, 120),
      ...feed(engine, NEUTRAL_SNAPSHOT, 200),
    ];
    expect(actions.filter((action) => action.type === "confirm")).toHaveLength(1);
  });

  it("a short D-pad tap moves once without repeating", () => {
    const engine = new ControllerEngine();
    feed(engine, NEUTRAL_SNAPSHOT, 0);
    let moves = 0;
    for (let t = 10; t <= 100; t += 16) moves += feed(engine, right, t).filter((a) => a.type === "move").length;
    expect(moves).toBe(1);
  });

  it("holding repeats at a bounded, time-based rate", () => {
    const engine = new ControllerEngine();
    feed(engine, NEUTRAL_SNAPSHOT, 0);
    let held = 0;
    for (let t = 10; t <= 1010; t += 16) held += feed(engine, right, t).filter((a) => a.type === "move").length;
    // One initial step, then repeats after 420 ms at 135 ms intervals: about 5 in a second.
    expect(held).toBeGreaterThanOrEqual(4);
    expect(held).toBeLessThanOrEqual(6);
  });

  it("repeat speed does not depend on the tick rate", () => {
    const count = (step: number) => {
      const engine = new ControllerEngine();
      feed(engine, NEUTRAL_SNAPSHOT, 0);
      let moves = 0;
      for (let t = 10; t <= 1500; t += step) moves += feed(engine, right, t).filter((a) => a.type === "move").length;
      return moves;
    };
    expect(Math.abs(count(8) - count(33))).toBeLessThanOrEqual(1);
  });

  it("changing direction while held steps the new direction at once", () => {
    const engine = new ControllerEngine();
    const left = { ...NEUTRAL_SNAPSHOT, dpad: { ...NEUTRAL_SNAPSHOT.dpad, left: true } };
    feed(engine, NEUTRAL_SNAPSHOT, 0);
    for (let t = 10; t <= 200; t += 16) feed(engine, right, t);
    let delta = 0;
    for (let t = 216; t <= 300; t += 16) {
      for (const action of feed(engine, left, t)) if (action.type === "move") delta += action.delta;
    }
    expect(delta).toBe(-1);
  });

  it("the left stick has a dead zone and hysteresis", () => {
    const engine = new ControllerEngine();
    const stick = (x: number) => ({ ...NEUTRAL_SNAPSHOT, leftX: x });
    feed(engine, NEUTRAL_SNAPSHOT, 0);
    let moves = 0;
    for (let t = 10; t <= 600; t += 16) moves += feed(engine, stick(0.4), t).filter((a) => a.type === "move").length;
    expect(moves).toBe(0);
    moves = 0;
    for (let t = 620; t <= 700; t += 16) moves += feed(engine, stick(0.6), t).filter((a) => a.type === "move").length;
    expect(moves).toBe(1);
    // Easing back to 0.4 stays "pushed" (hysteresis): no extra step and no release flicker.
    for (let t = 720; t <= 760; t += 16) feed(engine, stick(0.4), t);
    expect(feed(engine, stick(0.4), 780).filter((a) => a.type === "move")).toHaveLength(0);
  });
});
