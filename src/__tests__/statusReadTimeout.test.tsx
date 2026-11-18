// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlCenter } from "../components/ControlCenter";
import { STATUS_READ_TIMEOUT_MS, withTimeout } from "../services/withTimeout";

const mocks = vi.hoisted(() => {
  const controlStatus = {
    windows: false, running: false, gameMode: false, controllerCount: 0, playstationControllerCount: 0,
    foregroundProcess: null, returnHotkeyRegistered: false, lastError: null,
  };
  const remoteStatus = {
    enabled: false, secureOriginAvailable: false, pairingAvailable: false, pairedDeviceCount: 0,
    pairedDevices: [], origin: null, caFingerprint: null, trustProfilePath: null, pairingCode: null,
    pairingExpiresInSeconds: 0,
  };
  const streamingStatus = {
    windows: true, enabled: false, pointerMode: false, activeService: null,
    lastResult: null, acceptedActions: 0, rejectedActions: 0,
  };
  const fallbackStatus = {
    enabled: false, gesture: "disabled" as const, holdMs: 2000 as const,
    physicalMappingValidated: true, validationNote: "", primaryChordSuppressed: false,
    armed: false, holdingSinceMs: null, lastTriggeredAtMs: null,
  };
  return {
    controlStatus,
    remoteStatus,
    streamingStatus,
    fallbackStatus,
    getStatus: vi.fn(),
    getRemoteStatus: vi.fn(async () => remoteStatus),
    controlStatusListener: null as ((status: typeof controlStatus) => void) | null,
    listenControlStatus: vi.fn(async (listener: (status: never) => void) => {
      mocks.controlStatusListener = listener as typeof mocks.controlStatusListener;
      return () => { mocks.controlStatusListener = null; };
    }),
    getStreamingStatus: vi.fn(async () => streamingStatus),
    getFallbackStatus: vi.fn(async () => fallbackStatus),
  };
});

vi.mock("../services/controlService", () => ({
  disabledControlServiceStatus: mocks.controlStatus,
  getControlServiceStatus: mocks.getStatus,
  listenForControlServiceStatus: mocks.listenControlStatus,
  getFallbackHotkeyOptions: vi.fn(async () => []),
  setFallbackHotkey: vi.fn(async () => mocks.controlStatus),
}));
vi.mock("../services/livingRoom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/livingRoom")>();
  return {
    ...actual,
    getStreamingControlStatus: mocks.getStreamingStatus,
    getControllerFallbackStatus: mocks.getFallbackStatus,
  };
});
vi.mock("../services/remoteAccess", () => ({
  disabledRemoteAccessStatus: mocks.remoteStatus,
  REMOTE_ACCESS_DISABLED_REASON: "Serwer domyślnie nie nasłuchuje w sieci.",
  getRemoteAccessStatus: mocks.getRemoteStatus,
  listenForRemoteAccessStatus: vi.fn(async () => () => {}),
  prepareRemoteTrustProfile: vi.fn(async () => mocks.remoteStatus),
  startRemoteAccess: vi.fn(async () => mocks.remoteStatus),
  beginRemotePairing: vi.fn(async () => mocks.remoteStatus),
  stopRemoteAccess: vi.fn(async () => mocks.remoteStatus),
  revokeAllRemoteDevices: vi.fn(async () => mocks.remoteStatus),
  revokeRemoteDevice: vi.fn(async () => mocks.remoteStatus),
  inspectRemoteRecovery: vi.fn(),
  runRemoteRecovery: vi.fn(),
}));

function setupDialog() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
}

function renderCenter() {
  return render(<ControlCenter
    profile="cinema"
    onProfileChange={vi.fn(async () => true)}
    onShowDesktop={vi.fn()}
    onSystemVolume={vi.fn(async () => {})}
    ambientSettings={{ enabled: false, idleSeconds: 300 }}
    onAmbientSettingsChange={vi.fn()}
    mediaPlaying={false}
    onOpenDiagnostics={vi.fn()}
    onReturnToNexus={vi.fn()}
    onClose={vi.fn()}
  />);
}

describe("status read timeout", () => {
  beforeEach(() => {
    setupDialog();
    vi.useFakeTimers();
    mocks.getStatus.mockReset();
    mocks.getStatus.mockImplementation(async () => mocks.controlStatus);
    mocks.getStreamingStatus.mockReset();
    mocks.getStreamingStatus.mockImplementation(async () => mocks.streamingStatus);
    mocks.getFallbackStatus.mockReset();
    mocks.getFallbackStatus.mockImplementation(async () => mocks.fallbackStatus);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.controlStatusListener = null;
  });

  it("reports a Windows status read that never answers, and re-enables the retry", async () => {
    mocks.getStatus.mockImplementation(() => new Promise(() => {}));
    renderCenter();

    // Still waiting: the retry is not offered yet and nothing has failed.
    expect(screen.queryByRole("button", { name: "Ponów odczyt statusu Windows" })).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(STATUS_READ_TIMEOUT_MS);
    });

    expect(screen.getByText(/Nie udało się odczytać stanu Windows/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Ponów odczyt statusu Windows" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);

    // A retry that succeeds clears the failure.
    mocks.getStatus.mockImplementation(async () => mocks.controlStatus);
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(screen.queryByText(/Nie udało się odczytać stanu Windows/)).toBeNull();
  });

  it("ignores a stale first read that resolves after a successful retry (startup race)", async () => {
    let resolveStale!: (status: typeof mocks.controlStatus) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }));
    renderCenter();

    await act(async () => {
      vi.advanceTimersByTime(STATUS_READ_TIMEOUT_MS);
    });
    expect(screen.getByText(/Backend Windows: nieznany/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/brak odpowiedzi/i);

    mocks.getStatus.mockImplementationOnce(async () => ({ ...mocks.controlStatus, windows: true }));
    const retry = screen.getByRole("button", { name: "Ponów odczyt statusu Windows" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(screen.getByText(/Backend Windows: dostępny/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Głośność +" })).toBeTruthy();

    // The original IPC settles late with an outdated "unavailable" snapshot.
    await act(async () => {
      resolveStale({ ...mocks.controlStatus, windows: false });
    });

    expect(screen.getByText(/Backend Windows: dostępny/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Głośność +" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ponów odczyt statusu Windows" })).toBeNull();
  });

  it("retries SessionControllerControls after its status read times out", async () => {
    let resolveStale!: (status: typeof mocks.streamingStatus) => void;
    mocks.getStreamingStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }));
    renderCenter();

    const section = screen.getByLabelText("Sterowanie z kanapy");
    const refreshButton = screen.getByRole("button", { name: "Odśwież stan sterowania" }) as HTMLButtonElement;

    await act(async () => {
      vi.advanceTimersByTime(STATUS_READ_TIMEOUT_MS);
    });
    expect(section.textContent).toContain("Stan sterowania z kanapy jest niedostępny");
    expect(refreshButton.disabled).toBe(false);

    // A retry is reserved while pending, then succeeds once its IPC resolves.
    let resolveRetry!: (status: typeof mocks.streamingStatus) => void;
    mocks.getStreamingStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    await act(async () => {
      fireEvent.click(refreshButton);
    });
    expect(refreshButton.disabled).toBe(true);
    await act(async () => {
      resolveRetry({ ...mocks.streamingStatus, enabled: true });
    });
    expect(section.textContent).toContain("sterowanie włączone");
    expect(section.textContent).not.toContain("Stan sterowania z kanapy jest niedostępny");

    // The first attempt's IPC settles late and must not clobber the newer state.
    await act(async () => {
      resolveStale({ ...mocks.streamingStatus, enabled: false });
    });
    expect(section.textContent).toContain("sterowanie włączone");
    expect(refreshButton.disabled).toBe(false);
  });
});

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes through a value that settles in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 100, "test")).resolves.toBe(7);
  });

  it("rejects with the label when the task does not settle in time", async () => {
    const pending = withTimeout(new Promise<number>(() => {}), 100, "test");
    const assertion = expect(pending).rejects.toThrow(/test: brak odpowiedzi w ciągu 100 ms/);
    vi.advanceTimersByTime(100);
    await assertion;
  });
});
