import { describe, expect, it } from "vitest";
import { ControllerEngine, type ControllerSample } from "../services/controllerEngine";
import { BumperEdges } from "../services/nativeController";

const neutral: ControllerSample = {
  connected: true, dpadLeft: false, dpadRight: false, axisX: 0, confirm: false, back: false, options: false,
};

function run(engine: ControllerEngine, sample: ControllerSample, times: number[]) {
  return times.flatMap((at) => engine.update(sample, at, true));
}

describe("dominant axis for a stick diagonal", () => {
  it("moves along the stronger axis only and does not flip near 45 degrees", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    const diagonal = { ...neutral, axisX: 0.8, axisY: 0.6 };
    const first = run(engine, diagonal, [10, 60, 110]);
    expect(first).toEqual([{ type: "move", delta: 1 }]);
    // The Y axis becomes slightly stronger: the lock keeps horizontal.
    const jitter = { ...neutral, axisX: 0.6, axisY: 0.65 };
    expect(run(engine, jitter, [160, 210]).filter((a) => a.type === "vertical")).toEqual([]);
  });

  it("releases the lock when both axes return to rest", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    run(engine, { ...neutral, axisX: 0.8, axisY: 0.6 }, [10, 60]);
    run(engine, neutral, [100, 150]);
    const vertical = run(engine, { ...neutral, axisX: 0.1, axisY: 0.9 }, [200, 260]);
    expect(vertical).toEqual([{ type: "vertical", delta: 1 }]);
  });

  it("a deliberate D-pad diagonal still moves both ways, as before", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    const actions = run(engine, { ...neutral, dpadRight: true, dpadDown: true }, [10, 60]);
    expect(actions).toEqual([{ type: "move", delta: 1 }, { type: "vertical", delta: 1 }]);
  });
});

describe("Options on release (native source)", () => {
  const options = { ...neutral, options: true };

  it("fires once on release, never on press", () => {
    const engine = new ControllerEngine({ optionsOnRelease: true });
    engine.update(neutral, 0, true);
    expect(run(engine, options, [10, 60, 400])).toEqual([]);
    expect(run(engine, neutral, [450, 500])).toEqual([{ type: "options" }]);
  });

  it("does not fire when PS was held at any point during the press", () => {
    const engine = new ControllerEngine({ optionsOnRelease: true });
    engine.update(neutral, 0, true);
    run(engine, options, [10, 60]);
    run(engine, { ...options, guide: true }, [100, 150]);
    run(engine, options, [200, 250]);
    expect(run(engine, neutral, [300, 350])).toEqual([]);
    // The next ordinary press works again.
    run(engine, options, [400, 450]);
    expect(run(engine, neutral, [500, 550])).toEqual([{ type: "options" }]);
  });

  it("does not fire when Options is already held as input starts and then released", () => {
    const engine = new ControllerEngine({ optionsOnRelease: true });
    engine.update(options, 0, true); // primed while held (focus returned, pad reconnected)
    expect(run(engine, options, [10, 100])).toEqual([]);
    expect(run(engine, neutral, [150, 200])).toEqual([]);
  });

  it("the default engine keeps firing Options on press (Gamepad API behaviour unchanged)", () => {
    const engine = new ControllerEngine();
    engine.update(neutral, 0, true);
    expect(run(engine, options, [10, 60])).toEqual([{ type: "options" }]);
  });
});

describe("BumperEdges", () => {
  it("fires on rising edges only and ignores a bumper held at start", () => {
    const edges = new BumperEdges();
    expect(edges.update(true, false)).toEqual([]); // held when first seen
    expect(edges.update(true, false)).toEqual([]);
    expect(edges.update(false, false)).toEqual([]);
    expect(edges.update(false, true)).toEqual([1]);
    expect(edges.update(false, true)).toEqual([]);
    expect(edges.update(true, true)).toEqual([-1]);
  });

  it("re-primes after a reset", () => {
    const edges = new BumperEdges();
    edges.update(false, false);
    edges.reset();
    expect(edges.update(false, true)).toEqual([]);
  });
});
