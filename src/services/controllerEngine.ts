export type ControllerProfile = "auto" | "standard" | "playstation";
export type ControllerAction =
  | { type: "move"; delta: -1 | 1 }
  | { type: "moveY"; delta: -1 | 1 }
  | { type: "confirm" | "back" | "options" | "home" };

export type ControllerSample = {
  connected: boolean;
  dpadLeft: boolean;
  dpadRight: boolean;
  dpadUp?: boolean;
  dpadDown?: boolean;
  axisX: number;
  axisY?: number;
  confirm: boolean;
  back: boolean;
  options: boolean;
  home?: boolean;
};

export type HatDirections = { up: boolean; down: boolean; left: boolean; right: boolean };

type Direction = -1 | 0 | 1;
type ButtonName = "confirm" | "back" | "options" | "home";
type ButtonState = { raw: boolean; since: number; pressed: boolean };
type Edge = "down" | "up" | null;
/** What happens to the Options press: held back until the chord window closes, or consumed by Home. */
type OptionsHold = "idle" | "pending" | "emitted" | "consumed";

const DEBOUNCE_MS = 40;
const INITIAL_REPEAT_MS = 420;
const REPEAT_MS = 135;
/** Home = PS + Options pressed within this window (same chord as the native DualSense path). */
export const HOME_CHORD_WINDOW_MS = 250;
/** Minimum gap between two Home actions (same cooldown as the native path). */
export const HOME_COOLDOWN_MS = 750;
/** Sony pads expose the D-pad as an 8-way hat on axis 9 in the raw mapping. */
const SONY_HAT_AXIS = 9;
const HAT_TOLERANCE = 0.06;
const NO_HAT: HatDirections = { up: false, down: false, left: false, right: false };

function isPlayStationId(id: string): boolean {
  return /(wireless controller|dualshock|dualsense|054c)/i.test(id);
}

export function resolveControllerProfile(
  pad: Pick<Gamepad, "id" | "mapping">,
  preference: ControllerProfile,
): Exclude<ControllerProfile, "auto"> | null {
  if (preference !== "auto") return preference;
  if (pad.mapping === "standard") return "standard";
  return isPlayStationId(pad.id) ? "playstation" : null;
}

function isPressed(pad: Gamepad, index: number): boolean {
  const button = pad.buttons[index];
  return Boolean(button && (button.pressed || button.value >= 0.7));
}

/**
 * Decodes an 8-way hat normalised to [-1, 1] in 1/7 steps: N = -1, clockwise,
 * NW = 1, neutral about 1.2857. Values that are not a hat position (for example
 * a plain 0 from a pad without a hat) decode to "nothing pressed".
 */
export function decodeDpadHat(value: number | undefined): HatDirections {
  if (value === undefined || !Number.isFinite(value)) return NO_HAT;
  const position = Math.round((value + 1) * 3.5);
  if (position < 0 || position > 8 || Math.abs(value - (position / 3.5 - 1)) > HAT_TOLERANCE) return NO_HAT;
  return {
    up: position === 0 || position === 1 || position === 7,
    right: position === 1 || position === 2 || position === 3,
    down: position === 3 || position === 4 || position === 5,
    left: position === 5 || position === 6 || position === 7,
  };
}

/** Human-readable mapping for the diagnostics panel. Keep in step with readControllerSample. */
export function controllerMappingSummary(profile: Exclude<ControllerProfile, "auto">): string {
  return profile === "standard"
    ? "Potwierdź B0 · Wstecz B1 · Options B9 · D-pad B12–B15 · Home B16 (PS, razem z Options) · lewy analog A0/A1"
    : "Potwierdź ✕ B1 · Wstecz ◯ B2 · Options B9 · Home PS B12 (razem z Options) · D-pad: hat na osi A9 · lewy analog A0/A1";
}

export function readControllerSample(
  pad: Gamepad | null | undefined,
  preference: ControllerProfile = "auto",
): ControllerSample | null {
  if (!pad?.connected) return null;
  const profile = resolveControllerProfile(pad, preference);
  if (!profile) return null;

  const standard = profile === "standard";
  const confirmButton = standard ? 0 : 1;
  const backButton = standard ? 1 : 2;
  // On the raw Sony layout buttons 12-13 are PS and Touchpad, so the D-pad
  // comes from the hat only. The standard mapping keeps the D-pad on 12-15.
  const hat = standard ? NO_HAT : decodeDpadHat(pad.axes[SONY_HAT_AXIS]);
  const axisX = pad.axes[0] ?? 0;
  const axisY = pad.axes[1] ?? 0;
  return {
    connected: true,
    dpadLeft: isPressed(pad, 14) || hat.left,
    dpadRight: isPressed(pad, 15) || hat.right,
    dpadUp: (standard && isPressed(pad, 12)) || hat.up,
    dpadDown: (standard && isPressed(pad, 13)) || hat.down,
    axisX: Number.isFinite(axisX) ? axisX : 0,
    axisY: Number.isFinite(axisY) ? axisY : 0,
    confirm: isPressed(pad, confirmButton),
    back: isPressed(pad, backButton),
    options: isPressed(pad, 9),
    home: isPressed(pad, standard ? 16 : 12),
  };
}

function emptyButton(): ButtonState {
  return { raw: false, since: 0, pressed: false };
}

/** Same hysteresis as before: a held direction stays active until the stick clearly returns. */
function axisHysteresis(value: number, previous: Direction): Direction {
  if (previous < 0 && value < -0.35) return -1;
  if (previous > 0 && value > 0.35) return 1;
  if (value < -0.55) return -1;
  if (value > 0.55) return 1;
  return 0;
}

/** Debounced direction with initial delay and repeat, one per axis. */
class RepeatChannel {
  private direction: Direction = 0;
  private since = 0;
  private nextRepeatAt: number | null = null;

  reset(): void {
    this.direction = 0;
    this.since = 0;
    this.nextRepeatAt = null;
  }

  /** Starts from a held direction without replaying it until it is released. */
  prime(direction: Direction, now: number): void {
    this.direction = direction;
    this.since = now;
    this.nextRepeatAt = direction === 0 ? null : Number.POSITIVE_INFINITY;
  }

  /** Returns the move to emit this frame, or 0. */
  step(direction: Direction, now: number): Direction {
    if (direction !== this.direction) {
      this.direction = direction;
      this.since = now;
      this.nextRepeatAt = null;
      return 0;
    }
    if (direction === 0 || now - this.since < DEBOUNCE_MS) return 0;
    if (this.nextRepeatAt === null) {
      this.nextRepeatAt = now + INITIAL_REPEAT_MS;
      return direction;
    }
    if (now >= this.nextRepeatAt) {
      this.nextRepeatAt = now + REPEAT_MS;
      return direction;
    }
    return 0;
  }
}

export class ControllerEngine {
  private ready = false;
  private readonly horizontal = new RepeatChannel();
  private readonly vertical = new RepeatChannel();
  private horizontalAxis: Direction = 0;
  private verticalAxis: Direction = 0;
  private readonly buttons: Record<ButtonName, ButtonState> = {
    confirm: emptyButton(),
    back: emptyButton(),
    options: emptyButton(),
    home: emptyButton(),
  };
  private homeDownAt: number | null = null;
  private optionsDownAt: number | null = null;
  private optionsHold: OptionsHold = "idle";
  private lastHomeAt = Number.NEGATIVE_INFINITY;

  update(sample: ControllerSample | null, now: number, focused: boolean): ControllerAction[] {
    if (!focused || !sample?.connected) {
      this.reset();
      return [];
    }
    if (!this.ready) {
      this.prime(sample, now);
      return [];
    }

    const actions: ControllerAction[] = [];
    // Both channels always advance; a diagonal emits only the horizontal move.
    const x = this.horizontal.step(this.readHorizontal(sample), now);
    const y = this.vertical.step(this.readVertical(sample), now);
    if (x !== 0) actions.push({ type: "move", delta: x });
    else if (y !== 0) actions.push({ type: "moveY", delta: y });

    this.updateButton("confirm", sample.confirm, now, actions);
    this.updateButton("back", sample.back, now, actions);
    this.updateChord(sample, now, actions);
    return actions;
  }

  reset(): void {
    this.ready = false;
    this.horizontal.reset();
    this.vertical.reset();
    this.horizontalAxis = 0;
    this.verticalAxis = 0;
    this.buttons.confirm = emptyButton();
    this.buttons.back = emptyButton();
    this.buttons.options = emptyButton();
    this.buttons.home = emptyButton();
    this.homeDownAt = null;
    this.optionsDownAt = null;
    this.optionsHold = "idle";
    // lastHomeAt is kept on purpose: a reconnect must not fire Home twice.
  }

  private prime(sample: ControllerSample, now: number): void {
    this.ready = true;
    this.horizontal.prime(this.readHorizontal(sample), now);
    this.vertical.prime(this.readVertical(sample), now);
    for (const name of ["confirm", "back", "options", "home"] as const) {
      const pressed = name === "home" ? Boolean(sample.home) : sample[name];
      this.buttons[name] = { raw: pressed, since: now, pressed };
    }
    this.homeDownAt = sample.home ? now : null;
    // An Options press already held at connect time must not open anything later.
    this.optionsHold = sample.options ? "consumed" : "idle";
    this.optionsDownAt = null;
  }

  private readHorizontal(sample: ControllerSample): Direction {
    if (sample.dpadLeft !== sample.dpadRight) return sample.dpadLeft ? -1 : 1;
    this.horizontalAxis = axisHysteresis(sample.axisX, this.horizontalAxis);
    return this.horizontalAxis;
  }

  private readVertical(sample: ControllerSample): Direction {
    const up = sample.dpadUp === true;
    const down = sample.dpadDown === true;
    if (up !== down) return up ? -1 : 1;
    this.verticalAxis = axisHysteresis(sample.axisY ?? 0, this.verticalAxis);
    return this.verticalAxis;
  }

  /** Debounced edge detection shared by every button. */
  private debounce(name: ButtonName, raw: boolean, now: number): Edge {
    const state = this.buttons[name];
    if (raw !== state.raw) {
      state.raw = raw;
      state.since = now;
    }
    if (state.raw === state.pressed || now - state.since < DEBOUNCE_MS) return null;
    state.pressed = state.raw;
    return state.pressed ? "down" : "up";
  }

  private updateButton(name: "confirm" | "back", raw: boolean, now: number, actions: ControllerAction[]): void {
    if (this.debounce(name, raw, now) === "down") actions.push({ type: name });
  }

  private isWithinChord(since: number | null, now: number): boolean {
    return since !== null && now - since <= HOME_CHORD_WINDOW_MS;
  }

  private fireHome(now: number, actions: ControllerAction[]): void {
    this.lastHomeAt = now;
    actions.push({ type: "home" });
  }

  private canFireHome(now: number): boolean {
    return now - this.lastHomeAt >= HOME_COOLDOWN_MS;
  }

  /**
   * Home = PS + Options within the chord window, in either order. Options is held
   * back for the window so a Home chord never also opens the Control Center. Each
   * chord fires once; Options must be released before the next one can start.
   */
  private updateChord(sample: ControllerSample, now: number, actions: ControllerAction[]): void {
    const home = this.debounce("home", Boolean(sample.home), now);
    const options = this.debounce("options", sample.options, now);

    if (home === "down") {
      this.homeDownAt = now;
      if (this.optionsHold === "pending" && this.isWithinChord(this.optionsDownAt, now) && this.canFireHome(now)) {
        this.optionsHold = "consumed";
        this.fireHome(now, actions);
      }
    } else if (home === "up") {
      this.homeDownAt = null;
    }

    if (options === "down") {
      this.optionsDownAt = now;
      const homeJoined = this.buttons.home.pressed && this.isWithinChord(this.homeDownAt, now);
      if (homeJoined && this.canFireHome(now)) {
        this.optionsHold = "consumed";
        this.fireHome(now, actions);
      } else {
        this.optionsHold = "pending";
      }
    }

    if (
      this.optionsHold === "pending" &&
      this.buttons.options.pressed &&
      this.optionsDownAt !== null &&
      now - this.optionsDownAt >= HOME_CHORD_WINDOW_MS
    ) {
      this.optionsHold = "emitted";
      actions.push({ type: "options" });
    }

    if (options === "up") {
      // A quick tap that never became a chord still counts as Options.
      if (this.optionsHold === "pending") actions.push({ type: "options" });
      this.optionsHold = "idle";
      this.optionsDownAt = null;
    }
  }
}
