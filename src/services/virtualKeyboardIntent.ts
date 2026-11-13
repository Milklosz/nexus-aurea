import type { NavIntent } from "./navIntent";
import {
  applyKeyAction,
  keyAt,
  moveKeyCursor,
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
      return applyResult(cursor, applyKeyAction(state, key.action));
    }
    case "back":
      return applyResult(cursor, applyKeyAction(state, { type: "cancel" }));
    case "menu":
    case "home":
      return { cursor, state, outcome: "none" };
  }
}

function applyResult(
  cursor: KeyCursor,
  result: ReturnType<typeof applyKeyAction>,
): KeyboardIntentStep {
  const { outcome, ...state } = result;
  return { cursor, state, outcome };
}
