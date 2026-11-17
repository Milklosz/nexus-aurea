import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DisplayAudioSnapshot,
  DisplayChangedEvent,
  DisplayInfo,
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

/** Only this provenance means the DPI was confirmed by a per-monitor-aware read. */
export const CONFIRMED_DPI_PROVENANCE = "getDpiForMonitorPerMonitorProcess" as const;
/** Windows exposes effective DPI relative to a 96 DPI baseline. */
const EFFECTIVE_DPI_BASELINE = 96;
/** A divergence below this is rounding noise, not a meaningful mismatch. */
const DIVERGENCE_THRESHOLD_POINTS = 5;

export type DisplayGeometryFlags = {
  /** Effective scale (DPI / 96 * 100) as an integer percentage, or null when unknown. */
  effectiveScalePercent: number | null;
  /** Absolute gap between the API scale bucket and the confirmed effective scale. */
  scaleDivergencePoints: number | null;
  /** True when the API scale and confirmed effective scale differ meaningfully. */
  scaleDiverges: boolean;
  /** True when this monitor starts left of or above the primary origin. */
  negativeOrigin: boolean;
};

type Diagnostics = DisplayInfo["diagnostics"];

/**
 * Effective scale derived from a confirmed DPI only. An unconfirmed value —
 * including an unverified 96 — is reported as unknown, never as a fact.
 */
export function effectiveScalePercent(diagnostics: Diagnostics): number | null {
  if (!diagnostics || diagnostics.dpiProvenance !== CONFIRMED_DPI_PROVENANCE) return null;
  const dpi = diagnostics.effectiveDpiX;
  if (dpi === null || !Number.isFinite(dpi) || dpi <= 0) return null;
  return Math.round((dpi / EFFECTIVE_DPI_BASELINE) * 100);
}

/** Gap in percentage points, or null unless both scales are knowable. */
export function scaleDivergencePoints(diagnostics: Diagnostics): number | null {
  const effective = effectiveScalePercent(diagnostics);
  if (effective === null || !diagnostics || diagnostics.scalePercent === null) return null;
  if (!Number.isFinite(diagnostics.scalePercent)) return null;
  return Math.abs(diagnostics.scalePercent - effective);
}

/** Detect an extended desktop placed to the left or above the primary monitor. */
export function hasNegativeOrigin(diagnostics: Diagnostics): boolean {
  if (!diagnostics) return false;
  return diagnostics.x < 0 || diagnostics.y < 0;
}

/** Combined, gated geometry flags used by the diagnostics panel. */
export function displayGeometryFlags(diagnostics: Diagnostics): DisplayGeometryFlags {
  const effectiveScalePercentValue = effectiveScalePercent(diagnostics);
  const divergence = scaleDivergencePoints(diagnostics);
  return {
    effectiveScalePercent: effectiveScalePercentValue,
    scaleDivergencePoints: divergence,
    scaleDiverges: divergence !== null && divergence >= DIVERGENCE_THRESHOLD_POINTS,
    negativeOrigin: hasNegativeOrigin(diagnostics),
  };
}

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
