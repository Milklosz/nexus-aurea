import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RemoteCommand } from "./remoteCommand";

export type { RemoteCommand } from "./remoteCommand";

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
};

export const REMOTE_ACCESS_DISABLED_REASON =
  "HTTPS działa tylko po zainstalowaniu profilu zaufania na iPhonie. Nie omijaj ostrzeżeń Safari.";

export async function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  if (!isTauri()) return { ...disabledRemoteAccessStatus };
  return invoke<RemoteAccessStatus>("get_remote_access_status");
}

export async function prepareRemoteTrustProfile(): Promise<RemoteAccessStatus> {
  if (!isTauri()) throw new Error("Profil zaufania można przygotować tylko w aplikacji VELORA na Windows.");
  return invoke<RemoteAccessStatus>("prepare_remote_trust_profile");
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

export async function listenForRemoteAccessStatus(
  callback: (status: RemoteAccessStatus) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<RemoteAccessStatus>("remote-access-status", (event) => callback(event.payload));
}

const remoteCommands: ReadonlySet<string> = new Set([
  "up", "down", "left", "right", "select", "back", "home",
  "volume-up", "volume-down", "mute",
  "profile-cinema", "profile-gaming", "profile-desktop",
]);

export async function listenForRemoteCommand(
  callback: (command: RemoteCommand) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<string>("nexus-remote-command", (event) => {
    if (remoteCommands.has(event.payload)) callback(event.payload as RemoteCommand);
  });
}
