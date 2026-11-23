/**
 * Phase 3 (Ascension D) — pairing lifecycle helper tests.
 *
 * Device identity, the revocation list and the QR onboarding phase are derived
 * ONLY from the existing `get_remote_access_status` payload and the existing
 * Tauri commands (`revoke_remote_device`, `revoke_all_remote_devices`). These
 * tests pin the pure helpers; no new command or LAN surface is introduced.
 */
import { describe, expect, it } from "vitest";
import {
  disabledRemoteAccessStatus,
  findPairedRemoteDevice,
  getRemoteAccessStatus,
  isRemoteCommand,
  isRemoteDevicePaired,
  listPairedRemoteDevices,
  qrOnboardingPhase,
  REMOTE_COMMANDS,
  remotePairingPhase,
  type RemoteAccessStatus,
} from "../services/remoteAccess";

function statusWith(overrides: Partial<RemoteAccessStatus>): RemoteAccessStatus {
  return { ...disabledRemoteAccessStatus, ...overrides };
}

describe("ascension D: remote pairing phase (device identity / revocation / QR onboarding)", () => {
  it("derives the lifecycle phase from the status payload only", () => {
    expect(remotePairingPhase(disabledRemoteAccessStatus)).toBe("disabled");
    expect(remotePairingPhase(statusWith({ enabled: true }))).toBe("onboarding");
    expect(remotePairingPhase(statusWith({ enabled: true, pairedDeviceCount: 2, pairedDevices: [{ id: "a", name: "iPhone" }] }))).toBe("paired");
    expect(remotePairingPhase(statusWith({ enabled: true, recoveryRequired: true }))).toBe("recovery-required");
    expect(remotePairingPhase(statusWith({ enabled: true, storeState: "damaged" }))).toBe("recovery-required");
    expect(remotePairingPhase(statusWith({ enabled: true, storeState: "locked" }))).toBe("recovery-required");
    expect(remotePairingPhase(statusWith({ enabled: true, storeState: "ok" }))).toBe("onboarding");
  });

  it("exposes the revocation list (paired devices) and device identity lookup", () => {
    const status = statusWith({
      enabled: true,
      pairedDeviceCount: 2,
      pairedDevices: [
        { id: "0123456789abcdef0123456789abcdef", name: "iPhone" },
        { id: "fedcba9876543210fedcba9876543210", name: "iPad" },
      ],
    });
    const list = listPairedRemoteDevices(status);
    expect(list).toEqual([
      { id: "0123456789abcdef0123456789abcdef", name: "iPhone" },
      { id: "fedcba9876543210fedcba9876543210", name: "iPad" },
    ]);
    expect(findPairedRemoteDevice(status, "fedcba9876543210fedcba9876543210")).toEqual({
      id: "fedcba9876543210fedcba9876543210",
      name: "iPad",
    });
    expect(isRemoteDevicePaired(status, "0123456789abcdef0123456789abcdef")).toBe(true);
    // A device that is not in the list has been revoked (or was never paired).
    expect(isRemoteDevicePaired(status, "aaaaaaaabbbbbbbbccccccccdddddddd")).toBe(false);
    expect(findPairedRemoteDevice(status, "")).toBeNull();
    expect(listPairedRemoteDevices(statusWith({ pairedDevices: undefined as unknown as [] }))).toEqual([]);
  });

  it("derives the QR onboarding phase from the fragment presence and validity", () => {
    expect(qrOnboardingPhase(false, false)).toBe("idle");
    expect(qrOnboardingPhase(true, true)).toBe("active");
    expect(qrOnboardingPhase(true, false)).toBe("expired");
  });

  it("keeps the remote command allowlist exact and shared via isRemoteCommand", () => {
    expect(REMOTE_COMMANDS).toHaveLength(15);
    for (const command of ["up", "down", "select", "home", "menu", "volume-up", "profile-cinema"]) {
      expect(isRemoteCommand(command)).toBe(true);
    }
    expect(isRemoteCommand("control-center")).toBe(false);
    expect(isRemoteCommand("launch-app")).toBe(false);
    expect(isRemoteCommand("")).toBe(false);
    expect(isRemoteCommand(42)).toBe(false);
    expect(isRemoteCommand(undefined)).toBe(false);
  });

  it("keeps the LAN server disabled outside the Windows app (no browser pairing)", async () => {
    const status = await getRemoteAccessStatus();
    expect(status).toEqual(disabledRemoteAccessStatus);
    expect(status.enabled).toBe(false);
    expect(status.pairedDevices).toEqual([]);
  });
});
