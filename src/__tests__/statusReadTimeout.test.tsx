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
  return {
    controlStatus,
    remoteStatus,
    getStatus: vi.fn(),
    getRemoteStatus: vi.fn(async () => remoteStatus),
  };
});

vi.mock("../services/controlService", () => ({
  disabledControlServiceStatus: mocks.controlStatus,
  getControlServiceStatus: mocks.getStatus,
  getFallbackHotkeyOptions: vi.fn(async () => []),
  setFallbackHotkey: vi.fn(async () => mocks.controlStatus),
}));
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
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
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
