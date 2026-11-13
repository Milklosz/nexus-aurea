import type { NavIntent } from "./navIntent";
import {
  applyKeyAction,
  DEFAULT_KEYBOARD_MAX_LENGTH,
  keyAt,
  moveKeyCursor,
  type KeyAction,
  type KeyCursor,
  type KeyboardOutcome,
  type KeyboardState,
} from "./virtualKeyboard";

export type KeyboardIntentStep = {
  cursor: KeyCursor;
  state: KeyboardState;
  outcome: KeyboardOutcome;
};

/**
 * Applies one shared navigation intent to the on-screen keyboard. The keyboard uses
 * the same vocabulary as the rest of the home screen: move, select the focused key,
 * back cancels. So the pad, the keyboard and the pilot behave the same way.
 *
 * Menu and home return "none": the caller decides what happens to an open keyboard.
 */
export function applyKeyboardIntent(
  cursor: KeyCursor,
  state: KeyboardState,
  intent: NavIntent,
): KeyboardIntentStep {
  switch (intent.kind) {
    case "move":
      return { cursor: moveKeyCursor(cursor, intent.direction), state, outcome: "none" };
    case "select": {
      const key = keyAt(cursor);
      if (!key) return { cursor, state, outcome: "none" };
      return applyKeyboardAction(cursor, state, key.action);
    }
    case "back":
      return applyKeyboardAction(cursor, state, { type: "cancel" });
    case "menu":
    case "home":
      return { cursor, state, outcome: "none" };
  }
}

/** Applies a key action directly, for example a key the user clicked or typed on a physical keyboard. */
export function applyKeyboardAction(
  cursor: KeyCursor,
  state: KeyboardState,
  action: KeyAction,
): KeyboardIntentStep {
  const { outcome, ...next } = applyKeyAction(state, action);
  return { cursor, state: next, outcome };
}

/** Starting draft for a field: its current value, cut to the keyboard's length limit. */
export function initialKeyboardState(value: string, fieldMaxLength: number): KeyboardState {
  const maxLength = fieldMaxLength > 0 ? fieldMaxLength : DEFAULT_KEYBOARD_MAX_LENGTH;
  return {
    text: Array.from(value).slice(0, maxLength).join(""),
    layer: "lower",
    maxLength,
  };
}

/** The part of a physical key press the on-screen keyboard takes over while it is open. */
export type PhysicalKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

/**
 * Physical keyboard while the on-screen keyboard is open: typed characters go straight
 * into the draft, Backspace deletes, Enter commits and Escape cancels. Arrow keys are
 * navigation and are handled by intentFromKeyboard instead. Ctrl, Alt and Meta
 * combinations belong to the OS and are never turned into text.
 */
export function keyActionFromPhysicalKey(event: PhysicalKeyEvent): KeyAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key === "Enter") return { type: "done" };
  if (event.key === "Escape") return { type: "cancel" };
  if (event.key === "Backspace") return { type: "backspace" };
  if (event.key === " ") return { type: "space" };
  if (Array.from(event.key).length === 1) return { type: "char", char: event.key };
  return null;
}
