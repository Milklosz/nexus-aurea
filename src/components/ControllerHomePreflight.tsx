import { useEffect, useRef } from "react";

type ControllerHomePreflightProps = {
  serviceName: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Local confirmation before a native-pad session can leave VELORA Home. */
export function ControllerHomePreflight({ serviceName, busy, onConfirm, onCancel }: ControllerHomePreflightProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open && typeof element.showModal === "function") element.showModal();
    cancelButton.current?.focus({ preventScroll: true });
    return () => { if (element?.open) element.close(); };
  }, []);

  return <dialog
    ref={dialog}
    className="control-center controller-home-preflight"
    aria-labelledby="controller-home-preflight-title"
    data-remote-admin=""
    onCancel={(event) => { event.preventDefault(); onCancel(); }}
  >
    <h2 id="controller-home-preflight-title">Włącz powrót na tę sesję?</h2>
    <p>Przed otwarciem {serviceName} możesz włączyć powrót do VELORA skrótem pada <strong>PS + Options</strong>.</p>
    <p>To ustawienie działa tylko do zamknięcia VELORA. Naciśnij oba przyciski niemal jednocześnie, potem zwolnij oba. Nie zmienia ustawień Windows ani Steam.</p>
    <div className="cc-actions">
      <button type="button" data-remote-admin="" aria-busy={busy} disabled={busy} onClick={onConfirm}>
        {busy ? "Włączam i otwieram…" : "Włącz powrót na tę sesję i otwórz"}
      </button>
      <button ref={cancelButton} type="button" data-remote-admin="" onClick={onCancel}>Anuluj</button>
    </div>
  </dialog>;
}
