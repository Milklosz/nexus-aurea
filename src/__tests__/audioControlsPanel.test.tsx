// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioControls } from "../components/AudioControls";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), getSystemAudio: vi.fn(), listenForSystemAudioChange: vi.fn(), setSystemAudioVolume: vi.fn(), setSystemAudioMute: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("../services/audioControl", () => mocks);
const output = { id: "0123456789abcdef", name: "HDMI audio", state: "active", defaultDevice: true, volumePercent: 45, muted: false };
beforeEach(() => { vi.clearAllMocks(); mocks.isTauri.mockReturnValue(true); mocks.getSystemAudio.mockResolvedValue(output); mocks.listenForSystemAudioChange.mockResolvedValue(() => {}); });
afterEach(cleanup);

describe("Audio Control Center panel", () => {
  it("shows a disabled read-only browser preview without native calls or a failure alert", () => {
    mocks.isTauri.mockReturnValue(false);
    render(<AudioControls />);
    expect(screen.getByText(/Podgląd przeglądarkowy/)).toBeTruthy();
    for (const button of screen.getAllByRole("button")) expect(button).toHaveProperty("disabled", true);
    fireEvent.focus(window);
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.click(screen.getByRole("button", { name: "Odśwież dźwięk" }));
    expect(mocks.getSystemAudio).not.toHaveBeenCalled();
    expect(mocks.setSystemAudioVolume).not.toHaveBeenCalled();
    expect(mocks.setSystemAudioMute).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads on mount and changes volume only after explicit action", async () => {
    mocks.setSystemAudioVolume.mockResolvedValue({ ...output, volumePercent: 50 });
    render(<AudioControls />);
    await screen.findByText("45%");
    expect(mocks.setSystemAudioVolume).not.toHaveBeenCalled();
    expect(mocks.setSystemAudioMute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Głośniej o 5 procent" }));
    await screen.findByText("50%");
    expect(mocks.setSystemAudioVolume).toHaveBeenCalledWith(50, output.id);
  });

  it("serializes repeated actions and displays readback rather than optimistic state", async () => {
    let complete!: (value: typeof output) => void;
    mocks.setSystemAudioVolume.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(<AudioControls />);
    await screen.findByText("45%");
    fireEvent.click(screen.getByRole("button", { name: "Głośniej o 5 procent" }));
    fireEvent.click(screen.getByRole("button", { name: "Głośniej o 5 procent" }));
    expect(mocks.setSystemAudioVolume).toHaveBeenCalledTimes(1);
    expect(screen.getByText("45%")).toBeTruthy();
    await act(async () => complete({ ...output, volumePercent: 49 }));
    await screen.findByText("49%");
  });

  it("clears stale output on denial and requires a fresh read", async () => {
    mocks.setSystemAudioMute.mockRejectedValueOnce("Wyjście audio zmieniło się.");
    render(<AudioControls />);
    await screen.findByText("45%");
    fireEvent.click(screen.getByRole("button", { name: "Wycisz" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Wyjście audio zmieniło się.");
    expect(screen.getByRole("button", { name: "Wycisz" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Odśwież dźwięk" }));
    await screen.findByText("45%");
    expect(mocks.getSystemAudio).toHaveBeenCalledTimes(2);
    expect(mocks.setSystemAudioMute).toHaveBeenCalledTimes(1);
  });

  it("refreshes when VELORA regains focus and cleans up listeners", async () => {
    const view = render(<AudioControls />);
    await screen.findByText("45%");
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.getSystemAudio).toHaveBeenCalledTimes(2));
    view.unmount();
    fireEvent.focus(window);
    expect(mocks.getSystemAudio).toHaveBeenCalledTimes(2);
  });

  it("invalidates a changed endpoint immediately and refreshes without writing the new output", async () => {
    let notify!: () => void;
    const stop = vi.fn();
    mocks.listenForSystemAudioChange.mockImplementationOnce(async callback => { notify = callback; return stop; });
    const view = render(<AudioControls />);
    await screen.findByText("45%");
    mocks.getSystemAudio.mockResolvedValueOnce({ ...output, id: "fedcba9876543210", name: "New output", volumePercent: 30 });
    act(() => { notify(); notify(); });
    expect(screen.getByRole("button", { name: "Głośniej o 5 procent" })).toHaveProperty("disabled", true);
    await screen.findByText("30%");
    expect(mocks.getSystemAudio).toHaveBeenCalledTimes(2);
    expect(mocks.setSystemAudioVolume).not.toHaveBeenCalled();
    expect(mocks.setSystemAudioMute).not.toHaveBeenCalled();
    view.unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("discards an in-flight read of a revoked endpoint and schedules a fresh read", async () => {
    let notify!: () => void;
    let complete!: (value: typeof output) => void;
    mocks.listenForSystemAudioChange.mockImplementationOnce(async callback => { notify = callback; return () => {}; });
    mocks.getSystemAudio.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    mocks.getSystemAudio.mockResolvedValueOnce({ ...output, name: "New output", volumePercent: 30 });
    render(<AudioControls />);
    await waitFor(() => expect(notify).toBeTypeOf("function"));
    act(() => notify());
    await new Promise(resolve => setTimeout(resolve, 120));
    await act(async () => complete(output));
    await screen.findByText("30%");
    expect(screen.queryByText("45%")).toBeNull();
    expect(mocks.setSystemAudioVolume).not.toHaveBeenCalled();
  });
});
