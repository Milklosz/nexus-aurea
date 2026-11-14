// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIRM_SETTLE_MS,
  FocusOwnershipGuard,
  canRestoreFocusTo,
  focusOpenerFrom,
  ownerAcceptsController,
  resolveFocusOwner,
  type FocusOwnerInput,
} from "../services/focusOwnership";
import { CrossSourceGate } from "../services/crossSourceGate";

const base: FocusOwnerInput = {
  veloraFocused: true,
  ambientActive: false,
  keyboardOpen: false,
  diagnosticsOpen: false,
  controlCenterOpen: false,
  activeElement: null,
};

afterEach(() => { document.body.innerHTML = ""; });

describe("resolveFocusOwner", () => {
  it("has exactly one owner and follows the layer order", () => {
    expect(resolveFocusOwner(base)).toBe("home-dock");
    expect(resolveFocusOwner({ ...base, controlCenterOpen: true })).toBe("control-center");
    expect(resolveFocusOwner({ ...base, controlCenterOpen: true, controlCenterPanel: "search" })).toBe("search");
    expect(resolveFocusOwner({ ...base, diagnosticsOpen: true, controlCenterOpen: true })).toBe("diagnostics");
    expect(resolveFocusOwner({ ...base, keyboardOpen: true, controlCenterOpen: true, controlCenterPanel: "search" })).toBe("keyboard");
    expect(resolveFocusOwner({ ...base, ambientActive: true, keyboardOpen: true })).toBe("ambient");
    expect(resolveFocusOwner({ ...base, veloraFocused: false, ambientActive: true, keyboardOpen: true })).toBe("external");
  });

  it("reports home-actions when focus is in the top action row", () => {
    document.body.innerHTML = `<div class="home-actions"><button id="a">Szukaj</button></div>`;
    const active = document.getElementById("a");
    expect(resolveFocusOwner({ ...base, activeElement: active })).toBe("home-actions");
  });

  it("a hidden interface never owns input", () => {
    expect(ownerAcceptsController("external")).toBe(false);
    expect(ownerAcceptsController("ambient")).toBe(false);
    for (const owner of ["keyboard", "diagnostics", "search", "control-center", "home-actions", "home-dock"] as const) {
      expect(ownerAcceptsController(owner)).toBe(true);
    }
  });
});

describe("FocusOwnershipGuard", () => {
  it("swallows a confirm right after a panel closes, but never move or back", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("control-center", 1000);
    guard.observe("home-dock", 2000); // panel closed by Circle
    expect(guard.allows({ type: "confirm" }, 2000 + CONFIRM_SETTLE_MS - 1)).toBe(false);
    expect(guard.allows({ type: "move", delta: 1 }, 2010)).toBe(true);
    expect(guard.allows({ type: "back" }, 2010)).toBe(true);
    expect(guard.allows({ type: "confirm" }, 2000 + CONFIRM_SETTLE_MS)).toBe(true);
  });

  it("does not delay a confirm when nothing changed", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("home-dock", 5);
    expect(guard.allows({ type: "confirm" }, 6)).toBe(true);
  });

  it("moving between the dock and the top actions is navigation, not a hand-over", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("home-actions", 1000);
    expect(guard.allows({ type: "confirm" }, 1010)).toBe(true);
    guard.observe("home-dock", 2000);
    expect(guard.allows({ type: "confirm" }, 2010)).toBe(true);
  });

  it("denies every action while an external app owns focus", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("external", 0);
    for (const action of [{ type: "confirm" }, { type: "back" }, { type: "options" }, { type: "move", delta: 1 }] as const) {
      expect(guard.allows(action, 10_000)).toBe(false);
    }
  });

  it("swallows confirm when VELORA regains focus from an external app", () => {
    const guard = new FocusOwnershipGuard();
    guard.observe("external", 0);
    guard.observe("home-dock", 5000);
    expect(guard.allows({ type: "confirm" }, 5050)).toBe(false);
    expect(guard.allows({ type: "confirm" }, 5000 + CONFIRM_SETTLE_MS)).toBe(true);
  });
});

describe("focus opener", () => {
  it("remembers a Home-zone control but not body or an element inside a dialog", () => {
    document.body.innerHTML = `
      <div class="home-actions"><button id="search">Szukaj</button></div>
      <div class="lr-dock"><button id="tile">Netflix</button></div>
      <dialog open><button id="inside">x</button></dialog>`;
    expect(focusOpenerFrom(document.getElementById("search"))?.id).toBe("search");
    expect(focusOpenerFrom(document.getElementById("tile"))?.id).toBe("tile");
    expect(focusOpenerFrom(document.getElementById("inside"))).toBeNull();
    expect(focusOpenerFrom(document.body)).toBeNull();
    expect(focusOpenerFrom(null)).toBeNull();
  });

  it("does not restore to a removed or disabled opener", () => {
    document.body.innerHTML = `<div class="home-actions"><button id="a">a</button><button id="b" disabled>b</button></div>`;
    const a = document.getElementById("a") as HTMLElement;
    const b = document.getElementById("b") as HTMLElement;
    expect(canRestoreFocusTo(a)).toBe(true);
    expect(canRestoreFocusTo(b)).toBe(false);
    a.remove();
    expect(canRestoreFocusTo(a)).toBe(false);
    expect(canRestoreFocusTo(null)).toBe(false);
  });
});

describe("CrossSourceGate", () => {
  it("drops the same action from a different source inside the window", () => {
    const gate = new CrossSourceGate(90);
    expect(gate.accept("gamepad-api", { type: "confirm" }, 1000)).toBe(true);
    expect(gate.accept("native", { type: "confirm" }, 1030)).toBe(false);
    expect(gate.accept("native", { type: "confirm" }, 1095)).toBe(true);
  });

  it("gives the browser path no say while the native pad is in use (virtual pads)", () => {
    const gate = new CrossSourceGate(90, 400);
    gate.noteNativeActivity(1000);
    expect(gate.accept("gamepad-api", { type: "confirm" }, 1100)).toBe(false);
    expect(gate.accept("gamepad-api", { type: "move", delta: 1 }, 1390)).toBe(false);
    expect(gate.accept("native", { type: "confirm" }, 1100)).toBe(true);
    // Native went quiet: the browser path (a real Xbox pad) works again.
    expect(gate.accept("gamepad-api", { type: "confirm" }, 1401)).toBe(true);
    gate.reset();
    gate.noteNativeActivity(5000);
    gate.reset();
    expect(gate.accept("gamepad-api", { type: "confirm" }, 5001)).toBe(true);
  });

  it("never throttles a single source and keeps directions independent", () => {
    const gate = new CrossSourceGate(90);
    expect(gate.accept("native", { type: "move", delta: 1 }, 0)).toBe(true);
    expect(gate.accept("native", { type: "move", delta: 1 }, 5)).toBe(true);
    expect(gate.accept("gamepad-api", { type: "move", delta: -1 }, 6)).toBe(true);
    expect(gate.accept("gamepad-api", { type: "move", delta: 1 }, 7)).toBe(false);
  });
});
