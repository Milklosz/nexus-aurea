// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNavigation } from "../hooks/useNavigation";
import { activateHomeAction, moveWithinHomeActions } from "../services/homeActions";
import { focusHomeZone, homeZoneOfElement } from "../services/homeZones";

afterEach(cleanup);

function row() {
  const view = render(
    <>
      <nav className="home-actions">
        <button type="button" id="a">Szukaj</button>
        <button type="button" id="b" data-remembered="true">Pilot</button>
        <button type="button" id="c" onClick={() => { (window as unknown as { pressed?: string }).pressed = "c"; }}>Ustawienia</button>
      </nav>
      <nav className="lr-dock"><button type="button" id="tile">Netflix</button></nav>
    </>,
  );
  const get = (id: string) => view.container.querySelector<HTMLButtonElement>(`#${id}`)!;
  return { ...view, get };
}

describe("Home top-bar actions", () => {
  it("moves left/right inside the row without wrapping and consumes the move at the ends", () => {
    const { get } = row();
    get("a").focus();
    expect(moveWithinHomeActions(document.activeElement, 1)).toBe(true);
    expect(document.activeElement).toBe(get("b"));
    get("c").focus();
    expect(moveWithinHomeActions(document.activeElement, 1)).toBe(true);
    expect(document.activeElement).toBe(get("c"));
    get("a").focus();
    expect(moveWithinHomeActions(document.activeElement, -1)).toBe(true);
    expect(document.activeElement).toBe(get("a"));
  });

  it("does not claim moves that start in the dock or elsewhere", () => {
    const { get } = row();
    get("tile").focus();
    expect(moveWithinHomeActions(document.activeElement, 1)).toBe(false);
    expect(moveWithinHomeActions(null, 1)).toBe(false);
  });

  it("presses the focused action on confirm and leaves dock confirmation to the caller", () => {
    const { get } = row();
    get("c").focus();
    expect(activateHomeAction(document.activeElement)).toBe(true);
    expect((window as unknown as { pressed?: string }).pressed).toBe("c");
    get("tile").focus();
    expect(activateHomeAction(document.activeElement)).toBe(false);
  });

  it("is a vertical zone of its own: the dock and the actions are distinct zones", () => {
    const { get } = row();
    expect(homeZoneOfElement(get("a"))).toBe("controlCenter");
    expect(homeZoneOfElement(get("tile"))).toBe("dock");
  });

  it("enters the actions zone on the remembered action, falling back to the first", () => {
    const { get, container } = row();
    expect(focusHomeZone(document, "controlCenter")).toBe(true);
    expect(document.activeElement).toBe(get("b"));
    get("b").removeAttribute("data-remembered");
    expect(focusHomeZone(container, "controlCenter")).toBe(true);
    expect(document.activeElement).toBe(get("a"));
  });
});

describe("useNavigation with a Home actions row", () => {
  it("lets the horizontal zone handler consume left/right before the dock", () => {
    const onHorizontalZone = vi.fn(() => true);
    renderHook(() => useNavigation(3, () => {}, () => {}, { onHorizontalZone }));
    act(() => { fireEvent.keyDown(window, { key: "ArrowRight" }); });
    act(() => { fireEvent.keyDown(window, { key: "ArrowLeft" }); });
    expect(onHorizontalZone.mock.calls).toEqual([[1], [-1]]);
  });

  it("does not launch the selected dock app when the confirm key (X) is pressed on a top action", () => {
    const onActivate = vi.fn();
    const { get } = row();
    renderHook(() => useNavigation(3, onActivate, () => {}, {}));
    get("a").focus();
    const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    act(() => { get("a").dispatchEvent(event); });
    expect(onActivate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("still launches the selected dock app when the confirm key (X) is pressed elsewhere", () => {
    const onActivate = vi.fn();
    const { get } = row();
    renderHook(() => useNavigation(3, onActivate, () => {}, {}));
    get("tile").focus();
    act(() => { get("tile").dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true })); });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
