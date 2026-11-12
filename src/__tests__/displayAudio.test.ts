import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISPLAY_CHANGED_EVENT,
  disabledDisplayAudioStatus,
  getDisplayAudioStatus,
  listenForDisplayChange,
  type DisplayAudioSnapshot,
  type DisplayChangedEvent,
} from "../services/displayAudio";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

afterEach(() => vi.clearAllMocks());
beforeEach(() => mocks.isTauri.mockReturnValue(true));

const nativeSnapshot: DisplayAudioSnapshot = {
  windows: true,
  supported: true,
  displays: [
    {
      id: "0123456789abcdef",
      name: "Monitor 1",
      width: 1920,
      height: 1080,
      refreshHz: 60,
      bitsPerPixel: 32,
      primary: true,
      hdr: null,
      hdrError: "Windows nie udostępnił informacji o HDR (kod 50).",
    },
  ],
  audio: [
    {
      id: "fedcba9876543210",
      name: "Głośniki",
      state: "active",
      defaultDevice: true,
      volumePercent: 40,
      muted: false,
    },
  ],
  displayError: null,
  audioError: null,
  policy: {
    readOnly: true,
    automaticModeChanges: false,
    notes: ["Ten build tylko odczytuje stan wyświetlaczy i audio."],
  },
  limitations: ["Automatyczna zmiana trybu obrazu nie jest zaimplementowana."],
  displaySignature: "89abcdef01234567",
  capturedAtMs: 1_763_000_000_000,
};

describe("Display and audio native bridge", () => {
  it("invokes the read-only status command without arguments", async () => {
    mocks.invoke.mockResolvedValueOnce(nativeSnapshot);

    await expect(getDisplayAudioStatus()).resolves.toEqual(nativeSnapshot);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("get_display_audio_status");
    expect(mocks.invoke.mock.calls[0]).toHaveLength(1);
  });

  it("uses a disabled, hardware-free fallback outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);

    const status = await getDisplayAudioStatus();

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(status).toEqual(disabledDisplayAudioStatus);
    expect(status.supported).toBe(false);
    expect(status.windows).toBe(false);
    expect(status.displays).toEqual([]);
    expect(status.audio).toEqual([]);
    expect(status.policy.readOnly).toBe(true);
    expect(status.policy.automaticModeChanges).toBe(false);
  });

  it("registers the native display change listener and forwards payloads", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValueOnce(unlisten);
    const callback = vi.fn();
    const event: DisplayChangedEvent = {
      previousSignature: "0123456789abcdef",
      displaySignature: "fedcba9876543210",
      displays: nativeSnapshot.displays,
      atMs: 1_763_000_000_000,
    };

    const stopListening = await listenForDisplayChange(callback);

    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(mocks.listen.mock.calls[0][0]).toBe(DISPLAY_CHANGED_EVENT);
    expect(DISPLAY_CHANGED_EVENT).toBe("velora-display-changed");
    const handler = mocks.listen.mock.calls[0][1] as (event: {
      payload: DisplayChangedEvent;
    }) => void;
    handler({ payload: event });
    expect(callback).toHaveBeenCalledWith(event);
    expect(stopListening).toBe(unlisten);
  });

  it("does not register a native listener outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);
    const callback = vi.fn();

    const stopListening = await listenForDisplayChange(callback);

    expect(mocks.listen).not.toHaveBeenCalled();
    expect(typeof stopListening).toBe("function");
    stopListening();
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps the read-only policy contract on both native and fallback snapshots", () => {
    expect(nativeSnapshot.policy.readOnly).toBe(true);
    expect(nativeSnapshot.policy.automaticModeChanges).toBe(false);
    expect(disabledDisplayAudioStatus.policy.readOnly).toBe(true);
    expect(disabledDisplayAudioStatus.policy.automaticModeChanges).toBe(false);
    expect(disabledDisplayAudioStatus.policy.notes.length).toBeGreaterThan(0);
    expect(disabledDisplayAudioStatus.limitations.length).toBeGreaterThan(0);
  });
});
