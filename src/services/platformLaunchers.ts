import { invoke, isTauri } from "@tauri-apps/api/core";

export type PlatformLauncherId = "steamBigPicture" | "playniteFullscreen";
export type PlatformLauncherStatus = {
  windows: boolean;
  steamAvailable: boolean;
  playniteAvailable: boolean;
};

export async function getPlatformLauncherStatus(): Promise<PlatformLauncherStatus> {
  if (!isTauri()) return { windows: false, steamAvailable: false, playniteAvailable: false };
  return invoke<PlatformLauncherStatus>("get_platform_launcher_status");
}

export async function launchPlatform(launcher: PlatformLauncherId): Promise<void> {
  if (!isTauri()) throw new Error("Launchery zewnętrzne są dostępne tylko w aplikacji Windows.");
  await invoke("launch_platform", { launcher });
}
