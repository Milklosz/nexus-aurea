import type { VirtualKeyboardController } from "../hooks/useVirtualKeyboard";
import { KEYBOARD_ROWS, keyAriaLabel, keyLabel } from "../services/virtualKeyboard";

type VirtualKeyboardProps = {
  controller: VirtualKeyboardController;
};

/**
 * VELORA's own on-screen keyboard. Rendered as a modal dialog so the existing
 * dialog-aware navigation keeps the dock and window shortcuts out of the way.
 * Opening and closing are imperative (see useVirtualKeyboard), so focus never
 * depends on render timing.
 */
export function VirtualKeyboard({ controller }: VirtualKeyboardProps) {
  const { session, cursor, dialogRef, handleKeyDown, activateAt, cancel } = controller;
  const layer = session?.layer ?? "lower";

  return <dialog
    ref={dialogRef}
    className="vkb"
    aria-labelledby="vkb-title"
    aria-describedby="vkb-hint"
    onKeyDown={handleKeyDown}
    onCancel={(event) => {
      event.preventDefault();
      cancel();
    }}
  >
    <header className="vkb-header">
      <h2 id="vkb-title">Klawiatura VELORA</h2>
      <p className="vkb-target">{session?.label ?? ""}</p>
    </header>
    <output className="vkb-preview" aria-label="Wpisany tekst">
      <span className="vkb-text">{session?.text ?? ""}</span>
      <span className="vkb-caret" aria-hidden="true" />
    </output>
    <div className="vkb-keys">
      {KEYBOARD_ROWS.map((row, rowIndex) => <div className="vkb-row" role="presentation" key={rowIndex}>
        {row.map((key, colIndex) => <button
          key={key.id}
          type="button"
          tabIndex={-1}
          className={`vkb-key vkb-key-${key.action.type}`}
          style={{ flexGrow: key.span }}
          data-vkb-row={rowIndex}
          data-vkb-col={colIndex}
          data-active={cursor.row === rowIndex && cursor.col === colIndex ? "true" : "false"}
          aria-label={keyAriaLabel(key, layer)}
          onClick={() => activateAt(rowIndex, colIndex)}
        >
          {keyLabel(key, layer)}
        </button>)}
      </div>)}
    </div>
    <p id="vkb-hint" className="vkb-hint">
      Kierunki poruszają fokusem · Potwierdź wybiera klawisz · Wstecz anuluje bez zmian · Home wraca do ekranu głównego
    </p>
  </dialog>;
}
