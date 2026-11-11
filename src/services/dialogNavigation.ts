export function getDialogNavigationControls(dialog: ParentNode): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled)",
  )).filter((control) => !control.closest("[hidden]") && !control.closest("[inert]"));
}

export function shouldUseNativeDialogArrowKey(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "image", "radio", "reset", "submit"].includes(target.type);
}
