import { describe, expect, it, vi } from "vitest";
import { dispatchRemoteCommand, type RemoteCommandHandlers } from "../services/remoteCommand";

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
