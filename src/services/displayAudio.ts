import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const DISPLAY_CHANGED_EVENT = "velora-display-changed";

export type AudioEndpointState =
  | "active"
  | "disabled"
  | "notPresent"
  | "unplugged"
  | "unknown";

export type DisplayInfo = {
  id: string;
  name: string;
  width: number;
  height: number;
  refreshHz: number;
  bitsPerPixel: number;
  primary: boolean;
  hdr: boolean | null;
  hdrError: string | null;
};

export type AudioEndpointInfo = {
  id: string;
  name: string;
  state: AudioEndpointState;
  defaultDevice: boolean;
  volumePercent: number | null;
  muted: boolean | null;
};

export type DisplayAudioPolicy = {
  readOnly: boolean;
  automaticModeChanges: boolean;
  notes: string[];
};

export type DisplayAudioSnapshot = {
  windows: boolean;
  supported: boolean;
  displays: DisplayInfo[];
  audio: AudioEndpointInfo[];
  displayError: string | null;
  audioError: string | null;
  policy: DisplayAudioPolicy;
  limitations: string[];
  displaySignature: string;
  capturedAtMs: number;
};

export type DisplayChangedEvent = {
  previousSignature: string;
  displaySignature: string;
  displays: DisplayInfo[];
  atMs: number;
};

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
