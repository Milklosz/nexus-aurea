import { useEffect } from "react";
import { getAppleMusicStatus, unavailableAppleMusicStatus, type AppleMusicStatus } from "../services/musicBridge";

export const MUSIC_STATUS_POLL_MS = 2500;

/**
 * Polls the Windows SMTC bridge while `enabled` is true. Polling is paused
 * while the document is hidden (the window is minimised or behind another
 * app) and resumes with an immediate refresh when it becomes visible again.
 */
export function useMusicStatusPolling(
  enabled: boolean,
  onStatus: (status: AppleMusicStatus) => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    let active = true;

    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void getAppleMusicStatus()
        .then(status => { if (active) onStatus(status); })
        .catch(() => {
          if (active) onStatus({ ...unavailableAppleMusicStatus, windows: true, message: "Nie udało się odczytać sesji Windows SMTC." });
        });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    const timer = window.setInterval(refresh, MUSIC_STATUS_POLL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, onStatus]);
}
