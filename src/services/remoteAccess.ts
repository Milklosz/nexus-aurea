import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isRemoteCommand } from "./remoteCommand";
import type { RemoteCommand } from "./remoteCommand";

export type { RemoteCommand } from "./remoteCommand";
export { isRemoteCommand, REMOTE_COMMANDS } from "./remoteCommand";

export type RemoteDeviceSummary = {
  id: string;
  name: string;
};

export type RemoteAccessStatus = {
  enabled: boolean;
  secureOriginAvailable: boolean;
  pairingAvailable: boolean;
  pairedDeviceCount: number;
  pairedDevices: RemoteDeviceSummary[];
  origin: string | null;
  caFingerprint: string | null;
  trustProfilePath: string | null;
  pairingCode: string | null;
  pairingExpiresInSeconds: number;
  /** Wall-clock expiry (Unix ms) of the one-time code; local UI only. */
  pairingExpiresAtMs?: number;
  /** State of the system credential store, distinct from "no paired devices". */
  storeState?: RemoteStoreState;
  storeMessage?: string | null;
  /** True only when the local, user-initiated recovery can restore the store. */
  recoveryRequired?: boolean;
};

export type RemoteStoreState =
  | "unknown"
  | "ok"
  | "unavailable"
  | "locked"
  | "damaged"
  | "rolled-back"
  | "recovery-pending";

/** Read-only preview of the resolved profile path and CA fingerprint. */
export type RemoteTrustProfilePreview = {
  path: string;
  fingerprint: string | null;
  portable: boolean;
};

/** Truthful result of each local-only rollback step. */
export type RemoteTrustCleanupReport = {
  serverStopped: boolean;
  profileRemoved: boolean;
  profilePath: string;
  devicesRevoked: boolean;
  note: string;
};

export type RemoteRecoveryMode = "revoke-all-devices" | "reset-trust";

export type RemoteRecoveryOption = {
  mode: RemoteRecoveryMode;
  summary: string;
};

export type RemoteRecoveryPlan = {
  storeState: RemoteStoreState;
  message: string | null;
  recoveryRequired: boolean;
  options: RemoteRecoveryOption[];
  /** One-time code the local UI sends back to run a recovery. */
  confirmation: string;
  confirmationExpiresInSeconds: number;
};

export const disabledRemoteAccessStatus: RemoteAccessStatus = {
  enabled: false,
  secureOriginAvailable: false,
  pairingAvailable: false,
  pairedDeviceCount: 0,
  pairedDevices: [],
  origin: null,
  caFingerprint: null,
  trustProfilePath: null,
  pairingCode: null,
  pairingExpiresInSeconds: 0,
  pairingExpiresAtMs: 0,
  storeState: "unknown",
  storeMessage: null,
  recoveryRequired: false,
};

export const REMOTE_ACCESS_DISABLED_REASON =
  "HTTPS działa tylko po zainstalowaniu profilu zaufania na iPhonie. Nie omijaj ostrzeżeń Safari.";

export async function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  if (!isTauri()) return { ...disabledRemoteAccessStatus };
  return invoke<RemoteAccessStatus>("get_remote_access_status");
}

/**
 * Local-only, one-time approval (120 s, single use) for the next trust-profile
 * write or rollback. Never available on the LAN HTTPS server. The UI checkbox
 * is the actual human consent; this token is only a freshness guard.
 */
export async function beginRemoteTrustProfileApproval(): Promise<string> {
  if (!isTauri()) throw new Error("Zatwierdzenie profilu jest możliwe tylko w aplikacji VELORA na Windows.");
  return invoke<string>("begin_remote_trust_approval");
}

/** Read-only: shows where the profile WOULD be written and the CA fingerprint. */
export async function inspectRemoteTrustProfile(): Promise<RemoteTrustProfilePreview> {
  if (!isTauri()) throw new Error("Podgląd profilu zaufania jest możliwy tylko w aplikacji VELORA na Windows.");
  return invoke<RemoteTrustProfilePreview>("inspect_remote_trust_profile");
}

/** Requires the one-time token from `beginRemoteTrustProfileApproval`. */
export async function prepareRemoteTrustProfile(approvalToken: string): Promise<RemoteAccessStatus> {
  if (!isTauri()) throw new Error("Profil zaufania można przygotować tylko w aplikacji VELORA na Windows.");
  if (!approvalToken) throw new Error("Najpierw zatwierdź przygotowanie profilu.");
  return invoke<RemoteAccessStatus>("prepare_remote_trust_profile", { approvalToken });
}

/**
 * Portable-only rollback: stops the server, removes the generated profile from
 * the portable trust directory and revokes every device. iOS-side profile
 * removal and full-trust disablement remain manual steps on the iPhone.
 */
export async function cleanupRemoteTrustArtifacts(approvalToken: string): Promise<RemoteTrustCleanupReport> {
  if (!isTauri()) throw new Error("Czyszczenie danych zaufania jest możliwe tylko w aplikacji VELORA na Windows.");
  if (!approvalToken) throw new Error("Najpierw zatwierdź czyszczenie danych zaufania.");
  return invoke<RemoteTrustCleanupReport>("cleanup_remote_trust_artifacts", { approvalToken });
}

export async function startRemoteAccess(trustConfirmed: boolean): Promise<RemoteAccessStatus> {
  if (!isTauri()) throw new Error("Serwer pilota można uruchomić tylko w aplikacji VELORA na Windows.");
  return invoke<RemoteAccessStatus>("start_remote_access", { trustConfirmed });
}

export async function beginRemotePairing(): Promise<RemoteAccessStatus> {
  if (!isTauri()) throw new Error("Parowanie można rozpocząć tylko w aplikacji VELORA na Windows.");
  return invoke<RemoteAccessStatus>("begin_remote_pairing");
}

export async function stopRemoteAccess(): Promise<RemoteAccessStatus> {
  if (!isTauri()) return { ...disabledRemoteAccessStatus };
  return invoke<RemoteAccessStatus>("stop_remote_access");
}

export async function revokeAllRemoteDevices(): Promise<RemoteAccessStatus> {
  if (!isTauri()) throw new Error("Dostęp można odwołać tylko w aplikacji VELORA na Windows.");
  return invoke<RemoteAccessStatus>("revoke_all_remote_devices");
}

export async function revokeRemoteDevice(deviceId: string): Promise<RemoteAccessStatus> {
  if (!isTauri()) throw new Error("Dostęp można odwołać tylko w aplikacji VELORA na Windows.");
  return invoke<RemoteAccessStatus>("revoke_remote_device", { deviceId });
}

/**
 * Local recovery of a damaged or incomplete credential state. Both calls go
 * through Tauri IPC only; the LAN HTTPS server has no route for them, so a
 * paired or unpaired iPhone can never start a recovery.
 */
export async function inspectRemoteRecovery(): Promise<RemoteRecoveryPlan> {
  if (!isTauri()) throw new Error("Odzyskiwanie zaufania działa tylko w aplikacji VELORA na Windows.");
  return invoke<RemoteRecoveryPlan>("inspect_remote_recovery");
}

export async function runRemoteRecovery(
  mode: RemoteRecoveryMode,
  confirmation: string,
): Promise<RemoteAccessStatus> {
  if (!isTauri()) throw new Error("Odzyskiwanie zaufania działa tylko w aplikacji VELORA na Windows.");
  if (!confirmation) throw new Error("Najpierw odczytaj stan i potwierdź odzyskiwanie.");
  return invoke<RemoteAccessStatus>("run_remote_recovery", { mode, confirmation });
}

export async function listenForRemoteAccessStatus(
  callback: (status: RemoteAccessStatus) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<RemoteAccessStatus>("remote-access-status", (event) => callback(event.payload));
}

export async function listenForRemoteCommand(
  callback: (command: RemoteCommand) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<string>("nexus-remote-command", (event) => {
    if (isRemoteCommand(event.payload)) callback(event.payload);
  });
}

// Pure QR / countdown helpers live in remoteReliability.ts (no Tauri import so
// they can be used from any UI module and from node tests). Re-exported here
// for callers that already import from this service.
export {
  buildPairingBootstrapUrl,
  encodeQrMatrix,
  formatPairingCountdown,
  pairingRemainingSeconds,
  parsePairingBootstrapUrl,
} from "./remoteReliability";
export type { PairingBootstrap } from "./remoteReliability";

/* ------------------------------------------------------------------------- *
 * Phase 3 (Ascension D) — pairing lifecycle helpers (PURE, ADDITIVE).
 *
 * Device identity, the revocation list and the QR onboarding phase are derived
 * ONLY from the existing `get_remote_access_status` payload and the existing
 * revoke commands (`revoke_remote_device`, `revoke_all_remote_devices`). No new
 * Tauri command, no LAN surface, no secret ever leaves the vault.
 * ------------------------------------------------------------------------- */

/** Lifecycle phase of the LAN remote, derived from the status payload alone. */
export type RemotePairingPhase =
  | "disabled"
  | "onboarding"
  | "paired"
  | "recovery-required";

export function remotePairingPhase(status: RemoteAccessStatus): RemotePairingPhase {
  if (status.recoveryRequired) return "recovery-required";
  if (!status.enabled) return "disabled";
  if (status.storeState === "unavailable" || status.storeState === "locked"
    || status.storeState === "damaged" || status.storeState === "rolled-back"
    || status.storeState === "recovery-pending") return "recovery-required";
  if (status.pairedDeviceCount > 0) return "paired";
  return "onboarding";
}

/**
 * The revocation list: every paired device the local UI can revoke through the
 * existing `revoke_remote_device` command. A device that disappears from this
 * list (or answers 401 on the LAN) has been revoked.
 */
export function listPairedRemoteDevices(status: RemoteAccessStatus): RemoteDeviceSummary[] {
  if (!Array.isArray(status.pairedDevices)) return [];
  return status.pairedDevices.map((device) => ({ id: String(device.id), name: String(device.name) }));
}

/** Device identity lookup — shows which deviceId this UI/pairing belongs to. */
export function findPairedRemoteDevice(
  status: RemoteAccessStatus,
  deviceId: string,
): RemoteDeviceSummary | null {
  if (!deviceId) return null;
  return listPairedRemoteDevices(status).find((device) => device.id === deviceId) ?? null;
}

export function isRemoteDevicePaired(status: RemoteAccessStatus, deviceId: string): boolean {
  return findPairedRemoteDevice(status, deviceId) !== null;
}

/** QR onboarding phase of the one-time code carried in the URL fragment. */
export type QrOnboardingPhase = "idle" | "active" | "expired";

export function qrOnboardingPhase(hasFragment: boolean, fragmentValid: boolean): QrOnboardingPhase {
  if (fragmentValid) return "active";
  if (hasFragment) return "expired";
  return "idle";
}
