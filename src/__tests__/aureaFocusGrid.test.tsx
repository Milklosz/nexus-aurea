// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAureaFocusGrid } from "../hooks/useAureaFocusGrid";
import { moveAureaFocus } from "../services/aureaNavigation";

function GridHarness({ columns = 2, count = 6, id = "harness-grid" }: { columns?: number; count?: number; id?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const grid = useAureaFocusGrid({ columns, itemCount: count, containerRef, id });
  return (
    <div ref={containerRef} onKeyDown={grid.onKeyDown} data-testid="grid">
      {Array.from({ length: count }, (_, i) => (
        <button key={i} type="button" data-aurea-item="">Item {i}</button>
      ))}
      <span data-testid="active">{grid.activeIndex}</span>
    </div>
  );
}

beforeEach(() => {
  delete document.body.dataset.focusSource;
});

afterEach(() => {
  cleanup();
  delete document.body.dataset.focusSource;
});

function gridItems(): HTMLElement[] {
  const container = document.querySelector<HTMLElement>('[data-testid="grid"]');
  return Array.from(container!.querySelectorAll<HTMLElement>("[data-aurea-item]"));
}

describe("useAureaFocusGrid", () => {
  it("moves DOM focus in 2D with arrow keys and keeps data attributes in sync", () => {
    render(<GridHarness />);
    const container = document.querySelector<HTMLElement>('[data-testid="grid"]')!;
    const items = gridItems();

    // Initial attributes are initialised on mount.
    expect(items[0].getAttribute("data-aurea-focus")).toBe("active");
    expect(items[1].getAttribute("data-aurea-focus")).toBe("idle");

    fireEvent.keyDown(container, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    expect(items[2].getAttribute("data-aurea-focus")).toBe("active");
    expect(items[0].getAttribute("data-aurea-focus")).toBe("idle");
    expect(items[2].getAttribute("data-focus-source")).toBe("keyboard");
    expect(items[2].getAttribute("aria-current")).toBe("true");
    expect(document.body.dataset.focusSource).toBe("keyboard");
    expect(document.querySelector('[data-testid="active"]')!.textContent).toBe("2");

    fireEvent.keyDown(container, { key: "ArrowRight" });
    expect(document.activeElement).toBe(items[3]);
    expect(items[3].getAttribute("data-aurea-focus")).toBe("active");
  });

  it("clamps left/right to the current row", () => {
    render(<GridHarness />);
    const container = document.querySelector<HTMLElement>('[data-testid="grid"]')!;
    const items = gridItems();
    fireEvent.keyDown(container, { key: "ArrowRight" }); // 0 -> 1
    fireEvent.keyDown(container, { key: "ArrowRight" }); // 1 -> stays at 1 (row end)
    expect(document.activeElement).toBe(items[1]);
  });

  it("registers the grid for remote navigation and cleans up on unmount", () => {
    const { unmount } = render(<GridHarness />);
    let moved = false;
    act(() => { moved = moveAureaFocus("right"); });
    expect(moved).toBe(true);
    expect(document.body.dataset.focusSource).toBe("remote");

    unmount();
    expect(moveAureaFocus("right")).toBe(false);
  });
});
