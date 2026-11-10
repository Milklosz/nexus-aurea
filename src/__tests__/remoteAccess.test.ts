import { describe, expect, it } from "vitest";
import {
  beginRemotePairing,
  disabledRemoteAccessStatus,
  getRemoteAccessStatus,
  startRemoteAccess,
} from "../services/remoteAccess";

describe("iPhone Remote native access gate", () => {
  it("keeps the desktop LAN server disabled in browser-only contexts", async () => {
    await expect(getRemoteAccessStatus()).resolves.toEqual(disabledRemoteAccessStatus);
  });

  it("requires the user to confirm trusted iPhone certificate setup before starting", async () => {
    await expect(startRemoteAccess(false)).rejects.toThrow("aplikacji NEXUS AUREA na Windows");
  });

  it("does not allow pairing from the browser preview", async () => {
    await expect(beginRemotePairing()).rejects.toThrow("aplikacji NEXUS AUREA na Windows");
  });
});
