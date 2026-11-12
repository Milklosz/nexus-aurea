// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTextEntryTarget, useNavigation } from "../hooks/useNavigation";
import { getDialogNavigationControls, shouldUseNativeDialogArrowKey } from "../services/dialogNavigation";

const activate = vi.fn();
const openMenu = vi.fn();

function NavigationHarness() {
  const navigation = useNavigation(3, activate, openMenu);
  return <>
    <button className="quick-settings-trigger" type="button">Control Center</button>
    <nav>
      {[0, 1, 2].map((index) => <button
        key={index}
        ref={(element) => { navigation.buttonRefs.current[index] = element; }}
        type="button"
      >App {index + 1}</button>)}
    </nav>
  </>;
}

function GridNavigationHarness({ columns = 3, count = 6 }: { columns?: number; count?: number }) {
  const navigation = useNavigation(count, activate, openMenu, { columns });
  return (
    <nav>
      {Array.from({ length: count }, (_, index) => <button
        key={index}
        ref={(element) => { navigation.buttonRefs.current[index] = element; }}
        type="button"
      >App {index + 1}</button>)}
    </nav>
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); delete document.body.dataset.focusSource; });

describe("TV home navigation", () => {
  it("moves through the dock and between the dock and quick settings with arrows", async () => {
    render(<NavigationHarness />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 1" })));
    act(() => { fireEvent.keyDown(window, { key: "ArrowRight" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 2" }));
    act(() => { fireEvent.keyDown(window, { key: "ArrowUp" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Control Center" }));
    act(() => { fireEvent.keyDown(screen.getByRole("button", { name: "Control Center" }), { key: "ArrowDown" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 2" }));
  });

  it("leaves Backspace available for text editing while identifying other targets", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const button = document.createElement("button");

    expect(isTextEntryTarget(input)).toBe(true);
    expect(isTextEntryTarget(textarea)).toBe(true);
    expect(isTextEntryTarget(button)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });

  it("includes enabled form controls in dialog navigation and skips hidden controls", () => {
    const dialog = document.createElement("dialog");
    const action = document.createElement("button");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const hidden = document.createElement("div");
    hidden.hidden = true;
    hidden.append(document.createElement("button"));
    const disabled = document.createElement("button");
    disabled.disabled = true;
    const hiddenInput = document.createElement("input");
    hiddenInput.type = "hidden";
    dialog.append(action, checkbox, hidden, disabled, hiddenInput);

    expect(getDialogNavigationControls(dialog)).toEqual([action, checkbox]);
  });

  it("skips controls inside aria-hidden dialog subtrees", () => {
    const dialog = document.createElement("dialog");
    const visible = document.createElement("button");
    const hiddenRegion = document.createElement("section");
    hiddenRegion.setAttribute("aria-hidden", "true");
    hiddenRegion.append(document.createElement("button"));
    dialog.append(visible, hiddenRegion);

    expect(getDialogNavigationControls(dialog)).toEqual([visible]);
  });

  it("skips dialog controls hidden by CSS layout and visibility", () => {
    const dialog = document.createElement("dialog");
    const visible = document.createElement("button");
    const displayNoneRegion = document.createElement("section");
    displayNoneRegion.style.display = "none";
    displayNoneRegion.append(document.createElement("button"));
    const hiddenRegion = document.createElement("section");
    hiddenRegion.style.visibility = "hidden";
    hiddenRegion.append(document.createElement("button"));
    dialog.append(visible, displayNoneRegion, hiddenRegion);

    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const target = element as HTMLElement;
      let visibility = target.style.visibility;
      for (let ancestor = target.parentElement; !visibility && ancestor; ancestor = ancestor.parentElement) {
        visibility = ancestor.style.visibility;
      }
      return { display: target.style.display, visibility } as CSSStyleDeclaration;
    });
    try {
      expect(getDialogNavigationControls(dialog)).toEqual([visible]);
    } finally {
      styleSpy.mockRestore();
    }
  });

  it("keeps native arrow editing in text controls and navigates from checkboxes", () => {
    const textInput = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    expect(shouldUseNativeDialogArrowKey(textInput)).toBe(true);
    expect(shouldUseNativeDialogArrowKey(checkbox)).toBe(false);
  });
});

describe("useNavigation — optional 2D columns mode", () => {
  it("moves a full row with ArrowDown/ArrowUp instead of the quick-settings shortcut", async () => {
    render(<GridNavigationHarness columns={3} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 1" })));
    act(() => { fireEvent.keyDown(window, { key: "ArrowDown" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 4" }));
    act(() => { fireEvent.keyDown(window, { key: "ArrowUp" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 1" }));
  });

  it("clamps vertical 2D movement at the first and last row", async () => {
    render(<GridNavigationHarness columns={3} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 1" })));
    act(() => { fireEvent.keyDown(window, { key: "ArrowUp" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 1" }));
    act(() => { fireEvent.keyDown(window, { key: "ArrowDown" }); });
    act(() => { fireEvent.keyDown(window, { key: "ArrowDown" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 6" }));
  });

  it("keeps left/right using focusApp and flags the keyboard focus source", async () => {
    render(<GridNavigationHarness columns={3} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 1" })));
    act(() => { fireEvent.keyDown(window, { key: "ArrowRight" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "App 2" }));
    expect(document.body.dataset.focusSource).toBe("keyboard");
  });
});
