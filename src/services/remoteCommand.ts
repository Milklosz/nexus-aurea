import type { CinemaProfile } from "./cinemaMode";
import type { SystemVolumeAction } from "./musicBridge";
import { moveAureaFocus, type NavigationDirection } from "./aureaNavigation";

export type RemoteCommand =
  | "up" | "down" | "left" | "right" | "select" | "back" | "home"
  | "volume-up" | "volume-down" | "mute"
  | "profile-cinema" | "profile-gaming" | "profile-desktop";

export type RemoteCommandHandlers = {
  navigate: (direction: -1 | 1) => void;
  select: () => void;
  /** Remote-safe select. When present it replaces `select` for the pilot. */
  selectRemote?: () => void;
  back: () => void;
  home: () => void;
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
  switch (command) {
    case "up":
      navigateDirectionCommand("up", -1, handlers);
      break;
    case "left":
      navigateDirectionCommand("left", -1, handlers);
      break;
    case "down":
      navigateDirectionCommand("down", 1, handlers);
      break;
    case "right":
      navigateDirectionCommand("right", 1, handlers);
      break;
    case "select":
      (handlers.selectRemote ?? handlers.select)();
      break;
    case "back":
      handlers.back();
      break;
    case "home":
      handlers.home();
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
