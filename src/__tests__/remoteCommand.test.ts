import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchRemoteCommand, type RemoteCommandHandlers } from "../services/remoteCommand";
import { registerAureaGrid, unregisterAureaGrid } from "../services/aureaNavigation";

function makeHandlers(overrides: Partial<RemoteCommandHandlers> = {}): RemoteCommandHandlers {
  return {
    navigate: vi.fn(),
    select: vi.fn(),
    back: vi.fn(),
    home: vi.fn(),
    volume: vi.fn(),
    profile: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  unregisterAureaGrid("remote-grid");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("iPhone Remote command mapping", () => {
  it.each([
    ["up", "navigate", -1],
    ["left", "navigate", -1],
    ["down", "navigate", 1],
    ["right", "navigate", 1],
    ["select", "select", undefined],
    ["back", "back", undefined],
    ["home", "home", undefined],
    ["volume-up", "volume", "up"],
    ["volume-down", "volume", "down"],
    ["mute", "volume", "mute"],
    ["profile-cinema", "profile", "cinema"],
    ["profile-gaming", "profile", "gaming"],
    ["profile-desktop", "profile", "desktop"],
  ] as const)("maps %s to %s", (command, handlerName, argument) => {
    const handlers = {
      navigate: vi.fn(),
      select: vi.fn(),
      back: vi.fn(),
      home: vi.fn(),
      volume: vi.fn(),
      profile: vi.fn(),
    } satisfies RemoteCommandHandlers;

    dispatchRemoteCommand(command, handlers);

    if (argument === undefined) {
      expect(handlers[handlerName]).toHaveBeenCalledOnce();
    } else {
      expect(handlers[handlerName]).toHaveBeenCalledWith(argument);
    }
  });
});

describe("iPhone Remote — 2D direction dispatch", () => {
  it.each([
    ["up", "up"],
    ["down", "down"],
    ["left", "left"],
    ["right", "right"],
  ] as const)("prefers navigateDirection(%s) and skips the legacy fallback", (command, direction) => {
    const navigateDirection = vi.fn();
    const handlers = makeHandlers({ navigateDirection });

    dispatchRemoteCommand(command, handlers);

    expect(navigateDirection).toHaveBeenCalledWith(direction);
    expect(handlers.navigate).not.toHaveBeenCalled();
  });

  it("uses moveAureaFocus (registered 2D grid) and skips the linear fallback", () => {
    // Node environment has no DOM; provide a minimal document so the real
    // moveAureaFocus can drive a registered grid.
    const body = { dataset: {} as Record<string, string> };
    vi.stubGlobal("document", { body });
    const items = [0, 1, 2, 3].map(() => ({
      focus: vi.fn(),
      setAttribute: vi.fn(),
    })) as unknown as HTMLElement[];
    const setActiveIndex = vi.fn();
    registerAureaGrid({ id: "remote-grid", columns: 2, items, activeIndex: 0, setActiveIndex });
    const handlers = makeHandlers();

    dispatchRemoteCommand("right", handlers);

    expect(setActiveIndex).toHaveBeenCalledWith(1);
    expect(items[1].focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(body.dataset.focusSource).toBe("remote");
    expect(handlers.navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["up", -1],
    ["left", -1],
    ["down", 1],
    ["right", 1],
  ] as const)("falls back to navigate(%s) when no grid is registered", (command, delta) => {
    const handlers = makeHandlers();

    dispatchRemoteCommand(command, handlers);

    expect(handlers.navigate).toHaveBeenCalledWith(delta);
  });
});
