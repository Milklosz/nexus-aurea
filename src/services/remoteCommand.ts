import type { CinemaProfile } from "./cinemaMode";
import type { SystemVolumeAction } from "./musicBridge";
import { moveAureaFocus, type NavigationDirection } from "./aureaNavigation";
import { dispatchNavIntent, intentFromRemote } from "./navIntent";

export type RemoteCommand =
  | "up" | "down" | "left" | "right" | "select" | "back" | "home" | "menu" | "switch-apps"
  | "volume-up" | "volume-down" | "mute"
  | "profile-cinema" | "profile-gaming" | "profile-desktop";

/**
 * The exact allowlist the LAN server accepts from a paired iPhone.
 * Phase 3 (Ascension D): exported as a pure guard so the event listener and
 * tests share one source of truth. ADDITIVE only — the set of commands is
 * unchanged and the server-side `RemoteCommand` enum stays the authority.
 */
export const REMOTE_COMMANDS: readonly RemoteCommand[] = [
  "up", "down", "left", "right", "select", "back", "home", "menu", "switch-apps",
  "volume-up", "volume-down", "mute",
  "profile-cinema", "profile-gaming", "profile-desktop",
];

/** Type guard for untrusted event payloads (e.g. the `nexus-remote-command` event). */
export function isRemoteCommand(value: unknown): value is RemoteCommand {
  return typeof value === "string" && (REMOTE_COMMANDS as readonly string[]).includes(value);
}

export type RemoteCommandHandlers = {
  navigate: (direction: -1 | 1) => void;
  select: () => void;
  /** Remote-safe select. When present it replaces `select` for the pilot. */
  selectRemote?: () => void;
  back: () => void;
  home: () => void;
  menu?: () => void;
  switchApplications?: () => void;
  volume: (action: SystemVolumeAction) => void;
  profile: (profile: CinemaProfile) => void;
  /** Optional: full 2D direction handler (takes precedence over grid/fallback). */
  navigateDirection?: (direction: NavigationDirection) => void;
};

/**
 * Direction commands prefer an explicit `navigateDirection` handler, then try
 * the registered AUREA 2D grid (`moveAureaFocus`), and finally fall back to the
 * original linear `navigate(-1 | 1)`. With no grid registered (or no DOM),
 * `moveAureaFocus` returns false and the legacy path is used unchanged.
 */
function navigateDirectionCommand(
  direction: NavigationDirection,
  delta: -1 | 1,
  handlers: RemoteCommandHandlers,
): void {
  if (handlers.navigateDirection) {
    handlers.navigateDirection(direction);
    return;
  }
  // Gdy otwarty jest dialog (Control Center / Diagnostyka), nawigacja należy do
  // jego kontrolek — nie przejmujemy fokusu zarejestrowaną siatką 2D.
  const dialogOpen = typeof document !== "undefined"
    && typeof document.querySelector === "function"
    && Boolean(document.querySelector("dialog[open]"));
  if (!dialogOpen && moveAureaFocus(direction)) return;
  handlers.navigate(delta);
}

export function dispatchRemoteCommand(command: RemoteCommand, handlers: RemoteCommandHandlers): void {
  // Navigation and lifecycle commands go through the shared intent model.
  const intent = intentFromRemote(command);
  if (intent) {
    dispatchNavIntent(intent, {
      move: (direction) => navigateDirectionCommand(
        direction,
        direction === "up" || direction === "left" ? -1 : 1,
        handlers,
      ),
      select: () => (handlers.selectRemote ?? handlers.select)(),
      back: () => handlers.back(),
      menu: () => handlers.menu?.(),
      home: () => handlers.home(),
    });
    return;
  }
  switch (command) {
    case "switch-apps":
      handlers.switchApplications?.();
      break;
    case "volume-up":
      handlers.volume("up");
      break;
    case "volume-down":
      handlers.volume("down");
      break;
    case "mute":
      handlers.volume("mute");
      break;
    case "profile-cinema":
      handlers.profile("cinema");
      break;
    case "profile-gaming":
      handlers.profile("gaming");
      break;
    case "profile-desktop":
      handlers.profile("desktop");
      break;
  }
}
