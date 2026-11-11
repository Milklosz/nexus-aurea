import { useCallback, useEffect, useRef, useState } from "react";

export function useNavigation(count: number, onActivate: () => void, onMenu: () => void) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activateRef = useRef(onActivate);
  const menuRef = useRef(onMenu);

  useEffect(() => {
    activateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    menuRef.current = onMenu;
  }, [onMenu]);

  const focusApp = useCallback(
    (index: number) => {
      const nextIndex = ((index % count) + count) % count;
      activeIndexRef.current = nextIndex;
      setActiveIndex(nextIndex);
      buttonRefs.current[nextIndex]?.focus({ preventScroll: true });
    },
    [count],
  );

  const noteFocus = useCallback((index: number) => {
    activeIndexRef.current = index;
    setActiveIndex(index);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
      ) {
        return;
      }

      if (event.key === "ArrowUp") {
        const quickSettings = document.querySelector<HTMLButtonElement>(".quick-settings-trigger");
        if (quickSettings && target !== quickSettings) {
          event.preventDefault();
          quickSettings.focus({ preventScroll: true });
        }
      } else if (event.key === "ArrowDown" && target instanceof HTMLElement && target.closest(".quick-settings-trigger")) {
        event.preventDefault();
        focusApp(activeIndexRef.current);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        focusApp(activeIndexRef.current + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusApp(activeIndexRef.current - 1);
      } else if (event.key.toLowerCase() === "x") {
        event.preventDefault();
        activateRef.current();
      } else if (event.key === "F2") {
        menuRef.current();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    const initialFocus = window.requestAnimationFrame(() => focusApp(0));
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.cancelAnimationFrame(initialFocus);
    };
  }, [focusApp]);

  const moveApp = useCallback((delta: number) => focusApp(activeIndexRef.current + delta), [focusApp]);

  return {
    moveApp,
    activeIndex,
    buttonRefs,
    focusApp,
    noteFocus,
  };
}
