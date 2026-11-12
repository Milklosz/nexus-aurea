import { useCallback, useEffect, useRef, useState } from "react";
import { registerAureaGrid, resolveGridIndex, unregisterAureaGrid, type AureaGrid } from "../services/aureaNavigation";

export function isTextEntryTarget(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && (
    target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)
  );
}

export interface UseNavigationOptions {
  /** When provided, ArrowUp/ArrowDown move a full 2D row instead of the quick-settings shortcut. */
  columns?: number;
  /** When provided, registers this navigation as an AUREA grid (for 2D remote / gamepad focus). */
  gridId?: string;
}

export function useNavigation(
  count: number,
  onActivate: () => void,
  onMenu: () => void,
  options?: UseNavigationOptions,
) {
  const columns = options?.columns;
  const gridId = options?.gridId;
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
      // Guarded: this hook can be imported in a DOM-less (Node) environment.
      if (typeof document === "undefined") return;
      if (document.body) document.body.dataset.focusSource = "keyboard";
      if (document.querySelector("dialog[open]")) return;
      const target = event.target;
      if (isTextEntryTarget(target)) return;

      if (event.key === "ArrowUp") {
        if (columns !== undefined) {
          event.preventDefault();
          focusApp(resolveGridIndex(activeIndexRef.current, "up", columns, count));
        } else {
          const quickSettings = document.querySelector<HTMLButtonElement>(".quick-settings-trigger");
          if (quickSettings && target !== quickSettings) {
            event.preventDefault();
            quickSettings.focus({ preventScroll: true });
          }
        }
      } else if (event.key === "ArrowDown" && (
        columns !== undefined ||
        (target instanceof HTMLElement && target.closest(".quick-settings-trigger"))
      )) {
        event.preventDefault();
        focusApp(columns !== undefined
          ? resolveGridIndex(activeIndexRef.current, "down", columns, count)
          : activeIndexRef.current);
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
  }, [focusApp, columns, count]);

  // Optional: register this navigation as the active AUREA grid. Legacy callers
  // (no gridId) never register, so their behaviour is exactly unchanged.
  useEffect(() => {
    if (gridId === undefined || typeof document === "undefined") return;
    const grid: AureaGrid = {
      id: gridId,
      columns: columns ?? count,
      get items() {
        return buttonRefs.current.filter((element): element is HTMLButtonElement => element != null);
      },
      get activeIndex() { return activeIndexRef.current; },
      setActiveIndex: noteFocus,
    };
    registerAureaGrid(grid);
    return () => unregisterAureaGrid(gridId);
  }, [gridId, columns, count, noteFocus]);

  const moveApp = useCallback((delta: number) => focusApp(activeIndexRef.current + delta), [focusApp]);

  return {
    moveApp,
    activeIndex,
    buttonRefs,
    focusApp,
    noteFocus,
  };
}
