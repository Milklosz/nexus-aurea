import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export const PLAYNITE_DOWNLOAD_URL = "https://playnite.link/download.html";

export async function openOfficialPlayniteDownload(): Promise<void> {
  if (isTauri()) {
    await openUrl(PLAYNITE_DOWNLOAD_URL);
    return;
  }

  window.open(PLAYNITE_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
}
