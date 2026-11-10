import { describe, expect, it } from "vitest";
import {
  authorizeRemoteCommand,
  beginRemotePairing,
  getRemoteAccessStatus,
  remoteConnectionLost,
  revokeRemoteAccess,
} from "../services/remoteAccess";

describe("iPhone Remote fail-closed access gate", () => {
  it("keeps the network endpoint disabled by default", () => {
    expect(getRemoteAccessStatus()).toEqual({
      enabled: false,
      paired: false,
      connected: false,
      endpointAvailable: false,
      secureOriginAvailable: false,
      pairingAvailable: false,
      pairedDeviceCount: 0,
      reason: "trustedHttpsRequired",
    });
  });

  it("refuses pairing until a trusted HTTPS origin exists", async () => {
    await expect(beginRemotePairing()).rejects.toThrow("certyfikatem zaufanym przez iPhone'a");
  });

  it("rejects commands even when a caller claims authentication while transport is unavailable", () => {
    expect(authorizeRemoteCommand({
      enabled: true,
      paired: true,
      connected: true,
      authenticated: true,
    })).toBe(false);
  });

  it("revokes access idempotently and clears connection state", () => {
    expect(revokeRemoteAccess()).toEqual(getRemoteAccessStatus());
    expect(revokeRemoteAccess()).toEqual(getRemoteAccessStatus());
    expect(remoteConnectionLost()).toEqual(getRemoteAccessStatus());
    expect(Object.keys(getRemoteAccessStatus())).not.toContain("token");
    expect(Object.keys(getRemoteAccessStatus())).not.toContain("secret");
  });
});
