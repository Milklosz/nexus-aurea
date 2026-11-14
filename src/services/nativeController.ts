import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ControllerSample } from "./controllerEngine";

/**
 * Native DualShock 4 input. The Rust side parses raw HID reports and emits only
 * semantic events: no raw packets, no device paths. This module is the typed
 * contract, the pure state reducer, and the (pure) mapping into the same
 * `ControllerSample` the browser Gamepad path feeds into the navigation engine.
 *
 * Buttons are identified by name, never by index, so Windows API differences in
 * numbering cannot leak into the mapping. NOT TESTED ON HARDWARE.
 */

export const NATIVE_CONTROLLER_EVENT = "velora-controller";

export type Ds4ButtonName =
  | "cross" | "circle" | "square" | "triangle"
  | "l1" | "r1" | "l2" | "r2" | "l3" | "r3"
  | "share" | "options" | "ps" | "touchpad";

export type Ds4Revision = "v1" | "v2" | "usbAdapter";
export type Ds4Transport = "usb" | "bluetooth";

export interface NativeDpad { up: boolean; down: boolean; left: boolean; right: boolean }

export type NativeControllerEvent =
  | { kind: "connected"; device: string; revision: Ds4Revision; transport: Ds4Transport }
  | {
      kind: "state";
      device: string;
      revision: Ds4Revision;
      transport: Ds4Transport;
      dpad: NativeDpad;
      leftX: number;
      leftY: number;
      buttons: Ds4ButtonName[];
    }
  | { kind: "disconnected"; device: string }
  | { kind: "unavailable"; reason: string };

export interface NativeControllerStatus {
  /** True on Windows builds that can read HID reports at all. */
  supported: boolean;
  running: boolean;
  lastError: string | null;
  pads: Array<{ device: string; revision: Ds4Revision; transport: Ds4Transport }>;
  ignoredReports: number;
}

export const disabledNativeControllerStatus: NativeControllerStatus = {
  supported: false,
  running: false,
  lastError: null,
  pads: [],
  ignoredReports: 0,
};

const BUTTONS: ReadonlySet<string> = new Set<Ds4ButtonName>([
  "cross", "circle", "square", "triangle", "l1", "r1", "l2", "r2", "l3", "r3",
  "share", "options", "ps", "touchpad",
]);
const REVISIONS: ReadonlySet<string> = new Set(["v1", "v2", "usbAdapter"]);
const TRANSPORTS: ReadonlySet<string> = new Set(["usb", "bluetooth"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDpad(value: unknown): value is NativeDpad {
  return isObject(value)
    && ["up", "down", "left", "right"].every((key) => typeof value[key] === "boolean");
}

/** Validates an untrusted event payload. Anything malformed is dropped, never coerced. */
export function parseNativeControllerEvent(payload: unknown): NativeControllerEvent | null {
  if (!isObject(payload) || typeof payload.kind !== "string") return null;
  switch (payload.kind) {
    case "connected":
      return typeof payload.device === "string"
        && REVISIONS.has(String(payload.revision))
        && TRANSPORTS.has(String(payload.transport))
        ? payload as unknown as NativeControllerEvent
        : null;
    case "state": {
      if (typeof payload.device !== "string"
        || !REVISIONS.has(String(payload.revision))
        || !TRANSPORTS.has(String(payload.transport))
        || !isDpad(payload.dpad)
        || typeof payload.leftX !== "number" || !Number.isFinite(payload.leftX)
        || typeof payload.leftY !== "number" || !Number.isFinite(payload.leftY)
        || !Array.isArray(payload.buttons)) return null;
      const buttons = payload.buttons.filter((name): name is Ds4ButtonName => typeof name === "string" && BUTTONS.has(name));
      return { ...(payload as unknown as NativeControllerEvent & { kind: "state" }), buttons };
    }
    case "disconnected":
      return typeof payload.device === "string" ? { kind: "disconnected", device: payload.device } : null;
    case "unavailable":
      return { kind: "unavailable", reason: typeof payload.reason === "string" ? payload.reason.slice(0, 200) : "" };
    default:
      return null;
  }
}

export async function getNativeControllerStatus(): Promise<NativeControllerStatus> {
  if (!isTauri()) return disabledNativeControllerStatus;
  return invoke<NativeControllerStatus>("get_native_controller_status");
}

export async function listenForNativeController(
  callback: (event: NativeControllerEvent) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<unknown>(NATIVE_CONTROLLER_EVENT, (event) => {
    const parsed = parseNativeControllerEvent(event.payload);
    if (parsed) callback(parsed);
  });
}

// ---------------------------------------------------------------------------
// Semantic mapping
// ---------------------------------------------------------------------------

/** Which physical buttons trigger each logical navigation action. Future settings can replace this. */
export interface ControllerBindings {
  confirm: readonly Ds4ButtonName[];
  back: readonly Ds4ButtonName[];
  options: readonly Ds4ButtonName[];
}

/**
 * Cross confirms, Circle goes back, Options opens Control Center. Share and PS have
 * no navigation action by default: Share is left to the system, and PS is handled
 * by the native return-home path, not by the dock.
 */
export const DEFAULT_DS4_BINDINGS: ControllerBindings = {
  confirm: ["cross"],
  back: ["circle"],
  options: ["options"],
};

/**
 * Rising edges of L1 (previous section, -1) and R1 (next section, +1). The first sample after a
 * reset only records the held state, so a bumper held across a focus change never fires late.
 */
export class BumperEdges {
  private primed = false;
  private l1 = false;
  private r1 = false;

  update(l1: boolean, r1: boolean): Array<-1 | 1> {
    const edges: Array<-1 | 1> = [];
    if (this.primed) {
      if (l1 && !this.l1) edges.push(-1);
      if (r1 && !this.r1) edges.push(1);
    }
    this.primed = true;
    this.l1 = l1;
    this.r1 = r1;
    return edges;
  }

  reset(): void {
    this.primed = false;
    this.l1 = false;
    this.r1 = false;
  }
}

export interface NativeSnapshot {
  dpad: NativeDpad;
  leftX: number;
  leftY: number;
  buttons: readonly Ds4ButtonName[];
}

export function sampleFromNative(
  snapshot: NativeSnapshot | null,
  bindings: ControllerBindings = DEFAULT_DS4_BINDINGS,
): ControllerSample | null {
  if (!snapshot) return null;
  const down = new Set(snapshot.buttons);
  const any = (names: readonly Ds4ButtonName[]) => names.some((name) => down.has(name));
  return {
    connected: true,
    dpadLeft: snapshot.dpad.left,
    dpadRight: snapshot.dpad.right,
    dpadUp: snapshot.dpad.up,
    dpadDown: snapshot.dpad.down,
    axisX: snapshot.leftX,
    axisY: snapshot.leftY,
    confirm: any(bindings.confirm),
    back: any(bindings.back),
    options: any(bindings.options),
    guide: down.has("ps"),
  };
}

// ---------------------------------------------------------------------------
// Connection model (pure reducer)
// ---------------------------------------------------------------------------

export interface NativePad {
  device: string;
  revision: Ds4Revision;
  transport: Ds4Transport;
}

export interface NativeControllerModel {
  /** Set when the native layer reported that it cannot read pads (e.g. non-Windows, sink failed). */
  unavailableReason: string | null;
  pads: NativePad[];
  /** The one pad whose input is interpreted. Others are ignored until it is neutral and they press. */
  activeDevice: string | null;
  snapshot: NativeSnapshot | null;
  lastButton: Ds4ButtonName | null;
  lastInputAt: number | null;
  /** When the current snapshot was last confirmed by a native event (state or heartbeat). */
  snapshotAt: number | null;
}

export const NEUTRAL_SNAPSHOT: NativeSnapshot = {
  dpad: { up: false, down: false, left: false, right: false },
  leftX: 0,
  leftY: 0,
  buttons: [],
};

export const initialNativeControllerModel: NativeControllerModel = {
  unavailableReason: null,
  pads: [],
  activeDevice: null,
  snapshot: null,
  lastButton: null,
  lastInputAt: null,
  snapshotAt: null,
};

function isNeutral(snapshot: NativeSnapshot | null): boolean {
  if (!snapshot) return true;
  return snapshot.buttons.length === 0
    && !snapshot.dpad.up && !snapshot.dpad.down && !snapshot.dpad.left && !snapshot.dpad.right
    && Math.abs(snapshot.leftX) < 0.35 && Math.abs(snapshot.leftY) < 0.35;
}

/**
 * Pure reducer over native events. `now` is injected so tests do not depend on a clock.
 * A second pad never steals control from the active pad mid-press: it takes over only
 * once the active pad is neutral and the newcomer produces input.
 */
export function reduceNativeController(
  model: NativeControllerModel,
  event: NativeControllerEvent,
  now: number,
): NativeControllerModel {
  switch (event.kind) {
    case "unavailable":
      return { ...initialNativeControllerModel, unavailableReason: event.reason || "unavailable" };
    case "connected": {
      const pad: NativePad = { device: event.device, revision: event.revision, transport: event.transport };
      const pads = [...model.pads.filter((known) => known.device !== event.device), pad];
      const becomesActive = model.activeDevice === null;
      return {
        ...model,
        unavailableReason: null,
        pads,
        activeDevice: model.activeDevice ?? event.device,
        // A connected active pad always has a snapshot, so the first real press is a press, not a prime.
        snapshot: becomesActive ? NEUTRAL_SNAPSHOT : model.snapshot,
        snapshotAt: becomesActive ? now : model.snapshotAt,
      };
    }
    case "disconnected": {
      const pads = model.pads.filter((known) => known.device !== event.device);
      if (model.activeDevice !== event.device) return { ...model, pads };
      // The active pad left: every input is released at once and another pad, if any, takes over.
      const next = pads[0]?.device ?? null;
      return { ...model, pads, activeDevice: next, snapshot: next ? NEUTRAL_SNAPSHOT : null, snapshotAt: next ? now : null };
    }
    case "state": {
      // A state event is also proof the pad exists, even if the connect event was missed.
      let next = model;
      if (!model.pads.some((known) => known.device === event.device)) {
        next = reduceNativeController(model, {
          kind: "connected", device: event.device, revision: event.revision, transport: event.transport,
        }, now);
      }
      const snapshot: NativeSnapshot = {
        dpad: event.dpad, leftX: event.leftX, leftY: event.leftY, buttons: event.buttons,
      };
      const lastPressed = event.buttons[event.buttons.length - 1] ?? null;
      const wantsControl = !isNeutral(snapshot);
      if (next.activeDevice === event.device) {
        return {
          ...next,
          snapshot,
          snapshotAt: now,
          lastButton: wantsControl && lastPressed ? lastPressed : next.lastButton,
          lastInputAt: wantsControl ? now : next.lastInputAt,
        };
      }
      if (wantsControl && isNeutral(next.snapshot)) {
        return { ...next, activeDevice: event.device, snapshot, snapshotAt: now, lastButton: lastPressed ?? next.lastButton, lastInputAt: now };
      }
      return next;
    }
  }
}

export type ControllerLinkState = "disconnected" | "connected" | "active" | "unsupported";

/** An input within this window counts the pad as active. */
export const ACTIVE_WINDOW_MS = 10_000;

export function nativeLinkState(model: NativeControllerModel, now: number): ControllerLinkState {
  if (model.unavailableReason) return "unsupported";
  if (model.pads.length === 0) return "disconnected";
  return model.lastInputAt !== null && now - model.lastInputAt < ACTIVE_WINDOW_MS ? "active" : "connected";
}

// ---------------------------------------------------------------------------
// Double-input guard
// ---------------------------------------------------------------------------

const DS4_PRODUCT_IDS = new Set(["05c4", "09cc", "0ba0"]);

/**
 * True when the browser Gamepad API entry is a DualShock 4 (or a PlayStation pad whose
 * product cannot be read). While a native DS4 is active, the Gamepad API must skip it,
 * otherwise one Cross press would produce two actions. Other pads (Xbox, DualSense)
 * stay on the browser path.
 *
 * Chromium reports ids like "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"
 * or, for non-standard mapping, "Wireless Controller (Vendor: 054c Product: 09cc)" and
 * sometimes "054c-09cc-Wireless Controller".
 */
export function isDualShock4GamepadId(id: string): boolean {
  const text = id.toLowerCase();
  const vendor = /vendor:\s*([0-9a-f]{4})/.exec(text)?.[1] ?? /^([0-9a-f]{4})-([0-9a-f]{4})-/.exec(text)?.[1];
  if (vendor !== "054c") return false;
  const product = /product:\s*([0-9a-f]{4})/.exec(text)?.[1] ?? /^[0-9a-f]{4}-([0-9a-f]{4})-/.exec(text)?.[1];
  // A known non-DS4 Sony product (DualSense 0ce6/0df2) stays on the browser path.
  if (product) return DS4_PRODUCT_IDS.has(product);
  // Sony vendor with an unreadable product: skip it rather than risk double input.
  return true;
}

export type InputSource = "native" | "gamepad-api" | "none";

/** One active source at a time. Native wins whenever it has a pad. */
export function chooseInputSource(model: NativeControllerModel, gamepadApiPadCount: number): InputSource {
  if (!model.unavailableReason && model.pads.length > 0) return "native";
  return gamepadApiPadCount > 0 ? "gamepad-api" : "none";
}
