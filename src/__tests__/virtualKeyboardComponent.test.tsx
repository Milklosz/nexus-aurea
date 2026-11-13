// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualKeyboard } from "../components/VirtualKeyboard";
import { useVirtualKeyboardHost } from "../hooks/useVirtualKeyboardHost";
import type { KeyboardSink } from "../services/virtualKeyboardRouting";

function makeField(value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("aria-label", "Nazwa profilu");
  input.value = value;
  document.body.appendChild(input);
  return input;
}

function mountKeyboard(field: HTMLInputElement) {
  const sinkRef: { current: KeyboardSink | null } = { current: null };
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(<VirtualKeyboard field={field} sinkRef={sinkRef} onDone={onDone} onCancel={onCancel} />);
  return { sinkRef, onDone, onCancel };
}

function pad(sinkRef: { current: KeyboardSink | null }): KeyboardSink {
  const current = sinkRef.current;
  if (!current) throw new Error("keyboard sink is not registered");
  return current;
}

function preview(): string {
  return screen.getByLabelText("Wpisany tekst").textContent ?? "";
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

describe("VirtualKeyboard", () => {
  let field: HTMLInputElement;

  beforeEach(() => {
    field = makeField("ab");
  });

  afterEach(() => {
    cleanup();
    field.remove();
  });

  it("opens as a modal dialog showing the field's current value and focuses the first key", () => {
    mountKeyboard(field);
    const dialog = document.querySelector("dialog.virtual-keyboard");
    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(preview()).toBe("ab");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "q" }));
  });

  it("moves the cursor through the pad sink and types the focused key on select", () => {
    const { sinkRef, onDone } = mountKeyboard(field);
    act(() => pad(sinkRef)({ kind: "move", direction: "right" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "w" }));
    act(() => pad(sinkRef)({ kind: "select" }));
    expect(preview()).toBe("abw");
    expect(onDone).not.toHaveBeenCalled();
    // The field itself stays untouched until the draft is committed.
    expect(field.value).toBe("ab");
  });

  it("calls onDone with the draft on Enter, and leaves the write to the host", () => {
    const { onDone } = mountKeyboard(field);
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onDone).toHaveBeenCalledWith("ab");
    expect(field.value).toBe("ab");
  });

  it("cancels on back or Escape without calling onDone", () => {
    const { sinkRef, onCancel, onDone } = mountKeyboard(field);
    act(() => pad(sinkRef)({ kind: "select" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDone).not.toHaveBeenCalled();
    expect(field.value).toBe("ab");
  });

  it("types physical characters straight into the draft, including x", () => {
    mountKeyboard(field);
    fireEvent.keyDown(document.body, { key: "x" });
    fireEvent.keyDown(document.body, { key: "ż" });
    expect(preview()).toBe("abxż");
  });

  it("deletes with Backspace and does nothing on empty text", () => {
    field.value = "";
    mountKeyboard(field);
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(preview()).toContain("Pole jest puste");
    fireEvent.keyDown(document.body, { key: "a" });
    expect(preview()).toBe("a");
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(preview()).toContain("Pole jest puste");
  });

  it("moves with the arrow keys on a physical keyboard", () => {
    mountKeyboard(field);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "w" }));
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "s" }));
  });

  it("swallows physical keys so the home screen underneath never reacts", () => {
    mountKeyboard(field);
    const homeListener = vi.fn();
    window.addEventListener("keydown", homeListener);
    try {
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      fireEvent.keyDown(document.body, { key: "a" });
      expect(homeListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", homeListener);
    }
  });

  it("lets OS and browser shortcuts through untouched", () => {
    mountKeyboard(field);
    const homeListener = vi.fn();
    window.addEventListener("keydown", homeListener);
    try {
      fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
      expect(homeListener).toHaveBeenCalledOnce();
      expect(preview()).toBe("ab");
    } finally {
      window.removeEventListener("keydown", homeListener);
    }
  });

  it("types a clicked letter and commits on a clicked Done key", () => {
    const { onDone } = mountKeyboard(field);
    fireEvent.click(screen.getByRole("button", { name: "q" }));
    expect(preview()).toBe("abq");
    fireEvent.click(screen.getByRole("button", { name: "Gotowe, zapisz tekst" }));
    expect(onDone).toHaveBeenCalledWith("abq");
  });

  it("removes its sink and key listener on unmount", () => {
    const { sinkRef } = mountKeyboard(field);
    expect(sinkRef.current).not.toBeNull();
    cleanup();
    expect(sinkRef.current).toBeNull();
    const homeListener = vi.fn();
    window.addEventListener("keydown", homeListener);
    fireEvent.keyDown(document.body, { key: "a" });
    window.removeEventListener("keydown", homeListener);
    expect(homeListener).toHaveBeenCalledOnce();
  });
});

describe("useVirtualKeyboardHost", () => {
  it("opens one field at a time and returns focus to it after commit", async () => {
    const first = makeField("one");
    const second = makeField("two");
    const { result } = renderHook(() => useVirtualKeyboardHost());

    act(() => result.current.openFor(first));
    act(() => result.current.openFor(second));
    expect(result.current.field).toBe(first);

    act(() => result.current.commit("saved"));
    expect(first.value).toBe("saved");
    expect(second.value).toBe("two");
    expect(result.current.field).toBeNull();

    await nextFrame();
    expect(document.activeElement).toBe(first);
    first.remove();
    second.remove();
  });

  it("cancel closes without writing the field", () => {
    const field = makeField("keep");
    const { result } = renderHook(() => useVirtualKeyboardHost());
    act(() => result.current.openFor(field));
    act(() => result.current.cancel());
    expect(field.value).toBe("keep");
    expect(result.current.field).toBeNull();
    field.remove();
  });
});
