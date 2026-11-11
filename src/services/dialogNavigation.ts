export function getDialogNavigationControls(dialog: ParentNode): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled)",
  )).filter((control) => !control.closest("[hidden], [inert], [aria-hidden='true']") && !isHiddenByCss(control));
}

function isHiddenByCss(control: HTMLElement): boolean {
  for (let ancestor: HTMLElement | null = control; ancestor; ancestor = ancestor.parentElement) {
    if (window.getComputedStyle(ancestor).display === "none") return true;
  }
  const visibility = window.getComputedStyle(control).visibility;
  return visibility === "hidden" || visibility === "collapse";
}

export function shouldUseNativeDialogArrowKey(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "image", "radio", "reset", "submit"].includes(target.type);
}
