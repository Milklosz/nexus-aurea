import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DisplayAudioSnapshot,
  DisplayChangedEvent,
} from "../contracts/display";

export type {
  AudioEndpointInfo,
  AudioEndpointState,
  DisplayAudioPolicy,
  DisplayAudioSnapshot,
  DisplayChangedEvent,
  DisplayInfo,
} from "../contracts/display";

export const DISPLAY_CHANGED_EVENT = "velora-display-changed";

export const disabledDisplayAudioStatus: DisplayAudioSnapshot = {
  windows: false,
  supported: false,
  displays: [],
  audio: [],
  displayError: null,
  audioError: null,
  policy: {
    readOnly: true,
    automaticModeChanges: false,
    notes: [
      "Podgląd w przeglądarce nie odczytuje sprzętu.",
      "Diagnostyka wyświetlaczy i audio jest tylko do odczytu.",
    ],
  },
  limitations: [
    "Diagnostyka wyświetlaczy i audio wymaga natywnej aplikacji VELORA dla Windows.",
  ],
  displaySignature: "",
  capturedAtMs: 0,
};

export async function getDisplayAudioStatus(): Promise<DisplayAudioSnapshot> {
  if (!isTauri()) return disabledDisplayAudioStatus;
  return invoke<DisplayAudioSnapshot>("get_display_audio_status");
}

export async function listenForDisplayChange(
  callback: (event: DisplayChangedEvent) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<DisplayChangedEvent>(DISPLAY_CHANGED_EVENT, (event) => callback(event.payload));
}
