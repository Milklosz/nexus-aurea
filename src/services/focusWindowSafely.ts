export async function focusWindowSafely(
  focusWindow: () => void | Promise<void>,
  onBlocked: () => void,
): Promise<void> {
  try {
    await focusWindow();
  } catch {
    onBlocked();
  }
}
