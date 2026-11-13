// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSearchPanel } from "../components/AppSearchPanel";
import type { SearchEntry } from "../services/appSearch";
import { TEXT_ENTRY_ATTRIBUTE, textEntryTargetFromFocus } from "../services/virtualKeyboardRouting";

const entries: SearchEntry[] = [
  { id: "tile:netflix", title: "Netflix", group: "Streaming", keywords: ["NETFLIX", "wideo film serial"] },
  { id: "tile:disney", title: "Disney+", group: "Streaming", keywords: ["DISNEY+", "wideo film serial"] },
  { id: "tile:steam", title: "Steam", group: "Aplikacja", keywords: ["STEAM", "muzyka aplikacja"] },
];

function results(): string[] {
  return screen.queryAllByRole("button").map((button) => button.textContent ?? "");
}

describe("AppSearchPanel", () => {
  afterEach(() => cleanup());

  it("lists every entry before anything is typed", () => {
    render(<AppSearchPanel entries={entries} onLaunch={vi.fn()} />);
    expect(results()).toEqual(["Netflix" + "Streaming", "Disney+" + "Streaming", "Steam" + "Aplikacja"]);
    expect(screen.getByRole("status").textContent).toBe("Wyniki: 3");
  });

  it("filters as the query changes", () => {
    render(<AppSearchPanel entries={entries} onLaunch={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Szukaj aplikacji"), { target: { value: "dis" } });
    expect(results()).toEqual(["Disney+Streaming"]);
    expect(screen.getByRole("status").textContent).toBe("Wyniki: 1");
  });

  it("shows an empty state that names the query", () => {
    render(<AppSearchPanel entries={entries} onLaunch={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Szukaj aplikacji"), { target: { value: "xyz" } });
    expect(results()).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("Brak wyników dla „xyz”.");
  });

  it("launches the chosen result by its entry id", () => {
    const onLaunch = vi.fn();
    render(<AppSearchPanel entries={entries} onLaunch={onLaunch} />);
    fireEvent.change(screen.getByLabelText("Szukaj aplikacji"), { target: { value: "steam" } });
    fireEvent.click(screen.getByRole("button", { name: /Steam/ }));
    expect(onLaunch).toHaveBeenCalledWith("tile:steam");
  });

  it("marks its field as VELORA text entry, so select opens the on-screen keyboard", () => {
    render(<AppSearchPanel entries={entries} onLaunch={vi.fn()} />);
    const field = screen.getByLabelText("Szukaj aplikacji");
    expect(field.hasAttribute(TEXT_ENTRY_ATTRIBUTE)).toBe(true);
    expect(textEntryTargetFromFocus(field)).toBe(field);
  });

  it("allows the pilot to reach the field and every result", () => {
    render(<AppSearchPanel entries={entries} onLaunch={vi.fn()} />);
    expect(screen.getByLabelText("Szukaj aplikacji").hasAttribute("data-remote-allow")).toBe(true);
    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("data-remote-allow")).toBe(true);
    }
  });
});
