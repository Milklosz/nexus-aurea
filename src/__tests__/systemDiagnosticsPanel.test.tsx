// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemDiagnosticsPanel } from "../components/SystemDiagnosticsPanel";
import {
  previewDiagnosticsSnapshot,
  type DiagnosticsSnapshot,
} from "../services/diagnostics";

const mocks = vi.hoisted(() => ({
  snapshot: null as DiagnosticsSnapshot | null,
  getSnapshot: vi.fn(async () => mocks.snapshot!),
  exportReport: vi.fn(async () => ({
    generatedAtMs: 10,
    sha256: "a".repeat(64),
    reportJson: '{"build":{"version":"0.9.2"},"limitations":[]}',
  })),
}));

vi.mock("../services/diagnostics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/diagnostics")>();
  return {
    ...actual,
    getDiagnosticsSnapshot: mocks.getSnapshot,
    exportDiagnosticsReport: mocks.exportReport,
  };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function snapshot(): DiagnosticsSnapshot {
  const value = previewDiagnosticsSnapshot("native");
  value.build = { version: "0.9.2", buildSha: "3a201da", target: "windows-x86_64", profile: "release", windows: true };
  value.session.current = "game";
  value.session.revision = 3;
  value.session.recovery = {
    recoveredAtMs: 5,
    previousSession: "cinema",
    previousRevision: 2,
    reason: "unexpectedExit",
    message: "Poprzednie uruchomienie zakończyło się nieoczekiwanie.",
  };
  value.launchRegistry.activeSessions = 1;
  value.launchRegistry.sessions = [{
    id: "game-1",
    displayName: "Gra",
    phase: "sessionActive",
    processIds: [100],
    foreground: true,
    windowId: 5,
    error: null,
    pidReuseDetected: false,
    attention: null,
    sessionRevision: 3,
  }];
  value.displayAudio.displays = [{
    id: "d1", name: "Panasonic", width: 3840, height: 2160, refreshHz: 60,
    bitsPerPixel: 32, primary: true, hdr: false, hdrError: null,
  }];
  value.displayAudio.audio = [{
    id: "a1", name: "TV", state: "active", defaultDevice: true,
    volumePercent: 20, muted: false,
  }];
  value.controlService.running = true;
  value.controlService.fallbackHotkey = "Alt+Shift+N";
  value.controlService.gamepadHomeRunning = true;
  value.controlService.gamepadHomeDeviceCount = 1;
  value.controlService.gamepadHomeDevices = [{
    id: "abc123", model: "dualSense", connection: "bluetooth",
    connectedAtMs: 1, lastReportAtMs: 2, reportCount: 42,
    lastChordAtMs: 2, reconnectCount: 0,
  }];
  value.errors = [{ source: "display", message: "HDR niedostępny przez API." }];
  return value;
}

describe("System Intelligence panel", () => {
  it("shows build, session recovery, devices and read-only display state", async () => {
    mocks.snapshot = snapshot();
    render(<SystemDiagnosticsPanel />);
    expect(await screen.findByText(/Wersja 0.9.2/)).toBeTruthy();
    expect(screen.getByText(/build 3a201da/)).toBeTruthy();
    expect(screen.getByText(/rewizja 3/)).toBeTruthy();
    expect(screen.getByText(/Poprzednie uruchomienie/)).toBeTruthy();
    expect(screen.getByText(/DualSense · Bluetooth · raporty 42/)).toBeTruthy();
    expect(screen.getByText(/Wyświetlacze: 1 · urządzenia audio: 1/)).toBeTruthy();
    expect(screen.getByText(/Tryb tylko do odczytu: tak/)).toBeTruthy();
    expect(screen.getByText(/display: HDR niedostępny/)).toBeTruthy();
  });

  it("exports a sanitized report and displays its SHA-256", async () => {
    mocks.snapshot = snapshot();
    render(<SystemDiagnosticsPanel />);
    await screen.findByText(/Wersja 0.9.2/);
    fireEvent.click(screen.getByRole("button", { name: "Eksportuj bezpieczny raport" }));
    const report = await screen.findByLabelText("Bezpieczny raport diagnostyczny JSON") as HTMLTextAreaElement;
    await waitFor(() => expect(report.value).toContain('"version":"0.9.2"'));
    expect(screen.getByText("a".repeat(64))).toBeTruthy();
    expect(mocks.exportReport).toHaveBeenCalledOnce();
    expect(report.value).not.toContain("C:\\\\Users");
  });
});
