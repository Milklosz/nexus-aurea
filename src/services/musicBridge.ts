import { invoke, isTauri } from "@tauri-apps/api/core";

export type AppleMusicStatus = {
  windows: boolean;
  bridgeAvailable: boolean;
  appleSessionFound: boolean;
  title: string | null;
  artist: string | null;
  album: string | null;
  playbackState: "playing" | "paused" | "stopped" | "changing" | "opened" | "closed" | "unknown" | null;
  positionSeconds: number | null;
  durationSeconds: number | null;
  canTogglePlayPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
  artworkSupported: boolean;
  audioDeviceName: string | null;
  bluetoothLatencyMs: number | null;
  message: string | null;
};

export type AppleMusicAction = "toggle" | "next" | "previous";
export type SystemVolumeAction = "up" | "down" | "mute";

export const unavailableAppleMusicStatus: AppleMusicStatus = {
  windows: false,
  bridgeAvailable: false,
  appleSessionFound: false,
  title: null,
  artist: null,
  album: null,
  playbackState: null,
  positionSeconds: null,
  durationSeconds: null,
  canTogglePlayPause: false,
  canNext: false,
  canPrevious: false,
  artworkSupported: false,
  audioDeviceName: null,
  bluetoothLatencyMs: null,
  message: "Apple Music SMTC wymaga natywnej aplikacji Windows.",
};

const BACKGROUND_MODE_KEY = "nexus.music.backgroundMode";

export async function getAppleMusicStatus(): Promise<AppleMusicStatus> {
  if (!isTauri()) return unavailableAppleMusicStatus;
  return invoke<AppleMusicStatus>("get_apple_music_status");
}

export async function controlAppleMusic(action: AppleMusicAction): Promise<void> {
  if (!isTauri()) throw new Error("Sterowanie Apple Music wymaga natywnej aplikacji Windows.");
  await invoke("control_apple_music", { action });
}

export async function adjustSystemVolume(action: SystemVolumeAction): Promise<void> {
  if (!isTauri()) throw new Error("Regulacja głośności wymaga natywnej aplikacji Windows.");
  await invoke("adjust_system_volume", { action });
}

export function readMusicBackgroundMode(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try { return storage.getItem(BACKGROUND_MODE_KEY) === "true"; }
  catch { return false; }
}

export function saveMusicBackgroundMode(enabled: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(BACKGROUND_MODE_KEY, String(enabled)); }
  catch { /* Background mode still applies for the current session. */ }
}
