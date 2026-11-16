import type { StreamingService } from "../data/streamingServices";
import { isTauri } from "@tauri-apps/api/core";
import type { NativeControllerStatus } from "./nativeController";
import { nativeControllerStore } from "./nativeControllerStore";

export const CONTROLLER_HOME_LAUNCH_BLOCKED_MESSAGE =
  "Nie można potwierdzić bezpiecznego powrotu do VELORA dla wykrytego kontrolera. Pozostań w VELORA, otwórz Centrum Sterowania → „Powrót do VELORA” i wybierz „Włącz powrót na tę sesję”.";

const NATIVE_STATUS_READ_TIMEOUT_MS = 2_000;

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

async function reconcileNativeStatusBounded(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      nativeControllerStore.reconcile(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Native controller status timeout")), NATIVE_STATUS_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Invalidate the read epoch so a late invoke cannot make the status look current.
    nativeControllerStore.invalidateStatusRead();
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
