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

// ===== Diagnostyka i odzyskiwanie (tylko do odczytu) =====
// Nowe komendy Tauri wyłącznie raportują stan istniejącego wpisu. Żadna z nich
// nie zapisuje do systemu — odświeżenie wpisu pozostaje po stronie użytkownika
// (istniejący przełącznik opt-in setAutostartEnabled).

/** Kształt odpowiedzi `get_autostart_diagnostics` (camelCase z Rust). */
export type AutostartDiagnostics = {
  windows: boolean;
  supported: boolean;
  healthy: boolean;
  pathValid: boolean;
  commandValid: boolean;
  issues: string[];
  lastError: string | null;
  checkedAt: string;
};

/** Kształt odpowiedzi `get_autostart_recovery` (camelCase z Rust). */
export type AutostartRecoveryReport = {
  windows: boolean;
  supported: boolean;
  stale: boolean;
  recommendedAction: string;
  issues: string[];
  safeMode: boolean;
};

/** Bezpieczne wartości dla podglądu WWW (bez invoke, bez wyjątku). */
export const disabledAutostartDiagnostics: AutostartDiagnostics = {
  windows: false,
  supported: false,
  healthy: true,
  pathValid: true,
  commandValid: true,
  issues: [],
  lastError: null,
  checkedAt: "",
};

export const disabledAutostartRecovery: AutostartRecoveryReport = {
  windows: false,
  supported: false,
  stale: false,
  recommendedAction: AUTOSTART_UNAVAILABLE_REASON,
  issues: [],
  safeMode: false,
};

/** Akceptujemy wyłącznie czyste kody problemów (camelCase), nigdy surowe dane. */
const DIAGNOSTIC_CODE = /^[a-z][a-zA-Z0-9]*$/;

/** Wzorce, których nie wolno przepuszczać do komunikatu dla użytkownika. */
const FORBIDDEN_IN_MESSAGE = /os error|Error:|0x|\\|\/|:/i;

/** Zwraca czytelny, zsanityzowany tekst albo bezpieczny komunikat zapasowy. */
function safeMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!cleaned || FORBIDDEN_IN_MESSAGE.test(cleaned)) return fallback;
  return cleaned.slice(0, 240);
}

/** Ścisła walidacja odpowiedzi natywnej; każda nieprawidłowość -> bezpieczny fallback. */
function parseDiagnostics(raw: unknown): AutostartDiagnostics {
  const fallback = (): AutostartDiagnostics => ({ ...disabledAutostartDiagnostics });
  if (typeof raw !== "object" || raw === null) return fallback();
  const r = raw as Record<string, unknown>;
  const booleans = ["windows", "supported", "healthy", "pathValid", "commandValid"] as const;
  if (!booleans.every((key) => typeof r[key] === "boolean")) return fallback();
  if (typeof r.checkedAt !== "string") return fallback();
  if (r.lastError !== null && typeof r.lastError !== "string") return fallback();
  if (!Array.isArray(r.issues)) return fallback();
  const issues = r.issues as unknown[];
  if (!issues.every((item) => typeof item === "string" && DIAGNOSTIC_CODE.test(item))) {
    return fallback();
  }
  return {
    windows: r.windows as boolean,
    supported: r.supported as boolean,
    healthy: r.healthy as boolean,
    pathValid: r.pathValid as boolean,
    commandValid: r.commandValid as boolean,
    issues: (issues as string[]).filter((code) => DIAGNOSTIC_CODE.test(code)),
    lastError:
      r.lastError === null ? null : safeMessage(r.lastError, "Nie udało się odczytać stanu autostartu."),
    checkedAt: r.checkedAt as string,
  };
}

/** Ścisła walidacja odpowiedzi natywnej; każda nieprawidłowość -> bezpieczny fallback. */
function parseRecovery(raw: unknown): AutostartRecoveryReport {
  const fallback = (): AutostartRecoveryReport => ({ ...disabledAutostartRecovery });
  if (typeof raw !== "object" || raw === null) return fallback();
  const r = raw as Record<string, unknown>;
  const booleans = ["windows", "supported", "stale", "safeMode"] as const;
  if (!booleans.every((key) => typeof r[key] === "boolean")) return fallback();
  if (typeof r.recommendedAction !== "string") return fallback();
  if (!Array.isArray(r.issues)) return fallback();
  const issues = r.issues as unknown[];
  if (!issues.every((item) => typeof item === "string" && DIAGNOSTIC_CODE.test(item))) {
    return fallback();
  }
  return {
    windows: r.windows as boolean,
    supported: r.supported as boolean,
    stale: r.stale as boolean,
    recommendedAction: safeMessage(r.recommendedAction, AUTOSTART_UNAVAILABLE_REASON),
    issues: (issues as string[]).filter((code) => DIAGNOSTIC_CODE.test(code)),
    safeMode: r.safeMode as boolean,
  };
}

/** Diagnostyka stanu (tylko do odczytu) z bezpiecznym fallbackiem. */
export async function getAutostartDiagnostics(): Promise<AutostartDiagnostics> {
  if (!isTauri()) return { ...disabledAutostartDiagnostics };
  try {
    const raw = await invoke<unknown>("get_autostart_diagnostics");
    return parseDiagnostics(raw);
  } catch {
    return { ...disabledAutostartDiagnostics };
  }
}

/** Raport odzyskiwania (tylko do odczytu) z bezpiecznym fallbackiem. */
export async function getAutostartRecovery(): Promise<AutostartRecoveryReport> {
  if (!isTauri()) return { ...disabledAutostartRecovery };
  try {
    const raw = await invoke<unknown>("get_autostart_recovery");
    return parseRecovery(raw);
  } catch {
    return { ...disabledAutostartRecovery };
  }
}

const RECOVERY_REFRESH_GUIDANCE =
  "Wpis autostartu VELORA wymaga odświeżenia. Wyłącz i włącz autostart ponownie, aby go odświeżyć.";
const RECOVERY_HEALTHY =
  "Wpis autostartu VELORA jest poprawny. Nie są potrzebne żadne działania.";

/** Czysty, polski komunikat dla użytkownika — bez surowych ścieżek i błędów. */
export function autostartRecoveryMessage(report: AutostartRecoveryReport): string {
  if (!report.supported) return AUTOSTART_UNAVAILABLE_REASON;
  if (!report.stale) return RECOVERY_HEALTHY;
  // Nawet jeśli natywny raport zawiera techniczne szczegóły, gwarantujemy
  // stałą, czystą instrukcję odświeżenia — nigdy nie ujawniamy surowych danych.
  const action = safeMessage(report.recommendedAction, RECOVERY_REFRESH_GUIDANCE);
  return action.includes("odświeżyć") ? action : RECOVERY_REFRESH_GUIDANCE;
}

/** Zwięzłe podsumowanie dla przyszłego UI (nie modyfikuje AutostartPanel). */
export function autostartDiagnosticsSummary(d: AutostartDiagnostics): string {
  if (d.healthy && d.issues.length === 0) return "Autostart: poprawny";
  return `Autostart: wykryto ${d.issues.length} problemów`;
}
