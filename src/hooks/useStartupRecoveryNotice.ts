import { useEffect, useRef } from "react";
import { startupRecoveryNotice } from "../services/sessionRecovery";
import type { SessionSnapshot } from "../services/sessionOrchestrator";

/**
 * Reads the session snapshot once on mount and shows its recovery notice, if any.
 * A read that finishes after unmount is ignored, so a second mount (for example
 * React StrictMode) produces at most one notice.
 */
export function useStartupRecoveryNotice(
  readSnapshot: () => Promise<Pick<SessionSnapshot, "recovery">>,
  notify: (message: string) => void,
): void {
  const notifyRef = useRef(notify);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  useEffect(() => {
    let active = true;
    void readSnapshot()
      .then((snapshot) => {
        const notice = startupRecoveryNotice(snapshot.recovery);
        if (active && notice) notifyRef.current(notice);
      })
      .catch(() => {
        // Without a snapshot there is no recovery to report; the app still starts normally.
      });
    return () => {
      active = false;
    };
  }, [readSnapshot]);
}
