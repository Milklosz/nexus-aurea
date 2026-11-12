// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLaunchGuard } from "../hooks/useLaunchGuard";

describe("service launch guard", () => {
  it("ignores a duplicate launch for the same dock service until the first finishes", async () => {
    let finishLaunch!: () => void;
    const pending = new Promise<void>((resolve) => { finishLaunch = resolve; });
    const launch = vi.fn(() => pending);
    const duplicate = vi.fn(async () => {});
    const { result } = renderHook(() => useLaunchGuard());
    let first!: Promise<void>;

    act(() => {
      first = result.current.run("steam", launch);
    });
    await waitFor(() => expect(result.current.launchingIds.has("steam")).toBe(true));

    const second = result.current.run("steam", duplicate);
    expect(launch).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();

    await act(async () => {
      finishLaunch();
      await Promise.all([first, second]);
    });
    expect(result.current.launchingIds.has("steam")).toBe(false);
  });
});
