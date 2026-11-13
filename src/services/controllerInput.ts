import type { ControllerProfile } from "./controllerEngine";

/**
 * Input normalization for gamepads. Every raw layout is turned into the same
 * shape (D-pad, left stick, three buttons) before the navigation engine sees it.
 * Pure functions, no DOM or timers, so each layout can be tested with synthetic
 * Gamepad objects.
 *
 * What is verified and what is not:
 * - Standard mapping (W3C): D-pad 12 up, 13 down, 14 left, 15 right. Covered by tests.
 * - PlayStation raw mapping (Chromium, Sony HID): button 12 is the PS button, 13 the
 *   touchpad, 9 Options. The D-pad is reported as a hat on axis 9. The hat table
 *   below comes from the documented 8-direction encoding. It is NOT verified on
 *   DualSense hardware: NOT RUN.
 */

export type ResolvedControllerProfile = Exclude<ControllerProfile, "auto">;

export interface NormalizedDpad {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export type DpadSource = "standard-buttons" | "sony-hat" | "legacy-buttons";

export interface NormalizedPad {
  dpad: NormalizedDpad;
  dpadSource: DpadSource;
  stick: { x: number; y: number };
  buttons: { confirm: boolean; back: boolean; options: boolean };
}

const NO_DIRECTION: NormalizedDpad = { up: false, down: false, left: false, right: false };

/** Sony hat axis on Chromium's raw mapping. */
export const SONY_HAT_AXIS = 9;
/** Value of the hat when no direction is pressed. */
export const SONY_HAT_NEUTRAL = 1 + 2 / 7;
/** Allowed distance from a table value. The hat reports discrete values, so this is tight. */
const HAT_TOLERANCE = 0.02;

/** Hat value for each direction, clockwise from up: -1 + k * 2/7 for k = 0..7. */
const HAT_DIRECTIONS: readonly Partial<NormalizedDpad>[] = [
  { up: true },
  { up: true, right: true },
  { right: true },
  { down: true, right: true },
  { down: true },
  { down: true, left: true },
  { left: true },
  { up: true, left: true },
];

export type HatReading =
  | { kind: "neutral" }
  | { kind: "direction"; dpad: NormalizedDpad };

/** Decodes a Sony hat value. Returns null for anything that is not a hat value, such as a stick position. */
export function decodeSonyHat(value: number): HatReading | null {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value - SONY_HAT_NEUTRAL) <= HAT_TOLERANCE) return { kind: "neutral" };
  for (let index = 0; index < HAT_DIRECTIONS.length; index += 1) {
    const expected = -1 + (index * 2) / 7;
    if (Math.abs(value - expected) <= HAT_TOLERANCE) {
      return { kind: "direction", dpad: { ...NO_DIRECTION, ...HAT_DIRECTIONS[index] } };
    }
  }
  return null;
}

export function isPressed(pad: Gamepad, index: number): boolean {
  const button = pad.buttons[index];
  return Boolean(button && (button.pressed || button.value >= 0.7));
}

function finiteAxis(pad: Gamepad, index: number): number {
  const value = pad.axes[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * D-pad for a resolved profile. The standard profile reads buttons 12 to 15.
 * The PlayStation profile reads the hat when one is present and decodable, and
 * is authoritative then: a neutral hat means no D-pad direction, whatever the
 * buttons say. Without a hat, left and right fall back to buttons 14 and 15.
 * Vertical is never read from buttons on the PlayStation profile, because 12
 * is the PS button there.
 */
export function normalizeDpad(pad: Gamepad, profile: ResolvedControllerProfile): { dpad: NormalizedDpad; source: DpadSource } {
  if (profile === "standard") {
    return {
      dpad: {
        up: isPressed(pad, 12),
        down: isPressed(pad, 13),
        left: isPressed(pad, 14),
        right: isPressed(pad, 15),
      },
      source: "standard-buttons",
    };
  }
  const hat = decodeSonyHat(pad.axes[SONY_HAT_AXIS] ?? Number.NaN);
  if (hat) {
    return { dpad: hat.kind === "direction" ? hat.dpad : { ...NO_DIRECTION }, source: "sony-hat" };
  }
  return {
    dpad: { ...NO_DIRECTION, left: isPressed(pad, 14), right: isPressed(pad, 15) },
    source: "legacy-buttons",
  };
}

/**
 * Full normalization. Button roles keep the existing convention: the standard
 * profile uses A=0 (confirm) and B=1 (back); the PlayStation profile uses
 * Circle=1 (confirm) and Square=2 (back). Changing that is a product decision.
 */
export function normalizeGamepad(pad: Gamepad, profile: ResolvedControllerProfile): NormalizedPad {
  const { dpad, source } = normalizeDpad(pad, profile);
  return {
    dpad,
    dpadSource: source,
    stick: { x: finiteAxis(pad, 0), y: finiteAxis(pad, 1) },
    buttons: {
      confirm: isPressed(pad, profile === "standard" ? 0 : 1),
      back: isPressed(pad, profile === "standard" ? 1 : 2),
      options: isPressed(pad, 9),
    },
  };
}
