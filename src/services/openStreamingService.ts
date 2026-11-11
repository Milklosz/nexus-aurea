import { isTauri } from "@tauri-apps/api/core";
import type { WebStreamingService } from "../data/streamingServices";
import { isOfficialHttpsUrl } from "../data/streamingServices";
import { edgeCinemaErrorMessage, launchEdgeCinema } from "./edgeCinema";

const UNTRUSTED_STREAMING_URL_ERROR = "Adres usługi nie znajduje się na liście zaufanych stron.";

export function streamingServiceErrorMessage(cause: unknown, serviceName: string): string {
  // Mapowanie błędów Edge Cinema na czytelne wskazówki. Dla błędów
  // nierozpoznanych zwracany jest — bez zmian — dotychczasowy komunikat ogólny.
  return edgeCinemaErrorMessage(
    cause,
    `Nie udało się otworzyć ${serviceName}. Sprawdź połączenie z internetem i spróbuj ponownie.`,
  );
}

export async function openStreamingService(service: WebStreamingService): Promise<void> {
  // Walidacja zaufanego adresu HTTPS zawsze jako pierwsza — zarówno w Tauri,
  // jak i w podglądzie WWW.
  if (!isOfficialHttpsUrl(service.href, service.allowedHost)) {
    throw new Error(UNTRUSTED_STREAMING_URL_ERROR);
  }

  if (isTauri()) {
    // Produkcja: dedykowane, bezpieczne okno Microsoft Edge (app-mode/pełny ekran)
    // ze stałym profilem, zamiast domyślnej przeglądarki systemowej.
    await launchEdgeCinema(service.href);
    return;
  }

  // Wyłącznie podgląd WWW (poza Tauri): fallback na nową, odizolowaną kartę.
  // Nie jest używany w natywnej aplikacji Windows.
  window.open(service.href, "_blank", "noopener,noreferrer");
}
