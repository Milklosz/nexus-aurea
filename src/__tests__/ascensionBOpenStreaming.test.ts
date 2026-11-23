// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SessionLaunchCoordinator } from "../services/veloraSessionManager";
import type { WebStreamingService } from "../data/streamingServices";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  launchEdgeCinema: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("../services/edgeCinema", () => ({
  launchEdgeCinema: mocks.launchEdgeCinema,
  edgeCinemaErrorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));

import { openStreamingService, streamingServiceErrorMessage } from "../services/openStreamingService";

const netflix: WebStreamingService = {
  kind: "web",
  id: "netflix",
  name: "Netflix",
  label: "Netflix",
  className: "svc-netflix",
  href: "https://www.netflix.com/pl/",
  allowedHost: "www.netflix.com",
};

afterEach(() => { vi.clearAllMocks(); mocks.isTauri.mockReturnValue(true); });

it("launches once through native IPC and records the launch on the coordinator", async () => {
  mocks.launchEdgeCinema.mockResolvedValue({ launched: true, mode: "app-fullscreen", profileDir: "EdgeCinemaServices/netflix", launchId: "cinema-1", adopted: false });
  const coordinator = new SessionLaunchCoordinator();
  await openStreamingService(netflix, coordinator);
  expect(mocks.launchEdgeCinema).toHaveBeenCalledTimes(1);
  expect(mocks.launchEdgeCinema).toHaveBeenCalledWith("https://www.netflix.com/pl/");
  const machine = coordinator.machineFor("edge-cinema:netflix");
  expect(machine.state).toBe("active");
  expect(machine.sessionId).toBe("cinema-1");
  expect(machine.generation).toBe(1);
});

it("blocks a duplicate launch event while the launch is still in flight (no second IPC)", async () => {
  let resolveLaunch: (value: unknown) => void = () => {};
  mocks.launchEdgeCinema.mockReturnValue(new Promise((resolve) => { resolveLaunch = resolve; }));
  const coordinator = new SessionLaunchCoordinator();
  const first = openStreamingService(netflix, coordinator);
  await expect(openStreamingService(netflix, coordinator)).rejects.toThrow(/już uruchamiana/);
  expect(mocks.launchEdgeCinema).toHaveBeenCalledTimes(1);
  resolveLaunch({ launched: true, mode: "app-fullscreen", profileDir: "p", launchId: "cinema-1", adopted: false });
  await first;
  // Once active, a repeated click adopts the existing session (idempotent key,
  // same generation, no new launch transition) instead of spawning a duplicate.
  mocks.launchEdgeCinema.mockResolvedValue({ launched: true, mode: "app-fullscreen", profileDir: "p", launchId: "cinema-1", adopted: true });
  await openStreamingService(netflix, coordinator);
  expect(mocks.launchEdgeCinema).toHaveBeenCalledTimes(2);
  const machine = coordinator.machineFor("edge-cinema:netflix");
  expect(machine.generation).toBe(1);
  expect(machine.receipts.filter((r) => r.cause === "launchRequested")).toHaveLength(1);
});

it("marks the machine as error when the native launch fails, and allows a fresh generation afterwards", async () => {
  mocks.launchEdgeCinema.mockRejectedValueOnce(new Error("spawn failed"));
  const coordinator = new SessionLaunchCoordinator();
  await expect(openStreamingService(netflix, coordinator)).rejects.toThrow("spawn failed");
  expect(coordinator.machineFor("edge-cinema:netflix").state).toBe("error");
  mocks.launchEdgeCinema.mockResolvedValue({ launched: true, mode: "app-fullscreen", profileDir: "p", launchId: "cinema-2", adopted: false });
  await openStreamingService(netflix, coordinator);
  expect(coordinator.machineFor("edge-cinema:netflix").generation).toBe(2);
});

it("rejects untrusted URLs before touching the coordinator or IPC", async () => {
  const coordinator = new SessionLaunchCoordinator();
  await expect(openStreamingService({ ...netflix, href: "https://netflix.evil.example/pl/" }, coordinator))
    .rejects.toThrow(/zaufanych stron/);
  expect(mocks.launchEdgeCinema).not.toHaveBeenCalled();
  expect(coordinator.machineFor("edge-cinema:netflix").state).toBe("idle");
});

it("keeps the web-preview fallback isolated from the native coordinator", async () => {
  mocks.isTauri.mockReturnValue(false);
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  const coordinator = new SessionLaunchCoordinator();
  await openStreamingService(netflix, coordinator);
  expect(openSpy).toHaveBeenCalledWith("https://www.netflix.com/pl/", "_blank", "noopener,noreferrer");
  expect(mocks.launchEdgeCinema).not.toHaveBeenCalled();
  expect(coordinator.machineFor("edge-cinema:netflix").state).toBe("idle");
  openSpy.mockRestore();
});

it("maps errors through the streaming-service message helper unchanged", () => {
  expect(streamingServiceErrorMessage(new Error("Adres usługi nie znajduje się na liście zaufanych stron."), "Netflix"))
    .toContain("zaufanych stron");
  expect(streamingServiceErrorMessage("weird", "Netflix")).toContain("Nie udało się otworzyć Netflix");
});
