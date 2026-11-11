// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIRECTION_KEYS,
  applyFocusState,
  directionFromKey,
  focusStateAttributes,
  isNavigationDirection,
  moveAureaFocus,
  registerAureaGrid,
  resolveGridIndex,
  unregisterAureaGrid,
  type AureaGrid,
} from "../services/aureaNavigation";

afterEach(() => {
  unregisterAureaGrid("test-grid");
  unregisterAureaGrid("first-grid");
  document.body.replaceChildren();
  delete document.body.dataset.focusSource;
  vi.clearAllMocks();
});

describe("resolveGridIndex — pure 2D row movement", () => {
  it("moves up/down a full row (columns)", () => {
    expect(resolveGridIndex(1, "down", 3, 6)).toBe(4);
    expect(resolveGridIndex(4, "up", 3, 6)).toBe(1);
    expect(resolveGridIndex(2, "down", 3, 6)).toBe(5);
    expect(resolveGridIndex(3, "up", 3, 6)).toBe(0);
  });

  it("clamps up/down at the grid bounds (including a partial last row)", () => {
    expect(resolveGridIndex(0, "up", 3, 5)).toBe(0);
    expect(resolveGridIndex(2, "down", 3, 5)).toBe(4);
    expect(resolveGridIndex(4, "down", 3, 5)).toBe(4);
  });

  it("keeps left/right inside the current row (never crosses rows)", () => {
    expect(resolveGridIndex(0, "left", 3, 6)).toBe(0);
    expect(resolveGridIndex(1, "left", 3, 6)).toBe(0);
    expect(resolveGridIndex(2, "right", 3, 6)).toBe(2);
    expect(resolveGridIndex(3, "left", 3, 6)).toBe(3);
    expect(resolveGridIndex(4, "right", 3, 6)).toBe(5);
    expect(resolveGridIndex(5, "right", 3, 6)).toBe(5);
  });

  it("always returns an integer in [0, count) — never NaN or negative", () => {
    expect(resolveGridIndex(0, "up", 3, 6)).toBe(0);
    expect(resolveGridIndex(5, "down", 3, 6)).toBe(5);
    expect(resolveGridIndex(-7, "right", 3, 6)).toBe(1);
    expect(resolveGridIndex(99, "left", 3, 6)).toBe(4);
    expect(resolveGridIndex(Number.NaN, "right", 3, 6)).toBe(1);
    expect(resolveGridIndex(0, "right", 3, 0)).toBe(0);
  });

  it("handles count=0 and columns<=0 defensively", () => {
    expect(resolveGridIndex(3, "left", 3, 0)).toBe(0);
    expect(resolveGridIndex(3, "down", 0, 6)).toBe(3);
    expect(resolveGridIndex(3, "down", -2, 6)).toBe(3);
  });
});

describe("direction mapping", () => {
  it("maps arrow keys to directions", () => {
    expect(DIRECTION_KEYS).toEqual({
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    });
    expect(directionFromKey("ArrowUp")).toBe("up");
    expect(directionFromKey("ArrowDown")).toBe("down");
    expect(directionFromKey("ArrowLeft")).toBe("left");
    expect(directionFromKey("ArrowRight")).toBe("right");
    expect(directionFromKey("x")).toBeNull();
    expect(directionFromKey("toString")).toBeNull();
  });

  it("narrows navigation directions", () => {
    expect(isNavigationDirection("up")).toBe(true);
    expect(isNavigationDirection("down")).toBe(true);
    expect(isNavigationDirection("left")).toBe(true);
    expect(isNavigationDirection("right")).toBe(true);
    expect(isNavigationDirection("select")).toBe(false);
    expect(isNavigationDirection("")).toBe(false);
  });
});

describe("focusStateAttributes / applyFocusState", () => {
  it("marks active/idle plus the source, aria-current only 'true' when active", () => {
    expect(focusStateAttributes(true, "remote")).toEqual({
      "data-aurea-focus": "active",
      "data-focus-source": "remote",
      "aria-current": "true",
    });
    expect(focusStateAttributes(false, "keyboard")).toEqual({
      "data-aurea-focus": "idle",
      "data-focus-source": "keyboard",
      "aria-current": "false",
    });
    expect(focusStateAttributes(false, "gamepad")["aria-current"]).toBe("false");
  });

  it("applies the attributes to a DOM element", () => {
    const element = document.createElement("button");
    applyFocusState(element, true, "gamepad");
    expect(element.getAttribute("data-aurea-focus")).toBe("active");
    expect(element.getAttribute("data-focus-source")).toBe("gamepad");
    expect(element.getAttribute("aria-current")).toBe("true");
  });
});

function makeGrid(overrides: Partial<AureaGrid> = {}): AureaGrid {
  const items = [0, 1, 2, 3].map(() => {
    const button = document.createElement("button");
    button.setAttribute("data-aurea-item", "");
    document.body.append(button);
    return button;
  });
  return {
    id: "test-grid",
    columns: 2,
    items,
    activeIndex: 0,
    setActiveIndex: vi.fn(),
    ...overrides,
  };
}

describe("grid registry + moveAureaFocus", () => {
  it("returns false when no grid is registered", () => {
    expect(moveAureaFocus("right")).toBe(false);
  });

  it("returns false for an empty grid", () => {
    registerAureaGrid(makeGrid({ items: [] }));
    expect(moveAureaFocus("right")).toBe(false);
  });

  it("resolves the next index, focuses it and refreshes focus state", () => {
    const grid = makeGrid({ columns: 2, activeIndex: 0 });
    registerAureaGrid(grid);

    expect(moveAureaFocus("down")).toBe(true);
    expect(grid.setActiveIndex).toHaveBeenCalledWith(2);
    expect(document.activeElement).toBe(grid.items[2]);
    expect(document.body.dataset.focusSource).toBe("remote");
    expect(grid.items[2].getAttribute("data-aurea-focus")).toBe("active");
    expect(grid.items[0].getAttribute("data-aurea-focus")).toBe("idle");
    expect(grid.items[2].getAttribute("data-focus-source")).toBe("remote");
    expect(grid.items[2].getAttribute("aria-current")).toBe("true");
  });

  it("keeps only one active grid (last registered wins) and unregisters cleanly", () => {
    const first = makeGrid({ id: "first-grid" });
    const second = makeGrid({ id: "test-grid" });
    registerAureaGrid(first);
    registerAureaGrid(second);

    expect(moveAureaFocus("right")).toBe(true);
    expect(second.setActiveIndex).toHaveBeenCalled();
    expect(first.setActiveIndex).not.toHaveBeenCalled();

    unregisterAureaGrid("test-grid");
    expect(moveAureaFocus("right")).toBe(false);
  });
});
