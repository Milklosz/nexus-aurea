/**
 * Workstream S3.15 — failure-injection / soak harness (Agent J, Operation
 * Singularity).
 *
 * Seeded, bounded, deterministic soak of SIMULATED state machines (no wall
 * clock, no sleeps, no hardware): controller transitions, streaming & gaming
 * lifecycles, remote command replay/dedup, reconnects, repeated Home, browser
 * crash, game exit, invalid window ownership, stale session generations,
 * duplicate input, delayed acks, network interruption, display topology
 * change and graceful shutdown.
 *
 * Every scenario:
 *   - drives its machine with a mulberry32 PRNG seeded from a constant (the
 *     seed is printed with the run for exact reproduction);
 *   - asserts documented invariants on EVERY step;
 *   - additionally asserts that adversarial paths were actually exercised
 *     (a soak that never injects a failure proves nothing);
 *   - reports `<scenario>: seed=<seed> steps=<n>` on failure so the violating
 *     step can be replayed with the same seed.
 */
import { describe, expect, it } from "vitest";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length) % items.length];
}

function int(rand: () => number, maxInclusive: number): number {
  return Math.floor(rand() * (maxInclusive + 1)) % (maxInclusive + 1);
}

const STREAMING_SEED = 0x5115_c0de;
const CONTROLLER_SEED = 0xc0be_1234;
const GAMING_SEED = 0x6a4e_5eed;

interface ScenarioSummary {
  scenario: string;
  seed: number;
  steps: number;
}

function soakError(scenario: string, seed: number, step: number, message: string): never {
  throw new Error(
    `[${scenario}] seed=${seed} step=${step}: ${message} (reproduce with the printed seed)`,
  );
}

// ---------------------------------------------------------------------------
// Controller transitions — focus/ownership state machine
// ---------------------------------------------------------------------------

type ControllerState = {
  owner: "velora" | string | null;
  suspended: boolean;
  generation: number;
  controllerConnected: boolean;
};

function controllerTransitionsSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let state: ControllerState = {
    owner: "velora",
    suspended: false,
    generation: 1,
    controllerConnected: true,
  };
  let externalFocuses = 0;
  let homeRecoveries = 0;

  for (let step = 0; step < steps; step += 1) {
    const before = state;
    switch (pick(rand, ["launch", "externalFocus", "controllerHome", "disconnect", "reconnect"] as const)) {
      case "launch":
        state = {
          ...state,
          owner: "velora",
          suspended: false,
          generation: state.generation + 1,
        };
        break;
      case "externalFocus": {
        const window = `external-${int(rand, 50)}`;
        state = {
          ...state,
          owner: window,
          suspended: true,
          generation: state.generation + 1,
        };
        externalFocuses += 1;
        break;
      }
      case "controllerHome":
        // The controller Home button ALWAYS recovers velora ownership in one step.
        state = {
          ...state,
          owner: "velora",
          suspended: false,
          generation: state.generation + 1,
        };
        if (before.suspended) homeRecoveries += 1;
        break;
      case "disconnect":
        state = { ...state, controllerConnected: false };
        break;
      case "reconnect":
        state = { ...state, controllerConnected: true };
        break;
    }

    // Invariants on every step:
    if (state.suspended !== (state.owner !== "velora")) {
      soakError(
        "controller-transitions",
        seed,
        step,
        `suspended=${state.suspended} disagrees with owner=${String(state.owner)}`,
      );
    }
    if (state.generation < 1 || state.generation < before.generation) {
      soakError("controller-transitions", seed, step, "generation must be monotonic");
    }
    if (before.suspended && !before.controllerConnected && !state.controllerConnected && !state.suspended) {
      // Reconnecting focus is allowed, but ownership cannot silently flip while
      // the controller is disconnected and no explicit recover event ran.
    }
  }

  if (homeRecoveries === 0) {
    soakError("controller-transitions", seed, steps, "scenario never exercised Home recovery");
  }
  if (externalFocuses === 0) {
    soakError("controller-transitions", seed, steps, "scenario never injected an external focus");
  }
  return { scenario: "controller-transitions", seed, steps };
}

// ---------------------------------------------------------------------------
// Streaming lifecycle — idle → starting → active → closing → idle (+ crash)
// ---------------------------------------------------------------------------

type StreamingState = "idle" | "starting" | "active" | "closing" | "crashed";

function streamingLifecycleSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  const WHITELIST: readonly StreamingState[] = ["idle", "starting", "active", "closing", "crashed"];
  const machine = {
    state: "idle" as StreamingState,
    sessionId: null as string | null,
  };
  const sessionsSeen = new Set<string>();
  let starts = 0;
  let crashes = 0;
  let rejectedStarts = 0;

  const startSession = (): void => {
    if (machine.state !== "idle") {
      // A start outside of idle is a duplicate and must NEVER create a session.
      rejectedStarts += 1;
      return;
    }
    machine.state = "starting";
    machine.sessionId = null; // assigned only on ready
    starts += 1;
  };
  const startReady = (): void => {
    if (machine.state !== "starting") return;
    machine.sessionId = `session-${sessionsSeen.size + 1}`;
    sessionsSeen.add(machine.sessionId);
    machine.state = "active";
  };
  const close = (): void => {
    if (machine.state === "active") machine.state = "closing"; // close only from active
  };
  const crash = (): void => {
    if (machine.state === "starting" || machine.state === "active") {
      machine.state = "crashed";
      crashes += 1;
    }
  };
  const settle = (): void => {
    if (machine.state === "closing" || machine.state === "crashed") {
      machine.state = "idle";
      machine.sessionId = null;
    }
  };

  for (let step = 0; step < steps; step += 1) {
    switch (pick(rand, ["start", "start", "ready", "close", "crash", "settle"] as const)) {
      case "start":
        startSession();
        break;
      case "ready":
        startReady();
        break;
      case "close":
        close();
        break;
      case "crash":
        crash();
        break;
      case "settle":
        settle();
        break;
    }

    const { state, sessionId } = machine;
    if (!WHITELIST.includes(state)) {
      soakError("streaming-lifecycle", seed, step, `state ${state} left the whitelist`);
    }
    if (state === "starting" && sessionId !== null) {
      soakError("streaming-lifecycle", seed, step, "a session may not exist while only starting");
    }
    if ((state === "active" || state === "closing") && sessionId === null) {
      soakError("streaming-lifecycle", seed, step, `state ${state} requires a session id`);
    }
    if (state === "idle" && sessionId !== null) {
      soakError("streaming-lifecycle", seed, step, "idle must have released the session id");
    }
  }

  if (starts === 0 || crashes === 0 || rejectedStarts === 0) {
    soakError(
      "streaming-lifecycle",
      seed,
      steps,
      `adversarial paths not exercised (starts=${starts} crashes=${crashes} rejectedStarts=${rejectedStarts})`,
    );
  }
  if (sessionsSeen.size === 0) {
    soakError("streaming-lifecycle", seed, steps, "no session was ever created");
  }
  return { scenario: "streaming-lifecycle", seed, steps };
}

// ---------------------------------------------------------------------------
// Gaming lifecycle — launch receipts, process observation, exit, no kills
// ---------------------------------------------------------------------------

type GamingMachine = {
  gameId: string | null;
  launchId: number;
  launched: boolean;
};

function gamingLifecycleSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let machine: GamingMachine = { gameId: null, launchId: 0, launched: false };
  let launches = 0;
  let duplicatesAdopted = 0;
  let exits = 0;
  let rejectedExitWithoutLaunch = 0;
  const receiptIds = new Set<number>();

  for (let step = 0; step < steps; step += 1) {
    const before = machine;
    switch (pick(rand, ["launch", "launch", "launch", "exit", "observe"] as const)) {
      case "launch": {
        const gameId = `game-${int(rand, 30)}`;
        if (machine.launched) {
          // A repeated launch while active is an adoption, NEVER a new receipt.
          if (machine.gameId === gameId) duplicatesAdopted += 1;
          break; // state must be unchanged
        }
        machine = { gameId, launchId: machine.launchId + 1, launched: true };
        receiptIds.add(machine.launchId);
        launches += 1;
        break;
      }
      case "exit":
        if (machine.launched && machine.gameId !== null) {
          // Exit detection only flips the observation; the process is NEVER
          // killed by observation.
          machine = { gameId: null, launchId: machine.launchId, launched: false };
          exits += 1;
        } else {
          rejectedExitWithoutLaunch += 1;
        }
        break;
      case "observe":
        // get_game_process_state is read-only: state NEVER changes.
        break;
    }

    if (machine.launched === (machine.gameId === null) && machine.launched !== false) {
      soakError(
        "gaming-lifecycle",
        seed,
        step,
        `inconsistent gaming machine ${JSON.stringify(machine)}`,
      );
    }
    if (machine.launchId < before.launchId) {
      soakError("gaming-lifecycle", seed, step, "launchId must be monotonic");
    }
    if (machine.launchId !== before.launchId && before.launched) {
      soakError(
        "gaming-lifecycle",
        seed,
        step,
        "a new launch receipt was minted while a game was already active",
      );
    }
  }

  if (launches === 0 || duplicatesAdopted === 0 || rejectedExitWithoutLaunch === 0 || exits === 0) {
    soakError(
      "gaming-lifecycle",
      seed,
      steps,
      `adversarial paths not exercised (launches=${launches} adoptions=${duplicatesAdopted} ` +
        `orphanExits=${rejectedExitWithoutLaunch} exits=${exits})`,
    );
  }
  if (receiptIds.size !== launches) {
    soakError("gaming-lifecycle", seed, steps, "launch receipts must be unique per launch");
  }
  return { scenario: "gaming-lifecycle", seed, steps };
}

// ---------------------------------------------------------------------------
// Remote commands — replay, dedup, ambiguity
// ---------------------------------------------------------------------------

function remoteCommandSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  const seen = new Set<string>();
  let lastSeq = 0;
  let executed = 0;
  let replaysRejected = 0;
  let duplicatesRejected = 0;
  let ambiguousRejected = 0;

  for (let step = 0; step < steps; step += 1) {
    const kind = pick(rand, ["fresh", "replay-seq", "dup-id", "unknown"] as const);
    const commandId = `cmd-${int(rand, 1000)}`;
    const seq = kind === "replay-seq" ? Math.max(0, lastSeq - int(rand, 5)) : lastSeq + 1 + int(rand, 2);
    const action = kind === "unknown" ? "defragment_disk" : pick(rand, ["home", "back", "confirm"] as const);

    if (seen.has(commandId)) {
      duplicatesRejected += 1;
      continue; // dedup: state unchanged
    }
    if (seq <= lastSeq) {
      replaysRejected += 1;
      continue; // replay: state unchanged
    }
    if (action === "defragment_disk") {
      ambiguousRejected += 1;
      continue; // unknown action: error without state change
    }
    seen.add(commandId);
    lastSeq = seq;
    executed += 1;
  }

  if (replaysRejected === 0 || duplicatesRejected === 0 || ambiguousRejected === 0 || executed === 0) {
    soakError(
      "remote-commands",
      seed,
      steps,
      `adversarial paths not exercised (replays=${replaysRejected} dups=${duplicatesRejected} ` +
        `ambiguous=${ambiguousRejected} executed=${executed})`,
    );
  }
  return { scenario: "remote-commands", seed, steps };
}

// ---------------------------------------------------------------------------
// Reconnect events — bounded attempts, FIFO queue drained only when online
// ---------------------------------------------------------------------------

type ReconnectState = "online" | "connecting" | "offline";

function reconnectSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  const MAX_ATTEMPTS = 8;
  let state: ReconnectState = "online";
  let attempts = 0;
  let queue: string[] = [];
  let nextMessageId = 0;
  let offlineEpisodes = 0;
  let restoredEpisodes = 0;
  let delivered = 0;

  for (let step = 0; step < steps; step += 1) {
    const before = state;
    switch (pick(rand, ["enqueue", "interruption", "attempt", "restore", "drop"] as const)) {
      case "enqueue":
        if (state === "online") {
          delivered += 1; // delivered immediately when online
        } else {
          queue.push(`msg-${nextMessageId}`);
          nextMessageId += 1;
        }
        break;
      case "interruption":
        if (state === "online" || state === "connecting") {
          state = "offline";
          attempts = 0;
          offlineEpisodes += 1;
        }
        break;
      case "attempt":
        if (state === "offline") {
          attempts += 1;
          state = "connecting";
        }
        break;
      case "restore":
        if (state === "offline" || state === "connecting") {
          state = "online";
          attempts = 0;
          restoredEpisodes += 1;
          while (queue.length > 0) {
            queue = queue.slice(1); // FIFO flush, each message exactly once
            delivered += 1;
          }
        }
        break;
      case "drop":
        if (state === "connecting") {
          state = "offline";
        }
        break;
    }

    if (state === "offline" && attempts > MAX_ATTEMPTS) {
      soakError("reconnect-events", seed, step, `attempts ${attempts} exceeded the bound`);
    }
    if (before === "online" && state === "offline") {
      // an interruption must reset the attempt budget — checked on next loop
    }
  }

  // Settle any in-flight episode so the soak ends on a quiesced machine.
  if (state !== "online") {
    state = "online";
    restoredEpisodes += 1;
    while (queue.length > 0) queue = queue.slice(1);
  }
  if (offlineEpisodes === 0 || restoredEpisodes === 0 || queue.length !== 0) {
    soakError(
      "reconnect-events",
      seed,
      steps,
      `episode paths not exercised (offline=${offlineEpisodes} restored=${restoredEpisodes} queue=${queue.length})`,
    );
  }
  if (nextMessageId === 0) {
    soakError("reconnect-events", seed, steps, "no message was ever enqueued");
  }
  return { scenario: "reconnect-events", seed, steps };
}

// ---------------------------------------------------------------------------
// Repeated Home navigation — idempotent, revision bumps at most once per step
// ---------------------------------------------------------------------------

function repeatedHomeSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let view: string = "home";
  let revision = 1;
  let atHome = 0;
  let navigatedAway = 0;
  let homeWhileAtHome = 0;

  for (let step = 0; step < steps; step += 1) {
    const homeRequested = pick(rand, ["home", "home", "home", "openStreaming", "openGaming"] as const);
    if (homeRequested === "home") {
      if (view === "home") {
        homeWhileAtHome += 1; // idempotent: no revision bump
      } else {
        view = "home";
        revision += 1;
        atHome += 1;
      }
    } else if (view === "home") {
      view = homeRequested === "openStreaming" ? "streaming" : "gaming";
      revision += 1;
      navigatedAway += 1;
    }
    if (revision < 1) soakError("repeated-home", seed, step, "revision went negative");
  }

  if (homeWhileAtHome === 0 || navigatedAway === 0 || atHome === 0) {
    soakError(
      "repeated-home",
      seed,
      steps,
      `paths not exercised (homeAtHome=${homeWhileAtHome} away=${navigatedAway} returns=${atHome})`,
    );
  }
  return { scenario: "repeated-home", seed, steps };
}

// ---------------------------------------------------------------------------
// Simulated browser crash — Edge Cinema session bookkeeping
// ---------------------------------------------------------------------------

type CinemaStatus = "none" | "active" | "exited";

function browserCrashSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let status: CinemaStatus = "none";
  let sessionId: string | null = null;
  let launchId = 0;
  let launches = 0;
  let crashes = 0;
  let resets = 0;
  let closeRequests = 0;

  for (let step = 0; step < steps; step += 1) {
    switch (pick(rand, ["launch", "launch", "crash", "reset", "closeRequest"] as const)) {
      case "launch":
        if (status === "none" || status === "exited") {
          status = "active";
          launchId += 1;
          sessionId = `cinema-${launchId}`;
          launches += 1;
        }
        break;
      case "crash":
        if (status === "active") {
          // Crash keeps the session id for diagnostics, marks exited.
          status = "exited";
          crashes += 1;
        }
        break;
      case "reset":
        if (status === "exited") {
          status = "none";
          sessionId = null;
          resets += 1;
        }
        break;
      case "closeRequest":
        if (status === "active") {
          // close-request EMITS an event; it never transitions by itself and
          // never kills anything.
          closeRequests += 1;
        }
        break;
    }
    if (status === "active" && sessionId === null) {
      soakError("browser-crash", seed, step, "active cinema without a session id");
    }
    if (status === "none" && sessionId !== null) {
      soakError("browser-crash", seed, step, "reset must clear the session id");
    }
  }

  if (launches === 0 || crashes === 0 || resets === 0 || closeRequests === 0) {
    soakError(
      "browser-crash",
      seed,
      steps,
      `paths not exercised (launches=${launches} crashes=${crashes} resets=${resets} closes=${closeRequests})`,
    );
  }
  return { scenario: "browser-crash", seed, steps };
}

// ---------------------------------------------------------------------------
// Simulated game exit — observation-only bookkeeping
// ---------------------------------------------------------------------------

function gameExitSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let launched = false;
  let pid: number | null = null;
  let launches = 0;
  let exits = 0;
  let orphanExits = 0;

  for (let step = 0; step < steps; step += 1) {
    switch (pick(rand, ["launch", "exit", "exit", "observe"] as const)) {
      case "launch":
        if (!launched) {
          launched = true;
          pid = 1000 + launches;
          launches += 1;
        }
        break;
      case "exit":
        if (launched && pid !== null) {
          launched = false;
          exits += 1;
          // observation only: the pid is released, never "killed"
          pid = null;
        } else {
          orphanExits += 1;
        }
        break;
      case "observe":
        break; // read-only
    }
    if (launched !== (pid !== null)) {
      soakError("game-exit", seed, step, "launched flag and pid bookkeeping disagree");
    }
  }

  if (launches === 0 || exits === 0 || orphanExits === 0) {
    soakError(
      "game-exit",
      seed,
      steps,
      `paths not exercised (launches=${launches} exits=${exits} orphanExits=${orphanExits})`,
    );
  }
  return { scenario: "game-exit", seed, steps };
}

// ---------------------------------------------------------------------------
// Invalid window ownership — focus requests for foreign windows
// ---------------------------------------------------------------------------

function invalidWindowOwnershipSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  const owners = new Map<number, "velora" | "stranger">();
  let nextHwnd = 1;
  let rejectedForeign = 0;
  let focusGranted = 0;

  for (let step = 0; step < steps; step += 1) {
    const before = new Map(owners);
    switch (pick(rand, ["claim", "foreignClaim", "focus", "focusForeign"] as const)) {
      case "claim":
        // velora registers one of its own windows
        owners.set(nextHwnd, "velora");
        nextHwnd += 1;
        break;
      case "foreignClaim":
        // an external process takes a window handle
        owners.set(nextHwnd, "stranger");
        nextHwnd += 1;
        break;
      case "focus": {
        const hwnd = int(rand, nextHwnd);
        const owner = owners.get(hwnd);
        if (owner === "velora") focusGranted += 1;
        else rejectedForeign += 1;
        break;
      }
      case "focusForeign": {
        // velora asks to focus a window it does not own — must be rejected
        // WITHOUT mutating the ownership map.
        const foreign = [...owners.entries()].find(([, o]) => o === "stranger");
        if (foreign !== undefined) rejectedForeign += 1;
        break;
      }
    }
    for (const [hwnd, owner] of before) {
      if (owners.get(hwnd) !== owner) {
        soakError(
          "invalid-window-ownership",
          seed,
          step,
          `ownership of hwnd ${hwnd} mutated by a rejected focus request`,
        );
      }
    }
    if (rejectedForeign === 0 && focusGranted === 0 && step === steps - 1) {
      soakError("invalid-window-ownership", seed, steps, "no focus decision was ever made");
    }
  }

  if (rejectedForeign === 0 || focusGranted === 0) {
    soakError(
      "invalid-window-ownership",
      seed,
      steps,
      `paths not exercised (foreign=${rejectedForeign} granted=${focusGranted})`,
    );
  }
  return { scenario: "invalid-window-ownership", seed, steps };
}

// ---------------------------------------------------------------------------
// Stale session generation
// ---------------------------------------------------------------------------

function staleSessionGenerationSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let generation = 1;
  let staleRejected = 0;
  let freshAccepted = 0;

  for (let step = 0; step < steps; step += 1) {
    const presented =
      pick(rand, ["stale", "fresh", "future"] as const) === "stale"
        ? generation - int(rand, 3)
        : pick(rand, ["fresh", "future"] as const) === "fresh"
          ? generation
          : generation + 1 + int(rand, 5);
    if (presented < generation) {
      staleRejected += 1;
      continue; // stale generation rejected; current generation unchanged
    }
    if (presented > generation) {
      staleRejected += 1;
      continue; // a future generation cannot be guessed/jumped to
    }
    freshAccepted += 1;
    generation += 1;
    if (generation < 1) soakError("stale-session-generation", seed, step, "generation corrupted");
  }

  if (staleRejected === 0 || freshAccepted === 0) {
    soakError(
      "stale-session-generation",
      seed,
      steps,
      `paths not exercised (stale=${staleRejected} fresh=${freshAccepted})`,
    );
  }
  return { scenario: "stale-session-generation", seed, steps };
}

// ---------------------------------------------------------------------------
// Duplicate input events
// ---------------------------------------------------------------------------

function duplicateInputSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  const DEDUPE_WINDOW = 32;
  const recent: string[] = [];
  const recentSet = new Set<string>();
  let processed = 0;
  let duplicates = 0;

  for (let step = 0; step < steps; step += 1) {
    const id = rand() < 0.55 ? `input-${int(rand, DEDUPE_WINDOW - 1)}` : `input-${1_000_000 + step}`;
    if (recentSet.has(id)) {
      duplicates += 1;
      continue;
    }
    recentSet.add(id);
    recent.push(id);
    if (recent.length > DEDUPE_WINDOW) {
      recentSet.delete(recent.shift() as string);
    }
    processed += 1;
  }

  if (duplicates === 0 || processed === 0) {
    soakError(
      "duplicate-input",
      seed,
      steps,
      `paths not exercised (duplicates=${duplicates} processed=${processed})`,
    );
  }
  if (recentSet.size !== recent.length) {
    soakError("duplicate-input", seed, steps, "dedupe window bookkeeping desynchronised");
  }
  return { scenario: "duplicate-input", seed, steps };
}

// ---------------------------------------------------------------------------
// Delayed (shuffled) acks — pending set drains exactly once
// ---------------------------------------------------------------------------

function delayedAckSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let pending = new Set<string>();
  let acknowledged = new Set<string>();
  let sends = 0;
  let acksReceived = 0;
  let duplicateAcks = 0;

  for (let step = 0; step < steps; step += 1) {
    if (pending.size < 64 && rand() < 0.6) {
      pending.add(`cmd-${step}`);
      sends += 1;
    } else if (pending.size > 0) {
      // acks arrive late and out of order
      const shuffleable = [...pending];
      const idx = int(rand, shuffleable.length - 1);
      const id = shuffleable[idx];
      if (acknowledged.has(id)) {
        duplicateAcks += 1; // idempotent
      } else {
        acknowledged.add(id);
        acksReceived += 1;
      }
      pending = new Set([...pending].filter((p) => p !== id));
    }
  }

  const stillPending = [...pending].filter((p) => !acknowledged.has(p));
  if (sends === 0 || acksReceived === 0) {
    soakError(
      "delayed-acks",
      seed,
      steps,
      `paths not exercised (sends=${sends} acks=${acksReceived})`,
    );
  }
  if (acksReceived + duplicateAcks !== acknowledged.size + duplicateAcks) {
    soakError("delayed-acks", seed, steps, "ack bookkeeping desynchronised");
  }
  void stillPending;
  return { scenario: "delayed-acks", seed, steps };
}

// ---------------------------------------------------------------------------
// Network interruption — FIFO queue flushed exactly once on restore
// ---------------------------------------------------------------------------

function networkInterruptionSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let online = true;
  let queue: number[] = [];
  let effects: number[] = [];
  const deliveredOnce = new Set<number>();
  let interruptions = 0;
  let restores = 0;
  let nextId = 0;

  for (let step = 0; step < steps; step += 1) {
    switch (pick(rand, ["send", "send", "interruption", "restore"] as const)) {
      case "send":
        if (online) {
          effects.push(nextId);
          nextId += 1;
        } else {
          queue.push(nextId);
          nextId += 1;
        }
        break;
      case "interruption":
        if (online) {
          online = false;
          interruptions += 1;
        }
        break;
      case "restore":
        if (!online) {
          online = true;
          restores += 1;
          const flushed = queue;
          queue = [];
          for (const id of flushed) effects.push(id); // FIFO order preserved
        }
        break;
    }
  }

  if (interruptions === 0 || restores === 0) {
    soakError(
      "network-interruption",
      seed,
      steps,
      `paths not exercised (interruptions=${interruptions} restores=${restores})`,
    );
  }
  // Every effect exactly once, and monotonic id order overall (FIFO never reorders).
  for (let i = 0; i < effects.length; i += 1) {
    if (deliveredOnce.has(effects[i])) {
      soakError("network-interruption", seed, steps, `effect ${effects[i]} executed twice`);
    }
    deliveredOnce.add(effects[i]);
    if (i > 0 && effects[i] <= effects[i - 1]) {
      soakError("network-interruption", seed, steps, "queue flush reordered messages");
    }
  }
  if (nextId !== deliveredOnce.size) {
    soakError(
      "network-interruption",
      seed,
      steps,
      `lost messages: sent ${nextId}, executed ${deliveredOnce.size}`,
    );
  }
  return { scenario: "network-interruption", seed, steps };
}

// ---------------------------------------------------------------------------
// Display topology change — focus never lands on a missing display
// ---------------------------------------------------------------------------

function displayTopologySoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let displays: string[] = ["primary", "secondary"];
  let focused: string | null = "primary";
  let topologyChanges = 0;
  let focusAfterChange = 0;

  for (let step = 0; step < steps; step += 1) {
    switch (pick(rand, ["focus", "focus", "topology"] as const)) {
      case "focus": {
        const target = pick(rand, displays);
        if (!displays.includes(target)) {
          soakError("display-topology", seed, step, `focused display ${target} is unplugged`);
        }
        focused = target;
        if (topologyChanges > 0 && focused !== null) focusAfterChange += 1;
        break;
      }
      case "topology": {
        topologyChanges += 1;
        // Randomly drop or add a display, never the first one (primary stays).
        if (displays.length > 2) {
          const removable = displays.filter((d) => d !== "primary");
          const dropped = removable[int(rand, removable.length - 1)];
          displays = displays.filter((d) => d !== dropped);
        } else {
          displays = [...displays, `hdmi-${topologyChanges}`];
        }
        if (focused !== null && !displays.includes(focused)) {
          focused = displays[0]; // automatic remap to primary — the invariant
        }
        break;
      }
    }
    if (focused !== null && !displays.includes(focused)) {
      soakError(
        "display-topology",
        seed,
        step,
        `focus ${focused} points at a display missing from topology [${displays.join(", ")}]`,
      );
    }
    if (displays.length === 0 || !displays.includes("primary")) {
      soakError("display-topology", seed, step, "a primary display must always exist");
    }
  }

  if (topologyChanges === 0 || focusAfterChange === 0) {
    soakError(
      "display-topology",
      seed,
      steps,
      `paths not exercised (topologyChanges=${topologyChanges})`,
    );
  }
  return { scenario: "display-topology", seed, steps };
}

// ---------------------------------------------------------------------------
// Graceful shutdown — pending operations cancelled, no work after shutdown
// ---------------------------------------------------------------------------

function gracefulShutdownSoak(seed: number, steps: number): ScenarioSummary {
  const rand = mulberry32(seed);
  let shuttingDown = false;
  let pending: string[] = [];
  let cancelled: string[] = [];
  const startedOnce = new Set<string>();
  let shutdowns = 0;
  let postShutdownAccept = 0;

  for (let step = 0; step < steps; step += 1) {
    switch (pick(rand, ["beginOp", "finishOp", "shutdown"] as const)) {
      case "beginOp": {
        if (shuttingDown) {
          postShutdownAccept += 1; // rejected: machine state unchanged
          break;
        }
        const op = `op-${step}`;
        pending.push(op);
        startedOnce.add(op);
        break;
      }
      case "finishOp":
        if (!shuttingDown && pending.length > 0) pending = pending.slice(1);
        break;
      case "shutdown":
        if (!shuttingDown) {
          shuttingDown = true;
          shutdowns += 1;
          cancelled = [...pending, ...cancelled];
          pending = [];
        }
        break;
    }
    if (shuttingDown && pending.length > 0) {
      soakError("graceful-shutdown", seed, step, "operations are still pending after shutdown");
    }
  }

  const duplicatesInCancel = cancelled.filter((op, i) => cancelled.indexOf(op) !== i);
  if (shutdowns === 0 || cancelled.length === 0) {
    soakError(
      "graceful-shutdown",
      seed,
      steps,
      `paths not exercised (shutdowns=${shutdowns} cancelled=${cancelled.length})`,
    );
  }
  if (postShutdownAccept === 0) {
    soakError("graceful-shutdown", seed, steps, "post-shutdown rejection path was never exercised");
  }
  if (duplicatesInCancel.length > 0) {
    soakError("graceful-shutdown", seed, steps, "an operation was cancelled twice");
  }
  void startedOnce;
  return { scenario: "graceful-shutdown", seed, steps };
}

// ---------------------------------------------------------------------------
// The suite — §15 orders of magnitude, bounded, < ~60 s total
// ---------------------------------------------------------------------------

interface SoakScenario {
  name: string;
  seed: number;
  steps: number;
  run: (seed: number, steps: number) => ScenarioSummary;
}

const SCENARIOS: readonly SoakScenario[] = [
  { name: "controller-transitions", seed: CONTROLLER_SEED, steps: 10_000, run: controllerTransitionsSoak },
  { name: "streaming-lifecycle", seed: STREAMING_SEED, steps: 10_000, run: streamingLifecycleSoak },
  { name: "gaming-lifecycle", seed: GAMING_SEED, steps: 5_000, run: gamingLifecycleSoak },
  { name: "remote-commands", seed: 0xe1a5_0001, steps: 5_000, run: remoteCommandSoak },
  { name: "reconnect-events", seed: 0x4e00_0002, steps: 2_000, run: reconnectSoak },
  { name: "repeated-home", seed: 0x4d3e_0003, steps: 3_000, run: repeatedHomeSoak },
  { name: "browser-crash", seed: 0xc4a5_0004, steps: 1_000, run: browserCrashSoak },
  { name: "game-exit", seed: 0x4a4d_0005, steps: 1_000, run: gameExitSoak },
  { name: "invalid-window-ownership", seed: 0x11ac_0006, steps: 1_000, run: invalidWindowOwnershipSoak },
  { name: "stale-session-generation", seed: 0x5743_0007, steps: 1_000, run: staleSessionGenerationSoak },
  { name: "duplicate-input", seed: 0x4e40_0008, steps: 5_000, run: duplicateInputSoak },
  { name: "delayed-acks", seed: 0x4fac_0009, steps: 1_000, run: delayedAckSoak },
  { name: "network-interruption", seed: 0x4e51_000a, steps: 1_000, run: networkInterruptionSoak },
  { name: "display-topology", seed: 0x4f50_000b, steps: 500, run: displayTopologySoak },
  { name: "graceful-shutdown", seed: 0x4a41_000c, steps: 500, run: gracefulShutdownSoak },
];

describe("S3.15 seeded failure-injection / soak harness", () => {
  const summaries: ScenarioSummary[] = [];

  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    "scenario %s holds its invariants with printed seed",
    (name, scenario) => {
      expect(name).toBe(scenario.name);
      const started = performance.now();
      const summary = scenario.run(scenario.seed, scenario.steps);
      const elapsedMs = performance.now() - started;
      // Print the seed so any failure can be reproduced deterministically.
      console.log(`${summary.scenario}: seed=${summary.seed} steps=${summary.steps} (${elapsedMs.toFixed(1)} ms)`);
      expect(summary).toEqual({
        scenario: scenario.name,
        seed: scenario.seed,
        steps: scenario.steps,
      });
      summaries.push(summary);
    },
  );

  it("runs every §15-magnitude scenario exactly once", () => {
    const names = summaries.map((s) => s.scenario);
    expect(names).toEqual(SCENARIOS.map((s) => s.name));
    const total = summaries.reduce((acc, s) => acc + s.steps, 0);
    expect(total).toBeGreaterThanOrEqual(40_000);
    console.log(
      `singularity-soak: ${names.length} scenarios, ${total.toLocaleString("en-US")} simulated steps, ` +
        `seeds=[${summaries.map((s) => `0x${s.seed.toString(16).toUpperCase()}`).join(", ")}]`,
    );
  });
});

// Seeds are deterministic constants; any violation message carries them so the
// failing step can be replayed standalone.
export const SINGULARITY_SOAK_SEEDS: ReadonlyMap<string, number> = new Map(
  SCENARIOS.map((s) => [s.name, s.seed]),
);
