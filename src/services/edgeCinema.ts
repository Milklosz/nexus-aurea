import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Nazwa dedykowanego, trwałego profilu Microsoft Edge używanego przez Edge Cinema.
 * Ta sama wartość jest używana po stronie Rust do zbudowania ścieżki
 * `<LOCALAPPDATA>/VELORA/VELORA-EdgeCinema`.
 */
export const EDGE_CINEMA_PROFILE_NAME = "VELORA-EdgeCinema";

/** Uczciwe, polskie komunikaty opisujące zachowanie i ograniczenia Edge Cinema. */
export const EDGE_CINEMA_NOTES: string[] = [
  "Dedykowany, trwały profil Microsoft Edge (VELORA-EdgeCinema) zachowuje logowania do serwisów między uruchomieniami.",
  "Błędy uruchomienia (brak Edge, katalog profilu, uruchomienie okna) są komunikowane czytelnie po polsku.",
  "VELORA nie gwarantuje i nie zmienia obsługi DRM / Widevine / PlayReady, jakości 4K, HDR, HDCP, możliwości GPU, poziomu subskrypcji ani dostępności usługi — zależą one od sprzętu, sterowników i dostawcy.",
];

export type EdgeCinemaStatus = {
  windows: boolean;
  edgeDetected: boolean;
  profileDir: string | null;
  notes: string[];
};

export type EdgeCinemaReceipt = {
  launched: boolean;
  mode: "app-fullscreen";
  profileDir: string;
  launchId?: string | null;
  adopted?: boolean;
};

const UNTRUSTED_STREAMING_URL_ERROR = "Adres usługi nie znajduje się na liście zaufanych stron.";
const NON_WINDOWS_ERROR = "Edge Cinema jest dostępne tylko w natywnej aplikacji Windows.";
const DEFAULT_ERROR_FALLBACK = "Nie udało się uruchomić Edge Cinema. Spróbuj ponownie.";

const EDGE_NOT_INSTALLED_GUIDANCE = "Nie znaleziono przeglądarki Microsoft Edge. Zainstaluj Edge i spróbuj ponownie.";
const PROFILE_DIR_GUIDANCE = "Nie udało się przygotować dedykowanego profilu Edge Cinema. Sprawdź uprawnienia do folderu danych aplikacji i spróbuj ponownie.";
const SPAWN_GUIDANCE = "Nie udało się uruchomić okna Edge Cinema. Sprawdź instalację Edge i spróbuj ponownie.";
const DRM_NOTE = "Obsługa DRM / Widevine / PlayReady oraz jakość 4K, HDR i HDCP nie są gwarantowane przez VELORA — zależą od sprzętu, GPU, subskrypcji i usługi.";

function messageFromCause(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof (cause as { message?: unknown }).message === "string"
  ) {
    return (cause as { message: string }).message;
  }
  return "";
}

/**
 * Mapuje błędy warstwy natywnej na czytelne, polskie wskazówki.
 * Nieznane błędy zwracają dokładnie przekazany `fallback` (bez zmian).
 */
export function edgeCinemaErrorMessage(cause: unknown, fallback: string = DEFAULT_ERROR_FALLBACK): string {
  const message = messageFromCause(cause);
  if (!message) return fallback;
  if (message === UNTRUSTED_STREAMING_URL_ERROR) return message;
  if (/(drm|widevine|playready|hdcp|\b4k\b|\bhdr\b)/i.test(message)) return DRM_NOTE;
  if (/nie wykryto/i.test(message) && /edge/i.test(message)) return EDGE_NOT_INSTALLED_GUIDANCE;
  if (/profilu|katalogu profilu|user-data-dir/i.test(message)) return PROFILE_DIR_GUIDANCE;
  if (/nie uruchomił|uruchomienie okna|spawn/i.test(message)) return SPAWN_GUIDANCE;
  if (/tylko w natywnej aplikacji windows/i.test(message)) return message;
  return fallback;
}

/**
 * Uruchamia dedykowane okno Microsoft Edge (tryb aplikacji + pełny ekran).
 * W podglądzie WWW (poza Tauri) rzuca jasny błąd — nigdy nie wywołuje window.open.
 */
export async function launchEdgeCinema(url: string): Promise<EdgeCinemaReceipt> {
  if (!isTauri()) {
    throw new Error(NON_WINDOWS_ERROR);
  }
  return invoke<EdgeCinemaReceipt>("launch_edge_cinema", { url });
}

/** Zwraca status wykrycia Edge i profilu; w podglądzie WWW status wyłączony z notatkami. */
export async function getEdgeCinemaStatus(): Promise<EdgeCinemaStatus> {
  if (!isTauri()) {
    return {
      windows: false,
      edgeDetected: false,
      profileDir: null,
      notes: [...EDGE_CINEMA_NOTES, "Edge Cinema działa w trybie podglądu i jest dostępne tylko w natywnej aplikacji Windows."],
    };
  }
  return invoke<EdgeCinemaStatus>("get_edge_cinema_status");
}
