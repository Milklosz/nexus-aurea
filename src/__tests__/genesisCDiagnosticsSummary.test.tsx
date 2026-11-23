// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SystemDiagnosticsPanel } from "../components/SystemDiagnosticsPanel";
import {
  previewDiagnosticsSnapshot,
  summarizeDiagnostics,
  type DiagnosticsSnapshot,
} from "../services/diagnostics";

const mocks = vi.hoisted(() => ({
  snapshot: null as DiagnosticsSnapshot | null,
  getSnapshot: vi.fn(async () => mocks.snapshot!),
  exportReport: vi.fn(async () => ({ generatedAtMs: 1, sha256: "b".repeat(64), reportJson: "{}" })),
}));

vi.mock("../services/diagnostics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/diagnostics")>();
  return {
    ...actual,
    getDiagnosticsSnapshot: mocks.getSnapshot,
    exportDiagnosticsReport: mocks.exportReport,
  };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.snapshot = null; });

function richSnapshot(): DiagnosticsSnapshot {
  const value = previewDiagnosticsSnapshot("native");
  value.build = {
    version: "0.12.0-rc.1",
    buildSha: "abc",
    checkoutSha: "abc",
    branch: "genesis-c-control",
    buildRef: "refs/heads/genesis-c-control",
    dirty: "false",
    event: "push",
    prHeadSha: null,
    prBaseSha: null,
    target: "x86_64-pc-windows-msvc",
    profile: "release",
    rustcVersion: "rustc 1.89.0",
    windows: true,
  };
  value.session.current = "game";
  value.session.revision = 3;
  value.sessionOperations = [
    { id: "op-1", kind: "returnHome", status: "pending", startedAtMs: 1, deadlineAtMs: 2, finishedAtMs: null },
    { id: "op-2", kind: "returnHome", status: "completed", startedAtMs: 1, deadlineAtMs: 2, finishedAtMs: 3 },
  ];
  value.launchRegistry.activeSessions = 1;
  value.launchRegistry.sessions = [{
    id: "l1", displayName: "Gra", phase: "sessionActive", processIds: [1], foreground: true,
    windowId: 7, error: null, pidReuseDetected: false, attention: null, sessionRevision: 3,
  }];
  value.windowBroker.windows = true;
  value.windowBroker.trackedWindows = [{ hwnd: 7, processId: 1, processName: "velora", className: null, processCreatedAt100Ns: null, score: 1, isMain: true }];
  value.windowBroker.foreground.processName = "velora";
  value.controlService.windows = true;
  value.controlService.running = true;
  value.controlService.controllerCount = 1;
  value.nativeController.supported = true;
  value.nativeController.homeEnabled = true;
  value.nativeController.pads = [{ device: "ds4", revision: "v2", transport: "usb" }];
  value.displayAudio.windows = true;
  value.displayAudio.displays = [{
    id: "d1", name: "Panasonic", width: 3840, height: 2160, refreshHz: 60, bitsPerPixel: 32,
    primary: true, hdr: true, hdrError: null,
    diagnostics: {
      x: 0, y: 0, desktopWidth: 3840, desktopHeight: 2160, scalePercent: 150,
      effectiveDpiX: 144, effectiveDpiY: 144, dpiProvenance: "getDpiForMonitorPerMonitorProcess",
      refreshMillihz: 60_000, connectionType: "HDMI", adapterName: "RTX", edidManufacturerId: 1,
      edidProductCodeId: 2, identitySource: "displayConfig",
    },
  }];
  value.displayAudio.audio = [{ id: "a1", name: "Głośniki", state: "active", defaultDevice: true, volumePercent: 55, muted: false }];
  value.remote = { enabled: true, secureOriginAvailable: true, pairedDeviceCount: 1, recoveryRequired: false };
  value.errors = [{ source: "audio", message: "testowy błąd" }];
  return value;
}

describe("genesis C — summarizeDiagnostics (pure)", () => {
  it("aggregates counts and per-area states from a snapshot", () => {
    const summary = summarizeDiagnostics(richSnapshot());
    expect(summary.errorCount).toBe(1);
    expect(summary.pendingOperations).toBe(1);
    expect(summary.activeLaunches).toBe(1);
    expect(summary.trackedWindows).toBe(1);
    expect(summary.displays).toBe(1);
    expect(summary.audioEndpoints).toBe(1);
    expect(summary.controllerPads).toBe(1);
    const byId = new Map(summary.items.map((item) => [item.id, item]));
    expect(byId.get("build")?.state).toBe("ok");
    expect(byId.get("build")?.detail).toContain("0.12.0-rc.1");
    expect(byId.get("session")?.detail).toBe("game · stan 3");
    expect(byId.get("operations")?.state).toBe("warning");
    expect(byId.get("control-service")?.detail).toContain("aktywny");
    expect(byId.get("controller")?.detail).toContain("1 pad(y)");
    expect(byId.get("display-audio")?.detail).toBe("1 wyświetlaczy · 1 punktów audio");
    expect(byId.get("remote")?.state).toBe("ok");
    expect(byId.get("errors")?.state).toBe("error");
  });

  it("flags remote recovery-required as an error and non-Windows builds as unknown", () => {
    const value = previewDiagnosticsSnapshot("podgląd");
    value.remote = { enabled: false, secureOriginAvailable: false, pairedDeviceCount: 0, recoveryRequired: true };
    const summary = summarizeDiagnostics(value);
    const remote = summary.items.find((item) => item.id === "remote");
    expect(remote?.state).toBe("error");
    expect(remote?.detail).toContain("wymagane odzyskiwanie");
    expect(summary.items.find((item) => item.id === "build")?.state).toBe("unknown");
    expect(summary.items.find((item) => item.id === "control-service")?.state).toBe("unknown");
  });

  it("never fabricates: malformed snapshot fields become unknown counts", () => {
    const broken = { generatedAtMs: Number.NaN } as unknown as DiagnosticsSnapshot;
    const summary = summarizeDiagnostics(broken);
    expect(summary.errorCount).toBe(0);
    expect(summary.pendingOperations).toBe(0);
    expect(summary.items.find((item) => item.id === "session")?.state).toBe("unknown");
    expect(summary.items.find((item) => item.id === "remote")?.state).toBe("unknown");
    expect(summary.items.find((item) => item.id === "remote")?.detail).toBe("stan nieznany");
  });
});

describe("genesis C — SystemDiagnosticsPanel readable summary", () => {
  it("renders the Podsumowanie diagnostyki list from get_diagnostics_snapshot", async () => {
    mocks.snapshot = richSnapshot();
    render(<SystemDiagnosticsPanel />);
    const summaryList = await screen.findByRole("list", { name: "Podsumowanie diagnostyki" });
    const items = Array.from(summaryList.querySelectorAll("li"));
    expect(items.length).toBeGreaterThanOrEqual(8);
    const texts = items.map((item) => item.textContent ?? "");
    expect(texts.some((text) => text.includes("game · stan 3"))).toBe(true);
    expect(texts.some((text) => text.includes("1 oczekujących"))).toBe(true);
    expect(texts.some((text) => text.includes("1 pad(y) · powrót Home: włączony"))).toBe(true);
    expect(texts.some((text) => text.includes("urządzenia: 1"))).toBe(true);
    expect(texts.some((text) => text.includes("1 wpis(ów) w dzienniku błędów"))).toBe(true);
    const errorItem = items.find((item) => item.getAttribute("data-state") === "error");
    expect(errorItem?.textContent).toContain("Wykryte problemy");
  });

  it("keeps the detailed sections and shows the summary only after a successful read", async () => {
    mocks.snapshot = richSnapshot();
    render(<SystemDiagnosticsPanel />);
    await waitFor(() => expect(screen.getByRole("list", { name: "Podsumowanie diagnostyki" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Odśwież diagnostykę" })).toBeTruthy();
    expect(screen.getByText(/Wyświetlacze i audio \(tylko odczyt\)/)).toBeTruthy();
  });
});
