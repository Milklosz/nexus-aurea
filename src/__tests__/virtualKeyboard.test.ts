import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBOARD_MAX_LENGTH,
  INITIAL_KEY_CURSOR,
  KEYBOARD_ROWS,
  applyKeyAction,
  keyAriaLabel,
  keyAt,
  keyLabel,
  moveKeyCursor,
  type KeyCursor,
  type KeyDef,
  type KeyboardState,
} from "../services/virtualKeyboard";

const state = (text = "", overrides: Partial<KeyboardState> = {}): KeyboardState => ({
  text,
  layer: "lower",
  maxLength: DEFAULT_KEYBOARD_MAX_LENGTH,
  ...overrides,
});

function keyNamed(char: string): KeyDef {
  const key = KEYBOARD_ROWS.flat().find((candidate) => candidate.action.type === "char" && candidate.action.char === char);
  if (!key) throw new Error(`no key for ${char}`);
  return key;
}

describe("layout", () => {
  it("has unique key ids and only positive key widths", () => {
    const keys = KEYBOARD_ROWS.flat();
    expect(new Set(keys.map((key) => key.id)).size).toBe(keys.length);
    expect(keys.every((key) => key.span > 0)).toBe(true);
  });

  it("covers the Polish letters and the control keys", () => {
    for (const char of ["ą", "ć", "ę", "ł", "ń", "ó", "ś", "ź", "ż"]) {
      expect(() => keyNamed(char)).not.toThrow();
    }
    const types = new Set(KEYBOARD_ROWS.flat().map((key) => key.action.type));
    for (const type of ["shift", "space", "backspace", "done", "cancel"]) {
      expect(types.has(type as never)).toBe(true);
    }
  });

  it("starts on the letter q", () => {
    expect(keyAt(INITIAL_KEY_CURSOR)).toEqual(keyNamed("q"));
  });

  it("labels upper-case Polish letters with the Polish locale", () => {
    expect(keyLabel(keyNamed("ą"), "upper")).toBe("Ą");
    expect(keyLabel(keyNamed("ł"), "upper")).toBe("Ł");
    expect(keyLabel(keyNamed("ł"), "lower")).toBe("ł");
    expect(keyAriaLabel(keyNamed("ż"), "lower")).toBe("ż");
  });
});

describe("cursor movement", () => {
  it("left and right stay inside the row and never wrap", () => {
    expect(moveKeyCursor({ row: 1, col: 0 }, "left")).toEqual({ row: 1, col: 0 });
    expect(moveKeyCursor({ row: 1, col: 9 }, "right")).toEqual({ row: 1, col: 9 });
    expect(moveKeyCursor({ row: 1, col: 4 }, "right")).toEqual({ row: 1, col: 5 });
  });

  it("down from q lands on a in the row below", () => {
    expect(moveKeyCursor({ row: 1, col: 0 }, "down")).toEqual({ row: 2, col: 0 });
  });

  it("up and down follow the horizontal centre of the key, so the control row lines up", () => {
    // The first letter of the symbol row sits above the Shift key.
    expect(moveKeyCursor({ row: 4, col: 0 }, "down")).toEqual({ row: 5, col: 0 });
    // The cancel key at the far right goes back up to the last symbol.
    expect(moveKeyCursor({ row: 5, col: 4 }, "up")).toEqual({ row: 4, col: 9 });
    // The space bar (wide) is reached from the middle of the row above.
    const spaceCol = KEYBOARD_ROWS[5].findIndex((key) => key.action.type === "space");
    expect(moveKeyCursor({ row: 4, col: 4 }, "down")).toEqual({ row: 5, col: spaceCol });
  });

  it("does not move past the first or last row", () => {
    expect(moveKeyCursor({ row: 0, col: 3 }, "up")).toEqual({ row: 0, col: 3 });
    expect(moveKeyCursor({ row: 5, col: 2 }, "down")).toEqual({ row: 5, col: 2 });
  });

  it("clamps an out-of-range or non-finite cursor before moving", () => {
    expect(moveKeyCursor({ row: 99, col: -3 }, "left")).toEqual({ row: 5, col: 0 });
    expect(moveKeyCursor({ row: Number.NaN, col: Number.NaN }, "right")).toEqual({ row: 0, col: 1 });
    expect(keyAt({ row: -1, col: 500 })).toBeDefined();
  });

  it("every move stays on a real key for every starting cell", () => {
    const directions = ["up", "down", "left", "right"] as const;
    KEYBOARD_ROWS.forEach((row, rowIndex) => {
      row.forEach((_, colIndex) => {
        for (const direction of directions) {
          const next: KeyCursor = moveKeyCursor({ row: rowIndex, col: colIndex }, direction);
          expect(keyAt(next)).toBeDefined();
        }
      });
    });
  });
});

describe("key actions", () => {
  it("types a lower-case letter and keeps the lower layer", () => {
    expect(applyKeyAction(state(""), { type: "char", char: "a" })).toMatchObject({ text: "a", layer: "lower", outcome: "edit" });
  });

  it("shift makes the next letter upper case once, then returns to lower case", () => {
    const shifted = applyKeyAction(state("x"), { type: "shift" });
    expect(shifted).toMatchObject({ layer: "upper", outcome: "none", text: "x" });
    const typed = applyKeyAction(shifted, { type: "char", char: "ą" });
    expect(typed).toMatchObject({ text: "xĄ", layer: "lower", outcome: "edit" });
    expect(applyKeyAction(typed, { type: "shift" }).layer).toBe("upper");
  });

  it("space inserts a space", () => {
    expect(applyKeyAction(state("a"), { type: "space" }).text).toBe("a ");
  });

  it("backspace removes the last character, counting code points", () => {
    expect(applyKeyAction(state("ab"), { type: "backspace" })).toMatchObject({ text: "a", outcome: "edit" });
    expect(applyKeyAction(state("😀"), { type: "backspace" }).text).toBe("");
    expect(applyKeyAction(state(""), { type: "backspace" })).toMatchObject({ text: "", outcome: "none" });
  });

  it("stops at the maximum length, counting code points", () => {
    expect(applyKeyAction(state("abc", { maxLength: 3 }), { type: "char", char: "d" })).toMatchObject({ text: "abc", outcome: "none" });
    expect(applyKeyAction(state("ab", { maxLength: 3 }), { type: "char", char: "ł" })).toMatchObject({ text: "abł", outcome: "edit" });
  });

  it("done and cancel report their outcome and do not change the text", () => {
    expect(applyKeyAction(state("abc"), { type: "done" })).toMatchObject({ text: "abc", outcome: "done" });
    expect(applyKeyAction(state("abc"), { type: "cancel" })).toMatchObject({ text: "abc", outcome: "cancel" });
  });
});
