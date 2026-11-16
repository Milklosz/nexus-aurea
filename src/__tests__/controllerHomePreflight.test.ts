import { describe, expect, it } from "vitest";
import { streamingServices } from "../data/streamingServices";
import { disabledNativeControllerStatus } from "../services/nativeController";
import { shouldBlockControllerLaunchWithoutNativeHome, shouldPreflightControllerHome } from "../services/controllerHomePreflight";

describe("controller Home launch preflight", () => {
  const ds4Armed = {
    ...disabledNativeControllerStatus,
    supported: true,
    running: true,
    pads: [{ device: "0123456789abcdef", revision: "v2" as const, transport: "bluetooth" as const }],
  };

  it("guards web, Steam and Playnite only when a native pad is present and Home is disarmed", () => {
    for (const id of ["netflix", "steam", "playnite"] as const) {
      const service = streamingServices.find((candidate) => candidate.id === id)!;
      expect(shouldPreflightControllerHome(service, ds4Armed), id).toBe(true);
      expect(shouldPreflightControllerHome(service, { ...ds4Armed, homeEnabled: true }), id).toBe(false);
      expect(shouldPreflightControllerHome(service, { ...ds4Armed, pads: [] }), id).toBe(false);
      expect(shouldPreflightControllerHome(service, { ...ds4Armed, running: false }), id).toBe(false);
      expect(shouldPreflightControllerHome(service, { ...ds4Armed, supported: false }), id).toBe(false);
    }
  });

  it("does not guard Apple Music", () => {
    const service = streamingServices.find((candidate) => candidate.id === "appleMusic")!;
    expect(shouldPreflightControllerHome(service, ds4Armed)).toBe(false);
  });

  it("blocks a local controller launch when native Home status is unknown, including virtual XInput", () => {
    const service = streamingServices.find((candidate) => candidate.id === "netflix")!;
    expect(shouldBlockControllerLaunchWithoutNativeHome(
      service,
      disabledNativeControllerStatus,
      false,
    )).toBe(true);
  });

  it("blocks a local controller launch after the native sink stops even if Home was previously enabled", () => {
    const service = streamingServices.find((candidate) => candidate.id === "netflix")!;
    expect(shouldBlockControllerLaunchWithoutNativeHome(
      service,
      { ...ds4Armed, running: false, homeEnabled: true },
      true,
    )).toBe(true);
  });

  it("allows a healthy native Home path", () => {
    const service = streamingServices.find((candidate) => candidate.id === "netflix")!;
    expect(shouldBlockControllerLaunchWithoutNativeHome(
      service,
      { ...ds4Armed, homeEnabled: true },
      true,
    )).toBe(false);
  });
});
