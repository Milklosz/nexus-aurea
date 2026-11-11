// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ControlCenter } from "../components/ControlCenter";
import type { AmbientSettings } from "../services/ambient";
import type { CinemaProfile } from "../services/cinemaMode";
import type { RemoteAccessStatus } from "../services/remoteAccess";

const mocks = vi.hoisted(() => ({
  status: { windows: false, running: false, gameMode: false, controllerCount: 0, playstationControllerCount: 0, foregroundProcess: null, returnHotkeyRegistered: false, lastError: null },
  getStatus: vi.fn(async () => mocks.status),
  remoteStatus: { enabled: false, secureOriginAvailable: false, pairingAvailable: false, pairedDeviceCount: 0, pairedDevices: [], origin: null, caFingerprint: null, trustProfilePath: null, pairingCode: null, pairingExpiresInSeconds: 0 },
  getRemoteStatus: vi.fn(async () => mocks.remoteStatus),
  remoteStatusListener: null as ((status: RemoteAccessStatus) => void) | null,
  listenRemoteStatus: vi.fn(async (listener: (status: RemoteAccessStatus) => void) => {
    mocks.remoteStatusListener = listener;
    return () => {};
  }),
  prepareTrustProfile: vi.fn(async () => mocks.remoteStatus),
  startRemoteAccess: vi.fn(async () => mocks.remoteStatus),
  beginRemotePairing: vi.fn(async () => mocks.remoteStatus),
  stopRemoteAccess: vi.fn(async () => mocks.remoteStatus),
  revokeAllRemoteDevices: vi.fn(async () => mocks.remoteStatus),
  revokeRemoteDevice: vi.fn(async () => mocks.remoteStatus),
}));
vi.mock("../services/controlService", () => ({
  disabledControlServiceStatus: { windows: false, running: false, gameMode: false, controllerCount: 0, playstationControllerCount: 0, foregroundProcess: null, returnHotkeyRegistered: false, lastError: null },
  getControlServiceStatus: mocks.getStatus,
}));
vi.mock("../services/remoteAccess", () => ({
  disabledRemoteAccessStatus: mocks.remoteStatus,
  REMOTE_ACCESS_DISABLED_REASON: "Serwer domyślnie nie nasłuchuje w sieci.",
  getRemoteAccessStatus: mocks.getRemoteStatus,
  listenForRemoteAccessStatus: mocks.listenRemoteStatus,
  prepareRemoteTrustProfile: mocks.prepareTrustProfile,
  startRemoteAccess: mocks.startRemoteAccess,
  beginRemotePairing: mocks.beginRemotePairing,
  stopRemoteAccess: mocks.stopRemoteAccess,
  revokeAllRemoteDevices: mocks.revokeAllRemoteDevices,
  revokeRemoteDevice: mocks.revokeRemoteDevice,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.remoteStatusListener = null; });

function setupDialog() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function(this: HTMLDialogElement) { this.setAttribute("open", ""); }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
}

function renderCenter(overrides: Partial<{
  profile: CinemaProfile;
  onProfileChange: (profile: CinemaProfile) => Promise<boolean>;
  onShowDesktop: () => void;
  onSystemVolume: (action: "up" | "down" | "mute") => Promise<void>;
  ambientSettings: AmbientSettings;
  onAmbientSettingsChange: (settings: AmbientSettings) => void;
  onReturnToNexus: () => void;
  onOpenDiagnostics: () => void;
  onClose: () => void;
}> = {}) {
  return render(<ControlCenter
    profile={overrides.profile ?? "cinema"}
    onProfileChange={overrides.onProfileChange ?? vi.fn(async () => true)}
    onShowDesktop={overrides.onShowDesktop ?? vi.fn()}
    onSystemVolume={overrides.onSystemVolume ?? vi.fn(async () => {})}
    ambientSettings={overrides.ambientSettings ?? { enabled: false, idleSeconds: 300 }}
    onAmbientSettingsChange={overrides.onAmbientSettingsChange ?? vi.fn()}
    mediaPlaying={false}
    onOpenDiagnostics={overrides.onOpenDiagnostics ?? vi.fn()}
    onReturnToNexus={overrides.onReturnToNexus ?? vi.fn()}
    onClose={overrides.onClose ?? vi.fn()}
  />);
}

describe("Control Center", () => {
  it("switches Cinema, Gaming, and Desktop through the existing profile handler", async () => {
    setupDialog();
    const changeProfile = vi.fn(async () => true);
    renderCenter({ onProfileChange: changeProfile });
    fireEvent.click(screen.getByRole("button", { name: "Gaming" }));
    await waitFor(() => expect(changeProfile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Desktop" }));
    await waitFor(() => expect(changeProfile).toHaveBeenCalledTimes(2));
    expect(changeProfile).toHaveBeenNthCalledWith(1, "gaming");
    expect(changeProfile).toHaveBeenNthCalledWith(2, "desktop");
  });

  it("disables Windows volume controls when the backend is unavailable", async () => {
    setupDialog();
    mocks.status = { ...mocks.status, windows: false };
    renderCenter();
    await waitFor(() => expect(screen.getByText(/backend Windows: niedostępny/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Głośność +" })).toBeNull();
    expect(screen.getByText(/Regulacja głośności wymaga natywnego backendu Windows/)).toBeTruthy();
  });

  it("retries a failed Windows status read without duplicate requests and keeps retry focus while pending", async () => {
    setupDialog();
    mocks.getStatus.mockRejectedValueOnce(new Error("status unavailable"));
    renderCenter();

    expect((await screen.findByRole("alert")).textContent).toContain("Nie udało się odczytać stanu Windows.");
    const retryButton = screen.getByRole("button", { name: "Ponów odczyt statusu Windows" });
    retryButton.focus();
    expect(document.activeElement).toBe(retryButton);

    let resolveStatus!: (status: typeof mocks.status) => void;
    mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });

    expect(screen.getByRole("button", { name: "Odczytuję…" })).toBe(retryButton);
    expect(retryButton.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(retryButton);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);

    const recoveredStatus = { ...mocks.status, windows: true };
    resolveStatus(recoveredStatus);

    expect(await screen.findByRole("button", { name: "Głośność +" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ponów odczyt statusu Windows" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it("uses the existing system volume actions when Windows is available", async () => {
    setupDialog();
    mocks.status = { ...mocks.status, windows: true };
    const volume = vi.fn(async () => {});
    renderCenter({ onSystemVolume: volume });
    await waitFor(() => expect(screen.getByRole("button", { name: "Głośność +" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Głośność +" }));
    await waitFor(() => expect(volume).toHaveBeenCalledWith("up"));
  });

  it("offers explicit return-to-VELORA and desktop actions", async () => {
    setupDialog();
    const showDesktop = vi.fn();
    const returnToNexus = vi.fn();
    renderCenter({ onShowDesktop: showDesktop, onReturnToNexus: returnToNexus });
    fireEvent.click(screen.getByRole("button", { name: "Pokaż pulpit" }));
    fireEvent.click(screen.getByRole("button", { name: "Wróć do VELORA" }));
    expect(showDesktop).toHaveBeenCalledOnce();
    expect(returnToNexus).toHaveBeenCalledOnce();
  });

  it("includes the Gaming Hub and keeps the LAN server off until trust is confirmed", async () => {
    setupDialog();
    renderCenter();
    fireEvent.click(screen.getByRole("tab", { name: "Gaming" }));
    expect(screen.getByRole("heading", { name: "Gaming Hub" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "iPhone Remote" }));
    const remoteStatus = screen.getByLabelText("Stan iPhone Remote");
    expect(remoteStatus.textContent).toContain("Serwer LAN");
    await waitFor(() => expect(remoteStatus.textContent).toContain("wyłączony"));
    expect(screen.queryByRole("button", { name: "Uruchom serwer HTTPS" })).toBeNull();
    expect(screen.getByRole("button", { name: "Przygotuj profil zaufania iPhone'a" })).toBeTruthy();
    expect(screen.getByText(/Serwer domyślnie nie nasłuchuje w sieci/)).toBeTruthy();
  });

  it("keeps iPhone Remote actions hidden when its secure status cannot be read", async () => {
    setupDialog();
    mocks.getRemoteStatus.mockRejectedValueOnce(new Error("status unavailable"));
    renderCenter();
    fireEvent.click(screen.getByRole("tab", { name: "iPhone Remote" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/bezpiecznego stanu.*sterowanie pozostaje wyłączone/i);
    expect(screen.getByLabelText("Stan iPhone Remote").textContent).toContain("stan nieznany");
    expect(screen.queryByRole("button", { name: "Przygotuj profil zaufania iPhone'a" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wygeneruj kod parowania" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ponów odczyt statusu" }));
    expect(await screen.findByRole("button", { name: "Przygotuj profil zaufania iPhone'a" })).toBeTruthy();
    expect(mocks.getRemoteStatus).toHaveBeenCalledTimes(2);
  });

  it("deduplicates secure status retries and preserves retry focus while pending", async () => {
    setupDialog();
    mocks.getRemoteStatus.mockRejectedValueOnce(new Error("status unavailable"));
    renderCenter();
    fireEvent.click(screen.getByRole("tab", { name: "iPhone Remote" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    const retryButton = screen.getByRole("button", { name: "Ponów odczyt statusu" });
    retryButton.focus();
    expect(document.activeElement).toBe(retryButton);

    let resolveStatus!: (status: typeof mocks.remoteStatus) => void;
    mocks.getRemoteStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });

    expect(screen.getByRole("button", { name: "Odczytuję…" })).toBe(retryButton);
    expect(retryButton.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(retryButton);
    expect(mocks.getRemoteStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Przygotuj profil zaufania iPhone'a" })).toBeNull();
    expect(mocks.beginRemotePairing).not.toHaveBeenCalled();
    expect(mocks.startRemoteAccess).not.toHaveBeenCalled();

    resolveStatus(mocks.remoteStatus);

    expect(await screen.findByRole("button", { name: "Przygotuj profil zaufania iPhone'a" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ponów odczyt statusu" })).toBeNull();
    expect(mocks.getRemoteStatus).toHaveBeenCalledTimes(2);
    expect(mocks.beginRemotePairing).not.toHaveBeenCalled();
    expect(mocks.startRemoteAccess).not.toHaveBeenCalled();
  });

  it("ignores a late secure status read after a newer status event arrives", async () => {
    setupDialog();
    let resolveStatus!: (status: typeof mocks.remoteStatus) => void;
    mocks.getRemoteStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    renderCenter();
    fireEvent.click(screen.getByRole("tab", { name: "iPhone Remote" }));
    const remoteStatus = screen.getByLabelText("Stan iPhone Remote");
    await waitFor(() => expect(mocks.remoteStatusListener).toBeTypeOf("function"));

    const eventStatus = { ...mocks.remoteStatus, enabled: true, secureOriginAvailable: true, pairedDeviceCount: 2 };
    act(() => { mocks.remoteStatusListener?.(eventStatus); });
    expect(remoteStatus.textContent).toContain("2");

    await act(async () => { resolveStatus({ ...mocks.remoteStatus, pairedDeviceCount: 0 }); });

    expect(remoteStatus.textContent).toContain("2");
    expect(remoteStatus.textContent).toContain("HTTPSaktywny");
    expect(mocks.getRemoteStatus).toHaveBeenCalledOnce();
  });

  it("keeps one panel visible and supports remote left-right tab navigation", async () => {
    setupDialog();
    renderCenter();
    const cinemaTab = screen.getByRole("tab", { name: "Cinema" });
    expect(cinemaTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(cinemaTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Gaming" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Gaming" }));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Gaming" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "iPhone Remote" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "iPhone Remote" }));
    expect(screen.queryByRole("heading", { name: "Gaming Hub" })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Stan iPhone Remote").textContent).toContain("wyłączony"));
  });

  it("cycles the Ambient idle interval through supported values", async () => {
    setupDialog();
    const update = vi.fn();
    renderCenter({ ambientSettings: { enabled: true, idleSeconds: 300 }, onAmbientSettingsChange: update });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Bezczynność/ })); });
    expect(update).toHaveBeenCalledWith({ enabled: true, idleSeconds: 600 });
  });
});
