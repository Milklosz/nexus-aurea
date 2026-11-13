import type { NavIntent, NavIntentHandlers } from "./navIntent";
import { isKeyboardTextTarget, type KeyboardTextField } from "./virtualKeyboard";

/**
 * Only a VELORA-owned text field that carries this attribute may open the on-screen
 * keyboard. Fields in external services (streaming logins in a browser window) are
 * never in VELORA's DOM, and unmarked fields are never captured.
 */
export const TEXT_ENTRY_ATTRIBUTE = "data-velora-text-entry";

export type KeyboardSink = (intent: NavIntent) => void;

/**
 * Gives an open on-screen keyboard first claim on a navigation intent. Returns true
 * when the keyboard consumed it.
 *
 * - Select, move and back belong to the keyboard while it is open.
 * - Menu is ignored while typing, so Control Center cannot open under the keyboard.
 * - Home cancels the keyboard (the draft is discarded, nothing is written) and
 *   returns false, so the normal home action still runs.
 */
export function offerIntentToKeyboard(intent: NavIntent, sink: KeyboardSink | null): boolean {
  if (!sink) return false;
  if (intent.kind === "menu") return true;
  if (intent.kind === "home") {
    sink({ kind: "back" });
    return false;
  }
  sink(intent);
  return true;
}

/** Wraps the controller handlers so an open keyboard receives the intent before the home screen does. */
export function withKeyboardFirst(
  handlers: NavIntentHandlers,
  currentSink: () => KeyboardSink | null,
): NavIntentHandlers {
  const claimed = (intent: NavIntent) => offerIntentToKeyboard(intent, currentSink());
  return {
    move: (direction) => {
      if (!claimed({ kind: "move", direction })) handlers.move(direction);
    },
    select: () => {
      if (!claimed({ kind: "select" })) handlers.select();
    },
    back: () => {
      if (!claimed({ kind: "back" })) handlers.back();
    },
    menu: () => {
      if (!claimed({ kind: "menu" })) handlers.menu();
    },
    home: () => {
      if (!claimed({ kind: "home" })) handlers.home();
    },
  };
}

/** The text field that select should open the keyboard for, or null for any other focus target. */
export function textEntryTargetFromFocus(active: Element | null): KeyboardTextField | null {
  if (!active || !active.hasAttribute(TEXT_ENTRY_ATTRIBUTE)) return null;
  return isKeyboardTextTarget(active) ? active : null;
}
