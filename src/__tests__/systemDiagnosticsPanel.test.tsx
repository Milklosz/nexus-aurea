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
  value.build = {
    version: "0.9.2",
    buildSha: "36312486cebb5b523c24cf0754f4a317ad87f042",
    checkoutSha: "36312486cebb5b523c24cf0754f4a317ad87f042",
    branch: "test/velora-2-candidate-1",
    buildRef: "refs/heads/test/velora-2-candidate-1",
    dirty: "false",
    event: "test",
    prHeadSha: null,
    prBaseSha: null,
    target: "x86_64-pc-windows-msvc",
    profile: "release",
    rustcVersion: "rustc 1.89.0",
    windows: true,
  };
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
    expect(screen.getByText(/build 36312486cebb5b523c24cf0754f4a317ad87f042/)).toBeTruthy();
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

  it("shows physical negative coordinates and actual DPI without assuming HDMI or 60Hz", async () => {
    mocks.snapshot = snapshot();
    mocks.snapshot.displayAudio.displays[0].diagnostics = {
      x: -3840, y: 1080, desktopWidth: 3840, desktopHeight: 2160,
      scalePercent: 140, effectiveDpiX: 144, effectiveDpiY: 144, dpiProvenance: "getDpiForMonitorPerMonitorProcess", refreshMillihz: 59_940,
      connectionType: null, adapterName: "NVIDIA GeForce RTX 3070 Laptop GPU",
      edidManufacturerId: null, edidProductCodeId: null, identitySource: "gdiFallback",
    };
    render(<SystemDiagnosticsPanel />);
    expect(await screen.findByText(/3840×2160 px \(-3840, 1080\)/)).toBeTruthy();
    expect(screen.getByText(/skala API 140% \(DPI okna może się różnić\)/)).toBeTruthy();
    expect(screen.getByText(/144×144 DPI · efektywna skala 150%/)).toBeTruthy();
    expect(screen.getByText(/59,94 Hz \(DisplayConfig\)/)).toBeTruthy();
    expect(screen.getByText(/połączenie nieznane/)).toBeTruthy();
    expect(screen.queryByText(/HDMI/)).toBeNull();
    // 140% API bucket vs 144 DPI (150%): a calm note, not a failure.
    expect(screen.getByText(/różni się o 10 p.p. od skali efektywnej \(150%\)/)).toBeTruthy();
    expect(screen.getByText(/fizyczna geometria okna pozostaje niezmieniona/)).toBeTruthy();
    expect(screen.getByText(/pulpit rozszerzony: ujemne położenie \(-3840, 1080\)/)).toBeTruthy();
  });

  it("does not present an unverified 96-DPI default as the effective monitor scale", async () => {
    mocks.snapshot = snapshot();
    mocks.snapshot.displayAudio.displays[0].diagnostics = {
      x: 0, y: 0, desktopWidth: 3840, desktopHeight: 2160,
      scalePercent: 140, effectiveDpiX: 96, effectiveDpiY: 96, dpiProvenance: null,
      refreshMillihz: 60_000, connectionType: "HDMI", adapterName: null,
      edidManufacturerId: null, edidProductCodeId: null, identitySource: "displayConfig",
    };
    render(<SystemDiagnosticsPanel />);
    expect(await screen.findByText(/efektywne DPI nieznane/)).toBeTruthy();
    expect(screen.queryByText(/efektywna skala 100%/)).toBeNull();
    // Unconfirmed 96 must not produce a false divergence warning either.
    expect(screen.queryByText(/różni się o .* p.p./)).toBeNull();
    expect(screen.queryByText(/pulpit rozszerzony/)).toBeNull();
  });

  it("does not warn when confirmed effective scale matches the API bucket", async () => {
    mocks.snapshot = snapshot();
    mocks.snapshot.displayAudio.displays[0].diagnostics = {
      x: 0, y: 0, desktopWidth: 3840, desktopHeight: 2160,
      scalePercent: 140, effectiveDpiX: 134, effectiveDpiY: 134, dpiProvenance: "getDpiForMonitorPerMonitorProcess", refreshMillihz: 60_000,
      connectionType: "HDMI", adapterName: null,
      edidManufacturerId: null, edidProductCodeId: null, identitySource: "displayConfig",
    };
    render(<SystemDiagnosticsPanel />);
    expect(await screen.findByText(/efektywna skala 140%/)).toBeTruthy();
    expect(screen.queryByText(/różni się o .* p.p./)).toBeNull();
    expect(screen.queryByText(/pulpit rozszerzony/)).toBeNull();
  });

  it("notes a negative origin separately even when scales agree", async () => {
    mocks.snapshot = snapshot();
    mocks.snapshot.displayAudio.displays[0].diagnostics = {
      x: -3840, y: 0, desktopWidth: 3840, desktopHeight: 2160,
      scalePercent: 140, effectiveDpiX: 134, effectiveDpiY: 134, dpiProvenance: "getDpiForMonitorPerMonitorProcess", refreshMillihz: 60_000,
      connectionType: null, adapterName: null,
      edidManufacturerId: null, edidProductCodeId: null, identitySource: "displayConfig",
    };
    render(<SystemDiagnosticsPanel />);
    expect(await screen.findByText(/pulpit rozszerzony: ujemne położenie \(-3840, 0\)/)).toBeTruthy();
    expect(screen.queryByText(/różni się o .* p.p./)).toBeNull();
  });
});
