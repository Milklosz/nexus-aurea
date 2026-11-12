/**
 * VELORA iPhone Remote 2.0 — MODULE C reliability primitives (PROTOTYPE).
 *
 * PURE, node-safe, injectable. NO `@tauri-apps` import at module top level,
 * NO DOM globals, NO network calls of its own, NO secret handling. The HMAC
 * payload format is NEVER touched: `signature` is carried unchanged and
 * `commandId` is only a deterministic correlation key.
 *
 * Wiring into the PWA / axum server is a PLAN, not applied. See
 * docs/iphone-remote-reliability-plan.md. Existing protocol/security code
 * (public/remote/app.js, src-tauri/src/remote_access.rs) is unchanged.
 */

import {
  idempotencyKey,
  actionAck,
  veloraError,
  toVeloraError,
  messageFromUnknown,
  VELORA_EVENTS,
  typedEvent,
} from "../contracts";
import type {
  RemoteState,
  RemoteCommandEnvelope,
  RemoteCommandAckPayload,
  RemoteTransportAdapter,
  ActionAck,
  TypedEvent,
  VeloraError,
  AdapterDescriptor,
} from "../contracts";

export const REMOTE_RELIABILITY_DESCRIPTOR: AdapterDescriptor = {
  id: "remote-reliability",
  kind: "remote",
  prototype: true,
};

/** Frozen, regression-asserted prefix. NEVER modify the real payload format. */
export const REMOTE_HMAC_PAYLOAD_PREFIX = "NEXUS-AUREA-REMOTE-V1" as const;

export const REMOTE_MAX_RECONNECT_ATTEMPTS = 8;

export interface RemoteCommandRequest {
  command: string;
  deviceId: string;
  sequence: number;
  signature: string;
}

export type RemoteReliabilityEvent =
  | "connected"
  | "paired"
  | "disconnected"
  | "wifi-lost"
  | "wifi-restored"
  | "timeout"
  | "replay-rejected"
  | "fatal"
  | "ack";

export function commandIdFor(deviceId: string, sequence: number): string {
  return idempotencyKey(["remote", deviceId, sequence]);
}

/** Pure exponential backoff + DETERMINISTIC jitter (NO Math.random), capped. */
export function reconnectDelayMs(attempt: number, base = 400, max = 10_000): number {
  const a = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  if (a >= REMOTE_MAX_RECONNECT_ATTEMPTS) return 0;
  const shift = Math.min(a, 30);
  const backoff = base * 2 ** shift;
  const floor = Math.floor(backoff);
  const jitter = floor > 0 ? (Math.imul(a + 1, 0x9e3779b1) >>> 0) % floor : 0;
  return Math.max(0, Math.min(backoff + jitter, max));
}

export function reduceRemoteState(state: RemoteState, event: RemoteReliabilityEvent): RemoteState {
  switch (event) {
    case "fatal":
    case "replay-rejected":
      return "error";
    case "wifi-lost":
      return "offline"; // commands SUSPENDED/queued, NOT auto-replayed
    case "wifi-restored":
      return "reconnecting";
    case "disconnected":
      return "disconnected";
    case "paired":
      return "paired"; // verified (re-)pairing signal
    case "connected":
    case "ack":
      // Only a trusted session in reconnecting/pairing may reach "paired".
      return state === "reconnecting" || state === "pairing" ? "paired" : state;
    case "timeout":
      if (state === "reconnecting") return "reconnecting";
      if (state === "pairing") return "disconnected";
      return state;
    default:
      return state;
  }
}

/**
 * Bounded FIFO command queue. NEVER auto-replays on reconnect: there is no
 * reconnect hook and dequeue() only removes — it never re-inserts.
 */
export class RemoteCommandQueue {
  private readonly items: RemoteCommandRequest[] = [];
  private readonly ids = new Set<string>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : 1;
  }

  enqueue(request: RemoteCommandRequest): { accepted: boolean; duplicate: boolean } {
    const id = commandIdFor(request.deviceId, request.sequence);
    if (this.ids.has(id)) return { accepted: false, duplicate: true };
    while (this.items.length >= this.capacity) {
      const oldest = this.items.shift();
      if (oldest) this.ids.delete(commandIdFor(oldest.deviceId, oldest.sequence));
    }
    this.items.push(request);
    this.ids.add(id);
    return { accepted: true, duplicate: false };
  }

  dequeue(): RemoteCommandRequest | null {
    const item = this.items.shift() ?? null;
    if (item) this.ids.delete(commandIdFor(item.deviceId, item.sequence));
    return item;
  }

  peek(): RemoteCommandRequest | null {
    return this.items[0] ?? null;
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.ids.clear();
  }

  has(commandId: string): boolean {
    return this.ids.has(commandId);
  }
}

/**
 * ALWAYS false. WHY: the server persists `last_sequence` BEFORE emit() in
 * authenticate_command. A lost command therefore burns its sequence number;
 * a retry with a fresh sequence is a NEW command (double action) and a retry
 * with the OLD sequence is rejected as a replay. Safe retry is impossible
 * until SERVER-SIDE idempotency exists — see docs/iphone-remote-reliability-plan.md.
 */
export function shouldReplayOnReconnect(_state: RemoteState): boolean {
  return false;
}

function ackKey(commandId: string): string {
  return idempotencyKey(["remote-ack", commandId]);
}

/** Pure, bounded ack correlation. `idempotencyKey` derives the ack keys. */
export class AckTracker {
  private readonly pending = new Map<string, number>();

  /**
   * `registeredAtMs` is optional so `register(commandId)` stays valid and the
   * primitive stays PURE (no hidden Date.now()); pass a deterministic clock
   * value when expiry checks are needed.
   */
  register(commandId: string, registeredAtMs = 0): string {
    const key = ackKey(commandId);
    if (!this.pending.has(key)) this.pending.set(key, registeredAtMs);
    return key;
  }

  resolve(commandId: string, payload: RemoteCommandAckPayload): ActionAck {
    const key = ackKey(commandId);
    this.pending.delete(key);
    return actionAck(
      payload.commandId,
      payload.executed ? "executed" : "rejected",
      key,
      payload.error,
      null,
    );
  }

  isPending(commandId: string): boolean {
    return this.pending.has(ackKey(commandId));
  }

  expired(commandId: string, nowMs: number, timeoutMs: number): boolean {
    const at = this.pending.get(ackKey(commandId));
    if (at === undefined) return false; // resolved / never registered
    return nowMs - at >= timeoutMs;
  }
}

function httpStatus(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const record = cause as Record<string, unknown>;
  if (typeof record.status === "number" && Number.isFinite(record.status)) return record.status;
  const response = record.response;
  if (typeof response === "object" && response !== null) {
    const nested = (response as Record<string, unknown>).status;
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }
  return null;
}

function errorLabel(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (typeof cause !== "object" || cause === null) return "";
  const record = cause as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of ["name", "code", "message", "reason"] as const) {
    const value = record[field];
    if (typeof value === "string") parts.push(value);
    else if (typeof value === "number") parts.push(String(value));
  }
  return parts.join(" ");
}

/**
 * Map transport failures to stable VeloraError codes. NO raw leaks: only a
 * sanitized diagnosis (never the stack / raw object) is attached as `cause`.
 */
export function classifyRemoteError(cause: unknown): VeloraError {
  const safe = messageFromUnknown(cause);
  const status = httpStatus(cause);
  if (status !== null) {
    if (status === 401) {
      return veloraError("remote-replay", "Polecenie odrzucone jako powtórzenie lub po odwołaniu dostępu.", false, safe);
    }
    if (status === 429) {
      return veloraError("remote-timeout", "Serwer pilota jest przeciążony.", true, safe);
    }
    if (status >= 500) {
      return veloraError("remote-disconnected", "Serwer pilota jest niedostępny.", true, safe);
    }
  }
  const label = errorLabel(cause);
  if (/abort|timeout|timed.?out|etimedout/i.test(label)) {
    return veloraError("remote-timeout", "Upłynął czas oczekiwania na potwierdzenie.", true, safe);
  }
  if (/network|failed to fetch|fetch failed|econnreset|econnrefused|enotfound|offline/i.test(label)) {
    return veloraError("remote-disconnected", "Utracono połączenie z serwerem pilota.", true, safe);
  }
  if (/ack.?missing|missing.?ack|brak.*potwierdzenia|remote-ack-missing/i.test(label)) {
    return veloraError("remote-ack-missing", "Serwer nie potwierdził wykonania polecenia.", false, safe);
  }
  return toVeloraError(cause, "Nieoczekiwany błąd połączenia pilota.");
}

/**
 * Derive a deterministic commandId; carry `signature` UNCHANGED. The HMAC
 * payload format (NEXUS-AUREA-REMOTE-V1 ...) is NEVER re-signed here.
 */
export function buildEnvelope(request: RemoteCommandRequest): RemoteCommandEnvelope {
  return {
    command: request.command,
    deviceId: request.deviceId,
    sequence: request.sequence,
    commandId: commandIdFor(request.deviceId, request.sequence),
    signature: request.signature,
  };
}

/** Own minimal type — do NOT rely on the DOM AbortSignal global. */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

export interface RemoteTransportDeps {
  send(
    request: RemoteCommandRequest,
    signal?: AbortSignalLike,
  ): Promise<{ commandId: string; executed: boolean }>;
  subscribe(listener: (event: TypedEvent<unknown>) => void): () => void;
  nowMs?: () => number;
  timeoutMs?: number;
}

/**
 * Prototype over injected transport; NOT wired to the PWA or server.
 * Wiring plan: docs/iphone-remote-reliability-plan.md.
 *
 * Uses an AckTracker, classifyRemoteError and an injected clock (nowMs /
 * timeoutMs) to return an ActionAck (executed / rejected / duplicate).
 * `subscribe` delegates to the injected transport and forwards its events.
 */
export function createRemoteTransportAdapter(deps: RemoteTransportDeps): RemoteTransportAdapter {
  const tracker = new AckTracker();
  const now = deps.nowMs ?? (() => 0);
  const timeout = deps.timeoutMs ?? 5_000;
  const listeners = new Set<(event: TypedEvent<unknown>) => void>();
  const broadcast = (event: TypedEvent<unknown>): void => {
    for (const listener of listeners) listener(event);
  };
  const ackEvent = (
    commandId: string,
    executed: boolean,
    error: VeloraError | null,
  ): TypedEvent<RemoteCommandAckPayload> =>
    typedEvent(VELORA_EVENTS.remoteCommandAck, { commandId, executed, error });

  return {
    id: REMOTE_RELIABILITY_DESCRIPTOR.id,
    async send(envelope: RemoteCommandEnvelope): Promise<ActionAck> {
      const commandId = envelope.commandId;
      const key = tracker.register(commandId, now());
      const request: RemoteCommandRequest = {
        command: envelope.command,
        deviceId: envelope.deviceId,
        sequence: envelope.sequence,
        signature: envelope.signature, // never re-signed
      };
      const signal: AbortSignalLike = { aborted: false };
      broadcast(typedEvent(VELORA_EVENTS.remoteCommandEnvelope, envelope));
      try {
        const result = await deps.send(request, signal);
        // Late ack: the injected clock advanced past the deadline while waiting.
        if (tracker.expired(commandId, now(), timeout)) {
          const error = veloraError("remote-timeout", "Potwierdzenie polecenia nie dotarło w czasie.", true, null);
          const ack = tracker.resolve(commandId, { commandId, executed: false, error });
          broadcast(ackEvent(commandId, false, error));
          return ack;
        }
        const resolved = tracker.resolve(commandId, {
          commandId: result.commandId,
          executed: result.executed,
          error: null,
        });
        const ack: ActionAck = result.executed
          ? resolved
          : actionAck(commandId, "duplicate", key, null, null);
        broadcast(ackEvent(commandId, result.executed, null));
        return ack;
      } catch (cause) {
        const error = classifyRemoteError(cause);
        const ack = tracker.resolve(commandId, { commandId, executed: false, error });
        broadcast(ackEvent(commandId, false, error));
        return ack;
      }
    },
    subscribe(listener: (event: TypedEvent<unknown>) => void): () => void {
      listeners.add(listener);
      const unsubscribeUpstream = deps.subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeUpstream();
      };
    },
  };
}

/**
 * Pairing lifecycle safety. After a reconnect / restart the app MUST verify
 * pairing with a signed hello before trusting `paired` (fixes the optimistic
 * pairing gap). Pure decision object — no storage access performed here.
 */
export function safePairingReset(): { clearStoredRecord: boolean; requireReverify: boolean } {
  return { clearStoredRecord: true, requireReverify: true };
}
