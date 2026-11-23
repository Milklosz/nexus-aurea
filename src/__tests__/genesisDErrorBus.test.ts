import { describe, expect, it } from "vitest";
import {
  ERROR_BUS_CAPACITY,
  clearErrorBus,
  errorBusListenerCount,
  getErrorBusSnapshot,
  getRecentErrors,
  reportError,
  sanitizeErrorMessage,
  subscribeToErrorBus,
} from "../services/errorBus";

describe("errorBus ring buffer", () => {
  it("sanitizes messages: control characters stripped, length capped, never throws", () => {
    expect(sanitizeErrorMessage("a\u0000b\u001fc")).toBe("a b c");
    expect(sanitizeErrorMessage(new Error("kaput"))).toBe("Error: kaput");
    expect(sanitizeErrorMessage({ message: "obj" })).toBe("obj");
    expect(sanitizeErrorMessage("x".repeat(1000)).length).toBeLessThanOrEqual(240);
    expect(sanitizeErrorMessage(undefined)).toBe("undefined");
  });

  it("stores entries with increasing seq and notifies listeners", () => {
    clearErrorBus();
    const seen: number[] = [];
    const unsubscribe = subscribeToErrorBus((entry) => seen.push(entry.seq));
    reportError("test", new Error("one"), 1_000);
    reportError("test", "two", 1_001);
    expect(getRecentErrors().map((entry) => entry.message)).toEqual(["Error: one", "two"]);
    expect(seen).toEqual([1, 2]);
    expect(getErrorBusSnapshot()).toMatchObject({ size: 2, capacity: ERROR_BUS_CAPACITY, evicted: 0, lastSeq: 2, listeners: 1 });
    unsubscribe();
    expect(errorBusListenerCount()).toBe(0);
    reportError("test", "three", 1_002);
    expect(getRecentErrors()).toHaveLength(3);
  });

  it("is a bounded ring: oldest entries are evicted and counted, never silently dropped", () => {
    clearErrorBus();
    for (let index = 0; index < ERROR_BUS_CAPACITY + 40; index += 1) {
      reportError("soak", `error ${index}`, index);
    }
    const snapshot = getErrorBusSnapshot();
    expect(snapshot.size).toBe(ERROR_BUS_CAPACITY);
    expect(snapshot.evicted).toBe(40);
    expect(snapshot.lastSeq).toBe(ERROR_BUS_CAPACITY + 40);
    const recent = getRecentErrors();
    expect(recent[0].message).toBe(`error 40`);
    expect(recent[recent.length - 1].message).toBe(`error ${ERROR_BUS_CAPACITY + 39}`);
  });

  it("a throwing listener never breaks reporting for other listeners", () => {
    clearErrorBus();
    const good = [] as string[];
    const unsubBad = subscribeToErrorBus(() => {
      throw new Error("broken listener");
    });
    const unsubGood = subscribeToErrorBus((entry) => good.push(entry.message));
    expect(() => reportError("test", "still reported")).not.toThrow();
    expect(good).toEqual(["still reported"]);
    expect(getRecentErrors()).toHaveLength(1);
    unsubGood();
    unsubBad();
    clearErrorBus();
    expect(errorBusListenerCount()).toBe(0);
  });
});
