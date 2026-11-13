import { describe, expect, it } from "vitest";
import {
  beginRemotePairing,
  disabledRemoteAccessStatus,
  getRemoteAccessStatus,
  inspectRemoteRecovery,
  runRemoteRecovery,
  startRemoteAccess,
} from "../services/remoteAccess";

describe("iPhone Remote native access gate", () => {
  it("keeps the desktop LAN server disabled in browser-only contexts", async () => {
    await expect(getRemoteAccessStatus()).resolves.toEqual(disabledRemoteAccessStatus);
  });

  it("requires the user to confirm trusted iPhone certificate setup before starting", async () => {
    await expect(startRemoteAccess(false)).rejects.toThrow("aplikacji VELORA na Windows");
  });

  it("does not allow pairing from the browser preview", async () => {
    await expect(beginRemotePairing()).rejects.toThrow("aplikacji VELORA na Windows");
  });
});

describe("iPhone Remote local recovery gate", () => {
  it("is unavailable outside the Windows app", async () => {
    await expect(inspectRemoteRecovery()).rejects.toThrow("aplikacji VELORA na Windows");
    await expect(runRemoteRecovery("reset-trust", "ABCD2345")).rejects.toThrow("aplikacji VELORA na Windows");
  });
});
