import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { intentFromKeyboard, isIgnoredShortcutEvent, type NavIntent } from "../services/navIntent";
import {
  INITIAL_KEY_CURSOR,
  KEYBOARD_ROWS,
  keyAriaLabel,
  keyLabel,
  type KeyCursor,
  type KeyboardState,
  type KeyboardTextField,
  type KeyDef,
} from "../services/virtualKeyboard";
import {
  applyKeyboardAction,
  applyKeyboardIntent,
  initialKeyboardState,
  keyActionFromPhysicalKey,
  type KeyboardIntentStep,
} from "../services/virtualKeyboardIntent";
import type { KeyboardSink } from "../services/virtualKeyboardRouting";
import "./VirtualKeyboard.css";

export interface VirtualKeyboardProps {
  /** The VELORA field being edited. Its value is read on open and written only on commit. */
  field: KeyboardTextField;
  /** Receives the intent sink, so the pad and the pilot drive this keyboard. */
  sinkRef: MutableRefObject<KeyboardSink | null>;
  onDone: (text: string) => void;
  onCancel: () => void;
}

interface Model {
  cursor: KeyCursor;
  state: KeyboardState;
}

/**
 * On-screen keyboard for a VELORA text field. The model lives in services/virtualKeyboard*;
 * this component only draws it and feeds it. Pad, pilot and physical keys all end in the
 * same applyKeyboardIntent / applyKeyboardAction calls. No animations and no delays.
 */
export function VirtualKeyboard({ field, sinkRef, onDone, onCancel }: VirtualKeyboardProps) {
  const label = field.getAttribute("aria-label") || "Wpisz tekst";
  const [model, setModel] = useState<Model>(() => ({
    cursor: INITIAL_KEY_CURSOR,
    state: initialKeyboardState(field.value, field.maxLength),
  }));
  // The latest model is read synchronously, so two inputs in one frame do not drop a step.
  const modelRef = useRef(model);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keyRefs = useRef<Array<Array<HTMLButtonElement | null>>>([]);
  const doneRef = useRef(onDone);
  const cancelRef = useRef(onCancel);

  useEffect(() => {
    doneRef.current = onDone;
    cancelRef.current = onCancel;
  }, [onDone, onCancel]);

  const apply = useCallback((step: KeyboardIntentStep) => {
    const next: Model = { cursor: step.cursor, state: step.state };
    modelRef.current = next;
    setModel(next);
    if (step.outcome === "done") doneRef.current(step.state.text);
    else if (step.outcome === "cancel") cancelRef.current();
  }, []);

  // Modal, like the other VELORA dialogs, so the home screen is inert underneath.
  // Falls back to the open attribute where showModal is missing (jsdom).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  // Pad and pilot: the shared navigation intents.
  useEffect(() => {
    const sink: KeyboardSink = (intent: NavIntent) => {
      const current = modelRef.current;
      apply(applyKeyboardIntent(current.cursor, current.state, intent));
    };
    sinkRef.current = sink;
    return () => {
      if (sinkRef.current === sink) sinkRef.current = null;
    };
  }, [apply, sinkRef]);

  // Physical keyboard. Registered in the capture phase so the home screen never sees these keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // OS and browser shortcuts (Ctrl, Alt, Meta, auto-repeat of one-shot keys) pass through.
      if (isIgnoredShortcutEvent(event)) return;
      const action = keyActionFromPhysicalKey(event);
      const intent = action ? null : intentFromKeyboard(event);
      event.preventDefault();
      event.stopImmediatePropagation();
      const current = modelRef.current;
      if (action) apply(applyKeyboardAction(current.cursor, current.state, action));
      else if (intent) apply(applyKeyboardIntent(current.cursor, current.state, intent));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [apply]);

  // Visible focus follows the cursor, so a screen reader and the highlight always agree.
  useEffect(() => {
    keyRefs.current[model.cursor.row]?.[model.cursor.col]?.focus({ preventScroll: true });
  }, [model.cursor]);

  const layer = model.state.layer;
  const count = Array.from(model.state.text).length;

  return (
    <dialog
      ref={dialogRef}
      className="virtual-keyboard"
      aria-labelledby="virtual-keyboard-title"
      onCancel={(event) => {
        event.preventDefault();
        cancelRef.current();
      }}
    >
      <p className="virtual-keyboard-eyebrow">WPROWADŹ TEKST</p>
      <h2 id="virtual-keyboard-title">{label}</h2>
      <output className="virtual-keyboard-preview" aria-live="polite" aria-label="Wpisany tekst">
        {model.state.text || <span className="virtual-keyboard-placeholder">Pole jest puste</span>}
      </output>
      <p className="virtual-keyboard-count" aria-hidden="true">{count} / {model.state.maxLength}</p>
      <div className="virtual-keyboard-keys">
        {KEYBOARD_ROWS.map((row, rowIndex) => (
          <div className="virtual-keyboard-row" role="presentation" key={rowIndex}>
            {row.map((key: KeyDef, colIndex) => {
              const focused = model.cursor.row === rowIndex && model.cursor.col === colIndex;
              return (
                <button
                  key={key.id}
                  ref={(element) => {
                    keyRefs.current[rowIndex] ??= [];
                    keyRefs.current[rowIndex][colIndex] = element;
                  }}
                  type="button"
                  tabIndex={-1}
                  className={`virtual-keyboard-key virtual-keyboard-key-${key.action.type}`}
                  style={{ flex: `${key.span} 1 0%` }}
                  aria-label={keyAriaLabel(key, layer)}
                  aria-pressed={key.action.type === "shift" ? layer === "upper" : undefined}
                  data-focused={focused || undefined}
                  onClick={() => {
                    const current = modelRef.current;
                    apply(applyKeyboardAction({ row: rowIndex, col: colIndex }, current.state, key.action));
                  }}
                >
                  {keyLabel(key, layer)}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </dialog>
  );
}
