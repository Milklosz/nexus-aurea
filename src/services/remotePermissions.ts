/**
 * Explicit permission boundary for the paired iPhone Remote.
 *
 * The remote `select` command is intentionally NOT a generic DOM click:
 *  - outside a modal dialog it may activate the focused Home dock item;
 *  - inside a dialog it may only activate controls explicitly marked with
 *    `data-remote-allow`;
 *  - anything marked `data-remote-admin` is always denied.
 *
 * This prevents a paired phone from revoking pairings, stopping the HTTPS
 * server, toggling autostart, or operating other administrative controls via
 * the shared `active.click()` path.
 */

export const REMOTE_ALLOW_ATTRIBUTE = "data-remote-allow";
export const REMOTE_ADMIN_ATTRIBUTE = "data-remote-admin";

export function canRemoteSelect(element: Element | null): boolean {
  if (!element || typeof (element as Element).closest !== "function") return false;
  if (element.closest(`[${REMOTE_ADMIN_ATTRIBUTE}]`) && !element.closest(`[${REMOTE_ALLOW_ATTRIBUTE}]`)) {
    return false;
  }
  const dialog = element.closest("dialog[open]");
  if (!dialog) return true;
  // Default deny inside dialogs: the remote cannot reach an unmarked button
  // (including future administrative controls) by generic activation.
  return Boolean(element.closest(`[${REMOTE_ALLOW_ATTRIBUTE}]`));
}
