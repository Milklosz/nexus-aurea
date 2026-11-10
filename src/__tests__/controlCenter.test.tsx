// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ControlCenter } from "../components/ControlCenter";
import type { AmbientSettings } from "../services/ambient";
import type { CinemaProfile } from "../services/cinemaMode";

const mocks = vi.hoisted(() => ({
  status: { windows: false, running: false, gameMode: false, controllerCount: 0, playstationControllerCount: 0, foregroundProcess: null, returnHotkeyRegistered: false, lastError: null },
  getStatus: vi.fn(async () => mocks.status),
}));
vi.mock("../services/controlService", () => ({
  disabledControlServiceStatus: { windows: false, running: false, gameMode: false, controllerCount: 0, playstationControllerCount: 0, foregroundProcess: null, returnHotkeyRegistered: false, lastError: null },
  getControlServiceStatus: mocks.getStatus,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
    expect(screen.getByText(/Regulacja głośności jest niedostępna/)).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "Gaming Hub" })).toBeTruthy();
    expect(screen.getByText(/Serwer LAN: wyłączony/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Uruchom serwer HTTPS" })).toBeNull();
    expect(screen.getByRole("button", { name: "Przygotuj profil zaufania iPhone'a" })).toBeTruthy();
    expect(screen.getByText(/Serwer domyślnie nie nasłuchuje w sieci/)).toBeTruthy();
  });

  it("cycles the Ambient idle interval through supported values", async () => {
    setupDialog();
    const update = vi.fn();
    renderCenter({ ambientSettings: { enabled: true, idleSeconds: 300 }, onAmbientSettingsChange: update });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Bezczynność/ })); });
    expect(update).toHaveBeenCalledWith({ enabled: true, idleSeconds: 600 });
  });
});
