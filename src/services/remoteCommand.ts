import type { CinemaProfile } from "./cinemaMode";
import type { SystemVolumeAction } from "./musicBridge";

export type RemoteCommand =
  | "up" | "down" | "left" | "right" | "select" | "back" | "home"
  | "volume-up" | "volume-down" | "mute"
  | "profile-cinema" | "profile-gaming" | "profile-desktop";

export type RemoteCommandHandlers = {
  navigate: (direction: -1 | 1) => void;
  select: () => void;
  back: () => void;
  home: () => void;
  volume: (action: SystemVolumeAction) => void;
  profile: (profile: CinemaProfile) => void;
};

export function dispatchRemoteCommand(command: RemoteCommand, handlers: RemoteCommandHandlers): void {
  switch (command) {
    case "up":
    case "left":
      handlers.navigate(-1);
      break;
    case "down":
    case "right":
      handlers.navigate(1);
      break;
    case "select":
      handlers.select();
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
