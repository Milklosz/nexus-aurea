import { directionFromKey, type NavigationDirection } from "./aureaNavigation";
import type { ControllerAction } from "./controllerEngine";
import type { RemoteCommand } from "./remoteCommand";

/**
 * One vocabulary for every input source (keyboard, DualSense, iPhone remote).
 * Sources differ in their raw events; they converge on these intents, so a
 * given physical intent (e.g. "confirm the focused tile") behaves the same
 * everywhere. Source adapters below are pure and have no DOM or hardware
 * dependency, so they can be tested without a TV or a controller.
 */
export type NavIntent =
  | { kind: "move"; direction: NavigationDirection }
  | { kind: "select" }
  | { kind: "back" }
  | { kind: "menu" }
  | { kind: "home" };

export type NavKeyEvent = Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "metaKey" | "altKey">;

/**
 * Keyboard: arrows move (auto-repeat allowed so holding a key keeps moving),
 * X selects and F2 opens the menu, each once per physical press. Ctrl, Alt and
 * Meta combinations belong to the OS or browser and produce no intent.
 */
export function intentFromKeyboard(event: NavKeyEvent): NavIntent | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const direction = directionFromKey(event.key);
  if (direction) return { kind: "move", direction };
  if (event.key.toLowerCase() === "x") return event.repeat ? null : { kind: "select" };
  if (event.key === "F2") return event.repeat ? null : { kind: "menu" };
  if (event.key === "Backspace" || event.key === "BrowserBack") return event.repeat ? null : { kind: "back" };
  return null;
}

/**
 * Keys whose single press toggles or closes something (fullscreen, dialogs,
 * menus). Holding them must not repeat the action: auto-repeat would flip
 * fullscreen on and off while the key is held.
 */
const ONE_SHOT_SHORTCUT_KEYS: ReadonlySet<string> = new Set(["Escape", "F11", "F2", "F3"]);

/**
 * App-level shortcut guard. True when a keydown belongs to the OS or browser
 * (Ctrl, Alt or Meta held: e.g. Ctrl+Escape opens Start) or is an auto-repeat
 * of a one-shot shortcut. Arrow and Backspace auto-repeat are unaffected.
 */
export function isIgnoredShortcutEvent(event: NavKeyEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  return event.repeat && ONE_SHOT_SHORTCUT_KEYS.has(event.key);
}

/**
 * DualSense: D-pad (or left stick) left/right is a linear move; up/down is a vertical
 * move between home zones, and inside dialogs it moves the focus the same way.
 */
export function intentFromController(action: ControllerAction): NavIntent {
  switch (action.type) {
    case "move":
      return { kind: "move", direction: action.delta < 0 ? "left" : "right" };
    case "vertical":
      return { kind: "move", direction: action.delta < 0 ? "up" : "down" };
    case "confirm":
      return { kind: "select" };
    case "back":
      return { kind: "back" };
    case "options":
      return { kind: "menu" };
  }
}

/** iPhone remote: navigation and lifecycle commands only; volume and profile commands are not navigation. */
export function intentFromRemote(command: RemoteCommand): NavIntent | null {
  switch (command) {
    case "up":
    case "down":
    case "left":
    case "right":
      return { kind: "move", direction: command };
    case "select":
      return { kind: "select" };
    case "back":
      return { kind: "back" };
    case "home":
      return { kind: "home" };
    default:
      return null;
  }
}

export type NavIntentHandlers = {
  move: (direction: NavigationDirection) => void;
  select: () => void;
  back: () => void;
  menu: () => void;
  home: () => void;
};

export function dispatchNavIntent(intent: NavIntent, handlers: NavIntentHandlers): void {
  switch (intent.kind) {
    case "move":
      handlers.move(intent.direction);
      break;
    case "select":
      handlers.select();
      break;
    case "back":
      handlers.back();
      break;
    case "menu":
      handlers.menu();
      break;
    case "home":
      handlers.home();
      break;
  }
}

/** Entry point for the DualSense hook: one raw controller action in, one handler call out. */
export function dispatchControllerAction(action: ControllerAction, handlers: NavIntentHandlers): void {
  dispatchNavIntent(intentFromController(action), handlers);
}
