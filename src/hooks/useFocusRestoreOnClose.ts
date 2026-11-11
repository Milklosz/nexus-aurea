import { useEffect, useRef } from "react";

export function useFocusRestoreOnClose(isOpen: boolean, restoreFocus: () => void, shouldRestore = true) {
  const wasOpen = useRef(false);

  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;

    wasOpen.current = false;
    if (!shouldRestore) return;

    const frame = window.requestAnimationFrame(restoreFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, restoreFocus, shouldRestore]);
}
