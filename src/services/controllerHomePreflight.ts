import type { StreamingService } from "../data/streamingServices";
import { isTauri } from "@tauri-apps/api/core";
import type { NativeControllerStatus } from "./nativeController";
import { nativeControllerStore } from "./nativeControllerStore";
import { sessionRevisionToken, type SessionSnapshot } from "./sessionOrchestrator";

export const CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE =
  "Nie można potwierdzić bezpiecznego powrotu do VELORA dla wykrytego kontrolera. Pozostań w VELORA, otwórz Centrum Sterowania → „Powrót do VELORA” i wybierz „Włącz powrót na tę sesję”.";

const NATIVE_STATUS_READ_TIMEOUT_MS = 2_000;

/**
 * An explicit, bounded acknowledgement that the native Home path was healthy
 * for ONE authoritative session state. It is never inherited on remount:
 * re-establishing it is a deliberate user action ("Resume") for the current
 * session, not a silent continuation of a previous one.
 */
export interface ControllerHomeReadiness {
  readonly token: string;
  readonly establishedAtMs: number;
}

export function establishControllerHomeReadiness(
  snapshot: SessionSnapshot,
  atMs: number,
): ControllerHomeReadiness {
  return { token: sessionRevisionToken(snapshot), establishedAtMs: atMs };
}

/**
 * True only while an established acknowledgement still matches the current
 * session. A different revision, session or launch means an explicit Resume is
 * required; a remounted panel with no acknowledgement is never implicitly ready.
 */
export function isControllerHomeReady(
  readiness: ControllerHomeReadiness | null | undefined,
  current: SessionSnapshot | null | undefined,
): boolean {
  return Boolean(
    readiness
    && current
    && readiness.token === sessionRevisionToken(current),
  );
}

/** Only a present native DS4 plus a disarmed Home path needs a launch guard. */
export function shouldPreflightControllerHome(
  service: StreamingService,
  status: NativeControllerStatus,
): boolean {
  const guardedService = service.kind === "web" || service.id === "steam" || service.id === "playnite";
  return guardedService
    && status.supported
    && status.running
    && status.pads.length > 0
    && !status.homeEnabled;
}

/** A local controller may leave VELORA only when the native Home worker is confirmed healthy. */
export function shouldBlockControllerLaunchWithoutNativeHome(
  service: StreamingService,
  status: NativeControllerStatus,
  statusKnown: boolean,
): boolean {
  const guardedService = service.kind === "web" || service.id === "steam" || service.id === "playnite";
  return guardedService
    && (!statusKnown || !status.supported || !status.running || status.pads.length === 0);
}

function browserGamepadObserved(): boolean {
  try {
    return typeof navigator !== "undefined"
      && typeof navigator.getGamepads === "function"
      && Array.from(navigator.getGamepads()).some((pad) => pad?.connected === true);
  } catch {
    return false;
  }
}

function controllerObserved(): boolean {
  const model = nativeControllerStore.getModel();
  const status = nativeControllerStore.getStatusSnapshot();
  return model.pads.length > 0
    || model.activeDevice !== null
    || (nativeControllerStore.getStatusKnown() && status.pads.length > 0)
    || browserGamepadObserved();
}

function healthyNativeHome(status: NativeControllerStatus, statusKnown: boolean): boolean {
  return statusKnown
    && status.supported
    && status.running
    && status.lastError === null
    && status.pads.length > 0
    && status.homeEnabled;
}

type NativeStatusRead = Pick<typeof nativeControllerStore, "reconcile" | "invalidateStatusRead">;

/**
 * Reads native status with a hard deadline. On timeout the read epoch is
 * invalidated, so a late invoke reply can never make the status look current.
 * The store is injectable to exercise the epoch boundary in tests; production
 * always uses the single process-wide store.
 */
export async function reconcileNativeStatusBounded(
  store: NativeStatusRead = nativeControllerStore,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      store.reconcile(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Native controller status timeout")), NATIVE_STATUS_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Invalidate the read epoch so a late invoke cannot make the status look current.
    store.invalidateStatusRead();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Guard external launch paths that can bypass the dock's interactive preflight.
 * It never arms Home: an observed controller must already have a confirmed,
 * healthy native Home path enabled for this VELORA session.
 */
export async function ensureControllerHomeForExternalLaunch(): Promise<void> {
  // Keep browser preview behavior owned by each launch service (normally unavailable).
  if (!isTauri()) return;

  const hasInitialStatusRead = nativeControllerStore.getStatusReadInFlight();
  if (!controllerObserved() && !hasInitialStatusRead) return;

  await reconcileNativeStatusBounded();

  // A pending startup read can establish that no controller is present. In that
  // case keyboard and mouse launches keep their existing behavior.
  if (!controllerObserved()) return;

  if (!healthyNativeHome(nativeControllerStore.getStatusSnapshot(), nativeControllerStore.getStatusKnown())) {
    throw new Error(CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE);
  }
}
