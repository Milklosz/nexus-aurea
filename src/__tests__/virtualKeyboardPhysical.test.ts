import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBOARD_MAX_LENGTH, INITIAL_KEY_CURSOR } from "../services/virtualKeyboard";
import {
  applyKeyboardAction,
  initialKeyboardState,
  keyActionFromPhysicalKey,
} from "../services/virtualKeyboardIntent";

function press(key: string, modifiers: Partial<Record<"ctrlKey" | "altKey" | "metaKey", boolean>> = {}) {
  return { key, ctrlKey: false, altKey: false, metaKey: false, ...modifiers };
}

describe("keyActionFromPhysicalKey", () => {
  it("maps Enter to done, Escape to cancel and Backspace to backspace", () => {
    expect(keyActionFromPhysicalKey(press("Enter"))).toEqual({ type: "done" });
    expect(keyActionFromPhysicalKey(press("Escape"))).toEqual({ type: "cancel" });
    expect(keyActionFromPhysicalKey(press("Backspace"))).toEqual({ type: "backspace" });
  });

  it("types printable characters, including the letter x that the shared map uses for select", () => {
    expect(keyActionFromPhysicalKey(press("x"))).toEqual({ type: "char", char: "x" });
    expect(keyActionFromPhysicalKey(press("ł"))).toEqual({ type: "char", char: "ł" });
    expect(keyActionFromPhysicalKey(press(" "))).toEqual({ type: "space" });
  });

  it("leaves arrows, function keys and modifier combinations to the other handlers", () => {
    expect(keyActionFromPhysicalKey(press("ArrowLeft"))).toBeNull();
    expect(keyActionFromPhysicalKey(press("F2"))).toBeNull();
    expect(keyActionFromPhysicalKey(press("Shift"))).toBeNull();
    expect(keyActionFromPhysicalKey(press("a", { ctrlKey: true }))).toBeNull();
    expect(keyActionFromPhysicalKey(press("Escape", { altKey: true }))).toBeNull();
    expect(keyActionFromPhysicalKey(press("q", { metaKey: true }))).toBeNull();
  });

  it("does not type multi-character key names", () => {
    expect(keyActionFromPhysicalKey(press("Dead"))).toBeNull();
    expect(keyActionFromPhysicalKey(press(""))).toBeNull();
  });
});

describe("initialKeyboardState", () => {
  it("starts from the field value", () => {
    expect(initialKeyboardState("draft", 20)).toEqual({ text: "draft", layer: "lower", maxLength: 20 });
  });

  it("uses the default limit when the field has none (-1)", () => {
    const state = initialKeyboardState("", -1);
    expect(state.maxLength).toBe(DEFAULT_KEYBOARD_MAX_LENGTH);
  });

  it("cuts an over-long value to the limit by characters, not UTF-16 units", () => {
    const state = initialKeyboardState("ąęóźżłćń", 4);
    expect(state.text).toBe("ąęóź");
  });
});

describe("applyKeyboardAction", () => {
  const state = initialKeyboardState("", 10);

  it("keeps the cursor and reports done with the typed text", () => {
    const step = applyKeyboardAction(INITIAL_KEY_CURSOR, initialKeyboardState("ok", 10), { type: "done" });
    expect(step.outcome).toBe("done");
    expect(step.state.text).toBe("ok");
    expect(step.cursor).toEqual(INITIAL_KEY_CURSOR);
  });

  it("types a physical character into the draft", () => {
    const step = applyKeyboardAction(INITIAL_KEY_CURSOR, state, { type: "char", char: "x" });
    expect(step.state.text).toBe("x");
    expect(step.outcome).toBe("edit");
  });

  it("does nothing on backspace with empty text", () => {
    const step = applyKeyboardAction(INITIAL_KEY_CURSOR, state, { type: "backspace" });
    expect(step.state.text).toBe("");
    expect(step.outcome).toBe("none");
  });

  it("does not grow past the field limit", () => {
    const full = initialKeyboardState("abcd", 4);
    const step = applyKeyboardAction(INITIAL_KEY_CURSOR, full, { type: "char", char: "z" });
    expect(step.state.text).toBe("abcd");
    expect(step.outcome).toBe("none");
  });
});
