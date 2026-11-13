// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "../components/StatusBar";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StatusBar owns its clock", () => {
  it("renders the Warsaw time and advances on its own timer", () => {
    render(<StatusBar weatherLabel="5°C" weatherTitle="Zabrze" />);
    const clock = document.querySelector("time.clock");
    expect(clock?.textContent).toBe("11:00");

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(document.querySelector("time.clock")?.textContent).toBe("11:01");
    expect(screen.getByLabelText("Godzina 11:01")).toBeTruthy();
  });
});
