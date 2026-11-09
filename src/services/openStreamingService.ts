import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { StreamingService } from "../data/streamingServices";
import { isOfficialHttpsUrl } from "../data/streamingServices";

export async function openStreamingService(service: StreamingService): Promise<void> {
  if (!isOfficialHttpsUrl(service.href, service.allowedHost)) {
    throw new Error("Adres usługi nie znajduje się na liście zaufanych stron.");
  }

  if (isTauri()) {
    await openUrl(service.href);
    return;
  }

  window.open(service.href, "_blank", "noopener,noreferrer");
}
