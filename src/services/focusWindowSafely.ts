type FocusableWindow = {
  unminimize: () => Promise<void>;
  setFocus: () => Promise<void>;
};

export async function focusWindowSafely(
  window: FocusableWindow,
  onBlocked: () => void,
  onFocused?: () => void,
): Promise<void> {
  try {
    await window.unminimize();
    await window.setFocus();
    onFocused?.();
  } catch {
    onBlocked();
  }
}
