import { describe, expect, it, vi } from "vitest";
import {
  dispatchNavIntent,
  intentFromController,
  intentFromKeyboard,
  intentFromRemote,
  type NavIntent,
  type NavIntentHandlers,
} from "../services/navIntent";

function key(overrides: Partial<Parameters<typeof intentFromKeyboard>[0]> & { key: string }) {
  return { repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...overrides };
}

describe("keyboard intents", () => {
  it("maps arrows to moves and keeps auto-repeat for movement", () => {
    expect(intentFromKeyboard(key({ key: "ArrowLeft" }))).toEqual({ kind: "move", direction: "left" });
    expect(intentFromKeyboard(key({ key: "ArrowUp", repeat: true }))).toEqual({ kind: "move", direction: "up" });
  });

  it("maps x to select and F2 to menu once per press", () => {
    expect(intentFromKeyboard(key({ key: "x" }))).toEqual({ kind: "select" });
    expect(intentFromKeyboard(key({ key: "X" }))).toEqual({ kind: "select" });
    expect(intentFromKeyboard(key({ key: "x", repeat: true }))).toBeNull();
    expect(intentFromKeyboard(key({ key: "F2" }))).toEqual({ kind: "menu" });
    expect(intentFromKeyboard(key({ key: "F2", repeat: true }))).toBeNull();
  });

  it("produces no intent for Ctrl, Alt or Meta combinations", () => {
    expect(intentFromKeyboard(key({ key: "ArrowRight", altKey: true }))).toBeNull();
    expect(intentFromKeyboard(key({ key: "x", ctrlKey: true }))).toBeNull();
    expect(intentFromKeyboard(key({ key: "x", metaKey: true }))).toBeNull();
  });

  it("ignores unrelated and prototype keys", () => {
    expect(intentFromKeyboard(key({ key: "a" }))).toBeNull();
    expect(intentFromKeyboard(key({ key: "toString" }))).toBeNull();
    expect(intentFromKeyboard(key({ key: "Enter" }))).toBeNull();
  });
});

describe("controller intents", () => {
  it("maps D-pad and buttons to the shared vocabulary", () => {
    expect(intentFromController({ type: "move", delta: -1 })).toEqual({ kind: "move", direction: "left" });
    expect(intentFromController({ type: "move", delta: 1 })).toEqual({ kind: "move", direction: "right" });
    expect(intentFromController({ type: "confirm" })).toEqual({ kind: "select" });
    expect(intentFromController({ type: "back" })).toEqual({ kind: "back" });
    expect(intentFromController({ type: "options" })).toEqual({ kind: "menu" });
  });
});

describe("remote intents", () => {
  it("maps navigation and lifecycle commands", () => {
    expect(intentFromRemote("up")).toEqual({ kind: "move", direction: "up" });
    expect(intentFromRemote("select")).toEqual({ kind: "select" });
    expect(intentFromRemote("back")).toEqual({ kind: "back" });
    expect(intentFromRemote("home")).toEqual({ kind: "home" });
  });

  it("does not treat volume or profile commands as navigation", () => {
    expect(intentFromRemote("volume-up")).toBeNull();
    expect(intentFromRemote("mute")).toBeNull();
    expect(intentFromRemote("profile-cinema")).toBeNull();
  });
});

describe("cross-source parity", () => {
  it("gives the same intent for the same logical button on every source", () => {
    const select = intentFromKeyboard(key({ key: "x" }));
    expect(select).toEqual(intentFromController({ type: "confirm" }));
    expect(select).toEqual(intentFromRemote("select"));

    const back = intentFromController({ type: "back" });
    expect(back).toEqual(intentFromRemote("back"));

    expect(intentFromKeyboard(key({ key: "ArrowLeft" }))).toEqual(
      intentFromController({ type: "move", delta: -1 }),
    );
    expect(intentFromKeyboard(key({ key: "ArrowRight" }))).toEqual(intentFromRemote("right"));
  });
});

describe("dispatchNavIntent", () => {
  function handlers(): NavIntentHandlers {
    return { move: vi.fn(), select: vi.fn(), back: vi.fn(), menu: vi.fn(), home: vi.fn() };
  }

  it.each<[NavIntent, keyof NavIntentHandlers]>([
    [{ kind: "select" }, "select"],
    [{ kind: "back" }, "back"],
    [{ kind: "menu" }, "menu"],
    [{ kind: "home" }, "home"],
  ])("calls exactly the %j handler", (intent, expected) => {
    const h = handlers();
    dispatchNavIntent(intent, h);
    for (const name of Object.keys(h) as Array<keyof NavIntentHandlers>) {
      expect(h[name]).toHaveBeenCalledTimes(name === expected ? 1 : 0);
    }
  });

  it("passes the direction to the move handler", () => {
    const h = handlers();
    dispatchNavIntent({ kind: "move", direction: "down" }, h);
    expect(h.move).toHaveBeenCalledWith("down");
  });
});
