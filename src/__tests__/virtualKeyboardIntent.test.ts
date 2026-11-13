import { describe, expect, it } from "vitest";
import { intentFromController, intentFromKeyboard, intentFromRemote, type NavIntent } from "../services/navIntent";
import { applyKeyboardIntent } from "../services/virtualKeyboardIntent";
import { DEFAULT_KEYBOARD_MAX_LENGTH, INITIAL_KEY_CURSOR, type KeyboardState } from "../services/virtualKeyboard";

const state = (text = ""): KeyboardState => ({
  text,
  layer: "lower",
  maxLength: DEFAULT_KEYBOARD_MAX_LENGTH,
});

function key(name: string) {
  return { key: name, repeat: false, ctrlKey: false, altKey: false, metaKey: false };
}

describe("applyKeyboardIntent", () => {
  it("moves the cursor on move intents and leaves the text alone", () => {
    const step = applyKeyboardIntent(INITIAL_KEY_CURSOR, state("ab"), { kind: "move", direction: "right" });
    expect(step.cursor).toEqual({ row: 1, col: 1 });
    expect(step.state.text).toBe("ab");
    expect(step.outcome).toBe("none");
  });

  it("inserts the focused character on select", () => {
    const step = applyKeyboardIntent(INITIAL_KEY_CURSOR, state(""), { kind: "select" });
    expect(step.state.text).toBe("q");
    expect(step.outcome).toBe("edit");
  });

  it("cancels on back without changing the text", () => {
    const step = applyKeyboardIntent(INITIAL_KEY_CURSOR, state("draft"), { kind: "back" });
    expect(step.state.text).toBe("draft");
    expect(step.outcome).toBe("cancel");
  });

  it("reports done and cancel when those keys are selected", () => {
    // The control row is the sixth row (index 5): shift, space, backspace, done, cancel.
    const row = 5;
    const doneCursor = { row, col: 3 };
    const cancelCursor = { row, col: 4 };
    expect(applyKeyboardIntent(doneCursor, state("ok"), { kind: "select" }).outcome).toBe("done");
    expect(applyKeyboardIntent(cancelCursor, state("ok"), { kind: "select" }).outcome).toBe("cancel");
  });

  it("leaves the keyboard unchanged for menu and home, so the caller decides", () => {
    for (const intent of [{ kind: "menu" }, { kind: "home" }] as NavIntent[]) {
      const step = applyKeyboardIntent(INITIAL_KEY_CURSOR, state("keep"), intent);
      expect(step.cursor).toEqual(INITIAL_KEY_CURSOR);
      expect(step.state.text).toBe("keep");
      expect(step.outcome).toBe("none");
    }
  });

  it("gives the same step for pad, keyboard and pilot inputs (parity)", () => {
    const sources: Array<[string, NavIntent | null]> = [
      ["pad right", intentFromController({ type: "move", delta: 1 })],
      ["keyboard right", intentFromKeyboard(key("ArrowRight"))],
      ["pilot right", intentFromRemote("right")],
    ];
    const steps = sources.map(([, intent]) =>
      applyKeyboardIntent(INITIAL_KEY_CURSOR, state(), intent as NavIntent),
    );
    expect(steps[0]).toEqual(steps[1]);
    expect(steps[1]).toEqual(steps[2]);

    const selects: NavIntent[] = [
      intentFromController({ type: "confirm" }),
      intentFromKeyboard(key("x")),
      intentFromRemote("select"),
    ].filter((intent): intent is NavIntent => intent !== null);
    const selected = selects.map((intent) => applyKeyboardIntent(INITIAL_KEY_CURSOR, state(), intent));
    expect(selected.every((step) => step.state.text === "q" && step.outcome === "edit")).toBe(true);
  });
});
