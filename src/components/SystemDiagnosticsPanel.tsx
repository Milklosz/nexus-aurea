import { useCallback, useEffect, useState } from "react";
import {
  exportDiagnosticsReport,
  getDiagnosticsSnapshot,
  type DiagnosticsSnapshot,
} from "../services/diagnostics";

const modelLabels: Record<string, string> = {
  dualSense: "DualSense",
  dualSenseEdge: "DualSense Edge",
  unknown: "model nieznany",
};
const connectionLabels: Record<string, string> = {
  usb: "USB",
  bluetooth: "Bluetooth",
  unknown: "połączenie nieznane",
};

function sessionLabel(current: string): string {
  const labels: Record<string, string> = {
    veloraHome: "VELORA Home",
    game: "Game",
    playnite: "Playnite",
    cinema: "Cinema",
    desktop: "Desktop",
    ambient: "Ambient",
  };
  return labels[current] ?? current;
}

export function SystemDiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [report, setReport] = useState("");
  const [reportSha, setReportSha] = useState("");
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSnapshot(await getDiagnosticsSnapshot());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się odczytać diagnostyki systemowej.");
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const exportReport = async () => {
    setExporting(true);
    setError("");
    try {
      const exported = await exportDiagnosticsReport();
      setReport(exported.reportJson);
      setReportSha(exported.sha256);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się wyeksportować raportu.");
    } finally {
      setExporting(false);
    }
  };

  return <section className="system-diagnostics" aria-label="VELORA System Intelligence">
    <div className="cc-card-heading">
      <span className="cc-card-index">07</span>
      <div><h3>System Intelligence</h3><p>Bezpieczny, tylko do odczytu raport stanu dla MSI.</p></div>
    </div>
    <button type="button" data-remote-allow="" onClick={() => void load()} aria-busy={loading} disabled={loading}>
      {loading ? "Odczytuję…" : "Odśwież diagnostykę"}
    </button>
    {error && <p role="alert">{error}</p>}
    {snapshot && <>
      <p role="status">
        Wersja {snapshot.build.version} · build {snapshot.build.buildSha} · {snapshot.build.target} · {snapshot.build.profile}
      </p>
      <ul className="system-diagnostics-list">
        <li>Sesja: <strong>{sessionLabel(snapshot.session.current)}</strong> · rewizja {snapshot.session.revision}</li>
        <li>Operacje sesji: {snapshot.sessionOperations.filter((operation) => operation.status === "pending").length} oczekujących</li>
        <li>Uruchomienia: {snapshot.launchRegistry.activeSessions} aktywne · {snapshot.launchRegistry.sessions.length} zapisanych</li>
        <li>Okna: {snapshot.windowBroker.trackedWindows.length} śledzonych · pierwszy plan: {snapshot.windowBroker.foreground.processName ?? "brak"}</li>
        <li>Control Service: {snapshot.controlService.running ? "aktywny" : "wyłączony"} · skrót {snapshot.controlService.fallbackHotkey ?? "Ctrl+Alt+N"}</li>
        <li>DualSense Home: {snapshot.controlService.gamepadHomeRunning
          ? `${snapshot.controlService.gamepadHomeDeviceCount ?? 0} urządzeń Raw Input`
          : "niedostępny"} · kontrolery Sony: {snapshot.controlService.playstationControllerCount}</li>
        {(snapshot.controlService.gamepadHomeDevices?.length ?? 0) > 0 && <li>
          Pady: {snapshot.controlService.gamepadHomeDevices?.map((device) =>
            `${modelLabels[device.model] ?? device.model} · ${connectionLabels[device.connection] ?? device.connection} · raporty ${device.reportCount}`
          ).join("; ")}
        </li>}
        <li>
          Ostatni raport pada: {snapshot.controlService.gamepadHomeLastReportAtMs ?? "brak"}
          {" · duplikaty: "}{snapshot.controlService.gamepadHomeDuplicateReports ?? 0}
          {" · reconnect: "}{snapshot.controlService.gamepadHomeReconnects ?? 0}
          {snapshot.controlService.gamepadHomeLastChord
            ? ` · ostatnia kombinacja: ${snapshot.controlService.gamepadHomeLastChord.outcome}`
            : ""}
        </li>
        <li>Wyświetlacze: {snapshot.displayAudio.displays.length} · urządzenia audio: {snapshot.displayAudio.audio.length}</li>
        <li>Tryb tylko do odczytu: {snapshot.displayAudio.policy.readOnly ? "tak" : "nie"} · automatyczne zmiany: {snapshot.displayAudio.policy.automaticModeChanges ? "tak" : "nie"}</li>
      </ul>
      <details>
        <summary>Wyświetlacze i audio (tylko odczyt)</summary>
        {snapshot.displayAudio.displays.length === 0
          ? <p>Brak danych o wyświetlaczach.</p>
          : <ul>{snapshot.displayAudio.displays.map((display) => <li key={display.id}>
            {display.name}: {display.width}×{display.height} @ {display.refreshHz} Hz · HDR: {display.hdr === null ? "niedostępny" : display.hdr ? "tak" : "nie"} · {display.primary ? "główny" : "dodatkowy"}
            {display.hdrError ? ` · ${display.hdrError}` : ""}
          </li>)}</ul>}
        {snapshot.displayAudio.audio.length === 0
          ? <p>Brak danych o urządzeniach audio.</p>
          : <ul>{snapshot.displayAudio.audio.map((endpoint) => <li key={endpoint.id}>
            {endpoint.name} · {endpoint.state} · {endpoint.defaultDevice ? "domyślne" : "niedomyślne"}
            {endpoint.volumePercent !== null ? ` · ${endpoint.volumePercent}%` : ""}
            {endpoint.muted ? " · wyciszone" : ""}
          </li>)}</ul>}
        <p className="cc-card-note">Ten widok nie zmienia rozdzielczości, HDR, głośności ani domyślnego urządzenia audio.</p>
      </details>
      {snapshot.session.recovery && <p role="note">
        Ostatnie odzyskanie: {snapshot.session.recovery.message}
      </p>}
      {snapshot.errors.length > 0 && <div role="alert">
        <p>Wykryte problemy ({snapshot.errors.length}):</p>
        <ul>{snapshot.errors.map((entry, index) => <li key={`${entry.source}-${index}`}>{entry.source}: {entry.message}</li>)}</ul>
      </div>}
      <details>
        <summary>Ograniczenia i zakres</summary>
        <ul>{snapshot.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
      </details>
      <button type="button" data-remote-allow="" disabled={exporting} aria-busy={exporting} onClick={() => void exportReport()}>
        {exporting ? "Eksportuję…" : "Eksportuj bezpieczny raport"}
      </button>
      {reportSha && <p role="status">SHA-256 raportu: <code>{reportSha}</code></p>}
      {report && <textarea
        className="system-diagnostics-report"
        aria-label="Bezpieczny raport diagnostyczny JSON"
        readOnly
        rows={12}
        value={report}
      />}
      <p className="cc-card-note">Raport nie zawiera tokenów parowania, kluczy, danych logowania, tytułów obcych okien ani prywatnych ścieżek użytkownika.</p>
    </>}
  </section>;
}
