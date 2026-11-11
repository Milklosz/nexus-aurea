type FocusableWindow = {
  unminimize: () => Promise<void>;
  setFocus: () => Promise<void>;
};

export async function focusWindowSafely(
  window: FocusableWindow,
  onBlocked: () => void,
): Promise<void> {
  try {
    await window.unminimize();
    await window.setFocus();
  } catch {
    onBlocked();
  }
}
