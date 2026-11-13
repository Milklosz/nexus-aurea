import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { writeFieldValue, type KeyboardTextField } from "../services/virtualKeyboard";
import type { KeyboardSink } from "../services/virtualKeyboardRouting";

/**
 * Owns the on-screen keyboard for the app shell. The keyboard opens only for a field
 * the caller passes in (see textEntryTargetFromFocus). Commit writes the draft back
 * through the field's own input event; cancel leaves the field untouched. Either way
 * focus returns to the field that opened the keyboard.
 */
export function useVirtualKeyboardHost() {
  const [field, setField] = useState<KeyboardTextField | null>(null);
  const openFieldRef = useRef<KeyboardTextField | null>(null);
  // The mounted keyboard registers its intent sink here, so pad and pilot input can reach it.
  const sinkRef: MutableRefObject<KeyboardSink | null> = useRef(null);

  const restoreFocus = useCallback((target: KeyboardTextField) => {
    window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }, []);

  const openFor = useCallback((target: KeyboardTextField) => {
    if (openFieldRef.current) return;
    openFieldRef.current = target;
    setField(target);
  }, []);

  const close = useCallback(() => {
    const target = openFieldRef.current;
    openFieldRef.current = null;
    setField(null);
    if (target) restoreFocus(target);
  }, [restoreFocus]);

  const commit = useCallback((text: string) => {
    const target = openFieldRef.current;
    if (target) writeFieldValue(target, text);
    close();
  }, [close]);

  return { field, sinkRef, openFor, commit, cancel: close };
}
