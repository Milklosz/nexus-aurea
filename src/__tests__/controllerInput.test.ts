import { describe, expect, it } from "vitest";
import { readControllerSample } from "../services/controllerEngine";
import {
  decodeSonyHat,
  normalizeGamepad,
  SONY_HAT_NEUTRAL,
} from "../services/controllerInput";

function pad(options: {
  id?: string;
  mapping?: string;
  pressed?: number[];
  axes?: number[];
} = {}): Gamepad {
  const pressed = new Set(options.pressed ?? []);
  return {
    id: options.id ?? "DualSense Wireless Controller",
    mapping: (options.mapping ?? "") as Gamepad["mapping"],
    connected: true,
    axes: options.axes ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, SONY_HAT_NEUTRAL],
    buttons: Array.from({ length: 17 }, (_, index) => ({
      pressed: pressed.has(index),
      value: pressed.has(index) ? 1 : 0,
      touched: pressed.has(index),
    })),
  } as unknown as Gamepad;
}

/** Sony hat value for one direction, from the 8-step encoding -1 + k * 2/7. */
const HAT = {
  up: -1,
  upRight: -1 + 2 / 7,
  right: -1 + 4 / 7,
  downRight: -1 + 6 / 7,
  down: -1 + 8 / 7,
  downLeft: -1 + 10 / 7,
  left: -1 + 12 / 7,
  upLeft: 1,
};

const PS = "playstation" as const;

describe("decodeSonyHat", () => {
  it("decodes every direction from the documented values", () => {
    expect(decodeSonyHat(HAT.up)).toEqual({ kind: "direction", dpad: { up: true, down: false, left: false, right: false } });
    expect(decodeSonyHat(HAT.right)).toEqual({ kind: "direction", dpad: { up: false, down: false, left: false, right: true } });
    expect(decodeSonyHat(HAT.down)).toEqual({ kind: "direction", dpad: { up: false, down: true, left: false, right: false } });
    expect(decodeSonyHat(HAT.left)).toEqual({ kind: "direction", dpad: { up: false, down: false, left: true, right: false } });
    expect(decodeSonyHat(HAT.upRight)).toEqual({ kind: "direction", dpad: { up: true, down: false, left: false, right: true } });
    expect(decodeSonyHat(HAT.downRight)).toEqual({ kind: "direction", dpad: { up: false, down: true, left: false, right: true } });
    expect(decodeSonyHat(HAT.downLeft)).toEqual({ kind: "direction", dpad: { up: false, down: true, left: true, right: false } });
    expect(decodeSonyHat(HAT.upLeft)).toEqual({ kind: "direction", dpad: { up: true, down: false, left: true, right: false } });
  });

  it("reads the neutral position as a hat with no direction", () => {
    expect(decodeSonyHat(SONY_HAT_NEUTRAL)).toEqual({ kind: "neutral" });
  });

  it("does not treat stick positions or centre values as hat directions", () => {
    expect(decodeSonyHat(0)).toBeNull();
    expect(decodeSonyHat(0.5)).toBeNull();
    expect(decodeSonyHat(-0.9)).toBeNull();
    expect(decodeSonyHat(Number.NaN)).toBeNull();
  });
});

describe("normalizeGamepad: standard mapping", () => {
  it("reads the D-pad from buttons 12 to 15 and ignores the hat axis", () => {
    const up = normalizeGamepad(pad({ mapping: "standard", pressed: [12] }), "standard");
    expect(up.dpad).toEqual({ up: true, down: false, left: false, right: false });
    expect(up.dpadSource).toBe("standard-buttons");
    const left = normalizeGamepad(pad({ mapping: "standard", pressed: [14], axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, HAT.left] }), "standard");
    expect(left.dpad.left).toBe(true);
    expect(left.dpad.right).toBe(false);
  });

  it("keeps confirm on A (0) and back on B (1)", () => {
    const input = normalizeGamepad(pad({ mapping: "standard", pressed: [0, 1, 9] }), "standard");
    expect(input.buttons).toEqual({ confirm: true, back: true, options: true });
  });
});

describe("normalizeGamepad: PlayStation raw mapping", () => {
  it("reads every hat direction and treats the hat as the D-pad", () => {
    const left = normalizeGamepad(pad({ axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, HAT.left] }), PS);
    expect(left.dpad).toEqual({ up: false, down: false, left: true, right: false });
    expect(left.dpadSource).toBe("sony-hat");
    const down = normalizeGamepad(pad({ axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, HAT.down] }), PS);
    expect(down.dpad.down).toBe(true);
  });

  it("reports no direction on a neutral hat", () => {
    const input = normalizeGamepad(pad(), PS);
    expect(input.dpad).toEqual({ up: false, down: false, left: false, right: false });
    expect(input.dpadSource).toBe("sony-hat");
  });

  it("lets a decodable hat win over buttons 14 and 15, so a neutral hat is never overridden by them", () => {
    const input = normalizeGamepad(pad({ pressed: [14] }), PS);
    expect(input.dpad.left).toBe(false);
    expect(input.dpadSource).toBe("sony-hat");
  });

  it("never reads vertical D-pad from buttons 12 or 13, where 12 is the PS button", () => {
    const psButton = normalizeGamepad(pad({ axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5], pressed: [12] }), PS);
    expect(psButton.dpad.up).toBe(false);
    expect(psButton.dpad.down).toBe(false);
    const touchpad = normalizeGamepad(pad({ axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5], pressed: [13] }), PS);
    expect(touchpad.dpad.down).toBe(false);
  });

  it("falls back to buttons 14 and 15 only when no decodable hat is present", () => {
    const fallback = normalizeGamepad(pad({ axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5], pressed: [15] }), PS);
    expect(fallback.dpad).toEqual({ up: false, down: false, left: false, right: true });
    expect(fallback.dpadSource).toBe("legacy-buttons");
  });

  it("maps Cross to confirm (0) and Circle to back (1)", () => {
    const cross = normalizeGamepad(pad({ pressed: [0] }), PS);
    expect(cross.buttons).toEqual({ confirm: true, back: false, options: false });
    const circle = normalizeGamepad(pad({ pressed: [1] }), PS);
    expect(circle.buttons).toEqual({ confirm: false, back: true, options: false });
  });

  it("does nothing on Square (2), which is reserved for future actions", () => {
    const square = normalizeGamepad(pad({ pressed: [2] }), PS);
    expect(square.buttons).toEqual({ confirm: false, back: false, options: false });
  });

  it("maps Options (9) to options and nothing else", () => {
    const input = normalizeGamepad(pad({ pressed: [9] }), PS);
    expect(input.buttons).toEqual({ confirm: false, back: false, options: true });
  });

  it("returns finite stick values and zero for NaN", () => {
    expect(normalizeGamepad(pad({ axes: [-0.8, 0.4, 0, 0, 0, 0, 0, 0, 0, HAT.left] }), PS).stick).toEqual({ x: -0.8, y: 0.4 });
    expect(normalizeGamepad(pad({ axes: [Number.NaN, Number.NaN, 0, 0, 0, 0, 0, 0, 0, HAT.left] }), PS).stick).toEqual({ x: 0, y: 0 });
  });
});

describe("readControllerSample uses the normalized input", () => {
  it("exposes the hat as the same up, down, left and right flags the engine reads", () => {
    const sample = readControllerSample(pad({ axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, HAT.upRight] }), "playstation");
    expect(sample?.dpadUp).toBe(true);
    expect(sample?.dpadRight).toBe(true);
    expect(sample?.dpadLeft).toBe(false);
    expect(sample?.dpadDown).toBe(false);
  });
});
