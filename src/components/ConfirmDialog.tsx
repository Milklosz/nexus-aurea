import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { REMOTE_CONFIRM_ATTRIBUTE } from "../services/remotePermissions";

export { REMOTE_CONFIRM_ATTRIBUTE };

/**
 * Internal marker set on the trigger only while the confirmed re-click is
 * being dispatched, so the capture handler lets exactly that one click through.
 */
const CONFIRMED_DISPATCH_ATTRIBUTE = "data-velora-confirmed-dispatch";

export type PendingConfirm = {
  /** The trigger element that opened the dialog. */
  element: HTMLElement;
  /** Explicit warning shown to the human; carried by the attribute value. */
  warning: string;
  /** Visible label of the gated action, for context in the dialog. */
  actionLabel: string;
};

export type ConfirmGate = {
  /** Attach to a container's `onClickCapture`. */
  captureClick: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Render inside the same dialog/panel; null while no confirmation is pending. */
  dialog: ReactNode;
};

/** Pure: resolve the confirm-gated trigger for an event target, if any. */
export function findConfirmTrigger(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (typeof target.closest !== "function") return null;
  const trigger = target.closest<HTMLElement>(`[${REMOTE_CONFIRM_ATTRIBUTE}]`);
  if (!trigger) return null;
  // The confirmed re-dispatch must pass through untouched.
  if (trigger.hasAttribute(CONFIRMED_DISPATCH_ATTRIBUTE)) return null;
  return trigger;
}

/** Pure: is this element a disabled control (a click on it must not open the gate)? */
export function isDisabledControl(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
    ? element.disabled
    : element.getAttribute("aria-disabled") === "true";
}

/**
 * Reusable confirm gate for risky local actions.
 *
 * Any control carrying `data-velora-confirm="<explicit warning>"` is intercepted
 * in the capture phase: the first click never reaches the control's own handler.
 * Instead a local ConfirmDialog (role="alertdialog") shows the warning; only the
 * dialog's "Potwierdź" re-dispatches the original click, exactly once, with a
 * temporary dispatch marker. "Anuluj" (or Escape) drops the action.
 *
 * The gate is fail-closed for the iPhone Remote: `canRemoteSelect()` denies any
 * `[data-velora-confirm]` element, so the remote can never open this dialog via
 * a generic `active.click()`, and the dialog itself sits in a `data-remote-admin`
 * zone.
 */
export function useConfirmGate(): ConfirmGate {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const open = useCallback((next: PendingConfirm) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const close = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
  }, []);

  const captureClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const trigger = findConfirmTrigger(event.target);
    if (!trigger) return;
    if (isDisabledControl(trigger)) return;
    // Swallow the first click: the gated handler must not run before confirmation.
    event.preventDefault();
    event.stopPropagation();
    open({
      element: trigger,
      warning: trigger.getAttribute(REMOTE_CONFIRM_ATTRIBUTE) ?? "",
      actionLabel: (trigger.textContent ?? "").trim(),
    });
  }, [open]);

  const confirm = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    close();
    const { element } = current;
    if (!element.isConnected) return;
    element.setAttribute(CONFIRMED_DISPATCH_ATTRIBUTE, "");
    try {
      // Exactly one re-dispatch; the capture handler lets this single click through.
      element.click();
    } finally {
      element.removeAttribute(CONFIRMED_DISPATCH_ATTRIBUTE);
    }
  }, [close]);

  // Safe default focus: the destructive choice is never the focused one.
  useEffect(() => {
    if (pending) cancelRef.current?.focus({ preventScroll: true });
  }, [pending]);

  const onOverlayKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }, [close]);

  const dialog: ReactNode = pending ? (
    <div className="velora-confirm-overlay" data-remote-admin="" onKeyDown={onOverlayKeyDown}>
      <div
        className="velora-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="velora-confirm-title"
        aria-describedby="velora-confirm-warning"
      >
        <h3 id="velora-confirm-title">Potwierdź ryzykowną akcję</h3>
        <p id="velora-confirm-warning" className="velora-confirm-warning">
          {pending.warning || "Ta akcja jest ryzykowna i wymaga potwierdzenia."}
        </p>
        {pending.actionLabel && <p className="velora-confirm-action">Akcja: {pending.actionLabel}</p>}
        <div className="cc-actions velora-confirm-actions">
          <button type="button" ref={cancelRef} onClick={close}>Anuluj</button>
          <button type="button" className="velora-confirm-ok" onClick={confirm}>Potwierdź</button>
        </div>
      </div>
    </div>
  ) : null;

  return { captureClick, dialog };
}
