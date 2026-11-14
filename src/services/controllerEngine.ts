import { normalizeGamepad } from "./controllerInput";

export type ControllerProfile = "auto" | "standard" | "playstation";
export type ControllerAction =
  | { type: "move"; delta: -1 | 1 }
  | { type: "vertical"; delta: -1 | 1 }
  | { type: "confirm" | "back" | "options" };

export type ControllerSample = {
  connected: boolean;
  dpadLeft: boolean;
  dpadRight: boolean;
  axisX: number;
  confirm: boolean;
  back: boolean;
  options: boolean;
  /** Optional so existing samples without vertical input stay valid. */
  dpadUp?: boolean;
  dpadDown?: boolean;
  /** Left stick Y: negative is up, positive is down. */
  axisY?: number;
  /**
   * The PlayStation (guide) button. It is a modifier, never a navigation action: while it is
   * held, Options does not open Control Center (PS + Options is the global Home chord).
   */
  guide?: boolean;
};

export type ControllerEngineOptions = {
  /**
   * Fire Options when it is released instead of when it is pressed, and not at all if the
   * guide button was involved. Used by the native source so PS + Options never also opens a panel.
   */
  optionsOnRelease?: boolean;
};

type Direction = -1 | 0 | 1;
type ButtonState = { raw: boolean; since: number; pressed: boolean };

const DEBOUNCE_MS = 40;
const INITIAL_REPEAT_MS = 420;
const REPEAT_MS = 135;

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

export function readControllerSample(
  pad: Gamepad | null | undefined,
  preference: ControllerProfile = "auto",
): ControllerSample | null {
  if (!pad?.connected) return null;
  const profile = resolveControllerProfile(pad, preference);
  if (!profile) return null;

  // Raw layouts differ (standard buttons, Sony hat on axis 9); normalizeGamepad hides that.
  const input = normalizeGamepad(pad, profile);
  return {
    connected: true,
    dpadLeft: input.dpad.left,
    dpadRight: input.dpad.right,
    dpadUp: input.dpad.up,
    dpadDown: input.dpad.down,
    axisX: input.stick.x,
    axisY: input.stick.y,
    confirm: input.buttons.confirm,
    back: input.buttons.back,
    options: input.buttons.options,
  };
}

function emptyButton(): ButtonState {
  return { raw: false, since: 0, pressed: false };
}

/**
 * Debounced, auto-repeating direction for one axis of input. The first step fires
 * after the debounce window, the second after the initial repeat delay, and then at
 * the repeat rate while the direction is held.
 */
class DirectionRepeat {
  private direction: Direction = 0;
  private since = 0;
  private nextAt: number | null = null;

  /** Returns the step to emit now, or 0 when nothing should fire. */
  step(direction: Direction, now: number): Direction {
    if (direction !== this.direction) {
      this.direction = direction;
      this.since = now;
      this.nextAt = null;
      return 0;
    }
    if (direction === 0 || now - this.since < DEBOUNCE_MS) return 0;
    if (this.nextAt === null) {
      this.nextAt = now + INITIAL_REPEAT_MS;
      return direction;
    }
    if (now >= this.nextAt) {
      this.nextAt = now + REPEAT_MS;
      return direction;
    }
    return 0;
  }

  prime(direction: Direction, now: number): void {
    this.direction = direction;
    this.since = now;
    this.nextAt = direction === 0 ? null : Number.POSITIVE_INFINITY;
  }

  reset(): void {
    this.direction = 0;
    this.since = 0;
    this.nextAt = null;
  }
}

export class ControllerEngine {
  constructor(private readonly options: ControllerEngineOptions = {}) {}

  private ready = false;
  /** Which axis wins while both are pushed (a diagonal). Locked until both are released. */
  private dominant: "horizontal" | "vertical" | null = null;
  private optionsGuideInvolved = false;
  private readonly horizontal = new DirectionRepeat();
  private readonly vertical = new DirectionRepeat();
  private axisDirection: Direction = 0;
  private axisYDirection: Direction = 0;
  private readonly buttons: Record<"confirm" | "back" | "options", ButtonState> = {
    confirm: emptyButton(),
    back: emptyButton(),
    options: emptyButton(),
  };

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
    let horizontalDirection = this.readDirection(sample);
    let verticalDirection = this.readVerticalDirection(sample);
    // A stick diagonal must not move twice (dock and zone at once): the stronger axis wins and
    // is locked until both axes are released, so jitter near 45 degrees cannot flip it. A
    // deliberate D-pad diagonal keeps both moves, as before.
    const dpadHeld = Boolean(sample.dpadLeft || sample.dpadRight || sample.dpadUp || sample.dpadDown);
    if (horizontalDirection !== 0 && verticalDirection !== 0 && !dpadHeld) {
      if (this.dominant === null) {
        this.dominant = Math.abs(sample.axisX) >= Math.abs(sample.axisY ?? 0) ? "horizontal" : "vertical";
      }
      if (this.dominant === "horizontal") verticalDirection = 0;
      else horizontalDirection = 0;
    } else if (horizontalDirection === 0 && verticalDirection === 0) {
      this.dominant = null;
    }
    const horizontalStep = this.horizontal.step(horizontalDirection, now);
    if (horizontalStep !== 0) actions.push({ type: "move", delta: horizontalStep });
    const verticalStep = this.vertical.step(verticalDirection, now);
    if (verticalStep !== 0) actions.push({ type: "vertical", delta: verticalStep });

    this.updateButton("confirm", sample.confirm, now, actions);
    this.updateButton("back", sample.back, now, actions);
    if (this.options.optionsOnRelease) this.updateOptionsOnRelease(sample, now, actions);
    else this.updateButton("options", sample.options, now, actions);
    return actions;
  }

  reset(): void {
    this.ready = false;
    this.horizontal.reset();
    this.vertical.reset();
    this.axisDirection = 0;
    this.axisYDirection = 0;
    this.dominant = null;
    this.optionsGuideInvolved = false;
    this.buttons.confirm = emptyButton();
    this.buttons.back = emptyButton();
    this.buttons.options = emptyButton();
  }

  private prime(sample: ControllerSample, now: number): void {
    this.ready = true;
    this.horizontal.prime(this.readDirection(sample), now);
    this.vertical.prime(this.readVerticalDirection(sample), now);
    for (const name of ["confirm", "back", "options"] as const) {
      this.buttons[name] = { raw: sample[name], since: now, pressed: sample[name] };
    }
    // A button already held when input starts (focus regained, pad reconnected) must not fire on release.
    this.optionsGuideInvolved = Boolean(this.options.optionsOnRelease && sample.options);
  }

  private readDirection(sample: ControllerSample): Direction {
    if (sample.dpadLeft !== sample.dpadRight) return sample.dpadLeft ? -1 : 1;
    const axis = sample.axisX;
    if (this.axisDirection < 0 && axis < -0.35) return -1;
    if (this.axisDirection > 0 && axis > 0.35) return 1;
    if (axis < -0.55) {
      this.axisDirection = -1;
      return -1;
    }
    if (axis > 0.55) {
      this.axisDirection = 1;
      return 1;
    }
    this.axisDirection = 0;
    return 0;
  }

  /** -1 is up, +1 is down. The D-pad wins over the stick, as it does horizontally. */
  private readVerticalDirection(sample: ControllerSample): Direction {
    const dpadUp = sample.dpadUp ?? false;
    const dpadDown = sample.dpadDown ?? false;
    if (dpadUp !== dpadDown) return dpadUp ? -1 : 1;
    const axis = sample.axisY ?? 0;
    if (this.axisYDirection < 0 && axis < -0.35) return -1;
    if (this.axisYDirection > 0 && axis > 0.35) return 1;
    if (axis < -0.55) {
      this.axisYDirection = -1;
      return -1;
    }
    if (axis > 0.55) {
      this.axisYDirection = 1;
      return 1;
    }
    this.axisYDirection = 0;
    return 0;
  }

  private updateOptionsOnRelease(sample: ControllerSample, now: number, actions: ControllerAction[]): void {
    const state = this.buttons.options;
    const raw = sample.options;
    if (raw !== state.raw) {
      state.raw = raw;
      state.since = now;
    }
    // PS held at any moment of the Options press turns it into the Home chord.
    if (raw && sample.guide) this.optionsGuideInvolved = true;
    if (state.raw === state.pressed || now - state.since < DEBOUNCE_MS) return;
    state.pressed = state.raw;
    if (state.pressed) return;
    if (!this.optionsGuideInvolved) actions.push({ type: "options" });
    this.optionsGuideInvolved = false;
  }

  private updateButton(
    name: "confirm" | "back" | "options",
    raw: boolean,
    now: number,
    actions: ControllerAction[],
  ): void {
    const state = this.buttons[name];
    if (raw !== state.raw) {
      state.raw = raw;
      state.since = now;
    }
    if (state.raw === state.pressed || now - state.since < DEBOUNCE_MS) return;
    state.pressed = state.raw;
    if (state.pressed) actions.push({ type: name });
  }
}
