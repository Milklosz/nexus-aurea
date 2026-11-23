// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  establishControllerHomeReadiness,
  isControllerHomeReady,
  shouldBlockControllerLaunchWithoutNativeHome,
  shouldPreflightControllerHome,
} from "../services/controllerHomePreflight";
import { disabledNativeControllerStatus, type NativeControllerStatus } from "../services/nativeController";
import type { SessionId, SessionSnapshot } from "../services/sessionOrchestrator";
import {
  activateHomeAction,
  closeHomeDisclosure,
  moveWithinHomeActions,
} from "../services/homeActions";
import { returnHomeFocusTarget, useReturnHomeListener } from "../hooks/useReturnHomeFocus";
import type { ReturnHomeEvent } from "../services/sessionOrchestrator";
import type { StreamingService } from "../data/streamingServices";

/**
 * Ascension A, Phase 1, Deliverable 3: PS + Options Home recovery.
 *
 * The native chord itself never consults UI state (it is detected in Rust from
 * raw reports and dispatched through the Home transaction regardless of any
 * overlay), so it works from any dialog/panel/streaming session. What the
 * frontend owns is: (a) the dock-selection restore target, (b) the Home
 * readiness acknowledgement that is bound to one session revision and never
 * inherited, and (c) the homeActions primitives used on the way back.
 * homeActions.ts is owned elsewhere; this file only uses its exported API.
 * Everything is deterministic: pure functions, injected timestamps, no timers.
 */

function session(current: SessionId, revision: number, launchId = ""): SessionSnapshot {
  return {
    current,
    previous: null,
    revision,
    transitionedAtMs: revision * 1_000,
    context: launchId ? { launchId, sessionRevision: revision } : null,
    allowedTargets: ["veloraHome"],
  };
}

const netflix: StreamingService = {
  kind: "web", id: "netflix", name: "Netflix", label: "NETFLIX",
  className: "netflix", href: "https://www.netflix.com", allowedHost: "www.netflix.com",
};
const appleMusic: StreamingService = { kind: "managed", id: "appleMusic", name: "Apple Music", label: "APPLE MUSIC" } as StreamingService;

function status(overrides: Partial<NativeControllerStatus> = {}): NativeControllerStatus {
  return {
    ...disabledNativeControllerStatus,
    supported: true,
    running: true,
    pads: [{ device: "pad-a", revision: "v2", transport: "bluetooth" }],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("ascension A: Home readiness is bound to one session revision", () => {
  it("an established acknowledgement matches exactly its session state", () => {
    const home = session("veloraHome", 7);
    const readiness = establishControllerHomeReadiness(home, 1_000);
    expect(isControllerHomeReady(readiness, home)).toBe(true);
  });

  it("a real transition into a streaming session invalidates the token (explicit Resume required)", () => {
    const home = session("veloraHome", 7);
    const readiness = establishControllerHomeReadiness(home, 1_000);
    // User launches Netflix: new revision + new launch id.
    const cinema = session("cinema", 8, "launch-netflix-1");
    expect(isControllerHomeReady(readiness, cinema)).toBe(false);
    // Re-establishing for the new state works again.
    const again = establishControllerHomeReadiness(cinema, 2_000);
    expect(isControllerHomeReady(again, cinema)).toBe(true);
    expect(isControllerHomeReady(again, home)).toBe(false);
  });

  it("a remounted panel without acknowledgement is never implicitly ready", () => {
    const home = session("veloraHome", 7);
    expect(isControllerHomeReady(null, home)).toBe(false);
    expect(isControllerHomeReady(undefined, home)).toBe(false);
    const readiness = establishControllerHomeReadiness(home, 1_000);
    expect(isControllerHomeReady(readiness, null)).toBe(false);
  });

  it("a revision bump alone (same target, e.g. session hand-off) also invalidates", () => {
    const before = session("game", 3, "launch-steam-a");
    const readiness = establishControllerHomeReadiness(before, 10);
    const after = session("game", 4, "launch-steam-b");
    expect(isControllerHomeReady(readiness, after)).toBe(false);
  });
});

describe("ascension A: launch preflight gates (Home from any session state)", () => {
  it("preflight is required only for guarded services with a present but disarmed native Home", () => {
    expect(shouldPreflightControllerHome(netflix, status({ homeEnabled: false }))).toBe(true);
    expect(shouldPreflightControllerHome(netflix, status({ homeEnabled: true }))).toBe(false);
    expect(shouldPreflightControllerHome(netflix, status({ pads: [] }))).toBe(false);
    expect(shouldPreflightControllerHome(netflix, status({ running: false }))).toBe(false);
    // A non-guarded managed app keeps its existing behavior.
    expect(shouldPreflightControllerHome(appleMusic, status({ homeEnabled: false }))).toBe(false);
  });

  it("external launches are blocked unless the native Home path is confirmed healthy", () => {
    expect(shouldBlockControllerLaunchWithoutNativeHome(netflix, status(), false)).toBe(true); // status unknown
    expect(shouldBlockControllerLaunchWithoutNativeHome(netflix, status({ supported: false }), true)).toBe(true);
    expect(shouldBlockControllerLaunchWithoutNativeHome(netflix, status({ pads: [] }), true)).toBe(true);
    expect(shouldBlockControllerLaunchWithoutNativeHome(netflix, status({ homeEnabled: true, lastError: null }), true)).toBe(false);
    expect(shouldBlockControllerLaunchWithoutNativeHome(appleMusic, status(), false)).toBe(false);
  });
});

describe("ascension A: Home return target keeps the dock selection", () => {
  it("the launched tile is restored, not always the first one — from any session", () => {
    // Streaming session active (launched tile 4 of 6): the Home return targets it.
    expect(returnHomeFocusTarget(4, 6)).toBe(4);
    expect(returnHomeFocusTarget(0, 6)).toBe(0);
    expect(returnHomeFocusTarget(5, 6)).toBe(5);
  });

  it("out-of-range or invalid selections fall back to the first tile exactly once", () => {
    expect(returnHomeFocusTarget(6, 6)).toBe(0);
    expect(returnHomeFocusTarget(-1, 6)).toBe(0);
    expect(returnHomeFocusTarget(2.5, 6)).toBe(0);
    expect(returnHomeFocusTarget(3, 0)).toBe(0);
  });

  it("the return-home listener fires once per event and unsubscribes on unmount", () => {
    const events: ReturnHomeEvent[] = [];
    let unlisten: (() => void) | null = null;
    const listen = vi.fn(async (callback: (event: ReturnHomeEvent) => void) => {
      const cb = callback;
      unlisten = () => { events.push({ kind: "unlistened" } as unknown as ReturnHomeEvent); };
      return () => { if (unlisten) unlisten(); };
    });
    const event: ReturnHomeEvent = {
      atMs: 1, source: "localController", cause: "gamepadHome",
      restore: { attempted: true, restored: true, outcome: "restored", message: "" },
      session: session("veloraHome", 9, ""),
    } as unknown as ReturnHomeEvent;
    const handler = vi.fn();
    const view = renderHook(() => useReturnHomeListener(handler, listen));
    return act(async () => {
      await Promise.resolve();
      const cb = (listen.mock.calls[0]?.[0] ?? null) as ((e: ReturnHomeEvent) => void) | null;
      expect(cb).not.toBeNull();
      act(() => { cb?.(event); });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
      view.unmount();
      expect(events.some((e) => (e as unknown as { kind: string }).kind === "unlistened")).toBe(true);
    });
  });
});

describe("ascension A: homeActions API on the way back from an overlay", () => {
  function buildOverlay() {
    document.body.innerHTML = `
      <dialog open class="control-center">
        <div data-home-disclosure>
          <button id="disclosure-trigger" aria-expanded="true">Powrót</button>
          <div class="panel"><button id="inside-panel">Opcja</button></div>
        </div>
      </dialog>
      <div class="home-actions">
        <button id="ha-0">Szukaj</button>
        <button id="ha-1">Pilot</button>
        <button id="ha-2">Ustawienia</button>
      </div>`;
    return {
      trigger: document.getElementById("disclosure-trigger") as HTMLButtonElement,
      insidePanel: document.getElementById("inside-panel") as HTMLButtonElement,
      row: Array.from(document.querySelectorAll<HTMLButtonElement>(".home-actions button")),
    };
  }

  it("Circle closes an open Home disclosure even while focus is inside a dialog", () => {
    const { trigger, insidePanel } = buildOverlay();
    const click = vi.spyOn(trigger, "click");
    // Focus is on an element deep inside the dialog: the disclosure still closes.
    expect(closeHomeDisclosure(insidePanel)).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    // With nothing open, there is nothing to close.
    trigger.setAttribute("aria-expanded", "false");
    expect(closeHomeDisclosure(insidePanel)).toBe(false);
    expect(closeHomeDisclosure(null)).toBe(false);
  });

  it("left/right inside the actions row never wraps and never leaves the row", () => {
    const { row } = buildOverlay();
    row[1].focus();
    expect(document.activeElement).toBe(row[1]);
    expect(moveWithinHomeActions(document.activeElement, 1)).toBe(true);
    expect(document.activeElement).toBe(row[2]);
    // At the end the move is consumed (true) but focus stays put: no wrap, no dock exit.
    expect(moveWithinHomeActions(document.activeElement, 1)).toBe(true);
    expect(document.activeElement).toBe(row[2]);
    expect(moveWithinHomeActions(document.activeElement, -1)).toBe(true);
    expect(document.activeElement).toBe(row[1]);
    // Outside the row the caller falls back to dock navigation.
    expect(moveWithinHomeActions(document.body, 1)).toBe(false);
    expect(moveWithinHomeActions(null, 1)).toBe(false);
  });

  it("confirm on a Home action presses exactly that action", () => {
    const { row } = buildOverlay();
    const click = vi.spyOn(row[0], "click");
    row[0].focus();
    expect(activateHomeAction(document.activeElement)).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(activateHomeAction(document.body)).toBe(false);
  });
});
