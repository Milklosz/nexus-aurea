import { isTauri } from "@tauri-apps/api/core";
import type { WebStreamingService } from "../data/streamingServices";
import { isOfficialHttpsUrl } from "../data/streamingServices";
import { edgeCinemaErrorMessage, launchEdgeCinema } from "./edgeCinema";
import { SessionLaunchCoordinator } from "./veloraSessionManager";

const UNTRUSTED_STREAMING_URL_ERROR = "Adres usługi nie znajduje się na liście zaufanych stron.";
const DUPLICATE_LAUNCH_IN_FLIGHT_ERROR = "Ta usługa jest już uruchamiana — VELORA nie uruchamia duplikatu.";

/** Shared client-side launch coordinator (early duplicate hint; native stays authoritative). */
export const sharedSessionLaunchCoordinator = new SessionLaunchCoordinator();

export function streamingServiceErrorMessage(cause: unknown, serviceName: string): string {
  // Mapowanie błędów Edge Cinema na czytelne wskazówki. Dla błędów
  // nierozpoznanych zwracany jest — bez zmian — dotychczasowy komunikat ogólny.
  return edgeCinemaErrorMessage(
    cause,
    `Nie udało się otworzyć ${serviceName}. Sprawdź połączenie z internetem i spróbuj ponownie.`,
  );
}

/**
 * Opens a streaming service exactly once per launch generation.
 *
 * The client-side coordinator keys the launch by `service#generation`: while a
 * launch for the same service is in flight (or closing), a repeated call is a
 * duplicate and throws a truthful error WITHOUT a second IPC event. When the
 * session is already active the native adoption path is used (re-select the
 * existing window — still no duplicate spawn). The native LaunchRegistry
 * remains the authoritative duplicate guard.
 */
export async function openStreamingService(
  service: WebStreamingService,
  coordinator: SessionLaunchCoordinator = sharedSessionLaunchCoordinator,
): Promise<void> {
  // Walidacja zaufanego adresu HTTPS zawsze jako pierwsza — zarówno w Tauri,
  // jak i w podglądzie WWW.
  if (!isOfficialHttpsUrl(service.href, service.allowedHost)) {
    throw new Error(UNTRUSTED_STREAMING_URL_ERROR);
  }

  if (isTauri()) {
    // Produkcja: dedykowane, bezpieczne okno Microsoft Edge (app-mode/pełny ekran)
    // ze stałym profilem, zamiast domyślnej przeglądarki systemowej.
    //
    // The client-side coordinator keys the launch by `service#generation`:
    // while a launch for this service is in flight (or closing), a repeated
    // call is a duplicate and throws WITHOUT a second IPC launch event.
    // "launch" starts a new generation; "adopt" re-selects the active session
    // through the native adoption path (still no duplicate spawn). The native
    // LaunchRegistry remains the authoritative duplicate guard.
    const serviceKey = `edge-cinema:${service.id}`;
    const decision = coordinator.requestLaunch(serviceKey);
    if (decision.kind === "duplicate" || decision.kind === "stale") {
      throw new Error(DUPLICATE_LAUNCH_IN_FLIGHT_ERROR);
    }
    try {
      const receipt = await launchEdgeCinema(service.href);
      coordinator.noteLaunched(serviceKey, receipt.launchId ?? null);
    } catch (cause) {
      coordinator.failLaunch(serviceKey);
      throw cause;
    }
    return;
  }

  // Wyłącznie podgląd WWW (poza Tauri): fallback na nową, odizolowaną kartę.
  // Nie jest używany w natywnej aplikacji Windows.
  window.open(service.href, "_blank", "noopener,noreferrer");
}
