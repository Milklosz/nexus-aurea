// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeroPanel } from "../components/HeroPanel";

describe("neutral Grand Cinema home panel", () => {
  it("does not present fictional serial metadata as real content", () => {
    render(<HeroPanel />);
    expect(screen.getByRole("heading", { name: "Wybierz rozrywkę" })).toBeTruthy();
    expect(screen.getByText(/GRAND CINEMA/)).toBeTruthy();
    expect(screen.getByText(/Otwórz usługę z docka/)).toBeTruthy();
    expect(screen.queryByText(/Nocna zmiana|8 ODCINKÓW|DRAMAT/)).toBeNull();
  });
});

