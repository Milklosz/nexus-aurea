// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { NavIntent, NavIntentHandlers } from "../services/navIntent";
import {
  offerIntentToKeyboard,
  TEXT_ENTRY_ATTRIBUTE,
  textEntryTargetFromFocus,
  withKeyboardFirst,
} from "../services/virtualKeyboardRouting";

function handlers(): NavIntentHandlers & Record<keyof NavIntentHandlers, ReturnType<typeof vi.fn>> {
  return {
    move: vi.fn(),
    select: vi.fn(),
    back: vi.fn(),
    menu: vi.fn(),
    home: vi.fn(),
  } as NavIntentHandlers & Record<keyof NavIntentHandlers, ReturnType<typeof vi.fn>>;
}

describe("offerIntentToKeyboard", () => {
  it("lets the home screen handle everything when no keyboard is open", () => {
    expect(offerIntentToKeyboard({ kind: "select" }, null)).toBe(false);
  });

  it("gives select, move and back to an open keyboard", () => {
    const sink = vi.fn();
    const intents: NavIntent[] = [
      { kind: "select" },
      { kind: "move", direction: "left" },
      { kind: "back" },
    ];
    for (const intent of intents) expect(offerIntentToKeyboard(intent, sink)).toBe(true);
    expect(sink.mock.calls).toEqual(intents.map((intent) => [intent]));
  });

  it("ignores menu while typing, so Control Center cannot open under the keyboard", () => {
    const sink = vi.fn();
    expect(offerIntentToKeyboard({ kind: "menu" }, sink)).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  it("cancels the keyboard on home and then lets the normal home action run", () => {
    const sink = vi.fn();
    expect(offerIntentToKeyboard({ kind: "home" }, sink)).toBe(false);
    expect(sink).toHaveBeenCalledWith({ kind: "back" });
  });
});

describe("withKeyboardFirst", () => {
  it("routes controller intents to the keyboard while it is open", () => {
    const home = handlers();
    const sink = vi.fn();
    const wrapped = withKeyboardFirst(home, () => sink);

    wrapped.move("right");
    wrapped.select();
    wrapped.back();
    wrapped.menu();

    expect(home.move).not.toHaveBeenCalled();
    expect(home.select).not.toHaveBeenCalled();
    expect(home.back).not.toHaveBeenCalled();
    expect(home.menu).not.toHaveBeenCalled();
    expect(sink.mock.calls).toEqual([
      [{ kind: "move", direction: "right" }],
      [{ kind: "select" }],
      [{ kind: "back" }],
    ]);
  });

  it("falls through to the home handlers when no keyboard is open", () => {
    const home = handlers();
    const wrapped = withKeyboardFirst(home, () => null);
    wrapped.move("up");
    wrapped.select();
    wrapped.home();
    expect(home.move).toHaveBeenCalledWith("up");
    expect(home.select).toHaveBeenCalledOnce();
    expect(home.home).toHaveBeenCalledOnce();
  });

  it("runs the home action after the keyboard is cancelled by home", () => {
    const home = handlers();
    const sink = vi.fn();
    withKeyboardFirst(home, () => sink).home();
    expect(sink).toHaveBeenCalledWith({ kind: "back" });
    expect(home.home).toHaveBeenCalledOnce();
  });
});

describe("textEntryTargetFromFocus", () => {
  function field(markup: string): Element {
    const host = document.createElement("div");
    host.innerHTML = markup;
    document.body.appendChild(host);
    return host.firstElementChild as Element;
  }

  it("accepts a VELORA text field that carries the marker", () => {
    const input = field(`<input ${TEXT_ENTRY_ATTRIBUTE} type="text" aria-label="Nazwa">`);
    expect(textEntryTargetFromFocus(input)).toBe(input);
  });

  it("accepts a marked textarea", () => {
    const area = field(`<textarea ${TEXT_ENTRY_ATTRIBUTE}></textarea>`);
    expect(textEntryTargetFromFocus(area)).toBe(area);
  });

  it("never captures a field without the marker, including external-looking logins", () => {
    const login = field(`<input type="text" aria-label="Login do serwisu">`);
    const email = field(`<input type="email">`);
    expect(textEntryTargetFromFocus(login)).toBeNull();
    expect(textEntryTargetFromFocus(email)).toBeNull();
  });

  it("never captures a password field, even when marked", () => {
    const password = field(`<input ${TEXT_ENTRY_ATTRIBUTE} type="password">`);
    expect(textEntryTargetFromFocus(password)).toBeNull();
  });

  it("never captures a read-only or disabled marked field", () => {
    const readOnly = field(`<input ${TEXT_ENTRY_ATTRIBUTE} readonly>`);
    const disabled = field(`<input ${TEXT_ENTRY_ATTRIBUTE} disabled>`);
    expect(textEntryTargetFromFocus(readOnly)).toBeNull();
    expect(textEntryTargetFromFocus(disabled)).toBeNull();
  });

  it("returns null for a button or no focus at all", () => {
    const button = field(`<button ${TEXT_ENTRY_ATTRIBUTE}>x</button>`);
    expect(textEntryTargetFromFocus(button)).toBeNull();
    expect(textEntryTargetFromFocus(null)).toBeNull();
  });
});
