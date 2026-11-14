// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { crossSourceGate } from "../services/crossSourceGate";
import type { Ds4ButtonName, NativeControllerEvent } from "../services/nativeController";

/**
 * The real App driven by synthetic native DualShock 4 events: the whole chain
 * event -> store -> engine -> focus-owner gate -> intent handlers -> DOM focus.
 * No hardware and no Tauri; the native event source is faked at the listen boundary.
 * NOT TESTED ON HARDWARE.
 */

const mocks = vi.hoisted(() => ({
  emit: null as ((event: NativeControllerEvent) => void) | null,
  listen: vi.fn(),
  openService: vi.fn(async () => {}),
}));

vi.mock("../services/openStreamingService", () => ({
  openStreamingService: mocks.openService,
  streamingServiceErrorMessage: () => "error",
}));

vi.mock("../services/nativeController", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/nativeController")>();
  return {
    ...original,
    listenForNativeController: mocks.listen,
    getNativeControllerStatus: vi.fn(async () => ({ supported: true, running: true, lastError: null, pads: [], ignoredReports: 0 })),
  };
});

let now = 5000;
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
function advance(ms: number) {
  act(() => {
    for (let elapsed = 0; elapsed < ms; elapsed += 8) {
      now += 8;
      vi.advanceTimersByTime(8);
    }
  });
}
const connected = (): NativeControllerEvent => ({ kind: "connected", device: "pad", revision: "v2", transport: "usb" });
function state(buttons: Ds4ButtonName[] = [], dpad: Partial<Record<"up" | "down" | "left" | "right", boolean>> = {}): NativeControllerEvent {
  return { kind: "state", device: "pad", revision: "v2", transport: "usb", dpad: { up: false, down: false, left: false, right: false, ...dpad }, leftX: 0, leftY: 0, buttons };
}
const send = (event: NativeControllerEvent) => act(() => { mocks.emit?.(event); });
const tap = async (buttons: Ds4ButtonName[], dpad: Partial<Record<"up" | "down" | "left" | "right", boolean>> = {}) => {
  await send(state(buttons, dpad));
  advance(120);
  await send(state());
  advance(220); // clear the post-hand-over confirm settle window
};

beforeEach(async () => {
  now = 5000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(now), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  mocks.emit = null;
  mocks.listen.mockReset();
  mocks.openService.mockClear();
  mocks.listen.mockImplementation(async (callback: (event: NativeControllerEvent) => void) => {
    mocks.emit = callback;
    return () => { mocks.emit = null; };
  });
  crossSourceGate.reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function boot() {
  const view = render(<App />);
  await settle();
  advance(100);
  await send(connected());
  advance(100);
  return view;
}

const dialogOpen = () => document.querySelector("dialog[open]") !== null;
const focused = () => document.activeElement as HTMLElement | null;

describe("App driven by a native DualShock 4", () => {
  it("D-pad right moves the dock selection by exactly one tile per tap", async () => {
    await boot();
    const tiles = () => Array.from(document.querySelectorAll<HTMLElement>("[data-aurea-item]"));
    expect(tiles().length).toBeGreaterThan(2);
    const start = tiles().indexOf(focused() as HTMLElement);
    await tap([], { right: true });
    const afterOne = tiles().indexOf(focused() as HTMLElement);
    expect(afterOne).toBe(start + 1);
    await tap([], { right: true });
    expect(tiles().indexOf(focused() as HTMLElement)).toBe(start + 2);
  });

  it("Options opens Control Center on release and Circle closes it, returning focus to the dock", async () => {
    await boot();
    const before = focused();
    await send(state(["options"]));
    advance(150);
    expect(dialogOpen()).toBe(false); // not on press
    await send(state());
    advance(250);
    expect(dialogOpen()).toBe(true);
    await tap(["circle"]);
    expect(dialogOpen()).toBe(false);
    expect(focused()).toBe(before);
  });

  it("PS + Options never opens a panel (that is the Home chord)", async () => {
    await boot();
    await send(state(["ps"]));
    advance(60);
    await send(state(["ps", "options"]));
    advance(150);
    await send(state());
    advance(300);
    expect(dialogOpen()).toBe(false);
  });

  it("returns focus to the top-bar action that opened Control Center", async () => {
    await boot();
    await tap([], { up: true }); // dock -> top actions zone
    const opener = focused() as HTMLElement;
    expect(opener.closest(".home-actions, .quick-settings-trigger")).not.toBeNull();
    await tap(["options"]);
    expect(dialogOpen()).toBe(true);
    await tap(["circle"]);
    expect(dialogOpen()).toBe(false);
    await act(async () => { vi.advanceTimersByTime(64); });
    expect(focused()).toBe(opener);
  });

  it("Cross on the dock launches the focused service exactly once (positive control)", async () => {
    await boot();
    await tap(["cross"]);
    expect(mocks.openService).toHaveBeenCalledTimes(1);
  });

  it("falls back to the dock when the opener became disabled while the panel was open", async () => {
    await boot();
    await tap([], { up: true });
    const opener = focused() as HTMLElement;
    expect(opener.closest(".home-actions, .quick-settings-trigger")).not.toBeNull();
    await tap(["options"]);
    expect(dialogOpen()).toBe(true);
    (opener as HTMLButtonElement).disabled = true;
    await tap(["circle"]);
    expect(dialogOpen()).toBe(false);
    await act(async () => { vi.advanceTimersByTime(64); });
    expect(focused()).not.toBe(opener);
    expect(focused()?.hasAttribute("data-aurea-item")).toBe(true);
  });

  it("a Cross pressed in the gap right after a panel closes does not launch the dock app", async () => {
    await boot();
    await tap(["options"]);
    expect(dialogOpen()).toBe(true);
    // Circle closes the panel and Cross follows immediately, inside the hand-over window.
    await send(state(["circle"]));
    advance(100);
    await send(state());
    advance(30);
    await send(state(["cross"]));
    advance(100);
    await send(state());
    advance(300);
    expect(dialogOpen()).toBe(false);
    expect(mocks.openService).not.toHaveBeenCalled();
    // Once the hand-over settles, Cross works again.
    await tap(["cross"]);
    expect(mocks.openService).toHaveBeenCalledTimes(1);
  });

  it("the diagnostics screen shows only reported facts and Circle closes it", async () => {
    await boot();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2" })); });
    advance(50);
    const dialog = document.querySelector("dialog[open]") as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Kontroler natywny");
    expect(dialog?.textContent).toContain("DualShock 4 (v2)");
    expect(dialog?.textContent).toContain("USB");
    expect(dialog?.textContent).not.toMatch(/hid#|vid_054c/i);
    await tap(["circle"]);
    expect(dialogOpen()).toBe(false);
  });

  it("works without any pad: no listener noise, keyboard still navigates", async () => {
    render(<App />);
    await settle();
    advance(500);
    expect(dialogOpen()).toBe(false);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "F3" })); });
    advance(50);
    expect(dialogOpen()).toBe(true);
  });

  it("leaks no native listener when the interface is torn down", async () => {
    const view = await boot();
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    view.unmount();
    await settle();
    expect(mocks.emit).toBeNull();
  });
});
