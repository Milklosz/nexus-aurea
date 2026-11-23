/**
 * Phase 3 (Ascension D) — fail-closed outbound policy tests.
 *
 * These tests wire the Phase-3 policy primitives added to
 * `src/services/remoteReliability.ts` and prove the fail-closed contract:
 *   - an automatic retry is allowed ONLY when the request provably never
 *     reached the server, is bounded, and ALWAYS reuses the same signed bytes;
 *   - an ambiguous timeout after send is NEVER auto-retried — the command is
 *     marked "unknown" and only explicit re-confirmation re-sends it (with the
 *     same sequence + signature, so the server can never execute it twice);
 *   - the queue dedups by commandId and keeps a single in-flight request;
 *   - Wi-Fi loss keeps entries QUEUED (never replayed as a retry of a sent
 *     request).
 *
 * The HMAC payload format is never touched: `signature` is carried unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  autoRetryDelayMs,
  classifyOutboundFailure,
  commandIdFor,
  outcomeForStatus,
  shouldAutoRetry,
  shouldReplayOnReconnect,
  reconnectDelayMs,
  REMOTE_HMAC_PAYLOAD_PREFIX,
  REMOTE_MAX_AUTO_RETRIES,
  REMOTE_MAX_RECONNECT_ATTEMPTS,
  RemoteOutboundPipeline,
  type OutboundPipelineDeps,
  type PreparedOutboundCommand,
} from "../services/remoteReliability";
import { VELORA_EVENTS } from "../contracts";

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function fetchTypeError(): Error {
  return new TypeError("Failed to fetch");
}

describe("ascension D: fail-closed failure classification", () => {
  it("proves never-reached only when offline or on a DNS/connect-refused network error", () => {
    expect(classifyOutboundFailure(new Error("anything"), false)).toBe("never-reached");
    expect(classifyOutboundFailure(fetchTypeError(), true)).toBe("never-reached");
    const refused = new Error("connect ECONNREFUSED 192.168.1.4:47862");
    expect(classifyOutboundFailure(refused, true)).toBe("never-reached");
    const dns = new Error("getaddrinfo ENOTFOUND velora.local");
    expect(classifyOutboundFailure(dns, true)).toBe("never-reached");
  });

  it("treats an ambiguous timeout AFTER send as ambiguous, never never-reached", () => {
    expect(classifyOutboundFailure(abortError(), true)).toBe("ambiguous");
    const timeout = new Error("request ETIMEDOUT");
    expect(classifyOutboundFailure(timeout, true)).toBe("ambiguous");
    // Any other online transport failure is post-send uncertain -> fail closed.
    expect(classifyOutboundFailure(new Error("socket hang up"), true)).toBe("ambiguous");
  });

  it("maps the existing bare HTTP statuses to outcomes without changing them", () => {
    expect(outcomeForStatus(200)).toBe("executed");
    expect(outcomeForStatus(204)).toBe("executed");
    expect(outcomeForStatus(401)).toBe("replay-rejected");
    expect(outcomeForStatus(409)).toBe("ambiguous");
    expect(outcomeForStatus(429)).toBe("rate-limited");
    expect(outcomeForStatus(500)).toBe("unavailable");
    expect(outcomeForStatus(503)).toBe("unavailable");
  });

  it("allows automatic retries ONLY for never-reached failures and only within the bound", () => {
    for (let attempt = 0; attempt < REMOTE_MAX_AUTO_RETRIES; attempt += 1) {
      expect(shouldAutoRetry("never-reached", attempt)).toBe(true);
    }
    expect(shouldAutoRetry("never-reached", REMOTE_MAX_AUTO_RETRIES)).toBe(false);
    expect(shouldAutoRetry("never-reached", 99)).toBe(false);
    expect(shouldAutoRetry("ambiguous", 0)).toBe(false);
    expect(shouldAutoRetry("ambiguous", 2)).toBe(false);
  });

  it("keeps the auto-retry backoff bounded, deterministic and capped", () => {
    const delays = [0, 1, 2, 3].map((attempt) => autoRetryDelayMs(attempt));
    for (const delay of delays) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(1_600);
    }
    expect(autoRetryDelayMs(2)).toBe(autoRetryDelayMs(2));
    expect(autoRetryDelayMs(7)).toBeLessThanOrEqual(1_600);
    // The reconnect backoff constant is untouched: max 8 attempts, capped at 10s.
    expect(REMOTE_MAX_RECONNECT_ATTEMPTS).toBe(8);
    expect(reconnectDelayMs(REMOTE_MAX_RECONNECT_ATTEMPTS)).toBe(0);
    expect(reconnectDelayMs(3)).toBeLessThanOrEqual(10_000);
  });

  it("keeps shouldReplayOnReconnect ALWAYS false and the HMAC prefix frozen", () => {
    expect(shouldReplayOnReconnect("paired")).toBe(false);
    expect(shouldReplayOnReconnect("offline")).toBe(false);
    expect(REMOTE_HMAC_PAYLOAD_PREFIX).toBe("NEXUS-AUREA-REMOTE-V1");
    // The contract event names are unchanged (additive-only contract change).
    expect(Object.values(VELORA_EVENTS)).toHaveLength(8);
    expect(VELORA_EVENTS.remoteCommandAck).toBe("velora://remote-command-ack");
  });
});

interface Harness {
  deps: OutboundPipelineDeps;
  dispatched: PreparedOutboundCommand[];
  settlements: Array<{ commandId: string; outcome: string; attempts: number }>;
  waits: number[];
  setOnline(value: boolean): void;
  setDispatch(fn: (prepared: PreparedOutboundCommand) => Promise<number>): void;
}

function makeHarness(options: { online?: boolean } = {}): Harness {
  let online = options.online ?? true;
  let sequence = 0;
  const dispatched: PreparedOutboundCommand[] = [];
  const settlements: Harness["settlements"] = [];
  const waits: number[] = [];
  let dispatchFn: (prepared: PreparedOutboundCommand) => Promise<number> = async () => 204;
  const deps: OutboundPipelineDeps = {
    async prepare(command: string): Promise<PreparedOutboundCommand | null> {
      sequence += 1;
      return { command, deviceId: "device-a", sequence, signature: `sig-${sequence}` };
    },
    async dispatch(prepared: PreparedOutboundCommand): Promise<number> {
      dispatched.push(prepared);
      return dispatchFn(prepared);
    },
    online: () => online,
    wait: async (ms: number) => { waits.push(ms); },
    nowMs: () => 1_000,
    onSettle: (entry, outcome, attempts) => {
      settlements.push({ commandId: entry.commandId, outcome, attempts });
    },
  };
  return {
    deps,
    dispatched,
    settlements,
    waits,
    setOnline: (value) => { online = value; },
    setDispatch: (fn) => { dispatchFn = fn; },
  };
}

describe("ascension D: RemoteOutboundPipeline (fail-closed wiring)", () => {
  it("dedups the outbound queue by commandId and keeps a single in-flight request", async () => {
    const harness = makeHarness();
    const pipeline = new RemoteOutboundPipeline(harness.deps);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let dispatchCount = 0;
    harness.setDispatch(async () => { dispatchCount += 1; await gate; return 204; });

    const first = await pipeline.enqueue("home");
    expect(first).toEqual({ accepted: true, duplicate: false });
    const pumpPromise = pipeline.pump();
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatchCount).toBe(1);
    expect(pipeline.inFlightNow).toBe(true);

    // A second pump while one request is in flight must not dispatch again.
    const secondPump = pipeline.pump();
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatchCount).toBe(1);
    await secondPump;
    release();
    await pumpPromise;
    expect(pipeline.pendingCount).toBe(0);
  });

  it("dedups a repeated (deviceId, sequence) by commandId instead of queueing it twice", async () => {
    const harness = makeHarness();
    // A prepare() that returns the SAME sequence models the same signed request
    // arriving at the queue twice (e.g. a double-processed gesture).
    harness.deps.prepare = async (command: string): Promise<PreparedOutboundCommand> => ({
      command,
      deviceId: "device-a",
      sequence: 42,
      signature: "sig-42",
    });
    const pipeline = new RemoteOutboundPipeline(harness.deps);
    const first = await pipeline.enqueue("home");
    const second = await pipeline.enqueue("home");
    expect(first).toEqual({ accepted: true, duplicate: false });
    expect(second).toEqual({ accepted: false, duplicate: true });
    expect(pipeline.pendingCount).toBe(1);
    expect(pipeline.entryFor(commandIdFor("device-a", 42))?.commandId).toBe(commandIdFor("device-a", 42));
    await pipeline.pump();
    expect(harness.dispatched).toHaveLength(1);
  });

  it("marks a 409 outcome as unknown and never auto-replays it on pump", async () => {
    const harness = makeHarness();
    harness.setDispatch(async () => 409);
    const pipeline = new RemoteOutboundPipeline(harness.deps);
    await pipeline.enqueue("volume-up");
    await pipeline.pump();
    expect(harness.dispatched).toHaveLength(1);
    const unknown = pipeline.unknownCommands();
    expect(unknown).toHaveLength(1);
    expect(unknown[0].state).toBe("unknown");
    expect(harness.settlements[0].outcome).toBe("unknown");
    // Pumping again must NOT re-send the unknown entry.
    await pipeline.pump();
    expect(harness.dispatched).toHaveLength(1);
  });

  it("never auto-retries an ambiguous timeout after send; reconfirm re-sends the SAME signed bytes once", async () => {
    const harness = makeHarness();
    let calls = 0;
    harness.setDispatch(async () => {
      calls += 1;
      if (calls === 1) throw abortError();
      return 204;
    });
    const pipeline = new RemoteOutboundPipeline(harness.deps);
    await pipeline.enqueue("select");
    await pipeline.pump();
    // Exactly one attempt: the AbortError happened after send -> ambiguous.
    expect(calls).toBe(1);
    expect(harness.waits).toHaveLength(0);
    const entry = pipeline.unknownCommands()[0];
    expect(entry.state).toBe("unknown");
    expect(entry.attempts).toBe(0);

    // Explicit re-confirmation re-sends the identical request.
    const ok = await pipeline.reconfirm(entry.commandId);
    expect(ok).toBe(true);
    expect(calls).toBe(2);
    expect(harness.dispatched[1].sequence).toBe(harness.dispatched[0].sequence);
    expect(harness.dispatched[1].signature).toBe(harness.dispatched[0].signature);
    expect(pipeline.unknownCommands()).toHaveLength(0);
    expect(harness.settlements.at(-1)?.outcome).toBe("executed");
  });

  it("auto-retries ONLY provably never-sent requests, bounded, with identical signed bytes", async () => {
    const harness = makeHarness();
    harness.setDispatch(async () => { throw fetchTypeError(); });
    const pipeline = new RemoteOutboundPipeline(harness.deps);
    await pipeline.enqueue("up");
    await pipeline.pump();
    // 1 initial attempt + REMOTE_MAX_AUTO_RETRIES bounded retries, nothing more.
    expect(harness.dispatched).toHaveLength(1 + REMOTE_MAX_AUTO_RETRIES);
    for (const dispatched of harness.dispatched) {
      expect(dispatched.sequence).toBe(harness.dispatched[0].sequence);
      expect(dispatched.signature).toBe(harness.dispatched[0].signature);
    }
    expect(harness.waits).toHaveLength(REMOTE_MAX_AUTO_RETRIES);
    // After the bound is exhausted the entry is unknown (fail closed), not lost.
    expect(pipeline.unknownCommands()).toHaveLength(1);
    expect(harness.settlements.at(-1)?.outcome).toBe("unknown");
    expect(harness.settlements.at(-1)?.attempts).toBe(REMOTE_MAX_AUTO_RETRIES);
  });

  it("keeps an entry QUEUED on Wi-Fi loss mid-flight and sends it once after reconnect", async () => {
    const harness = makeHarness();
    let calls = 0;
    harness.setDispatch(async () => {
      calls += 1;
      if (calls === 1) {
        harness.setOnline(false); // Wi-Fi drops while the request is out
        throw fetchTypeError();
      }
      return 204;
    });
    const pipeline = new RemoteOutboundPipeline(harness.deps);
    await pipeline.enqueue("down");
    await pipeline.pump();
    const entry = pipeline.entryFor(commandIdFor("device-a", 1));
    expect(entry?.state).toBe("queued"); // NOT unknown: it may never have been sent
    expect(pipeline.unknownCommands()).toHaveLength(0);

    // Reconnect: pump again while online — the queued entry is sent exactly once.
    harness.setOnline(true);
    await pipeline.pump();
    expect(calls).toBe(2);
    expect(harness.dispatched[1].signature).toBe(harness.dispatched[0].signature);
    expect(harness.settlements.at(-1)?.outcome).toBe("executed");
  });

  it("surfaces replay-rejected (401) as a terminal outcome without retrying or marking unknown", async () => {
    const harness = makeHarness();
    let calls = 0;
    harness.setDispatch(async () => { calls += 1; return 401; });
    const pipeline = new RemoteOutboundPipeline(harness.deps);
    await pipeline.enqueue("home");
    await pipeline.pump();
    expect(calls).toBe(1);
    expect(harness.settlements[0].outcome).toBe("replay-rejected");
    expect(pipeline.unknownCommands()).toHaveLength(0);
    await pipeline.pump();
    expect(calls).toBe(1);
  });

  it("does not re-send an unknown entry when reconfirm is attempted while offline", async () => {
    const harness = makeHarness();
    harness.setDispatch(async () => { throw abortError(); });
    const pipeline = new RemoteOutboundPipeline(harness.deps);
    await pipeline.enqueue("back");
    await pipeline.pump();
    const entry = pipeline.unknownCommands()[0];
    harness.setOnline(false);
    expect(await pipeline.reconfirm(entry.commandId)).toBe(false);
    expect(harness.dispatched).toHaveLength(1);
  });
});
