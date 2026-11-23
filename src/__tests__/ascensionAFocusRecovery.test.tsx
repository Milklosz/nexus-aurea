// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusOwner, type FocusOwnerState } from "../hooks/useFocusOwner";
import {
  CONFIRM_SETTLE_MS,
  FocusOwnershipGuard,
  ownerAcceptsController,
  resolveFocusOwner,
} from "../services/focusOwnership";
import { shouldRestoreDockFocus } from "../services/windowFocusRestore";
import { crossSourceGate } from "../services/crossSourceGate";

/**
 * Ascension A, Phase 1, Deliverable 4: window ownership & focus recovery.
 *
 * useFocusOwner / useReturnHomeFocus / windowFocusRestore already exist and are
 * owned elsewhere — this file VERIFIES their recovery semantics (it does not
 * re-implement them): regaining foreground restores exactly one focus owner,
 * a confirm landing in the hand-over settle window is swallowed exactly once
 * (double-activation suppression), and duplicate focus events do not extend the
 * settle window. All timestamps are injected via a mocked performance.now().
 */

let now = 0;
let veloraFocused = true;

const baseState: FocusOwnerState = {
  ambientActive: false,
  keyboardOpen: false,
  controllerPreflightOpen: false,
  diagnosticsOpen: false,
  controlCenterOpen: false,
  controlCenterPanel: undefined,
};

beforeEach(() => {
  now = 10_000;
  veloraFocused = true;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "hasFocus").mockImplementation(() => veloraFocused);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  crossSourceGate.reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const advance = (ms: number) => { now += ms; };
const blurWindow = () => act(() => { veloraFocused = false; window.dispatchEvent(new Event("blur")); });
const focusWindow = () => act(() => { veloraFocused = true; window.dispatchEvent(new Event("focus")); });

describe("ascension A: focus ownership guard (recovery double-activation suppression)", () => {
  it("external -> home-dock on focus regain swallows one confirm in the settle window, then allows", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("home-dock", 0);
    // VELORA loses foreground: owner becomes external, controller input is not interpreted.
    guard.observe("external", 1_000);
    expect(ownerAcceptsController(guard.current)).toBe(false);
    expect(guard.allows({ type: "confirm" }, 1_001)).toBe(false);
    // Foreground returns at t=2_000: one hand-over, settle window starts now.
    guard.observe("home-dock", 2_000);
    expect(guard.allows({ type: "move", delta: 1 }, 2_000 + 10)).toBe(true); // moves are never delayed
    expect(guard.allows({ type: "back" }, 2_000 + 10)).toBe(true);
    expect(guard.allows({ type: "confirm" }, 2_000 + CONFIRM_SETTLE_MS - 1)).toBe(false); // swallowed once
    expect(guard.allows({ type: "confirm" }, 2_000 + CONFIRM_SETTLE_MS)).toBe(true); // then allowed
  });

  it("duplicate focus events do not extend the settle window", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("home-dock", 0);
    guard.observe("external", 100);
    guard.observe("home-dock", 500);
    guard.observe("home-dock", 510); // duplicate focus event: same owner, no new hand-over
    guard.observe("home-dock", 520);
    expect(guard.allows({ type: "confirm" }, 500 + CONFIRM_SETTLE_MS - 1)).toBe(false);
    expect(guard.allows({ type: "confirm" }, 500 + CONFIRM_SETTLE_MS)).toBe(true);
  });

  it("moving between the two Home zones is ordinary navigation, not a hand-over", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("home-dock", 0);
    guard.observe("home-actions", 100);
    // No settle delay inside the home layer: a confirm fires immediately.
    expect(guard.allows({ type: "confirm" }, 101)).toBe(true);
  });

  it("panel open/close cycles each start their own settle window", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("home-dock", 0);
    guard.observe("control-center", 1_000);
    expect(guard.allows({ type: "confirm" }, 1_000 + CONFIRM_SETTLE_MS - 1)).toBe(false);
    guard.observe("home-dock", 2_000); // panel closed
    expect(guard.allows({ type: "confirm" }, 2_000 + CONFIRM_SETTLE_MS - 1)).toBe(false);
    expect(guard.allows({ type: "confirm" }, 2_000 + CONFIRM_SETTLE_MS)).toBe(true);
  });
});

describe("ascension A: useFocusOwner hook on window focus recovery", () => {
  it("regaining foreground resolves exactly one owner and gates confirm once", () => {
    const view = renderHook((props: { state: FocusOwnerState }) => useFocusOwner(props.state), { initialProps: { state: baseState } });
    expect(view.result.current.owner()).toBe("home-dock");
    expect(view.result.current.allows({ type: "confirm" })).toBe(true); // hook reads the mocked clock

    blurWindow();
    advance(50);
    expect(view.result.current.owner()).toBe("external");
    expect(view.result.current.allows({ type: "confirm" })).toBe(false);

    focusWindow(); // t = 10_050: hand-over settle window starts now
    expect(view.result.current.owner()).toBe("home-dock");
    expect(view.result.current.allows({ type: "move", delta: -1 })).toBe(true);
    advance(CONFIRM_SETTLE_MS - 1);
    expect(view.result.current.allows({ type: "confirm" })).toBe(false); // swallowed once
    advance(1);
    expect(view.result.current.allows({ type: "confirm" })).toBe(true); // then allowed
    view.unmount();
  });

  it("a dialog-open state owns input until closed; the dock does not act under it", () => {
    const withDialog: FocusOwnerState = { ...baseState, controlCenterOpen: true, controlCenterPanel: "return-home" };
    const view = renderHook((props: { state: FocusOwnerState }) => useFocusOwner(props.state), { initialProps: { state: withDialog } });
    expect(view.result.current.owner()).toBe("control-center");
    expect(resolveFocusOwner({
      veloraFocused: true, ambientActive: false, keyboardOpen: false,
      controllerPreflightOpen: false, diagnosticsOpen: false,
      controlCenterOpen: true, controlCenterPanel: "search", activeElement: null,
    })).toBe("search");
    // Panel closes: owner returns to the dock, one settle window applies.
    view.rerender({ state: baseState } as { state: FocusOwnerState });
    expect(view.result.current.owner()).toBe("home-dock");
    advance(CONFIRM_SETTLE_MS - 1);
    expect(view.result.current.allows({ type: "confirm" })).toBe(false);
    advance(1);
    expect(view.result.current.allows({ type: "confirm" })).toBe(true);
    view.unmount();
  });
});

describe("ascension A: window focus restore policy (dock highlight under overlays)", () => {
  it("a focus event does not move dock focus while any overlay is open", () => {
    expect(shouldRestoreDockFocus({ diagnosticsOpen: false, controlCenterOpen: false, dialogOpen: false })).toBe(true);
    expect(shouldRestoreDockFocus({ diagnosticsOpen: true, controlCenterOpen: false, dialogOpen: false })).toBe(false);
    expect(shouldRestoreDockFocus({ diagnosticsOpen: false, controlCenterOpen: true, dialogOpen: false })).toBe(false);
    expect(shouldRestoreDockFocus({ diagnosticsOpen: false, controlCenterOpen: false, dialogOpen: true })).toBe(false);
  });

  it("the cross-source gate treats the recovery boundary as a new epoch (no replayed action fires)", () => {
    const tag = crossSourceGate.currentEpoch;
    expect(crossSourceGate.accept("native", { type: "confirm" }, now, tag)).toBe(true);
    crossSourceGate.advanceEpoch(); // window focus regain boundary
    expect(crossSourceGate.accept("native", { type: "confirm" }, now + 5, tag)).toBe(false); // replay dropped
    expect(crossSourceGate.accept("native", { type: "confirm" }, now + 5)).toBe(true); // fresh press fires once
  });
});
