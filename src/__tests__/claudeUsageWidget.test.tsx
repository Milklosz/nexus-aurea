// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeUsageWidget } from "../components/living-room/ClaudeUsageWidget";
import { activateHomeAction, closeHomeDisclosure, moveWithinHomeActions } from "../services/homeActions";
import { unavailableClaudeUsage, type ClaudeUsageSnapshot } from "../services/claudeUsage";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../services/claudeUsage", async (original) => ({
  ...await original<typeof import("../services/claudeUsage")>(), getClaudeUsage: mocks.read,
}));

// Supplied screenshot example; fixtures only, never production defaults.
const fixture: ClaudeUsageSnapshot = {
  ...unavailableClaudeUsage, status: "available", fetchedAt: Date.parse("2026-11-15T12:00:00Z"), errorCode: null,
  limits: [
    { categoryId: "session", categoryLabel: "Current session", usedPercent: 0, resetAt: null, resetTimezone: null, resetText: null },
    { categoryId: "week", categoryLabel: "Current week (all models)", usedPercent: 79, resetAt: null, resetTimezone: "Europe/Warsaw", resetText: "Nov 18, 2:59pm (Europe/Warsaw)" },
    { categoryId: "fable", categoryLabel: "Current week (Fable)", usedPercent: 19, resetAt: null, resetTimezone: "Europe/Warsaw", resetText: "Nov 18, 2:59pm (Europe/Warsaw)" },
  ],
};
beforeEach(() => { mocks.read.mockReset(); mocks.read.mockResolvedValue(unavailableClaudeUsage); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const expand = () => fireEvent.click(screen.getByRole("button", { name: /Claude Usage/ }));

describe("Claude Usage widget", () => {
  it("loads asynchronously without showing invented percentages", async () => {
    let resolve!: (value: ClaudeUsageSnapshot) => void;
    mocks.read.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<ClaudeUsageWidget />); expand();
    expect(screen.getByText("Sprawdzanie Claude Code…")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    await act(async () => resolve(unavailableClaudeUsage));
    expect(screen.getByText("Automatyczny odczyt /usage jest niedostępny.")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });
  it.each([
    ["notInstalled", "Claude Code nie jest zainstalowany."],
    ["notAuthenticated", "Zaloguj się w Claude Code."],
    ["usageUnavailable", "Automatyczny odczyt /usage jest niedostępny."],
    ["parserIncompatible", "Format danych Claude Code jest niezgodny."],
    ["timeout", "Claude Code nie odpowiedział na czas."],
    ["awaitingUsage", "Uruchom Claude Code z integracją status line i wykonaj pierwsze zapytanie."],
  ] as const)("explains %s", async (errorCode, message) => {
    mocks.read.mockResolvedValue({ ...unavailableClaudeUsage, errorCode });
    render(<ClaudeUsageWidget />); expand();
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });
  it("displays actual zero, dynamic categories, reset text and updated time", async () => {
    mocks.read.mockResolvedValue(fixture);
    render(<ClaudeUsageWidget />); expand();
    expect(await screen.findByText("79%")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy(); expect(screen.getByText("Weekly · Fable")).toBeTruthy();
    expect(screen.getAllByRole("meter")).toHaveLength(3);
    expect(screen.getAllByText(/Reset — Nov 18, 2:59pm/)).toHaveLength(2);
    expect(screen.getByText(/Updated —/)).toBeTruthy();
  });
  it("labels cached data stale and preserves it if a later read fails", async () => {
    mocks.read.mockResolvedValueOnce(fixture).mockResolvedValueOnce(unavailableClaudeUsage);
    render(<ClaudeUsageWidget />); expand(); await screen.findByText("79%");
    fireEvent.click(screen.getByRole("button", { name: "Odśwież Claude Usage" }));
    expect(await screen.findByText(/Dane nieaktualne/)).toBeTruthy();
    expect(screen.getByText("79%")).toBeTruthy(); expect(screen.getByText(/Updated —/)).toBeTruthy();
  });
  it("uses Cross/left/right shared actions and Circle closes back to the trigger", async () => {
    render(<nav className="home-actions"><ClaudeUsageWidget /><button>Inna akcja</button></nav>);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    const trigger = screen.getByRole("button", { name: /Claude Usage/ });
    trigger.focus(); act(() => { expect(activateHomeAction(document.activeElement)).toBe(true); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    act(() => { expect(moveWithinHomeActions(trigger, 1)).toBe(true); });
    expect(document.activeElement?.textContent).toBe("Odśwież Claude Usage");
    act(() => { expect(closeHomeDisclosure(document.activeElement)).toBe(true); });
    expect(document.activeElement).toBe(trigger); expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("deduplicates manual refresh and keeps focus during completion", async () => {
    let resolve!: (value: ClaudeUsageSnapshot) => void;
    mocks.read.mockImplementationOnce(async () => fixture).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<ClaudeUsageWidget />); expand(); await screen.findByText("79%");
    const button = screen.getByRole("button", { name: "Odśwież Claude Usage" }); button.focus();
    fireEvent.click(button); fireEvent.click(button);
    expect(mocks.read).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Odświeżanie…")).toBeTruthy();
    await act(async () => resolve(fixture)); expect(document.activeElement).toBe(button);
  });
  it("does not poll when automatic usage is unsupported", async () => {
    vi.useFakeTimers(); render(<ClaudeUsageWidget />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(60 * 60 * 1000); });
    expect(mocks.read).toHaveBeenCalledOnce();
  });
  it("reads the safe local adapter every fifteen minutes without moving focus", async () => {
    vi.useFakeTimers(); mocks.read.mockResolvedValue({ ...fixture, automaticUsageSupported: true });
    render(<ClaudeUsageWidget />);
    await act(async () => { await Promise.resolve(); });
    const button = screen.getByRole("button", { name: /Claude Usage/ }); button.focus();
    await act(async () => { vi.advanceTimersByTime(15 * 60 * 1000); });
    expect(mocks.read).toHaveBeenCalledTimes(2); expect(document.activeElement).toBe(button);
  });
  it("marks an open widget stale at reset without extra reads or focus changes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    mocks.read.mockResolvedValue({ ...fixture, limits: [{ ...fixture.limits[0], resetAt: new Date(Date.now() + 1000).toISOString() }] });
    render(<ClaudeUsageWidget />); expand();
    await act(async () => { await Promise.resolve(); });
    const button = screen.getByRole("button", { name: "Odśwież Claude Usage" }); button.focus();
    await act(async () => { vi.advanceTimersByTime(1100); });
    expect(screen.getByText(/Dane nieaktualne/)).toBeTruthy();
    expect(mocks.read).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(button);
  });
});
