import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportDiagnosticsReport,
  getDiagnosticsSnapshot,
  previewDiagnosticsSnapshot,
  sanitizeDiagnosticsText,
  type DiagnosticsSnapshot,
} from "../services/diagnostics";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

afterEach(() => vi.clearAllMocks());
beforeEach(() => mocks.isTauri.mockReturnValue(true));

describe("System Intelligence diagnostics bridge", () => {
  it("requests the native snapshot and sanitized export", async () => {
    const snapshot = previewDiagnosticsSnapshot("native");
    mocks.invoke.mockResolvedValueOnce(snapshot);
    await expect(getDiagnosticsSnapshot()).resolves.toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith("get_diagnostics_snapshot");

    const exported = { generatedAtMs: 1, sha256: "abc", reportJson: "{}" };
    mocks.invoke.mockResolvedValueOnce(exported);
    await expect(exportDiagnosticsReport()).resolves.toEqual(exported);
    expect(mocks.invoke).toHaveBeenCalledWith("export_diagnostics_report");
  });

  it("stays a read-only preview outside Tauri and never fabricates hardware", async () => {
    mocks.isTauri.mockReturnValue(false);
    const snapshot = await getDiagnosticsSnapshot();
    expect(snapshot.build.windows).toBe(false);
    expect(snapshot.displayAudio.supported).toBe(false);
    expect(snapshot.displayAudio.policy.readOnly).toBe(true);
    expect(snapshot.displayAudio.policy.automaticModeChanges).toBe(false);
    expect(snapshot.displayAudio.displays).toEqual([]);
    expect(snapshot.displayAudio.audio).toEqual([]);
    expect(snapshot.errors[0].source).toBe("diagnostics");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("refuses to fabricate an export outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(exportDiagnosticsReport()).rejects.toThrow(/Windows/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps the read-only policy in the typed contract", () => {
    const snapshot: DiagnosticsSnapshot = previewDiagnosticsSnapshot("test");
    expect(snapshot.displayAudio.policy.readOnly).toBe(true);
    expect(snapshot.displayAudio.policy.automaticModeChanges).toBe(false);
    expect(snapshot.launchRegistry.activeSessions).toBe(0);
  });

  it("redacts pairing codes, credentials and network identifiers", () => {
    for (const text of [
      "https://192.168.0.10:47862/#pair=123456&exp=1731000000",
      "one-time code 123456",
      "kod jednorazowy 123456",
      "pair=123456",
      "deviceId=0123456789abcdef",
      "token=private",
      "owner S-1-5-21-1234 contact milos@example.com",
    ]) {
      const sanitized = sanitizeDiagnosticsText(text);
      expect(sanitized).toBe("<redacted-detail>");
      expect(sanitized).not.toContain("123456");
    }
    expect(sanitizeDiagnosticsText("C:\\Users\\mil\\AppData\\Roaming\\VELORA\\x.json")).toBe(
      "<redacted-path>",
    );
  });

  it("bounds web preview text and never renders a secret in a preview snapshot", () => {
    const long = sanitizeDiagnosticsText("a".repeat(5000));
    expect(long.length).toBeLessThanOrEqual(1024);
    const snapshot = previewDiagnosticsSnapshot("pair=123456 password=hunter2");
    expect(JSON.stringify(snapshot)).not.toContain("123456");
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
    expect(snapshot.errors[0].message).toBe("<redacted-detail>");
  });
});
