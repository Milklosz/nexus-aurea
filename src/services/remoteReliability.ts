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
  RemoteCommandOutcome,
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

/* ------------------------------------------------------------------------- *
 * Signed paired-state verification ("hello")
 *
 * Why reuse the device HMAC: the paired iPhone already holds one non-exportable
 * WebCrypto HMAC key (the same one that signs commands). A "hello" request and
 * its acknowledgment are MACs over fresh, non-sensitive fields using THAT key.
 * There is no second key, no certificate change and no key distribution step —
 * only a fresh client nonce per check. The LAN `/api/status` stays anonymous
 * (booleans/counts); `/api/hello` is authenticated and read-only.
 * ------------------------------------------------------------------------- */

export interface SignedHelloStatus {
  nonce: string;
  serverEpoch: number;
  pairedDeviceCount: number;
  /** base64url HMAC over the ack payload, made with the paired device token. */
  signature: string;
}

export interface SignedHelloVerification {
  deviceId: string;
  nonce: string;
  status: SignedHelloStatus;
  /** Computes HMAC-SHA256 over a payload with the paired device key. */
  computeMac: (payload: string) => Promise<Uint8Array>;
}

export function helloRequestPayload(deviceId: string, nonce: string): string {
  return `NEXUS-AUREA-REMOTE-V1\n${deviceId}\nhello\n${nonce}`;
}

export function helloAckPayload(
  deviceId: string,
  serverEpoch: number,
  pairedDeviceCount: number,
  nonce: string,
): string {
  return `NEXUS-AUREA-REMOTE-V1\n${deviceId}\nhello-ack\n${serverEpoch}\n${pairedDeviceCount}\n${nonce}`;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/**
 * Verifies a signed hello acknowledgment. FAILS CLOSED: the nonce must match
 * the one we sent, the epoch/count must be sane, and the MAC must cover exactly
 * the fields we bound. `computeMac` is injected (WebCrypto sign in the PWA).
 */
export async function verifySignedHello(input: SignedHelloVerification): Promise<boolean> {
  const { deviceId, nonce, status, computeMac } = input;
  if (!/^[0-9a-f]{32}$/.test(nonce) || status.nonce !== nonce) return false;
  if (!Number.isSafeInteger(status.serverEpoch) || status.serverEpoch <= 0) return false;
  if (!Number.isSafeInteger(status.pairedDeviceCount) || status.pairedDeviceCount < 1) return false;
  const received = decodeBase64Url(status.signature);
  if (!received || received.length !== 32) return false;
  const expected = await computeMac(
    helloAckPayload(deviceId, status.serverEpoch, status.pairedDeviceCount, nonce),
  );
  return constantTimeEquals(expected, received);
}

/** Bounded exponential backoff schedule for reconnect verification. */
export interface ReconnectVerificationResult {
  statusVerified: boolean;
  pairedVerified: boolean;
  attempts: number;
}

/**
 * Drives a reconnect: re-fetch status with bounded exponential backoff, then
 * re-verify the paired state with a FRESH signed hello (`verifyPaired` is
 * injected — the PWA supplies the real WebCrypto MAC over a fresh nonce).
 * The anonymous LAN status alone never marks a device "paired & trusted".
 *
 * NEVER replays a queued command: this driver has no command sink at all and
 * `shouldReplayOnReconnect` stays false. A 401 fails closed immediately.
 */
export async function verifyReconnect(deps: {
  maxAttempts: number;
  fetchStatus: () => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<{ enabled: boolean; pairedDeviceCount: number }>;
  }>;
  verifyPaired: () => Promise<boolean>;
  delayMs: (attempt: number) => number;
  wait: (ms: number) => Promise<void>;
}): Promise<ReconnectVerificationResult> {
  const maxAttempts = Math.max(1, Math.min(8, Math.floor(deps.maxAttempts)));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await deps.wait(deps.delayMs(attempt));
    try {
      const response = await deps.fetchStatus();
      if (response.status === 401) {
        return { statusVerified: false, pairedVerified: false, attempts: attempt + 1 };
      }
      if (!response.ok) continue;
      const body = await response.json();
      if (body.enabled !== true) continue;
      // Paired state is trusted ONLY after a separate authenticated verification.
      const pairedVerified = await deps.verifyPaired();
      return { statusVerified: true, pairedVerified, attempts: attempt + 1 };
    } catch {
      // Bounded retry with fail-closed semantics.
    }
  }
  return { statusVerified: false, pairedVerified: false, attempts: maxAttempts };
}

/* ------------------------------------------------------------------------- *
 * QR-assisted short-lived pairing
 *
 * The QR carries ONLY the HTTPS origin, the one-time 6-digit code and a short
 * `exp` hint — placed in the URL FRAGMENT so a browser never sends it in an
 * HTTP request and the server never writes it to an access log. No device id,
 * device token, CA key, signature or other credential is ever encoded here.
 * The server remains the sole authority on the code's bounded (<=60s),
 * single-use validity; `exp` is only a client-side prefill hint.
 * ------------------------------------------------------------------------- */

export type PairingBootstrap = {
  origin: string;
  code: string;
  /** Unix seconds (client-side hint only). */
  exp: number;
};

export function buildPairingBootstrapUrl(
  origin: string,
  code: string,
  expiresAtMs: number,
): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const exp = Math.floor(expiresAtMs / 1000);
  return `${cleanOrigin}/#pair=${code}&exp=${exp}`;
}

/** Parses ONLY the strict `https://host/#pair=NNNNNN&exp=UNIX` shape. */
export function parsePairingBootstrapUrl(value: string): PairingBootstrap | null {
  const match = /^(https:\/\/[^\/#]+)\/#pair=(\d{6})&exp=(\d{1,12})$/.exec(value);
  if (!match) return null;
  return { origin: match[1], code: match[2], exp: Number(match[3]) };
}

/** Seconds left on the one-time code, never negative. */
export function pairingRemainingSeconds(expiresAtMs: number, nowMs: number): number {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0 || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

export function formatPairingCountdown(seconds: number): string {
  return `${Math.max(0, Math.floor(seconds))}s`;
}

/* Minimal, self-contained QR encoder: byte mode, ECC level L, versions 1-6.
 * No dependency and no network/storage access — the input is the short
 * bootstrap URL built above. Kept small so it stays auditable. */

const QR_RAW_CODEWORDS: Readonly<Record<number, number>> = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172 };
const QR_ECC_PER_BLOCK: Readonly<Record<number, number>> = { 1: 7, 2: 10, 3: 15, 4: 20, 5: 26, 6: 18 };
const QR_NUM_BLOCKS: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 2 };
const QR_ALIGNMENT: Readonly<Record<number, readonly number[]>> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
};

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i += 1) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

function toUtf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

function qrCodewords(version: number, bytes: number[]): number[] {
  const raw = QR_RAW_CODEWORDS[version];
  const ecc = QR_ECC_PER_BLOCK[version];
  const blocks = QR_NUM_BLOCKS[version];
  const dataCapacity = raw - ecc * blocks;
  const bits: number[] = [];
  const append = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4); // byte mode
  append(bytes.length, 8);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, dataCapacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  for (let i = 0; data.length < dataCapacity; i += 1) data.push(i % 2 === 0 ? 0xec : 0x11);

  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(ecc);
  const blockList: number[][] = [];
  let offset = 0;
  for (let i = 0; i < blocks; i += 1) {
    const dataLen = shortLen - ecc + (i < shortBlocks ? 0 : 1);
    const blockData = data.slice(offset, offset + dataLen);
    offset += dataLen;
    const cell = blockData.slice();
    if (i < shortBlocks) cell.push(0); // alignment placeholder, skipped when interleaving
    cell.push(...rsRemainder(blockData, divisor));
    blockList.push(cell);
  }
  const result: number[] = [];
  for (let i = 0; i < blockList[0].length; i += 1) {
    for (let j = 0; j < blocks; j += 1) {
      if (i !== shortLen - ecc || j >= shortBlocks) result.push(blockList[j][i]);
    }
  }
  return result;
}

function qrMatrix(version: number, codewords: number[]): boolean[][] {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFunction = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  const positions = QR_ALIGNMENT[version];
  for (const y of positions) {
    for (const x of positions) {
      if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Format bits for ECC level L (format id 1) with fixed mask 0. A fixed,
  // declared mask is a valid QR code: decoders read the format info to undo it.
  const formatData = (1 << 3) | 0;
  let rem = formatData;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const formatBits = (((formatData << 10) | rem) ^ 0x5412) & 0x7fff;
  const formatBit = (index: number): boolean => ((formatBits >>> index) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) setFunction(8, i, formatBit(i));
  setFunction(8, 7, formatBit(6));
  setFunction(8, 8, formatBit(7));
  setFunction(7, 8, formatBit(8));
  for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, formatBit(i));
  for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, formatBit(i));
  for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, formatBit(i));
  setFunction(8, size - 8, true);

  let index = 0;
  let right = size - 1;
  while (right >= 1) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && index < codewords.length * 8) {
          modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
          index += 1;
        }
      }
    }
    right -= 2;
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunction[y][x] && (x + y) % 2 === 0) modules[y][x] = !modules[y][x];
    }
  }
  return modules;
}

/** Encodes text into a boolean QR module matrix (true = dark). */
export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = toUtf8Bytes(text);
  let version = 1;
  for (let v = 1; v <= 6; v += 1) {
    version = v;
    const capacity = QR_RAW_CODEWORDS[v] - QR_ECC_PER_BLOCK[v] * QR_NUM_BLOCKS[v];
    if (bytes.length + 2 <= capacity) break;
  }
  const capacity = QR_RAW_CODEWORDS[version] - QR_ECC_PER_BLOCK[version] * QR_NUM_BLOCKS[version];
  if (bytes.length + 2 > capacity) throw new Error("QR payload too large for the supported versions.");
  return qrMatrix(version, qrCodewords(version, bytes));
}

/* ------------------------------------------------------------------------- *
 * Phase 3 (Ascension D) — FAIL-CLOSED outbound command policy.
 *
 * Why this shape: the server persists `last_sequence` BEFORE emitting the side
 * effect and keeps a bounded receipt log, so re-sending the EXACT same signed
 * request (same `sequence` + same `signature`) can never cause a second side
 * effect — the server answers 2xx (receipt dedup), 409 (ambiguous) or 401
 * (reject), never a second execution. Minting a NEW sequence for the same user
 * intent WOULD be a new command (double action). Therefore:
 *
 *   - an automatic retry MUST reuse the identical signed bytes (never re-sign,
 *     never increment the sequence) and is allowed ONLY when the failure proves
 *     the request never reached the server;
 *   - an ambiguous timeout AFTER the send (our own AbortController deadline)
 *     must NOT be auto-retried — the command is marked "unknown" and requires
 *     explicit user re-confirmation (which re-sends the same signed bytes).
 *
 * The HMAC payload format (`NEXUS-AUREA-REMOTE-V1` prefix, HMAC-SHA256,
 * monotonic sequence) is NEVER touched here: `signature` is carried unchanged.
 * ------------------------------------------------------------------------- */

/** Bounded number of AUTOMATIC retries — only for provably never-sent requests. */
export const REMOTE_MAX_AUTO_RETRIES = 3;

/**
 * Why one outbound attempt failed.
 *  - `never-reached`: the request provably never reached the server (browser
 *    offline at attempt time, or a DNS / connect-refused network error before
 *    any byte was accepted by a server). Safe to auto-retry the SAME bytes.
 *  - `ambiguous`: the request was handed to the network and the outcome is
 *    unknown (our deadline fired after send, or any other post-send loss).
 *    NEVER auto-retried — marked "unknown" instead.
 */
export type OutboundFailureKind = "never-reached" | "ambiguous";

/**
 * Classify a thrown transport failure. Fail-closed: while online, only a
 * network-level error (DNS / connect refused — "Failed to fetch"-class) counts
 * as never-reached; our own abort/timeout after send is ambiguous. Anything
 * else online is treated as ambiguous too.
 */
export function classifyOutboundFailure(cause: unknown, online: boolean): OutboundFailureKind {
  // The browser's own offline flag is the strongest proof: no packet can leave.
  if (!online) return "never-reached";
  const label = errorLabel(cause);
  if (/abort|timeout|timed.?out/i.test(label)) return "ambiguous"; // deadline fired after send
  if (/network|failed to fetch|fetch failed|econnreset|econnrefused|enotfound|dns/i.test(label)) {
    return "never-reached"; // DNS / connect refused before send
  }
  return "ambiguous"; // post-send uncertain — fail closed
}

/** Map the server's EXISTING bare HTTP status to a client-side outcome. */
export function outcomeForStatus(status: number): RemoteCommandOutcome {
  if (status === 401) return "replay-rejected";
  if (status === 409) return "ambiguous";
  if (status === 429) return "rate-limited";
  if (status >= 200 && status < 300) return "executed";
  return "unavailable";
}

/**
 * The ONLY policy that permits an automatic retry: the failure proved the
 * request never reached the server AND the bounded attempt budget remains.
 * Ambiguous-after-send is never auto-retried.
 */
export function shouldAutoRetry(
  failure: OutboundFailureKind,
  attempt: number,
  maxAttempts: number = REMOTE_MAX_AUTO_RETRIES,
): boolean {
  return failure === "never-reached" && Number.isFinite(attempt) && attempt >= 0 && attempt < maxAttempts;
}

/** Bounded exponential backoff for automatic never-reached retries (same bytes). */
export function autoRetryDelayMs(attempt: number, base = 200, max = 1_600): number {
  return reconnectDelayMs(Math.max(0, Math.floor(attempt)), base, max);
}

/** A prepared outbound command: sequence reserved + payload signed ONCE. */
export interface PreparedOutboundCommand {
  command: string;
  deviceId: string;
  sequence: number;
  /** base64url HMAC-SHA256 — carried unchanged, NEVER re-signed on retry. */
  signature: string;
}

export type OutboundEntryState = "queued" | "sending" | "unknown" | "settled";

export interface OutboundCommandEntry extends PreparedOutboundCommand {
  readonly commandId: string;
  attempts: number;
  state: OutboundEntryState;
}

export interface OutboundPipelineDeps {
  /** Reserves the next sequence and signs the payload exactly once. */
  prepare(command: string): Promise<PreparedOutboundCommand | null>;
  /** One HTTP attempt. Resolves with the HTTP status; throws on transport failure. */
  dispatch(prepared: PreparedOutboundCommand): Promise<number>;
  /** Browser connectivity — the proof used by classifyOutboundFailure. */
  online(): boolean;
  /** Injectable wait (backoff between never-reached retries). */
  wait?(ms: number): Promise<void>;
  nowMs?(): number;
  maxAutoRetries?: number;
  onSettle?(entry: OutboundCommandEntry, outcome: RemoteCommandOutcome | "unknown", attempts: number): void;
}

/**
 * Wires the existing primitives (RemoteCommandQueue dedup by commandId,
 * AckTracker correlation, reconnectDelayMs backoff) into the fail-closed
 * outbound policy. Single in-flight: `pump()` never dispatches two entries at
 * once. Wi-Fi loss keeps entries QUEUED (never auto-replayed as a retry of a
 * sent request); ambiguous-after-send entries move to "unknown" and are only
 * re-sent through explicit `reconfirm()` with the SAME signed bytes.
 */
export class RemoteOutboundPipeline {
  private readonly queue = new RemoteCommandQueue(32);
  private readonly entries = new Map<string, OutboundCommandEntry>();
  private readonly acks = new AckTracker();
  private readonly deps: OutboundPipelineDeps;
  private readonly maxAutoRetries: number;
  private readonly now: () => number;
  private inFlight = false;

  constructor(deps: OutboundPipelineDeps) {
    this.deps = deps;
    this.maxAutoRetries = Math.max(0, Math.floor(deps.maxAutoRetries ?? REMOTE_MAX_AUTO_RETRIES));
    this.now = deps.nowMs ?? (() => 0);
  }

  get pendingCount(): number {
    return this.queue.size();
  }

  get inFlightNow(): boolean {
    return this.inFlight;
  }

  unknownCommands(): readonly OutboundCommandEntry[] {
    return [...this.entries.values()].filter((entry) => entry.state === "unknown");
  }

  entryFor(commandId: string): OutboundCommandEntry | undefined {
    return this.entries.get(commandId);
  }

  /** Prepare + enqueue. Dedup is by commandId (deviceId, sequence). */
  async enqueue(command: string): Promise<{ accepted: boolean; duplicate: boolean }> {
    const prepared = await this.deps.prepare(command);
    if (!prepared) return { accepted: false, duplicate: false };
    const commandId = commandIdFor(prepared.deviceId, prepared.sequence);
    if (this.entries.has(commandId)) return { accepted: false, duplicate: true };
    const entry: OutboundCommandEntry = { ...prepared, commandId, attempts: 0, state: "queued" };
    const request: RemoteCommandRequest = {
      command: prepared.command,
      deviceId: prepared.deviceId,
      sequence: prepared.sequence,
      signature: prepared.signature,
    };
    const result = this.queue.enqueue(request);
    if (!result.accepted) return { accepted: false, duplicate: result.duplicate };
    this.entries.set(commandId, entry);
    this.acks.register(commandId, this.now());
    return { accepted: true, duplicate: false };
  }

  /** Drain the queue, one in-flight request at a time, while online. */
  async pump(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.queue.size() > 0 && this.deps.online()) {
        const request = this.queue.peek();
        if (!request) break;
        const commandId = commandIdFor(request.deviceId, request.sequence);
        const entry = this.entries.get(commandId);
        if (!entry || entry.state !== "queued") {
          this.queue.dequeue();
          continue;
        }
        entry.state = "sending";
        await this.dispatchEntry(entry, request);
        // Only remove the entry when it left the queue (settled / unknown).
        // A Wi-Fi loss re-queues it: it stays in front for the next pump.
        if ((entry.state as OutboundEntryState) !== "queued") this.queue.dequeue();
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Explicit user re-confirmation of an "unknown" command: re-sends the SAME
   * signed request (same sequence + signature) exactly once through the same
   * policy. The server can only answer dedup-2xx / 409 / 401 — never a second
   * side effect.
   */
  async reconfirm(commandId: string): Promise<boolean> {
    const entry = this.entries.get(commandId);
    if (!entry || entry.state !== "unknown") return false;
    if (this.inFlight || !this.deps.online()) return false;
    this.inFlight = true;
    try {
      entry.state = "sending";
      await this.dispatchEntry(entry, {
        command: entry.command,
        deviceId: entry.deviceId,
        sequence: entry.sequence,
        signature: entry.signature,
      });
      return true;
    } finally {
      this.inFlight = false;
    }
  }

  private async dispatchEntry(entry: OutboundCommandEntry, request: RemoteCommandRequest): Promise<void> {
    const commandId = entry.commandId;
    const wait = this.deps.wait ?? (async () => {});
    while (true) {
      if (!this.deps.online()) {
        // Wi-Fi loss: the entry stays QUEUED (it may never have been sent); it is
        // sent only after a verified reconnect — never treated as ambiguous.
        entry.state = "queued";
        return;
      }
      try {
        const status = await this.deps.dispatch(request);
        const outcome = outcomeForStatus(status);
        const settledAsUnknown = outcome === "ambiguous";
        entry.state = settledAsUnknown ? "unknown" : "settled";
        this.acks.resolve(commandId, {
          commandId,
          executed: outcome === "executed",
          error: outcome === "executed" ? null : veloraError("remote-ack-missing", "Polecenie niepotwierdzone.", false, null),
        });
        this.deps.onSettle?.(entry, settledAsUnknown ? "unknown" : outcome, entry.attempts);
        return;
      } catch (cause) {
        if (!this.deps.online()) {
          // Wi-Fi loss mid-flight: the request may never have been sent. The
          // entry stays QUEUED for a verified reconnect — NOT marked unknown.
          entry.state = "queued";
          return;
        }
        const failure = classifyOutboundFailure(cause, true);
        if (shouldAutoRetry(failure, entry.attempts, this.maxAutoRetries)) {
          entry.attempts += 1;
          // SAME request — identical sequence + signature, never re-signed.
          await wait(autoRetryDelayMs(entry.attempts));
          continue;
        }
        // Ambiguous after send: NEVER auto-retried; requires explicit re-confirmation.
        entry.state = "unknown";
        this.acks.resolve(commandId, {
          commandId,
          executed: false,
          error: classifyRemoteError(cause),
        });
        this.deps.onSettle?.(entry, "unknown", entry.attempts);
        return;
      }
    }
  }
}
