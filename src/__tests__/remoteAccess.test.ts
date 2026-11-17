import { describe, expect, it } from "vitest";
import {
  beginRemotePairing,
  disabledRemoteAccessStatus,
  formatPairingCountdown,
  getRemoteAccessStatus,
  inspectRemoteRecovery,
  pairingRemainingSeconds,
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

describe("iPhone Remote live pairing countdown", () => {
  it("derives remaining seconds from an absolute expiry and formats them", () => {
    expect(pairingRemainingSeconds(1_700_000_060_000, 1_700_000_055_000)).toBe(5);
    expect(pairingRemainingSeconds(1_700_000_060_000, 1_700_000_059_400)).toBe(1);
    expect(pairingRemainingSeconds(1_700_000_060_000, 1_700_000_060_001)).toBe(0);
    expect(pairingRemainingSeconds(0, 1_700_000_060_000)).toBe(0);
    expect(formatPairingCountdown(5)).toBe("5s");
    expect(formatPairingCountdown(0)).toBe("0s");
  });
});
