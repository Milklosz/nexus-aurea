/**
 * Whether a window `focus` event should move navigation focus back to the dock.
 *
 * Not while a modal overlay owns focus. Control Center and diagnostics are
 * modal `<dialog>` elements, so dock tiles behind them are inert: focusing
 * them does nothing visible, but it still changes which tile is highlighted
 * underneath the overlay. Any other open dialog counts as an overlay too.
 */
export function shouldRestoreDockFocus(state: {
  diagnosticsOpen: boolean;
  controlCenterOpen: boolean;
  dialogOpen: boolean;
}): boolean {
  return !state.diagnosticsOpen && !state.controlCenterOpen && !state.dialogOpen;
}
