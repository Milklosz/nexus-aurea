import { describe, expect, it } from "vitest";
import {
  intentFromController,
  intentFromKeyboard,
  intentFromRemote,
} from "../services/navIntent";

function key(name: string, repeat = false, modifiers: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
  return { key: name, repeat, ctrlKey: false, altKey: false, metaKey: false, ...modifiers };
}

describe("back is one intent across keyboard, DualSense and iPhone remote", () => {
  it("Backspace, DualSense back and remote back produce the same intent", () => {
    expect(intentFromKeyboard(key("Backspace"))).toEqual({ kind: "back" });
    expect(intentFromController({ type: "back" })).toEqual({ kind: "back" });
    expect(intentFromRemote("back")).toEqual({ kind: "back" });
  });

  it("BrowserBack is also back, once per press", () => {
    expect(intentFromKeyboard(key("BrowserBack"))).toEqual({ kind: "back" });
    expect(intentFromKeyboard(key("BrowserBack", true))).toBeNull();
  });

  it("does not repeat back on Backspace auto-repeat", () => {
    expect(intentFromKeyboard(key("Backspace", true))).toBeNull();
  });

  it("ignores Backspace combined with a modifier", () => {
    expect(intentFromKeyboard(key("Backspace", false, { ctrlKey: true }))).toBeNull();
    expect(intentFromKeyboard(key("Backspace", false, { altKey: true }))).toBeNull();
  });
});

describe("movement, select and menu parity", () => {
  it("left and right match across keyboard, DualSense and remote", () => {
    expect(intentFromKeyboard(key("ArrowLeft"))).toEqual(intentFromRemote("left"));
    expect(intentFromController({ type: "move", delta: -1 })).toEqual(intentFromRemote("left"));
    expect(intentFromKeyboard(key("ArrowRight"))).toEqual(intentFromRemote("right"));
    expect(intentFromController({ type: "move", delta: 1 })).toEqual(intentFromRemote("right"));
  });

  it("up and down match between keyboard and remote", () => {
    expect(intentFromKeyboard(key("ArrowUp"))).toEqual(intentFromRemote("up"));
    expect(intentFromKeyboard(key("ArrowDown"))).toEqual(intentFromRemote("down"));
  });

  it("select matches across keyboard (x), DualSense confirm and remote select", () => {
    const select = { kind: "select" };
    expect(intentFromKeyboard(key("x"))).toEqual(select);
    expect(intentFromController({ type: "confirm" })).toEqual(select);
    expect(intentFromRemote("select")).toEqual(select);
  });

  it("menu matches between keyboard (F2) and DualSense options", () => {
    expect(intentFromKeyboard(key("F2"))).toEqual({ kind: "menu" });
    expect(intentFromController({ type: "options" })).toEqual({ kind: "menu" });
  });

  it("home is a remote-only intent: keyboard and DualSense do not produce it", () => {
    expect(intentFromRemote("home")).toEqual({ kind: "home" });
    expect(intentFromKeyboard(key("Home"))).toBeNull();
  });
});
