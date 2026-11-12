// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualKeyboard } from "../components/VirtualKeyboard";
import { useVirtualKeyboard, type VirtualKeyboardController } from "../hooks/useVirtualKeyboard";

const fallbackFocus = vi.fn();
let latest: VirtualKeyboardController | null = null;

function kb(): VirtualKeyboardController {
  if (!latest) throw new Error("harness not rendered");
  return latest;
}

function Harness({ showName = true }: { showName?: boolean }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const keyboard = useVirtualKeyboard({ fallbackFocus });
  latest = keyboard;
  return <>
    <button type="button">Przed</button>
    {showName && <input aria-label="Nazwa" value={name} onChange={(event) => setName(event.target.value)} />}
    <input aria-label="Kod" maxLength={3} value={code} onChange={(event) => setCode(event.target.value)} />
    <input aria-label="Hasło" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} />
    <input aria-label="Tylko odczyt" readOnly value="stała" onChange={() => undefined} />
    <output data-testid="name">{name}</output>
    <VirtualKeyboard controller={keyboard} />
  </>;
}

function key(row: number, col: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.vkb [data-vkb-row="${row}"][data-vkb-col="${col}"]`);
  if (!element) throw new Error(`no key ${row}/${col}`);
  return element;
}

function dialog(): HTMLDialogElement {
  const element = document.querySelector<HTMLDialogElement>("dialog.vkb");
  if (!element) throw new Error("keyboard dialog missing");
  return element;
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function openOn(label: string): boolean {
  let opened = false;
  act(() => {
    opened = kb().open(field(label));
  });
  return opened;
}

beforeEach(() => {
  // jsdom has no modal dialog support; mirror the browser's open/close attribute behaviour.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
  fallbackFocus.mockClear();
});

afterEach(() => {
  cleanup();
  latest = null;
});

describe("on-screen keyboard: safe open and close without losing focus", () => {
  it("opens for a text field and moves focus onto a key", () => {
    render(<Harness />);
    field("Nazwa").focus();
    expect(openOn("Nazwa")).toBe(true);
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(key(1, 0));
  });

  it("Confirm types the focused key through a normal input event", () => {
    render(<Harness />);
    openOn("Nazwa");
    act(() => kb().activate()); // q
    act(() => kb().move("right")); // w
    act(() => kb().activate());
    expect(field("Nazwa").value).toBe("qw");
    expect(screen.getByTestId("name").textContent).toBe("qw");
    expect(document.activeElement).toBe(key(1, 1));
  });

  it("Back restores the text from before the keyboard opened and returns focus to the field", () => {
    render(<Harness />);
    openOn("Nazwa");
    act(() => kb().activate()); // q
    act(() => kb().cancel());
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(field("Nazwa").value).toBe("");
    expect(document.activeElement).toBe(field("Nazwa"));
    expect(fallbackFocus).not.toHaveBeenCalled();
  });

  it("Gotowe keeps the typed text and returns focus to the field", () => {
    render(<Harness />);
    openOn("Nazwa");
    act(() => kb().activate()); // q
    act(() => kb().activateAt(5, 3)); // Gotowe
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(field("Nazwa").value).toBe("q");
    expect(document.activeElement).toBe(field("Nazwa"));
  });

  it("Home closes the keyboard, keeps the text and hands focus to the Home flow", () => {
    render(<Harness />);
    openOn("Nazwa");
    act(() => kb().activate()); // q
    act(() => kb().closeForHome());
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(field("Nazwa").value).toBe("q");
    expect(document.activeElement).not.toBe(field("Nazwa"));
    expect(fallbackFocus).toHaveBeenCalledTimes(1);
  });

  it("physical keys type, move, delete and cancel while the keyboard is open", () => {
    render(<Harness />);
    openOn("Nazwa");
    fireEvent.keyDown(document.activeElement!, { key: "x" });
    expect(field("Nazwa").value).toBe("x");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(key(1, 1));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(field("Nazwa").value).toBe("xw");
    fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
    expect(field("Nazwa").value).toBe("x");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(field("Nazwa").value).toBe("");
    expect(document.activeElement).toBe(field("Nazwa"));
  });

  it("Tab never moves focus out of the keyboard", () => {
    render(<Harness />);
    openOn("Nazwa");
    const proceed = fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(proceed).toBe(false); // default was prevented
    expect(document.activeElement).toBe(key(1, 0));
  });

  it("keys never reach window-level shortcuts while the keyboard is open", () => {
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    try {
      render(<Harness />);
      openOn("Nazwa");
      fireEvent.keyDown(key(1, 0), { key: "F2" });
      fireEvent.keyDown(key(1, 0), { key: "ArrowDown" });
      expect(shortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", shortcut);
    }
  });

  it("refuses password, read-only and second opens", () => {
    render(<Harness />);
    expect(openOn("Hasło")).toBe(false);
    expect(openOn("Tylko odczyt")).toBe(false);
    expect(openOn("Nazwa")).toBe(true);
    expect(openOn("Kod")).toBe(false);
    expect(dialog().hasAttribute("open")).toBe(true);
  });

  it("respects the field's own maximum length", () => {
    render(<Harness />);
    openOn("Kod");
    for (let press = 0; press < 4; press += 1) act(() => kb().activate()); // always q
    expect(field("Kod").value).toBe("qqq");
  });

  it("if the field disappears while the keyboard is open, focus goes to the fallback", () => {
    const { rerender } = render(<Harness />);
    openOn("Nazwa");
    rerender(<Harness showName={false} />);
    act(() => kb().cancel());
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(fallbackFocus).toHaveBeenCalledTimes(1);
  });
});
