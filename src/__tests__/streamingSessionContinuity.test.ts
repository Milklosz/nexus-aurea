import { describe, expect, it } from "vitest";

/**
 * Deterministic regression model for first-session streaming continuity (S2.9-A).
 *
 * The confirmed defect was a first-launch-only asymmetry: Netflix -> VELORA ->
 * YouTube lost the paused state, while a repeated run preserved it. The native
 * cause is that the first launch used the spawn path (no identity-checked
 * focus verification) and that media keys are a blind toggle, so a stray
 * Play/Pause edge could flip a still-armed session. The fix is a full quiesce
 * on every real transition: media arming and the exact session target are
 * cleared and the input engine is neutral. This is a PURE model of that state
 * machine, not a hardware test and not a playback-state readback (DRM services
 * are never inspected, and no "restore pause" key is injected).
 */

type Session = "veloraHome" | "netflix" | "youtube";
type Service = "netflix" | "youtube";

interface QuiesceReceipt {
  revision: number;
  from: Session;
  to: Session;
  generation: number;
  reason: "launch" | "user";
  physicalHardwareVerified: false;
}

interface ModelState {
  snapshot: Session;
  revision: number;
  generation: number;
  mediaArmed: boolean;
  targetService: Service | null;
  paused: boolean;
  seenCommands: ReadonlySet<string>;
  receipts: QuiesceReceipt[];
}

interface RunResult {
  state: ModelState;
  strayEdges: number;
  strayEdgeAccepted: boolean;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function initialState(): ModelState {
  return {
    snapshot: "veloraHome",
    revision: 0,
    generation: 0,
    mediaArmed: false,
    targetService: null,
    paused: false,
    seenCommands: new Set<string>(),
    receipts: [],
  };
}

/**
 * Apply a transition command. A real transition (new command id and a changed
 * snapshot) produces one changed event: the generation advances and media
 * arming is quiesced exactly once. Deduped/replayed commands and idempotent
 * targets return the SAME state object: no event, no generation change, no
 * quiesce. `quiesce=false` models the legacy (buggy) behaviour for contrast.
 */
function applyCommand(
  state: ModelState,
  target: Session,
  commandId: string,
  quiesce: boolean,
): { state: ModelState; changed: boolean } {
  const deduped = state.seenCommands.has(commandId);
  if (deduped || target === state.snapshot) {
    return { state, changed: false };
  }
  const revision = state.revision + 1;
  const generation = quiesce ? state.generation + 1 : state.generation;
  const receipts = quiesce
    ? [
        ...state.receipts,
        {
          revision,
          from: state.snapshot,
          to: target,
          generation,
          reason: "launch" as const,
          physicalHardwareVerified: false as const,
        },
      ]
    : state.receipts;
  return {
    changed: true,
    state: {
      ...state,
      snapshot: target,
      revision,
      generation,
      mediaArmed: quiesce ? false : state.mediaArmed,
      targetService: quiesce ? null : state.targetService,
      seenCommands: new Set(state.seenCommands).add(commandId),
      receipts,
    },
  };
}

/** Control Center arms playback controls for one exact service session. */
function armMedia(state: ModelState, service: Service): ModelState {
  return { ...state, mediaArmed: true, targetService: service };
}

/** A blind media-key toggle is accepted only while armed for that exact service. */
function togglePlayPause(
  state: ModelState,
  foreground: Service,
): { state: ModelState; accepted: boolean } {
  if (!state.mediaArmed || state.targetService !== foreground) {
    return { state, accepted: false };
  }
  return { state: { ...state, paused: !state.paused }, accepted: true };
}

/** Observable state excludes per-run command ids but includes sanitized receipts. */
function observable(state: ModelState): Omit<ModelState, "seenCommands"> {
  return {
    snapshot: state.snapshot,
    revision: state.revision,
    generation: state.generation,
    mediaArmed: state.mediaArmed,
    targetService: state.targetService,
    paused: state.paused,
    receipts: state.receipts,
  };
}

/** Drive Home -> Netflix -> Home -> YouTube once. */
function runSequence(
  runId: string,
  seed: number,
  opts: { spawnPath: boolean; quiesce: boolean },
): RunResult {
  const random = seededRandom(seed);
  let state = initialState();
  let strayEdges = 0;
  let strayEdgeAccepted = false;

  const steps: Array<{ to: Session; id: string }> = [
    { to: "netflix", id: `${runId}-open-netflix` },
    { to: "veloraHome", id: `${runId}-home` },
    { to: "youtube", id: `${runId}-open-youtube` },
  ];

  for (const step of steps) {
    const before = state;
    const applied = applyCommand(state, step.to, step.id, opts.quiesce);
    state = applied.state;
    expect(applied.changed).toBe(true);
    expect(state.generation).toBe(before.generation + (opts.quiesce ? 1 : 0));

    // Deterministic replay of the same command id: deduped, never a second
    // event, generation advance or quiesce. Number of probes comes only from
    // the seeded RNG, never Math.random.
    const replayCount = 1 + Math.floor(random() * 2);
    for (let probe = 0; probe < replayCount; probe += 1) {
      const replay = applyCommand(state, step.to, step.id, opts.quiesce);
      expect(replay.changed).toBe(false);
      expect(replay.state).toBe(state);
    }

    if (step.to === "netflix") {
      state = armMedia(state, "netflix");
      const pause = togglePlayPause(state, "netflix");
      expect(pause.accepted).toBe(true);
      state = pause.state;
      expect(state.paused).toBe(true);
    }

    // The first launch (spawn path) is the less deterministic focus boundary;
    // model the stray Play/Pause edge that can land while leaving Netflix.
    if (opts.spawnPath && step.to === "veloraHome") {
      strayEdges += 1;
      const stray = togglePlayPause(state, "netflix");
      strayEdgeAccepted = strayEdgeAccepted || stray.accepted;
      state = stray.state;
    }
  }
  return { state, strayEdges, strayEdgeAccepted };
}

describe("streaming session continuity across a real transition", () => {
  it("first run and repeated run converge under the quiesce", () => {
    const first = runSequence("first", 0x5eed_a1, { spawnPath: true, quiesce: true });
    const repeated = runSequence("repeated", 0x5eed_b2, { spawnPath: false, quiesce: true });

    expect(first.state.snapshot).toBe("youtube");
    expect(repeated.state.snapshot).toBe("youtube");
    expect(first.strayEdges).toBeGreaterThan(0);
    expect(observable(first.state)).toEqual(observable(repeated.state));
    expect(first.state.paused).toBe(true);
  });

  it("no media action is accepted while disarmed", () => {
    let state = initialState();
    expect(togglePlayPause(state, "netflix").accepted).toBe(false);

    state = applyCommand(state, "netflix", "n1", true).state;
    expect(state.mediaArmed).toBe(false);
    expect(togglePlayPause(state, "netflix").accepted).toBe(false);

    state = armMedia(state, "netflix");
    const userPause = togglePlayPause(state, "netflix");
    expect(userPause.accepted).toBe(true);
    state = userPause.state;
    expect(state.paused).toBe(true);

    state = applyCommand(state, "veloraHome", "h1", true).state;
    expect(state.mediaArmed).toBe(false);
    expect(state.targetService).toBeNull();
    expect(togglePlayPause(state, "netflix").accepted).toBe(false);
    expect(state.paused).toBe(true);
  });

  it("generation advances only on real transitions and is idempotent on dedupe", () => {
    let state = initialState();
    const idempotent = applyCommand(state, "veloraHome", "noop", true);
    expect(idempotent.changed).toBe(false);
    expect(idempotent.state.generation).toBe(0);

    state = applyCommand(state, "netflix", "n1", true).state;
    expect(state.generation).toBe(1);
    const deduped = applyCommand(state, "netflix", "n1", true);
    expect(deduped.state).toBe(state);
    expect(deduped.state.generation).toBe(1);

    state = applyCommand(state, "veloraHome", "h1", true).state;
    state = applyCommand(state, "youtube", "y1", true).state;
    expect(state.generation).toBe(3);
    expect(state.receipts).toHaveLength(3);
    expect(state.receipts.map((receipt) => receipt.generation)).toEqual([1, 2, 3]);
    expect(state.receipts.every((receipt) => !receipt.physicalHardwareVerified)).toBe(true);
  });

  it("the quiesce closes the first-launch asymmetry shown by the legacy model", () => {
    const legacyFirst = runSequence("legacy-first", 0x1e6ac, {
      spawnPath: true,
      quiesce: false,
    });
    const legacyRepeated = runSequence("legacy-repeated", 0x1e6ac, {
      spawnPath: false,
      quiesce: false,
    });
    expect(legacyFirst.strayEdgeAccepted).toBe(true);
    expect(legacyRepeated.strayEdgeAccepted).toBe(false);
    expect(legacyFirst.state.paused).not.toBe(legacyRepeated.state.paused);

    const fixedFirst = runSequence("fixed-first", 0x1e6ac, {
      spawnPath: true,
      quiesce: true,
    });
    const fixedRepeated = runSequence("fixed-repeated", 0x1e6ac, {
      spawnPath: false,
      quiesce: true,
    });
    expect(fixedFirst.strayEdgeAccepted).toBe(false);
    expect(fixedFirst.state.paused).toBe(true);
    expect(fixedFirst.state.paused).toBe(fixedRepeated.state.paused);
    expect(observable(fixedFirst.state)).toEqual(observable(fixedRepeated.state));
  });
});
