import { invoke, isTauri } from "@tauri-apps/api/core";

export type TvDisplay = { id: string; name: string; width: number; height: number; x: number; y: number; scaleFactor: number; primary: boolean; current: boolean };
export type TvModeStatus = { supported: boolean; displays: TvDisplay[]; selectedDisplayId: string | null; fullscreen: boolean; selectionAvailable: boolean; error: string | null };
export const unsupportedTvMode: TvModeStatus = { supported: false, displays: [], selectedDisplayId: null, fullscreen: false, selectionAvailable: false, error: null };
export async function getTvModeStatus(): Promise<TvModeStatus> {
  return isTauri() ? invoke<TvModeStatus>("get_tv_mode_status") : unsupportedTvMode;
}
export async function applyTvMode(displayId: string | null, fullscreen: boolean): Promise<TvModeStatus> {
  if (!isTauri()) throw new Error("Wybór ekranu wymaga natywnej aplikacji VELORA.");
  if (displayId !== null && (!displayId || displayId.length > 512 || /[\x00-\x1f]/.test(displayId))) throw new Error("Nieprawidłowy ekran.");
  return invoke<TvModeStatus>("set_tv_mode", { displayId, fullscreen });
}
