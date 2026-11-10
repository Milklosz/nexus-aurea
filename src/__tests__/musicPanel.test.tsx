// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { MusicMiniPlayer, MusicPanel } from "../components/MusicPanel";
import type { AppleMusicStatus } from "../services/musicBridge";

afterEach(cleanup);

const status: AppleMusicStatus = {
  windows: true,
  bridgeAvailable: true,
  appleSessionFound: false,
  title: null,
  artist: null,
  album: null,
  playbackState: null,
  positionSeconds: null,
  durationSeconds: null,
  canTogglePlayPause: false,
  canNext: false,
  canPrevious: false,
  artworkSupported: false,
  audioDeviceName: null,
  bluetoothLatencyMs: null,
  message: "Brak aktywnej sesji Apple Music.",
};

function renderPanel(overrides: Partial<ComponentProps<typeof MusicPanel>> = {}) {
  return render(<MusicPanel
    status={status}
    profile="cinema"
    backgroundMode={false}
    onBackgroundModeChange={vi.fn()}
    onRefresh={vi.fn(async () => {})}
    onControl={vi.fn(async () => {})}
    onVolume={vi.fn(async () => {})}
    onOpenAppleMusic={vi.fn(async () => {})}
    {...overrides}
  />);
}

describe("Apple Music honest fallback", () => {
  it("reports a failed background command and allows retry", async () => {
    const control = vi.fn().mockRejectedValueOnce(new Error("session lost")).mockResolvedValueOnce(undefined);
    render(<MusicMiniPlayer status={{ ...status, appleSessionFound: true, canNext: true }} profile="cinema" onControl={control} />);
    const next = screen.getByRole("button", { name: "Następny utwór" });
    fireEvent.click(next);
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(next.hasAttribute("disabled")).toBe(false));
    fireEvent.click(next);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(control).toHaveBeenCalledTimes(2);
  });
  it("shows no fake track metadata and keeps transport unavailable without an Apple session", () => {
    renderPanel();
    expect(screen.getByText("Brak aktywnej sesji Apple Music.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "▶ Odtwórz" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Okładka albumu: niedostępna w tym prototypie/)).toBeTruthy();
  });

  it("opens Music Mode and exposes the explicitly selected Background Mode", () => {
    const changeMode = vi.fn();
    renderPanel({ onBackgroundModeChange: changeMode });
    fireEvent.click(screen.getByRole("button", { name: "Otwórz Music Mode" }));
    expect(screen.getByRole("region", { name: /Music Mode/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Przełącz do Background Mode" }));
    expect(changeMode).toHaveBeenCalledWith(true);
  });

  it("disables media transport during Gaming profile", () => {
    const active: AppleMusicStatus = { ...status, appleSessionFound: true, title: "Real track", artist: "Real artist", canTogglePlayPause: true };
    renderPanel({ status: active, profile: "gaming" });
    expect(screen.getByRole("button", { name: "▶ Odtwórz" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Tryb Gaming/)).toBeTruthy();
  });
});

