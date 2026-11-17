import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRMED_DPI_PROVENANCE,
  DISPLAY_CHANGED_EVENT,
  disabledDisplayAudioStatus,
  displayGeometryFlags,
  effectiveScalePercent,
  getDisplayAudioStatus,
  hasNegativeOrigin,
  listenForDisplayChange,
  scaleDivergencePoints,
  type DisplayAudioSnapshot,
  type DisplayChangedEvent,
  type DisplayInfo,
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

describe("Display geometry helpers (physical pixels, DPI honesty)", () => {
  type Diagnostics = DisplayInfo["diagnostics"];
  const diagnostics = (overrides: Partial<NonNullable<Diagnostics>> = {}): Diagnostics => ({
    x: 0,
    y: 0,
    desktopWidth: 3840,
    desktopHeight: 2160,
    scalePercent: 140,
    effectiveDpiX: 144,
    effectiveDpiY: 144,
    dpiProvenance: CONFIRMED_DPI_PROVENANCE,
    refreshMillihz: 59_940,
    connectionType: null,
    adapterName: null,
    edidManufacturerId: null,
    edidProductCodeId: null,
    identitySource: "displayConfig",
    ...overrides,
  });

  it("derives the effective scale only from confirmed DPI", () => {
    // Known real measurement: API bucket 140% but effective DPI 144 (150%).
    expect(effectiveScalePercent(diagnostics())).toBe(150);
    expect(effectiveScalePercent(diagnostics({ effectiveDpiX: 192 }))).toBe(200);
    expect(effectiveScalePercent(diagnostics({ effectiveDpiX: 134 }))).toBe(140);
    // An unverified 96 is never reported as the effective scale.
    expect(effectiveScalePercent(diagnostics({
      effectiveDpiX: 96, effectiveDpiY: 96, dpiProvenance: null,
    }))).toBeNull();
    expect(effectiveScalePercent(diagnostics({
      effectiveDpiX: 144, dpiProvenance: "other" as NonNullable<Diagnostics>["dpiProvenance"],
    }))).toBeNull();
    expect(effectiveScalePercent(diagnostics({ effectiveDpiX: null }))).toBeNull();
    expect(effectiveScalePercent(diagnostics({ effectiveDpiX: 0 }))).toBeNull();
    expect(effectiveScalePercent(undefined)).toBeNull();
  });

  it("measures scale divergence only when both scales are knowable", () => {
    expect(scaleDivergencePoints(diagnostics())).toBe(10);
    expect(scaleDivergencePoints(diagnostics({ scalePercent: 150 }))).toBe(0);
    expect(scaleDivergencePoints(diagnostics({ scalePercent: 134, effectiveDpiX: 134 }))).toBe(6);
    expect(scaleDivergencePoints(diagnostics({ scalePercent: null }))).toBeNull();
    expect(scaleDivergencePoints(diagnostics({
      effectiveDpiX: 96, dpiProvenance: null,
    }))).toBeNull();
  });

  it("detects negative origins from either axis", () => {
    expect(hasNegativeOrigin(undefined)).toBe(false);
    expect(hasNegativeOrigin(diagnostics())).toBe(false);
    expect(hasNegativeOrigin(diagnostics({ x: -3840 }))).toBe(true);
    expect(hasNegativeOrigin(diagnostics({ y: -1080 }))).toBe(true);
    expect(hasNegativeOrigin(diagnostics({ x: -3840, y: -1080 }))).toBe(true);
  });

  it("gates both warnings on confirmed provenance", () => {
    const divergent = displayGeometryFlags(diagnostics({ x: -3840, y: 1080 }));
    expect(divergent).toEqual({
      effectiveScalePercent: 150,
      scaleDivergencePoints: 10,
      scaleDiverges: true,
      negativeOrigin: true,
    });

    const unconfirmed = displayGeometryFlags(diagnostics({
      x: 0, y: 0, effectiveDpiX: 96, effectiveDpiY: 96, dpiProvenance: null,
    }));
    expect(unconfirmed.effectiveScalePercent).toBeNull();
    expect(unconfirmed.scaleDivergencePoints).toBeNull();
    expect(unconfirmed.scaleDiverges).toBe(false);
    expect(unconfirmed.negativeOrigin).toBe(false);

    const aligned = displayGeometryFlags(diagnostics({
      effectiveDpiX: 134, scalePercent: 140,
    }));
    expect(aligned.scaleDiverges).toBe(false);
  });
});
