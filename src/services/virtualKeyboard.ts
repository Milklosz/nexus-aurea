/**
 * On-screen keyboard for VELORA's own text fields. Pure logic, no DOM access at
 * import time. It only ever writes into a field that is part of VELORA's UI;
 * it never captures keys globally and never injects input into other apps.
 */

export type KeyboardLayer = "lower" | "upper";
export type KeyboardDirection = "up" | "down" | "left" | "right";

export type KeyAction =
  | { type: "char"; char: string }
  | { type: "space" }
  | { type: "backspace" }
  | { type: "shift" }
  | { type: "done" }
  | { type: "cancel" };

export interface KeyDef {
  id: string;
  action: KeyAction;
  /** Relative width inside its row. */
  span: number;
}

export interface KeyCursor {
  row: number;
  col: number;
}

export interface KeyboardState {
  text: string;
  layer: KeyboardLayer;
  maxLength: number;
}

export type KeyboardOutcome = "edit" | "none" | "done" | "cancel";

export interface KeyboardResult extends KeyboardState {
  outcome: KeyboardOutcome;
}

export const DEFAULT_KEYBOARD_MAX_LENGTH = 120;

/** Text input types that make sense for an on-screen keyboard. Passwords are excluded on purpose. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["", "text", "search", "email", "url", "tel"]);

const CHAR_ROWS: readonly (readonly string[])[] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "ł"],
  ["z", "x", "c", "v", "b", "n", "m", "ę", "ó", "ą"],
  ["ś", "ć", "ń", "ź", "ż", ".", ",", "-", "_", "@"],
];

export const KEYBOARD_ROWS: readonly (readonly KeyDef[])[] = [
  ...CHAR_ROWS.map((row) => row.map((char): KeyDef => ({
    id: `char-${char}`,
    action: { type: "char", char },
    span: 1,
  }))),
  [
    { id: "shift", action: { type: "shift" }, span: 1.5 },
    { id: "space", action: { type: "space" }, span: 4 },
    { id: "backspace", action: { type: "backspace" }, span: 1.5 },
    { id: "done", action: { type: "done" }, span: 2 },
    { id: "cancel", action: { type: "cancel" }, span: 1 },
  ],
];

/** Horizontal centre of every key as a share of its row (0..1), used for up/down moves. */
const KEY_CENTERS: readonly (readonly number[])[] = KEYBOARD_ROWS.map((row) => {
  const total = row.reduce((sum, key) => sum + key.span, 0);
  let start = 0;
  return row.map((key) => {
    const center = (start + key.span / 2) / total;
    start += key.span;
    return center;
  });
});

/** Starts on "q", the first letter a user normally reaches for. */
export const INITIAL_KEY_CURSOR: KeyCursor = { row: 1, col: 0 };

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

export function clampKeyCursor(cursor: KeyCursor): KeyCursor {
  const row = clampIndex(cursor.row, KEYBOARD_ROWS.length - 1);
  const col = clampIndex(cursor.col, KEYBOARD_ROWS[row].length - 1);
  return { row, col };
}

export function keyAt(cursor: KeyCursor): KeyDef | undefined {
  const { row, col } = clampKeyCursor(cursor);
  return KEYBOARD_ROWS[row][col];
}

/**
 * Moves the cursor. Left/right stay in the row. Up/down go to the row above or
 * below and pick the key whose centre is closest, so the control row lines up
 * with the letters above it. Never wraps.
 */
export function moveKeyCursor(cursor: KeyCursor, direction: KeyboardDirection): KeyCursor {
  const { row, col } = clampKeyCursor(cursor);
  const rowLength = KEYBOARD_ROWS[row].length;
  if (direction === "left") return { row, col: Math.max(0, col - 1) };
  if (direction === "right") return { row, col: Math.min(rowLength - 1, col + 1) };

  const nextRow = clampIndex(direction === "up" ? row - 1 : row + 1, KEYBOARD_ROWS.length - 1);
  if (nextRow === row) return { row, col };

  const center = KEY_CENTERS[row][col];
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  KEY_CENTERS[nextRow].forEach((candidate, index) => {
    const distance = Math.abs(candidate - center);
    if (distance < bestDistance - 1e-9) {
      best = index;
      bestDistance = distance;
    }
  });
  return { row: nextRow, col: best };
}

export function keyLabel(key: KeyDef, layer: KeyboardLayer): string {
  switch (key.action.type) {
    case "char":
      return layer === "upper" ? key.action.char.toLocaleUpperCase("pl-PL") : key.action.char;
    case "space":
      return "Spacja";
    case "backspace":
      return "⌫";
    case "shift":
      return layer === "upper" ? "⇧ ON" : "⇧";
    case "done":
      return "Gotowe";
    case "cancel":
      return "Anuluj";
  }
}

export function keyAriaLabel(key: KeyDef, layer: KeyboardLayer): string {
  switch (key.action.type) {
    case "char":
      return keyLabel(key, layer);
    case "space":
      return "Spacja";
    case "backspace":
      return "Usuń ostatni znak";
    case "shift":
      return layer === "upper" ? "Wyłącz wielkie litery" : "Wielka litera w następnym znaku";
    case "done":
      return "Gotowe, zapisz tekst";
    case "cancel":
      return "Anuluj bez zmian";
  }
}

function insertText(state: KeyboardState, value: string): KeyboardResult {
  const text = state.layer === "upper" ? value.toLocaleUpperCase("pl-PL") : value;
  if (Array.from(state.text).length >= state.maxLength) return { ...state, outcome: "none" };
  // The upper-case shift is one-shot: it applies to a single character.
  return { ...state, text: state.text + text, layer: "lower", outcome: "edit" };
}

export function applyKeyAction(state: KeyboardState, action: KeyAction): KeyboardResult {
  switch (action.type) {
    case "char":
      return insertText(state, action.char);
    case "space":
      return insertText(state, " ");
    case "backspace": {
      const chars = Array.from(state.text);
      if (chars.length === 0) return { ...state, outcome: "none" };
      chars.pop();
      return { ...state, text: chars.join(""), outcome: "edit" };
    }
    case "shift":
      return { ...state, layer: state.layer === "lower" ? "upper" : "lower", outcome: "none" };
    case "done":
      return { ...state, outcome: "done" };
    case "cancel":
      return { ...state, outcome: "cancel" };
  }
}

export type KeyboardTextField = HTMLInputElement | HTMLTextAreaElement;

/** Only editable, enabled, non-password text fields inside VELORA can receive the keyboard. */
export function isKeyboardTextTarget(element: Element | null): element is KeyboardTextField {
  if (typeof HTMLElement === "undefined" || !element) return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type) && !element.disabled && !element.readOnly;
  }
  return false;
}

/**
 * Writes a value through the element's own setter and fires `input`, which is what
 * React-controlled fields listen to. The field's owner stays the single source of truth.
 */
export function writeFieldValue(field: KeyboardTextField, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
