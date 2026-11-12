import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  DEFAULT_KEYBOARD_MAX_LENGTH,
  INITIAL_KEY_CURSOR,
  applyKeyAction,
  clampKeyCursor,
  isKeyboardTextTarget,
  keyAt,
  moveKeyCursor,
  writeFieldValue,
  type KeyAction,
  type KeyCursor,
  type KeyboardDirection,
  type KeyboardLayer,
  type KeyboardTextField,
} from "../services/virtualKeyboard";

/** The parts of a keyboard event the keyboard needs. Works for React and native events. */
export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface VirtualKeyboardSession {
  readonly field: KeyboardTextField;
  readonly label: string;
  readonly text: string;
  /** Text the field had when the keyboard opened; Back restores it. */
  readonly initialText: string;
  readonly layer: KeyboardLayer;
  readonly maxLength: number;
}

export interface VirtualKeyboardOptions {
  /** Focus target when the field that opened the keyboard is no longer usable. */
  fallbackFocus?: () => void;
}

export interface VirtualKeyboardController {
  readonly session: VirtualKeyboardSession | null;
  readonly cursor: KeyCursor;
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  /** Stable functions below keep their identity across renders. */
  readonly isOpen: () => boolean;
  /** Opens for a text field. Returns false for other elements or when already open. */
  readonly open: (field: Element | null, label?: string) => boolean;
  /** Closes. Focus returns to the field unless `restoreFocus` is false. */
  readonly close: (options?: { restoreFocus?: boolean }) => void;
  readonly move: (direction: KeyboardDirection) => void;
  /** Presses the focused key (pad Confirm / Enter). */
  readonly activate: () => void;
  readonly activateAt: (row: number, col: number) => void;
  /** Pad Back / Escape: restores the text from before the keyboard opened, then closes. */
  readonly cancel: () => void;
  /** Pad Home: closes, keeps the typed text and leaves focus to the caller's Home flow. */
  readonly closeForHome: () => void;
  readonly handleKeyDown: (event: KeyLike) => void;
}

export function useVirtualKeyboard(options: VirtualKeyboardOptions = {}): VirtualKeyboardController {
  const [session, setSession] = useState<VirtualKeyboardSession | null>(null);
  const [cursor, setCursor] = useState<KeyCursor>(INITIAL_KEY_CURSOR);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // Refs hold the synchronous truth; state only drives rendering.
  const sessionRef = useRef<VirtualKeyboardSession | null>(null);
  const cursorRef = useRef<KeyCursor>(INITIAL_KEY_CURSOR);
  const fallbackRef = useRef(options.fallbackFocus);

  useEffect(() => {
    fallbackRef.current = options.fallbackFocus;
  }, [options.fallbackFocus]);

  const focusCursor = useCallback((target: KeyCursor) => {
    dialogRef.current
      ?.querySelector<HTMLElement>(`[data-vkb-row="${target.row}"][data-vkb-col="${target.col}"]`)
      ?.focus({ preventScroll: true });
  }, []);

  const showDialog = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.hasAttribute("open")) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  const hideDialog = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || !dialog.hasAttribute("open")) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }, []);

  const isOpen = useCallback(() => sessionRef.current !== null, []);

  const close = useCallback((closeOptions: { restoreFocus?: boolean } = {}) => {
    const current = sessionRef.current;
    if (!current) return;
    sessionRef.current = null;
    setSession(null);
    hideDialog();
    if (closeOptions.restoreFocus !== false && current.field.isConnected && !current.field.disabled) {
      current.field.focus({ preventScroll: true });
    } else {
      fallbackRef.current?.();
    }
  }, [hideDialog]);

  const open = useCallback((field: Element | null, label?: string): boolean => {
    if (sessionRef.current || !isKeyboardTextTarget(field)) return false;
    const next: VirtualKeyboardSession = {
      field,
      label: label ?? field.getAttribute("aria-label") ?? "Pole tekstowe",
      text: field.value,
      initialText: field.value,
      layer: "lower",
      maxLength: field.maxLength > 0 ? field.maxLength : DEFAULT_KEYBOARD_MAX_LENGTH,
    };
    sessionRef.current = next;
    cursorRef.current = INITIAL_KEY_CURSOR;
    setSession(next);
    setCursor(INITIAL_KEY_CURSOR);
    showDialog();
    focusCursor(INITIAL_KEY_CURSOR);
    return true;
  }, [focusCursor, showDialog]);

  // Back / Escape / "Anuluj": put back the text from before the keyboard opened, then close.
  const cancel = useCallback(() => {
    const current = sessionRef.current;
    if (!current) return;
    if (current.text !== current.initialText) writeFieldValue(current.field, current.initialText);
    close({ restoreFocus: true });
  }, [close]);

  const commit = useCallback((action: KeyAction) => {
    const current = sessionRef.current;
    if (!current) return;
    const result = applyKeyAction({ text: current.text, layer: current.layer, maxLength: current.maxLength }, action);
    if (result.outcome === "cancel") {
      cancel();
      return;
    }
    if (result.outcome === "done") {
      close({ restoreFocus: true });
      return;
    }
    if (result.outcome === "edit") writeFieldValue(current.field, result.text);
    const updated: VirtualKeyboardSession = { ...current, text: result.text, layer: result.layer };
    sessionRef.current = updated;
    setSession(updated);
  }, [cancel, close]);

  const move = useCallback((direction: KeyboardDirection) => {
    if (!sessionRef.current) return;
    const next = moveKeyCursor(cursorRef.current, direction);
    cursorRef.current = next;
    setCursor(next);
    focusCursor(next);
  }, [focusCursor]);

  const activate = useCallback(() => {
    if (!sessionRef.current) return;
    const key = keyAt(cursorRef.current);
    if (key) commit(key.action);
  }, [commit]);

  const activateAt = useCallback((row: number, col: number) => {
    if (!sessionRef.current) return;
    const target = clampKeyCursor({ row, col });
    cursorRef.current = target;
    setCursor(target);
    focusCursor(target);
    const key = keyAt(target);
    if (key) commit(key.action);
  }, [commit, focusCursor]);

  const closeForHome = useCallback(() => close({ restoreFocus: false }), [close]);

  const handleKeyDown = useCallback((event: KeyLike) => {
    if (!sessionRef.current) return;
    // While the keyboard is open it owns the keys: window shortcuts (dock arrows,
    // F2/F3, Escape to windowed mode) must not run underneath it.
    event.stopPropagation();
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        move("up");
        return;
      case "ArrowDown":
        event.preventDefault();
        move("down");
        return;
      case "ArrowLeft":
        event.preventDefault();
        move("left");
        return;
      case "ArrowRight":
        event.preventDefault();
        move("right");
        return;
      case "Enter":
        event.preventDefault();
        activate();
        return;
      case "Escape":
        event.preventDefault();
        cancel();
        return;
      case "Backspace":
        event.preventDefault();
        commit({ type: "backspace" });
        return;
      case "Tab":
        // Focus stays inside the keyboard until it is closed.
        event.preventDefault();
        return;
      default:
        event.preventDefault();
        if (plain && event.key.length === 1) {
          commit(event.key === " " ? { type: "space" } : { type: "char", char: event.key });
        }
    }
  }, [activate, cancel, commit, move]);

  // If the owner unmounts while open, leave no dangling session behind.
  useEffect(() => () => {
    if (!sessionRef.current) return;
    sessionRef.current = null;
    hideDialog();
  }, [hideDialog]);

  return useMemo<VirtualKeyboardController>(() => ({
    session,
    cursor,
    dialogRef,
    isOpen,
    open,
    close,
    move,
    activate,
    activateAt,
    cancel,
    closeForHome,
    handleKeyDown,
  }), [session, cursor, isOpen, open, close, move, activate, activateAt, cancel, closeForHome, handleKeyDown]);
}
