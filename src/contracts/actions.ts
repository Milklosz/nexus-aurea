/**
 * VELORA 1.0 — Ecosystem / typowane akcje pilota i potwierdzenia (moduł F / E).
 *
 * Każda akcja niosąca skutek uboczny ma `requestId`, dzięki czemu potwierdzenie
 * wykonania (`ActionAck`) i idempotencja mogą być korelowane bez zmiany protokołu
 * HMAC / replay protection po stronie iPhone Remote.
 */

import type { VeloraError } from "./errors";

export type VeloraAction =
  | { readonly type: "app.launch"; readonly appId: string; readonly requestId: string }
  | { readonly type: "app.close.request"; readonly sessionId: string; readonly requestId: string }
  | { readonly type: "app.close.confirm"; readonly sessionId: string; readonly token: string }
  | { readonly type: "app.close.cancel"; readonly sessionId: string }
  | { readonly type: "app.focus"; readonly sessionId: string }
  | { readonly type: "navigation.back" }
  | { readonly type: "navigation.escape" }
  | { readonly type: "navigation.home" }
  | { readonly type: "display.fullscreen"; readonly enabled: boolean }
  | {
      readonly type: "remote.command";
      readonly command: string;
      readonly requestId: string;
      readonly sequence: number;
      readonly deviceId: string;
    }
  | { readonly type: "status.refresh" };

export type VeloraActionType = VeloraAction["type"];

export type ActionResultStatus =
  | "accepted"
  | "executed"
  | "rejected"
  | "duplicate"
  | "pending-confirmation"
  | "not-applicable";

export interface ActionAck {
  readonly requestId: string;
  readonly status: ActionResultStatus;
  readonly idempotencyKey: string;
  readonly error: VeloraError | null;
  readonly completedAt: string | null;
}

/**
 * Deterministyczny, stabilny klucz idempotencji (FNV-1a 32-bit).
 * Czysty, bez zależności, bez kryptografii — nie jest to podpis ani token.
 */
export function idempotencyKey(parts: readonly (string | number)[]): string {
  const joined = parts.join("\u001f");
  let hash = 0x811c9dc5;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `velora-${hash.toString(16).padStart(8, "0")}`;
}

export function actionAck(
  requestId: string,
  status: ActionResultStatus,
  key: string,
  error: VeloraError | null = null,
  completedAt: string | null = null,
): ActionAck {
  return { requestId, status, idempotencyKey: key, error, completedAt };
}

export function isIdempotentDuplicate(previous: ActionAck, next: ActionAck): boolean {
  return (
    previous.idempotencyKey === next.idempotencyKey &&
    previous.status === "executed" &&
    next.status === "duplicate"
  );
}
