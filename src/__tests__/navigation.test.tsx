// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTextEntryTarget, useNavigation } from "../hooks/useNavigation";

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
});
