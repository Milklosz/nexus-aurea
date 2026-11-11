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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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

  it("keeps native arrow editing in text controls and navigates from checkboxes", () => {
    const textInput = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    expect(shouldUseNativeDialogArrowKey(textInput)).toBe(true);
    expect(shouldUseNativeDialogArrowKey(checkbox)).toBe(false);
  });
});
