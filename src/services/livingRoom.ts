import { invoke, isTauri } from "@tauri-apps/api/core";

/** Session-only controls; enabling them never changes Steam or Windows settings. */
export interface StreamingControlStatus {
  windows: boolean;
  enabled: boolean;
  pointerMode: boolean;
  activeService: string | null;
  lastResult: string | null;
  acceptedActions: number;
  rejectedActions: number;
}

export const disabledStreamingControlStatus: StreamingControlStatus = {
  windows: false, enabled: false, pointerMode: false, activeService: null,
  lastResult: null, acceptedActions: 0, rejectedActions: 0,
};

export function parseStreamingControlStatus(value: unknown): StreamingControlStatus {
  if (typeof value !== "object" || value === null) throw new Error("Nieprawidłowy stan sterowania streamingiem.");
  const data = value as Record<string, unknown>;
  if (!["windows", "enabled", "pointerMode"].every(key => typeof data[key] === "boolean")
    || !["activeService", "lastResult"].every(key => data[key] === null || (typeof data[key] === "string" && data[key].length <= 200))
    || !["acceptedActions", "rejectedActions"].every(key => typeof data[key] === "number" && Number.isSafeInteger(data[key]) && (data[key] as number) >= 0)) {
    throw new Error("Nieprawidłowy stan sterowania streamingiem.");
  }
  return {
    windows: data.windows as boolean, enabled: data.enabled as boolean,
    pointerMode: data.pointerMode as boolean, activeService: data.activeService as string | null,
    lastResult: data.lastResult as string | null, acceptedActions: data.acceptedActions as number,
    rejectedActions: data.rejectedActions as number,
  };
}

export async function getStreamingControlStatus(): Promise<StreamingControlStatus> {
  if (!isTauri()) return disabledStreamingControlStatus;
  return parseStreamingControlStatus(await invoke("get_streaming_control_status"));
}

export async function configureStreamingControl(enabled: boolean, pointerMode: boolean): Promise<StreamingControlStatus> {
  if (!isTauri()) throw new Error("Sterowanie streamingiem wymaga natywnej aplikacji Windows.");
  return parseStreamingControlStatus(await invoke("configure_streaming_control", { enabled, pointerMode }));
}

export type FallbackHomeGesture = "disabled" | "l1R1Options";
export type FallbackHoldMs = 1500 | 2000 | 3000;
export interface FallbackHomeConfig {
  enabled: boolean;
  gesture: FallbackHomeGesture;
  holdMs: FallbackHoldMs;
}
export interface FallbackHomeStatus extends FallbackHomeConfig {
  physicalMappingValidated: boolean;
  validationNote: string;
  primaryChordSuppressed: boolean;
  armed: boolean;
  holdingSinceMs: number | null;
  lastTriggeredAtMs: number | null;
}
export const disabledFallbackHomeStatus: FallbackHomeStatus = {
  enabled: false, gesture: "disabled", holdMs: 2000, physicalMappingValidated: false,
  validationNote: "Gest zastępczy wymaga testu fizycznego pada.",
  primaryChordSuppressed: false, armed: false, holdingSinceMs: null, lastTriggeredAtMs: null,
};

export function parseFallbackHomeStatus(value: unknown): FallbackHomeStatus {
  if (typeof value !== "object" || value === null) throw new Error("Nieprawidłowy stan gestu Home.");
  const data = value as Record<string, unknown>;
  if (!["enabled", "physicalMappingValidated", "primaryChordSuppressed", "armed"].every(key => typeof data[key] === "boolean")
    || (data.gesture !== "disabled" && data.gesture !== "l1R1Options")
    || ![1500, 2000, 3000].includes(data.holdMs as number)
    || typeof data.validationNote !== "string" || data.validationNote.length > 500
    || !["holdingSinceMs", "lastTriggeredAtMs"].every(key => data[key] === null || (typeof data[key] === "number" && Number.isSafeInteger(data[key]) && (data[key] as number) >= 0))) {
    throw new Error("Nieprawidłowy stan gestu Home.");
  }
  return data as unknown as FallbackHomeStatus;
}

export async function getControllerFallbackStatus(): Promise<FallbackHomeStatus> {
  if (!isTauri()) return disabledFallbackHomeStatus;
  return parseFallbackHomeStatus(await invoke("get_controller_fallback_status"));
}

export async function configureControllerFallback(config: FallbackHomeConfig): Promise<FallbackHomeStatus> {
  if (!isTauri()) throw new Error("Gest zastępczy wymaga natywnej aplikacji Windows.");
  return parseFallbackHomeStatus(await invoke("configure_controller_fallback", { config }));
}
