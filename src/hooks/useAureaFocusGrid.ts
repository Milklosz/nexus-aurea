import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  applyFocusState,
  directionFromKey,
  registerAureaGrid,
  resolveGridIndex,
  unregisterAureaGrid,
  type AureaGrid,
} from "../services/aureaNavigation";

export interface AureaFocusGridOptions {
  columns: number;
  itemCount: number;
  containerRef: RefObject<HTMLElement | null>;
  id?: string;
}

export interface AureaFocusGridResult {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  focusItem: (index: number) => void;
}

/**
 * 2D focus grid for a container whose focusable children are marked with
 * `[data-aurea-item]`. Handles Arrow keys, keeps per-source focus attributes
 * in sync and registers the grid so iPhone Remote / gamepad input can move
 * focus through `moveAureaFocus`. No Tauri / global gamepad dependencies.
 */
export function useAureaFocusGrid(options: AureaFocusGridOptions): AureaFocusGridResult {
  const { columns, itemCount, containerRef, id = "aurea-focus-grid" } = options;
  const [activeIndex, setActiveIndexState] = useState(0);
  const activeIndexRef = useRef(0);

  const getItems = useCallback((): HTMLElement[] => {
    if (typeof document === "undefined") return [];
    const container = containerRef.current;
    if (!container) return [];
    return Array.from(container.querySelectorAll<HTMLElement>("[data-aurea-item]"));
  }, [containerRef]);

  // State-only updater: used by the registry so remote navigation can sync the
  // active index without forcing a keyboard focus source.
  const updateIndex = useCallback((index: number) => {
    activeIndexRef.current = index;
    setActiveIndexState(index);
  }, []);

  const focusItem = useCallback((index: number) => {
    if (typeof document === "undefined") return;
    const items = getItems();
    const count = items.length;
    const clamped = Math.min(Math.max(index, 0), Math.max(count - 1, 0));
    updateIndex(clamped);
    if (count === 0) return;
    items[clamped]?.focus({ preventScroll: true });
    if (document.body) document.body.dataset.focusSource = "keyboard";
    items.forEach((item, i) => applyFocusState(item, i === clamped, "keyboard"));
  }, [getItems, updateIndex]);

  // Public `setActiveIndex` focuses/activates the requested item.
  const setActiveIndex = focusItem;

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const direction = directionFromKey(event.key);
    if (!direction || typeof document === "undefined") return;
    const items = getItems();
    if (items.length === 0) return;
    event.preventDefault();
    const next = resolveGridIndex(activeIndexRef.current, direction, columns, items.length);
    focusItem(next);
  }, [columns, getItems, focusItem]);

  // Initialise visible focus attributes on freshly rendered items. Intentionally
  // does NOT depend on activeIndex: focus moves manage attributes themselves.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const items = getItems();
    items.forEach((item, i) => applyFocusState(item, i === activeIndexRef.current, "keyboard"));
  }, [getItems, itemCount, columns]);

  // Register the single active grid for 2D remote / gamepad navigation.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const grid: AureaGrid = {
      id,
      columns,
      get items() { return getItems(); },
      get activeIndex() { return activeIndexRef.current; },
      setActiveIndex: updateIndex,
    };
    registerAureaGrid(grid);
    return () => unregisterAureaGrid(id);
  }, [id, columns, getItems, updateIndex]);

  return { activeIndex, setActiveIndex, onKeyDown, focusItem };
}
