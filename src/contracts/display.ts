/**
 * VELORA 1.0 — read-only display/audio contracts.
 *
 * These shapes are the stable boundary for the future Scene Engine. They are
 * deliberately observational: no resolution, HDR, refresh-rate or default
 * audio endpoint is changed by VELORA.
 */

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
