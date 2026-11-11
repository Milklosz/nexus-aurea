import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { WebStreamingService } from "../data/streamingServices";
import { isOfficialHttpsUrl } from "../data/streamingServices";

const UNTRUSTED_STREAMING_URL_ERROR = "Adres usługi nie znajduje się na liście zaufanych stron.";

export function streamingServiceErrorMessage(cause: unknown, serviceName: string): string {
  const errorMessage = typeof cause === "string"
    ? cause
    : cause instanceof Error
      ? cause.message
      : typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
        ? cause.message
        : "";

  if (errorMessage === UNTRUSTED_STREAMING_URL_ERROR) return errorMessage;
  return `Nie udało się otworzyć ${serviceName}. Sprawdź połączenie z internetem i spróbuj ponownie.`;
}

export async function openStreamingService(service: WebStreamingService): Promise<void> {
  if (!isOfficialHttpsUrl(service.href, service.allowedHost)) {
    throw new Error(UNTRUSTED_STREAMING_URL_ERROR);
  }

  if (isTauri()) {
    await openUrl(service.href);
    return;
  }

  window.open(service.href, "_blank", "noopener,noreferrer");
}
