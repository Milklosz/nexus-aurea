import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  displayGeometryFlags,
  getDisplayAudioStatus,
  listenForDisplayChange,
  type AudioEndpointInfo,
  type DisplayAudioSnapshot,
  type DisplayInfo,
} from "../services/displayAudio";
import { getSystemAudio, listenForSystemAudioChange } from "../services/audioControl";
import { getSessionState, listenForSessionChange, type SessionSnapshot } from "../services/sessionOrchestrator";
import { getRemoteAccessStatus, listenForRemoteAccessStatus, type RemoteAccessStatus } from "../services/remoteAccess";
import { nativeControllerStore } from "../services/nativeControllerStore";
import { getNativeControllerStatus, type NativeControllerStatus } from "../services/nativeController";
import { STATUS_READ_TIMEOUT_MS, withTimeout } from "../services/withTimeout";

/* ------------------------------------------------------------------------- *
 * Control Center 4.0 — unified "System overview" (READ-ONLY, ADDITIVE).
 *
 * Aggregates existing read-only services into one summary card:
 *  - display info        get_display_audio_status (displayAudio.ts / display_audio.rs)
 *  - audio output/volume get_system_audio       (audioControl.ts)
 *  - controller          nativeControllerStore  (nativeController.ts)
 *  - active session      get_session_state      (sessionOrchestrator.ts)
 *  - network & remote    get_remote_access_status (remoteAccess.ts)
 *
 * Every item has an explicit loading / ready / unknown state. A failed or
 * malformed read is reported as "unknown" — values are never fabricated.
 * ------------------------------------------------------------------------- */

export type OverviewState = "loading" | "ready" | "unknown";

export type OverviewItemId = "display" | "audio" | "controller" | "session" | "remote";

export type OverviewItem = {
  id: OverviewItemId;
  label: string;
  state: OverviewState;
  summary: string;
};

export type OverviewSource<T> = { state: OverviewState; value: T | null };

export type OverviewInput = {
  display: OverviewSource<DisplayAudioSnapshot>;
  audio: OverviewSource<AudioEndpointInfo>;
  controller: OverviewSource<NativeControllerStatus>;
  /** Live store snapshot wins whenever the store has a confirmed read. */
  liveController: { known: boolean; status: NativeControllerStatus };
  session: OverviewSource<SessionSnapshot>;
  remote: OverviewSource<RemoteAccessStatus>;
};

export const OVERVIEW_ITEM_LABELS: Record<OverviewItemId, string> = {
  display: "Wyświetlacz",
  audio: "Wyjście audio",
  controller: "Kontroler",
  session: "Aktywna sesja",
  remote: "Sieć i pilot",
};

export const OVERVIEW_STATE_LABELS: Record<OverviewState, string> = {
  loading: "wczytywanie…",
  ready: "",
  unknown: "stan nieznany",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function displaySummary(snapshot: DisplayAudioSnapshot): { state: OverviewState; summary: string } {
  if (!isObject(snapshot)) return { state: "unknown", summary: "stan nieznany" };
  if (snapshot.windows === false) {
    return { state: "ready", summary: "podgląd przeglądarki — dane sprzętowe niedostępne" };
  }
  const displays = Array.isArray(snapshot.displays) ? snapshot.displays : [];
  if (displays.length === 0) {
    return {
      state: "unknown",
      summary: typeof snapshot.displayError === "string" && snapshot.displayError
        ? `stan nieznany (${snapshot.displayError.slice(0, 120)})`
        : "stan nieznany",
    };
  }
  const primary = displays.find((display) => display?.primary) ?? displays[0];
  const geometry = primary?.diagnostics ? displayGeometryFlags(primary.diagnostics) : null;
  const scale = geometry?.effectiveScalePercent ?? primary?.diagnostics?.scalePercent ?? null;
  const refresh = primary?.refreshHz && primary.refreshHz > 0 ? `${primary.refreshHz} Hz` : "odświeżanie nieznane";
  const name = typeof primary?.name === "string" && primary.name ? primary.name : "monitor";
  const resolution = Number.isFinite(primary?.width) && Number.isFinite(primary?.height)
    ? `${primary.width}×${primary.height}`
    : "rozdzielczość nieznana";
  const count = displays.length > 1 ? ` · ${displays.length} monitory` : "";
  return {
    state: "ready",
    summary: `${name} · ${resolution} @ ${refresh} · skala ${scale !== null ? `${scale}%` : "nieznana"}${count}`,
  };
}

function audioSummary(endpoint: AudioEndpointInfo | null): { state: OverviewState; summary: string } {
  if (!isObject(endpoint) || typeof endpoint.name !== "string") return { state: "unknown", summary: "stan nieznany" };
  const name = endpoint.name ? endpoint.name : "wyjście audio";
  const volume = typeof endpoint.volumePercent === "number" ? ` · ${endpoint.volumePercent}%` : " · głośność nieznana";
  const muted = endpoint.muted === true ? " · wyciszone" : "";
  return { state: "ready", summary: `${name}${volume}${muted}` };
}

function controllerSummary(known: boolean, status: NativeControllerStatus): { state: OverviewState; summary: string } {
  if (!known || !isObject(status) || typeof status.supported !== "boolean") return { state: "unknown", summary: "stan nieznany" };
  if (!status.supported) return { state: "ready", summary: "odczyt natywny niedostępny na tej platformie" };
  if (!status.running) return { state: "ready", summary: `zatrzymany${status.lastError ? ` · ${String(status.lastError).slice(0, 80)}` : ""}` };
  const pads = Array.isArray(status.pads) ? status.pads.length : 0;
  return { state: "ready", summary: `${pads} pad(y) podłączone · powrót Home: ${status.homeEnabled ? "włączony" : "wyłączony"}` };
}

function sessionSummary(snapshot: SessionSnapshot | null): { state: OverviewState; summary: string } {
  if (!isObject(snapshot) || typeof snapshot.current !== "string") return { state: "unknown", summary: "stan nieznany" };
  const revision = typeof snapshot.revision === "number" && Number.isFinite(snapshot.revision) ? snapshot.revision : "?";
  return { state: "ready", summary: `${snapshot.current} · rewizja ${revision}` };
}

function remoteSummary(status: RemoteAccessStatus | null): { state: OverviewState; summary: string } {
  if (!isObject(status) || typeof status.enabled !== "boolean") return { state: "unknown", summary: "stan nieznany" };
  const enabled = status.enabled === true;
  const devices = typeof status.pairedDeviceCount === "number" ? status.pairedDeviceCount : 0;
  const https = status.secureOriginAvailable === true ? "HTTPS gotowe" : "HTTPS niedostępne";
  const recovery = status.recoveryRequired === true ? " · wymagane odzyskiwanie" : "";
  return {
    state: "ready",
    summary: `serwer LAN ${enabled ? "włączony" : "wyłączony"} · ${https} · urządzenia: ${devices}${recovery}`,
  };
}

/** Pure aggregation: maps the five read-only sources to overview items. */
export function buildOverviewItems(input: OverviewInput): OverviewItem[] {
  const display = input.display.state === "ready" && input.display.value
    ? displaySummary(input.display.value)
    : { state: input.display.state === "ready" ? "unknown" : input.display.state, summary: "stan nieznany" };
  const audio = input.audio.state === "ready"
    ? audioSummary(input.audio.value)
    : { state: input.audio.state, summary: "stan nieznany" };
  // The live store snapshot wins as soon as it has a confirmed read; otherwise
  // the card's own bounded read decides between loading / ready / unknown.
  const controllerSource = input.liveController.known
    ? { state: "ready" as OverviewState, value: input.liveController.status }
    : input.controller;
  const controller = controllerSource.state === "ready" && controllerSource.value
    ? controllerSummary(true, controllerSource.value)
    : { state: controllerSource.state === "ready" ? "unknown" : controllerSource.state, summary: "stan nieznany" };
  const session = input.session.state === "ready"
    ? sessionSummary(input.session.value)
    : { state: input.session.state, summary: "stan nieznany" };
  const remote = input.remote.state === "ready"
    ? remoteSummary(input.remote.value)
    : { state: input.remote.state, summary: "stan nieznany" };
  const resolved: Array<[OverviewItemId, OverviewState, string]> = [
    ["display", display.state, display.summary],
    ["audio", audio.state, audio.summary],
    ["controller", controller.state, controller.summary],
    ["session", session.state, session.summary],
    ["remote", remote.state, remote.summary],
  ];
  return resolved.map(([id, state, summary]) => ({
    id,
    label: OVERVIEW_ITEM_LABELS[id],
    state,
    summary: state === "loading" ? OVERVIEW_STATE_LABELS.loading : state === "unknown" ? OVERVIEW_STATE_LABELS.unknown : summary,
  }));
}

/** One-line summary of every display, used by the expandable display details. */
export function describeDisplay(display: DisplayInfo): string {
  const parts: string[] = [];
  const name = typeof display?.name === "string" && display.name ? display.name : "monitor";
  const resolution = Number.isFinite(display?.width) && Number.isFinite(display?.height)
    ? `${display.width}×${display.height}`
    : "rozdzielczość nieznana";
  parts.push(`${name} · ${resolution}`);
  parts.push(display?.refreshHz && display.refreshHz > 0 ? `@ ${display.refreshHz} Hz` : "odświeżanie nieznane");
  parts.push(display?.primary ? "główny" : "dodatkowy");
  parts.push(display?.hdr === null || display?.hdr === undefined ? "HDR nieznany" : display.hdr ? "HDR włączone" : "HDR wyłączone");
  const diagnostics = display?.diagnostics;
  if (diagnostics) {
    const geometry = displayGeometryFlags(diagnostics);
    const scale = geometry.effectiveScalePercent ?? diagnostics.scalePercent ?? null;
    parts.push(`skala ${scale !== null ? `${scale}%` : "nieznana"}`);
    if (typeof diagnostics.refreshMillihz === "number" && diagnostics.refreshMillihz > 0) {
      parts.push(`${(diagnostics.refreshMillihz / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 3 })} Hz (DisplayConfig)`);
    }
    if (diagnostics.connectionType) parts.push(String(diagnostics.connectionType));
  }
  return parts.join(" · ");
}

type SourceKey = "display" | "audio" | "controller" | "session" | "remote";

export type SystemOverviewCardProps = {
  /**
   * When ControlCenter already owns the remote status read, it passes it down
   * so the overview never duplicates the secure IPC read (or steals a
   * one-shot mock in tests). Undefined means the card reads it itself.
   */
  remoteStatus?: RemoteAccessStatus | null;
  remoteStatusReady?: boolean;
  remoteStatusLoading?: boolean;
};

export function SystemOverviewCard(props: SystemOverviewCardProps = {}) {
  const [sources, setSources] = useState<Record<SourceKey, OverviewSource<unknown>>>({
    display: { state: "loading", value: null },
    audio: { state: "loading", value: null },
    controller: { state: "loading", value: null },
    session: { state: "loading", value: null },
    remote: { state: "loading", value: null },
  });
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const inFlight = useRef(false);

  const controllerStatus = useSyncExternalStore(
    nativeControllerStore.subscribe,
    nativeControllerStore.getStatusSnapshot,
    nativeControllerStore.getStatusSnapshot,
  );
  const controllerKnown = useSyncExternalStore(
    nativeControllerStore.subscribe,
    nativeControllerStore.getStatusKnown,
    nativeControllerStore.getStatusKnown,
  );

  const readSource = useCallback(async <T,>(
    key: SourceKey,
    read: () => Promise<T>,
    active: () => boolean,
  ) => {
    try {
      const value = await withTimeout(read(), STATUS_READ_TIMEOUT_MS, `Przegląd systemu: ${key}`);
      if (active()) setSources((previous) => ({ ...previous, [key]: { state: "ready", value } }));
    } catch {
      if (active()) setSources((previous) => ({ ...previous, [key]: { state: "unknown", value: null } }));
    }
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = ++requestId.current;
    setRefreshing(true);
    const active = () => id === requestId.current;
    const reads: Array<Promise<unknown>> = [
      readSource("display", getDisplayAudioStatus, active),
      readSource("audio", getSystemAudio, active),
      readSource("controller", getNativeControllerStatus, active),
      readSource("session", getSessionState, active),
    ];
    if (props.remoteStatusReady === undefined) {
      reads.push(readSource("remote", getRemoteAccessStatus, active));
    }
    await Promise.allSettled(reads);
    if (active()) setRefreshing(false);
    inFlight.current = false;
  }, [readSource]);

  useEffect(() => {
    void load();
    let active = true;
    const unlistens: Array<() => void> = [];
    void listenForDisplayChange(() => { if (active) void load(); }).then((stop) => { if (active) unlistens.push(stop); else stop(); });
    void listenForSystemAudioChange(() => { if (active) void load(); }).then((stop) => { if (active) unlistens.push(stop); else stop(); });
    void listenForSessionChange(() => { if (active) void load(); }).then((stop) => { if (active) unlistens.push(stop); else stop(); });
    if (props.remoteStatusReady === undefined) {
      void listenForRemoteAccessStatus(() => { if (active) void load(); }).then((stop) => { if (active) unlistens.push(stop); else stop(); });
    }
    return () => {
      active = false;
      requestId.current += 1;
      inFlight.current = false;
      for (const stop of unlistens) stop();
    };
  }, [load]);

  const remoteSource: OverviewSource<RemoteAccessStatus> = props.remoteStatusReady !== undefined
    ? {
      state: props.remoteStatusReady ? "ready" : props.remoteStatusLoading ? "loading" : "unknown",
      value: props.remoteStatus ?? null,
    }
    : sources.remote as OverviewSource<RemoteAccessStatus>;

  const items = buildOverviewItems({
    display: sources.display as OverviewSource<DisplayAudioSnapshot>,
    audio: sources.audio as OverviewSource<AudioEndpointInfo>,
    controller: sources.controller as OverviewSource<NativeControllerStatus>,
    liveController: { known: controllerKnown, status: controllerStatus },
    session: sources.session as OverviewSource<SessionSnapshot>,
    remote: remoteSource,
  });

  const displaySnapshot = sources.display.state === "ready"
    ? (sources.display.value as DisplayAudioSnapshot | null)
    : null;
  const displays = displaySnapshot && Array.isArray(displaySnapshot.displays) ? displaySnapshot.displays : [];

  return <section className="cc-card cc-card-wide cc-system-overview" aria-label="Przegląd systemu">
    <div className="cc-card-heading">
      <span className="cc-card-index">00</span>
      <div><h3>Przegląd systemu</h3><p>Jedno miejsce, tylko odczyt. Stan nieznany nigdy nie jest zgadywany.</p></div>
    </div>
    <ul className="cc-overview-list" aria-label="Stan źródeł systemowych" aria-live="polite">
      {items.map((item) => <li key={item.id} data-overview-state={item.state}>
        <span className="cc-overview-label">{item.label}</span>
        <strong className="cc-overview-value">{item.summary}</strong>
      </li>)}
    </ul>
    {displays.length > 0 && <details className="cc-overview-displays">
      <summary>Wyświetlacze ({displays.length}) — tylko odczyt</summary>
      <ul>
        {displays.map((display) => <li key={display?.id ?? display?.name ?? "display"}>{describeDisplay(display)}</li>)}
      </ul>
    </details>}
    <div className="cc-actions">
      <button type="button" data-remote-allow="" aria-busy={refreshing} disabled={refreshing}
        onClick={() => void load()}>
        {refreshing ? "Odświeżam…" : "Odśwież przegląd systemu"}
      </button>
    </div>
  </section>;
}
