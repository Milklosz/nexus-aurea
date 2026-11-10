export type ControllerProfile = "auto" | "standard" | "playstation";
export type ControllerAction =
  | { type: "move"; delta: -1 | 1 }
  | { type: "confirm" | "back" | "options" };

export type ControllerSample = {
  connected: boolean;
  dpadLeft: boolean;
  dpadRight: boolean;
  axisX: number;
  confirm: boolean;
  back: boolean;
  options: boolean;
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

function isPressed(pad: Gamepad, index: number): boolean {
  const button = pad.buttons[index];
  return Boolean(button && (button.pressed || button.value >= 0.7));
}

export function readControllerSample(
  pad: Gamepad | null | undefined,
  preference: ControllerProfile = "auto",
): ControllerSample | null {
  if (!pad?.connected) return null;
  const profile = resolveControllerProfile(pad, preference);
  if (!profile) return null;

  const confirmButton = profile === "standard" ? 0 : 1;
  const backButton = profile === "standard" ? 1 : 2;
  const axisX = pad.axes[0] ?? 0;
  return {
    connected: true,
    dpadLeft: isPressed(pad, 14),
    dpadRight: isPressed(pad, 15),
    axisX: Number.isFinite(axisX) ? axisX : 0,
    confirm: isPressed(pad, confirmButton),
    back: isPressed(pad, backButton),
    options: isPressed(pad, 9),
  };
}

function emptyButton(): ButtonState {
  return { raw: false, since: 0, pressed: false };
}

export class ControllerEngine {
  private ready = false;
  private direction: Direction = 0;
  private directionSince = 0;
  private nextRepeatAt: number | null = null;
  private axisDirection: Direction = 0;
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
    const direction = this.readDirection(sample);
    if (direction !== this.direction) {
      this.direction = direction;
      this.directionSince = now;
      this.nextRepeatAt = null;
    } else if (direction !== 0 && now - this.directionSince >= DEBOUNCE_MS) {
      if (this.nextRepeatAt === null) {
        actions.push({ type: "move", delta: direction });
        this.nextRepeatAt = now + INITIAL_REPEAT_MS;
      } else if (now >= this.nextRepeatAt) {
        actions.push({ type: "move", delta: direction });
        this.nextRepeatAt = now + REPEAT_MS;
      }
    }

    this.updateButton("confirm", sample.confirm, now, actions);
    this.updateButton("back", sample.back, now, actions);
    this.updateButton("options", sample.options, now, actions);
    return actions;
  }

  reset(): void {
    this.ready = false;
    this.direction = 0;
    this.directionSince = 0;
    this.nextRepeatAt = null;
    this.axisDirection = 0;
    this.buttons.confirm = emptyButton();
    this.buttons.back = emptyButton();
    this.buttons.options = emptyButton();
  }

  private prime(sample: ControllerSample, now: number): void {
    this.ready = true;
    this.direction = this.readDirection(sample);
    this.directionSince = now;
    this.nextRepeatAt = this.direction === 0 ? null : Number.POSITIVE_INFINITY;
    for (const name of ["confirm", "back", "options"] as const) {
      this.buttons[name] = { raw: sample[name], since: now, pressed: sample[name] };
    }
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
