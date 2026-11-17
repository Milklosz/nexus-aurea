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
  diagnostics?: {
    /** Physical desktop pixels; negative origins are valid. */
    x: number;
    y: number;
    desktopWidth: number;
    desktopHeight: number;
    /** GetScaleFactorForMonitor resource bucket; not the exact effective window DPI. */
    scalePercent: number | null;
    /** Exact effective monitor DPI only after per-monitor process-awareness verification. */
    effectiveDpiX: number | null;
    effectiveDpiY: number | null;
    dpiProvenance: "getDpiForMonitorPerMonitorProcess" | null;
    refreshMillihz: number | null;
    connectionType: string | null;
    adapterName: string | null;
    edidManufacturerId: number | null;
    edidProductCodeId: number | null;
    identitySource: "displayConfig" | "gdiFallback" | "mirroredSourceUnknown" | "";
  };
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
