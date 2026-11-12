import { describe, expect, it, vi } from "vitest";
import { dispatchControllerAction, type NavIntentHandlers } from "../services/navIntent";
import { dispatchRemoteCommand, type RemoteCommandHandlers } from "../services/remoteCommand";

function intentHandlers(): NavIntentHandlers {
  return { move: vi.fn(), select: vi.fn(), back: vi.fn(), menu: vi.fn(), home: vi.fn() };
}

function remoteHandlers(): RemoteCommandHandlers {
  return {
    navigate: vi.fn(),
    select: vi.fn(),
    selectRemote: vi.fn(),
    back: vi.fn(),
    home: vi.fn(),
    volume: vi.fn(),
    profile: vi.fn(),
  };
}

describe("DualSense actions go through the shared intent model", () => {
  it("routes each controller action to its intent handler", () => {
    const h = intentHandlers();
    dispatchControllerAction({ type: "move", delta: -1 }, h);
    expect(h.move).toHaveBeenLastCalledWith("left");
    dispatchControllerAction({ type: "move", delta: 1 }, h);
    expect(h.move).toHaveBeenLastCalledWith("right");
    dispatchControllerAction({ type: "confirm" }, h);
    expect(h.select).toHaveBeenCalledTimes(1);
    dispatchControllerAction({ type: "back" }, h);
    expect(h.back).toHaveBeenCalledTimes(1);
    dispatchControllerAction({ type: "options" }, h);
    expect(h.menu).toHaveBeenCalledTimes(1);
    expect(h.home).not.toHaveBeenCalled();
  });
});

describe("iPhone remote commands go through the shared intent model", () => {
  it("routes back and home to their handlers without touching other handlers", () => {
    const handlers = remoteHandlers();
    dispatchRemoteCommand("back", handlers);
    dispatchRemoteCommand("home", handlers);
    expect(handlers.back).toHaveBeenCalledTimes(1);
    expect(handlers.home).toHaveBeenCalledTimes(1);
    expect(handlers.navigate).not.toHaveBeenCalled();
    expect(handlers.select).not.toHaveBeenCalled();
  });

  it("keeps volume and profile commands outside navigation", () => {
    const handlers = remoteHandlers();
    dispatchRemoteCommand("volume-up", handlers);
    dispatchRemoteCommand("profile-cinema", handlers);
    expect(handlers.volume).toHaveBeenCalledWith("up");
    expect(handlers.profile).toHaveBeenCalledWith("cinema");
    expect(handlers.navigate).not.toHaveBeenCalled();
  });
});

describe("cross-source parity after wiring", () => {
  it("moves the same way for a left press on the controller and on the remote", () => {
    const controller = vi.fn();
    dispatchControllerAction(
      { type: "move", delta: -1 },
      { ...intentHandlers(), move: (direction) => controller(direction === "left" ? -1 : 1) },
    );
    const remote = remoteHandlers();
    dispatchRemoteCommand("left", remote);
    expect(controller).toHaveBeenCalledWith(-1);
    expect(remote.navigate).toHaveBeenCalledWith(-1);
  });

  it("moves the same way for a right press on the controller and on the remote", () => {
    const controller = vi.fn();
    dispatchControllerAction(
      { type: "move", delta: 1 },
      { ...intentHandlers(), move: (direction) => controller(direction === "left" ? -1 : 1) },
    );
    const remote = remoteHandlers();
    dispatchRemoteCommand("right", remote);
    expect(controller).toHaveBeenCalledWith(1);
    expect(remote.navigate).toHaveBeenCalledWith(1);
  });

  it("confirms through the remote-safe handler, as before", () => {
    const remote = remoteHandlers();
    dispatchRemoteCommand("select", remote);
    expect(remote.selectRemote).toHaveBeenCalledTimes(1);
    expect(remote.select).not.toHaveBeenCalled();
  });
});
