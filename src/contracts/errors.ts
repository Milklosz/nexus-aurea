/**
 * VELORA 1.0 — Ecosystem / stabilny kontrakt błędów (moduł F).
 *
 * Warstwa czysto typowana: brak zależności od UI, Tauri, DOM i platformy.
 * Celem jest, aby przyszły frontend (dowolny model/framework) mógł zostać
 * przebudowany bez przepisywania backendu — błędy zawsze mają ten sam kształt.
 *
 * Zasada: `message` jest bezpiecznym, czytelnym komunikatem dla użytkownika
 * (po polsku). `cause` to zsanityzowana diagnoza, NIGDY surowy stos wywołań,
 * ścieżka systemowa, token ani sekret.
 */

export type VeloraErrorCode =
  | "unavailable"
  | "invalid-manifest"
  | "file-access"
  | "invalid-path"
  | "launch-failed"
  | "edge-error"
  | "duplicate-launch"
  | "duplicate-window"
  | "remote-disconnected"
  | "remote-timeout"
  | "remote-replay"
  | "remote-ack-missing"
  | "autostart-invalid"
  | "app-close-unconfirmed"
  | "foreign-process"
  | "unknown";

export const VELORA_ERROR_CODES = [
  "unavailable",
  "invalid-manifest",
  "file-access",
  "invalid-path",
  "launch-failed",
  "edge-error",
  "duplicate-launch",
  "duplicate-window",
  "remote-disconnected",
  "remote-timeout",
  "remote-replay",
  "remote-ack-missing",
  "autostart-invalid",
  "app-close-unconfirmed",
  "foreign-process",
  "unknown",
] as const satisfies readonly VeloraErrorCode[];

const VELORA_ERROR_CODE_SET: ReadonlySet<string> = new Set(VELORA_ERROR_CODES);

export interface VeloraError {
  readonly code: VeloraErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly cause: string | null;
}

/** Usuwa znaki sterujące i ogranicza długość diagnozy. */
export function sanitizeCause(cause: string | null): string | null {
  if (cause === null) return null;
  const trimmed = cause.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 240);
}

export function veloraError(
  code: VeloraErrorCode,
  message: string,
  recoverable = false,
  cause: string | null = null,
): VeloraError {
  return { code, message, recoverable, cause: sanitizeCause(cause) };
}

export function isVeloraError(value: unknown): value is VeloraError {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    VELORA_ERROR_CODE_SET.has(record.code) &&
    typeof record.message === "string" &&
    typeof record.recoverable === "boolean"
  );
}

/** Bezpieczna ekstrakcja wiadomości z nieznanej przyczyny (bez wycieku stosu). */
export function messageFromUnknown(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return null;
}

export function toVeloraError(
  value: unknown,
  fallback = "Wystąpił nieoczekiwany błąd VELORA.",
): VeloraError {
  if (isVeloraError(value)) return value;
  return veloraError("unknown", fallback, false, messageFromUnknown(value));
}
