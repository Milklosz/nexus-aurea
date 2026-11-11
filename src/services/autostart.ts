import { invoke, isTauri } from "@tauri-apps/api/core";

/** Flaga awaryjnego startu w oknie; obsługiwana przez setup Tauri w lib.rs. */
export const SAFE_MODE_FLAG = "--windowed";

/** Komunikat używany wszędzie tam, gdzie autostart nie jest dostępny. */
export const AUTOSTART_UNAVAILABLE_REASON =
  "Autostart jest dostępny tylko w natywnej aplikacji Windows.";

export type AutostartStatus = {
  windows: boolean;
  supported: boolean;
  enabled: boolean;
  windowed: boolean;
  lastError: string | null;
};

export type StartupMode = {
  windowed: boolean;
  autostartEnabled: boolean;
};

/** Bezpieczny stan na czas ładowania oraz dla podglądu WWW (poza Tauri). */
export const disabledAutostartStatus: AutostartStatus = {
  windows: false,
  supported: false,
  enabled: false,
  windowed: false,
  lastError: AUTOSTART_UNAVAILABLE_REASON,
};

export const disabledStartupMode: StartupMode = {
  windowed: false,
  autostartEnabled: false,
};

/** Mapuje dowolną przyczynę błędu na czytelny komunikat po polsku. */
export function autostartErrorMessage(
  cause: unknown,
  fallback = "Nie udało się zmienić ustawień autostartu.",
): string {
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof (cause as { message: unknown }).message === "string" &&
    (cause as { message: string }).message
  ) {
    return (cause as { message: string }).message;
  }
  return fallback;
}

/** Odczyt jest zawsze bezpieczny i tylko do odczytu — nigdy nie zapisuje do systemu. */
export async function getAutostartStatus(): Promise<AutostartStatus> {
  if (!isTauri()) return { ...disabledAutostartStatus };
  return invoke<AutostartStatus>("get_autostart_status");
}

/**
 * Jedyne miejsce, które może zmienić system: wywołanie jest wynikiem
 * świadomego kliknięcia przełącznika przez użytkownika (opt-in).
 */
export async function setAutostartEnabled(
  enabled: boolean,
  windowed: boolean,
): Promise<AutostartStatus> {
  if (!isTauri()) throw new Error(AUTOSTART_UNAVAILABLE_REASON);
  return invoke<AutostartStatus>("set_autostart_enabled", { enabled, windowed });
}

/** Informuje, czy bieżący proces wystartował z flagą --windowed. */
export async function getStartupMode(): Promise<StartupMode> {
  if (!isTauri()) return { ...disabledStartupMode };
  return invoke<StartupMode>("get_startup_mode");
}
