import { withTimeout } from "./withTimeout";

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

export interface FocusWindowSafelyBoundedOptions {
  /** Hard cap on attempts — default 1, so the helper NEVER loops. */
  maxAttempts?: number;
  /** Per-attempt deadline; a hung native call cannot hang the caller. */
  timeoutMs?: number;
}

/**
 * S3.4 hardening of `focusWindowSafely`: the focus attempt is bounded by a
 * hard attempt cap (default 1 — recovery is exactly-once per trigger, never a
 * loop) and by a per-attempt timeout, so a stalled WebView2 focus call can
 * never hang shutdown or recovery. Blocked outcomes are reported exactly once
 * through `onBlocked`; successes exactly once through `onFocused`.
 */
export async function focusWindowSafelyBounded(
  window: FocusableWindow,
  onBlocked: () => void,
  onFocused?: () => void,
  options: FocusWindowSafelyBoundedOptions = {},
): Promise<void> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  let blocked = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const task = (async () => {
        await window.unminimize();
        await window.setFocus();
      })();
      if (timeoutMs > 0) {
        await withTimeout(task, timeoutMs, "Przywracanie fokusu okna");
      } else {
        await task;
      }
      onFocused?.();
      return;
    } catch {
      blocked = true;
    }
  }
  if (blocked) onBlocked();
}
