/**
 * Explicit permission boundary for the paired iPhone Remote.
 *
 * The remote `select` command is intentionally NOT a generic DOM click:
 *  - outside a modal dialog it may activate the focused Home dock item;
 *  - inside a dialog it may only activate controls explicitly marked with
 *    `data-remote-allow`;
 *  - anything marked `data-remote-admin` is always denied;
 *  - anything marked `data-velora-confirm` is always denied: risky actions
 *    need a local, explicit ConfirmDialog and can never be triggered by the
 *    remote through the shared `active.click()` path.
 *
 * This prevents a paired phone from revoking pairings, stopping the HTTPS
 * server, toggling autostart, or operating other administrative controls via
 * the shared `active.click()` path.
 */

export const REMOTE_ALLOW_ATTRIBUTE = "data-remote-allow";
export const REMOTE_ADMIN_ATTRIBUTE = "data-remote-admin";
/** Marks a control whose activation must go through the local ConfirmDialog first. */
export const REMOTE_CONFIRM_ATTRIBUTE = "data-velora-confirm";

export function canRemoteSelect(element: Element | null): boolean {
  if (!element || typeof (element as Element).closest !== "function") return false;
  if (element.closest(`[${REMOTE_ADMIN_ATTRIBUTE}]`)) {
    return false;
  }
  // Fail closed: a confirm-gated (risky) control is never remotely selectable,
  // even if some ancestor is broadly allowed.
  if (element.closest(`[${REMOTE_CONFIRM_ATTRIBUTE}]`)) {
    return false;
  }
  const dialog = element.closest("dialog[open]");
  if (!dialog) return true;
  // Default deny inside dialogs: the remote cannot reach an unmarked button
  // (including future administrative controls) by generic activation.
  return Boolean(element.closest(`[${REMOTE_ALLOW_ATTRIBUTE}]`));
}
