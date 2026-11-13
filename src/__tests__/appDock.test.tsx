// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDock } from "../components/AppDock";
import { streamingServices } from "../data/streamingServices";

vi.mock("../services/appManager", () => ({
  emptyAppManagerSnapshot: { windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null },
  getAppManagerStatus: vi.fn(async () => ({ windows: false, foregroundProcess: null, apps: [], games: [], gamesError: null })),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dock launch status", () => {
  it("announces when the selected service is being launched", () => {
    const buttonRefs = { current: [] } as RefObject<Array<HTMLButtonElement | null>>;
    render(
      <AppDock
        services={streamingServices}
        activeIndex={5}
        launchingIds={new Set(["steam"])}
        buttonRefs={buttonRefs}
        onFocus={vi.fn()}
        onActivate={vi.fn()}
        onUnavailable={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Otwórz Steam" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("uruchamianie w toku")).toBeTruthy();
    expect(screen.getByText("Uruchamiam Steam… Poczekaj chwilę.")).toBeTruthy();
  });
});
