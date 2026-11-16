import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AudioEndpointInfo } from "./displayAudio";

function requireNative(): void {
  if (!isTauri()) throw new Error("Sterowanie dźwiękiem wymaga natywnej aplikacji Windows.");
}

export async function getSystemAudio(): Promise<AudioEndpointInfo> {
  requireNative();
  return invoke<AudioEndpointInfo>("get_system_audio");
}

export async function setSystemAudioVolume(percent: number, expectedEndpointId: string): Promise<AudioEndpointInfo> {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("Głośność musi należeć do zakresu 0–100%.");
  }
  requireNative();
  return invoke<AudioEndpointInfo>("set_system_audio_volume", { percent, expectedEndpointId });
}

export async function setSystemAudioMute(muted: boolean, expectedEndpointId: string): Promise<AudioEndpointInfo> {
  requireNative();
  return invoke<AudioEndpointInfo>("set_system_audio_mute", { muted, expectedEndpointId });
}
/** Invalidation only; read back the current endpoint before showing or writing it. */
export async function listenForSystemAudioChange(callback: () => void): Promise<() => void> {
  return isTauri() ? listen("velora-audio-changed", callback) : () => {};
}
