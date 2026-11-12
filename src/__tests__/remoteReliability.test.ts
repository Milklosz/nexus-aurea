import { describe, expect, it } from "vitest";
import {
  REMOTE_RELIABILITY_DESCRIPTOR,
  REMOTE_HMAC_PAYLOAD_PREFIX,
  REMOTE_MAX_RECONNECT_ATTEMPTS,
  commandIdFor,
  reconnectDelayMs,
  reduceRemoteState,
  RemoteCommandQueue,
  shouldReplayOnReconnect,
  AckTracker,
  classifyRemoteError,
  buildEnvelope,
  createRemoteTransportAdapter,
  safePairingReset,
  type RemoteCommandRequest,
  type RemoteReliabilityEvent,
} from "../services/remoteReliability";
import { idempotencyKey, typedEvent, VELORA_EVENTS, veloraError } from "../contracts";
import type { RemoteState, TypedEvent } from "../contracts";

describe("iPhone Remote reliability primitives (prototype)", () => {
  it("REMOTE_RELIABILITY_DESCRIPTOR marks the adapter as a prototype", () => {
    expect(REMOTE_RELIABILITY_DESCRIPTOR).toEqual({
      id: "remote-reliability",
      kind: "remote",
      prototype: true,
    });
  });

  it("REMOTE_HMAC_PAYLOAD_PREFIX locks the frozen HMAC payload format", () => {
    expect(REMOTE_HMAC_PAYLOAD_PREFIX).toBe("NEXUS-AUREA-REMOTE-V1");
  });

  it("commandIdFor is stable and collision-free", () => {
    expect(commandIdFor("dev", 1)).toBe(idempotencyKey(["remote", "dev", 1]));
    expect(commandIdFor("dev", 1)).toBe(commandIdFor("dev", 1));
    expect(commandIdFor("dev", 1)).not.toBe(commandIdFor("dev", 2));
    expect(commandIdFor("dev", 1)).not.toBe(commandIdFor("other", 1));
    const ids = new Set<string>();
    for (let sequence = 0; sequence < 64; sequence += 1) {
      ids.add(commandIdFor("device-x", sequence));
    }
    expect(ids.size).toBe(64);
  });

  it("reconnectDelayMs is deterministic, capped, and zero after max attempts", () => {
    expect(reconnectDelayMs(3)).toBe(reconnectDelayMs(3));
    for (let attempt = 0; attempt < REMOTE_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      const delay = reconnectDelayMs(attempt);
      expect(delay).toBeLessThanOrEqual(10_000);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
    expect(reconnectDelayMs(REMOTE_MAX_RECONNECT_ATTEMPTS)).toBe(0);
    expect(reconnectDelayMs(REMOTE_MAX_RECONNECT_ATTEMPTS + 5)).toBe(0);
    for (let attempt = 1; attempt < REMOTE_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      expect(reconnectDelayMs(attempt)).toBeGreaterThanOrEqual(reconnectDelayMs(attempt - 1));
    }
    expect(reconnectDelayMs(2, 400, 1_000)).toBeLessThanOrEqual(1_000);
  });

  it("reduceRemoteState covers the full Wi-Fi / pairing / error matrix", () => {
    // Wi-Fi loss suspends, restore begins reconnect, then a verified signal re-pairs.
    expect(reduceRemoteState("paired", "wifi-lost")).toBe("offline");
    expect(reduceRemoteState("offline", "wifi-restored")).toBe("reconnecting");
    expect(reduceRemoteState("reconnecting", "connected")).toBe("paired");
    expect(reduceRemoteState("reconnecting", "ack")).toBe("paired");
    expect(reduceRemoteState("pairing", "connected")).toBe("paired");
    // ack/connected reach paired ONLY from reconnecting/pairing.
    expect(reduceRemoteState("disconnected", "connected")).toBe("disconnected");
    expect(reduceRemoteState("offline", "ack")).toBe("offline");
    expect(reduceRemoteState("error", "connected")).toBe("error");
    // the "paired" event completes (re-)pairing.
    expect(reduceRemoteState("pairing", "paired")).toBe("paired");
    // fatal / replay-rejected -> error, disconnected -> disconnected.
    expect(reduceRemoteState("paired", "fatal")).toBe("error");
    expect(reduceRemoteState("reconnecting", "replay-rejected")).toBe("error");
    expect(reduceRemoteState("paired", "disconnected")).toBe("disconnected");
    // every event in the union is handled without throwing.
    const events: RemoteReliabilityEvent[] = [
      "connected", "paired", "disconnected", "wifi-lost", "wifi-restored",
      "timeout", "replay-rejected", "fatal", "ack",
    ];
    for (const event of events) {
      expect(["disconnected", "pairing", "paired", "reconnecting", "offline", "error"]).toContain(
        reduceRemoteState("reconnecting", event),
      );
    }
  });

  it("shouldReplayOnReconnect is ALWAYS false", () => {
    const states = [
      "disconnected", "pairing", "paired", "reconnecting", "offline", "error",
    ] as const satisfies readonly RemoteState[];
    for (const state of states) expect(shouldReplayOnReconnect(state)).toBe(false);
  });

  it("RemoteCommandQueue is bounded FIFO, suppresses duplicates, and never auto-replays", () => {
    const queue = new RemoteCommandQueue(3);
    const a: RemoteCommandRequest = { command: "home", deviceId: "dev", sequence: 1, signature: "s1" };
    const b: RemoteCommandRequest = { command: "up", deviceId: "dev", sequence: 2, signature: "s2" };
    const c: RemoteCommandRequest = { command: "down", deviceId: "dev", sequence: 3, signature: "s3" };
    expect(queue.enqueue(a)).toEqual({ accepted: true, duplicate: false });
    expect(queue.enqueue(b)).toEqual({ accepted: true, duplicate: false });
    expect(queue.enqueue(c)).toEqual({ accepted: true, duplicate: false });
    expect(queue.size()).toBe(3);
    expect(queue.peek()).toBe(a);
    // duplicate by (deviceId, sequence) — even with a different command/signature.
    const dup: RemoteCommandRequest = { command: "mute", deviceId: "dev", sequence: 2, signature: "DIFFERENT" };
    expect(queue.enqueue(dup)).toEqual({ accepted: false, duplicate: true });
    expect(queue.size()).toBe(3);
    expect(queue.has(commandIdFor("dev", 2))).toBe(true);
    // FIFO order, then empty — dequeue never re-inserts (NO auto-replay).
    expect(queue.dequeue()).toBe(a);
    expect(queue.dequeue()).toBe(b);
    expect(queue.dequeue()).toBe(c);
    expect(queue.dequeue()).toBeNull();
    expect(queue.size()).toBe(0);
  });

  it("RemoteCommandQueue evicts oldest when over capacity and clears", () => {
    const queue = new RemoteCommandQueue(2);
    const r1: RemoteCommandRequest = { command: "home", deviceId: "dev", sequence: 1, signature: "s" };
    const r2: RemoteCommandRequest = { command: "up", deviceId: "dev", sequence: 2, signature: "s" };
    const r3: RemoteCommandRequest = { command: "down", deviceId: "dev", sequence: 3, signature: "s" };
    queue.enqueue(r1);
    queue.enqueue(r2);
    queue.enqueue(r3);
    expect(queue.size()).toBe(2);
    expect(queue.peek()).toBe(r2); // oldest (r1) evicted
    expect(queue.has(commandIdFor("dev", 1))).toBe(false);
    expect(queue.has(commandIdFor("dev", 3))).toBe(true);
    expect(queue.enqueue(r1).accepted).toBe(true); // evicted id can be re-enqueued
    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.dequeue()).toBeNull();
    expect(queue.has(commandIdFor("dev", 2))).toBe(false);
  });

  it("AckTracker registers, resolves to an ActionAck, and expires deterministically", () => {
    const tracker = new AckTracker();
    const id = "cmd-abc";
    const key = tracker.register(id, 1_000);
    expect(key).toBe(idempotencyKey(["remote-ack", id]));
    expect(tracker.isPending(id)).toBe(true);
    expect(tracker.expired(id, 1_400, 1_000)).toBe(false);
    expect(tracker.expired(id, 2_000, 1_000)).toBe(true);
    const ack = tracker.resolve(id, { commandId: id, executed: true, error: null });
    expect(ack.requestId).toBe(id);
    expect(ack.status).toBe("executed");
    expect(ack.idempotencyKey).toBe(key);
    expect(tracker.isPending(id)).toBe(false);
    expect(tracker.expired(id, 9_999, 1_000)).toBe(false); // resolved -> not expired
    tracker.register(id, 0);
    const rejected = tracker.resolve(id, { commandId: id, executed: false, error: null });
    expect(rejected.status).toBe("rejected");
  });

  it("classifyRemoteError maps failures to stable codes without raw leaks", () => {
    expect(classifyRemoteError({ status: 401 }).code).toBe("remote-replay");
    expect(classifyRemoteError({ status: 429 }).code).toBe("remote-timeout");
    expect(classifyRemoteError({ status: 503 }).code).toBe("remote-disconnected");
    expect(classifyRemoteError({ name: "AbortError" }).code).toBe("remote-timeout");
    expect(classifyRemoteError({ name: "TimeoutError" }).code).toBe("remote-timeout");
    expect(classifyRemoteError({ name: "TypeError", message: "fetch failed" }).code).toBe("remote-disconnected");
    expect(classifyRemoteError({ code: "ECONNRESET" }).code).toBe("remote-disconnected");
    expect(classifyRemoteError({ code: "remote-ack-missing" }).code).toBe("remote-ack-missing");
    expect(classifyRemoteError(veloraError("remote-ack-missing", "brak")).code).toBe("remote-ack-missing");
    expect(classifyRemoteError({ foo: "bar" }).code).toBe("unknown");
    expect(classifyRemoteError("some string").code).toBe("unknown");

    // No raw leak: a secret placed only in the stack never reaches the error.
    const err = new Error("connection dropped");
    err.stack = "Error: connection dropped\n at /Users/secret/HMACKEY=abcd";
    const result = classifyRemoteError(err);
    expect(JSON.stringify(result)).not.toContain("HMACKEY");
    expect(result.cause).not.toContain("/Users/secret");
    expect(typeof result.message).toBe("string");
    expect(typeof result.recoverable).toBe("boolean");
  });

  it("buildEnvelope preserves the signature byte-for-byte and derives a stable commandId", () => {
    const request: RemoteCommandRequest = {
      command: "home",
      deviceId: "dev",
      sequence: 42,
      signature: "MEUCIQD-example-signature==",
    };
    const envelope = buildEnvelope(request);
    expect(envelope.signature).toBe(request.signature); // UNCHANGED, never re-signed
    expect(envelope.commandId).toBe(commandIdFor("dev", 42));
    expect(envelope.commandId).toBe(idempotencyKey(["remote", "dev", 42]));
    expect(envelope.deviceId).toBe("dev");
    expect(envelope.sequence).toBe(42);
    expect(envelope.command).toBe("home");
    expect(buildEnvelope(request).commandId).toBe(envelope.commandId);
    expect(buildEnvelope({ ...request, signature: "TOTALLY-DIFFERENT" }).commandId).toBe(envelope.commandId);
  });

  it("safePairingReset requires re-verification of pairing after reconnect", () => {
    expect(safePairingReset()).toEqual({ clearStoredRecord: true, requireReverify: true });
  });
});

describe("createRemoteTransportAdapter (prototype over injected deps)", () => {
  function envelope() {
    return buildEnvelope({ command: "home", deviceId: "dev", sequence: 1, signature: "sig" });
  }

  it("returns an executed ActionAck on success", async () => {
    const adapter = createRemoteTransportAdapter({
      send: async () => ({ commandId: "c", executed: true }),
      subscribe: () => () => {},
    });
    const ack = await adapter.send(envelope());
    expect(ack.status).toBe("executed");
    expect(ack.error).toBeNull();
    expect(adapter.id).toBe("remote-reliability");
  });

  it("returns a duplicate ActionAck when the server reports an idempotent hit", async () => {
    const adapter = createRemoteTransportAdapter({
      send: async () => ({ commandId: "c", executed: false }),
      subscribe: () => () => {},
    });
    const ack = await adapter.send(envelope());
    expect(ack.status).toBe("duplicate");
  });

  it("returns a rejected ActionAck with a classified error on failure", async () => {
    const adapter = createRemoteTransportAdapter({
      send: async () => {
        throw { status: 401 };
      },
      subscribe: () => () => {},
    });
    const ack = await adapter.send(envelope());
    expect(ack.status).toBe("rejected");
    expect(ack.error?.code).toBe("remote-replay");
  });

  it("returns a timeout ack when the injected clock exceeds the ack deadline", async () => {
    let call = 0;
    const adapter = createRemoteTransportAdapter({
      send: async () => ({ commandId: "c", executed: true }),
      subscribe: () => () => {},
      nowMs: () => (call++ === 0 ? 0 : 10_000),
      timeoutMs: 5_000,
    });
    const ack = await adapter.send(envelope());
    expect(ack.status).toBe("rejected");
    expect(ack.error?.code).toBe("remote-timeout");
  });

  it("subscribe delegates and forwards injected transport events", () => {
    // Holder object: assignments made inside a closure are not tracked by TS's
    // control-flow narrowing for a bare `let`, which would narrow `upstream` to
    // `null` at the call site. Property access is re-widened after function calls.
    const upstream: { listener: ((event: TypedEvent<unknown>) => void) | null } = { listener: null };
    let unsubscribed = false;
    const adapter = createRemoteTransportAdapter({
      send: async () => ({ commandId: "c", executed: true }),
      subscribe: (listener) => {
        upstream.listener = listener;
        return () => {
          unsubscribed = true;
        };
      },
    });
    const seen: TypedEvent<unknown>[] = [];
    const off = adapter.subscribe((event) => seen.push(event));
    const event = typedEvent(VELORA_EVENTS.remoteStateChanged, {
      state: "paired",
      attempt: 0,
      reason: null,
    });
    upstream.listener?.(event);
    expect(seen).toEqual([event]);
    off();
    expect(unsubscribed).toBe(true);
  });
});
