import { useEffect, useRef } from "react";

export function useFocusRestoreOnClose(isOpen: boolean, restoreFocus: () => void) {
  const wasOpen = useRef(false);

  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;

    wasOpen.current = false;
    const frame = window.requestAnimationFrame(restoreFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, restoreFocus]);
}
