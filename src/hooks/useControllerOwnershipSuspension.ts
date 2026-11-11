import { useCallback, useEffect, useRef } from "react";
import {
  getControlServiceStatus,
  listenForControlServiceStatus,
  type ControlServiceStatus,
} from "../services/controlService";
import { shouldSuspendLocalControllerInput } from "../services/controllerOwnership";

export function useControllerOwnershipSuspension() {
  const statusRef = useRef<ControlServiceStatus | null>(null);

  useEffect(() => {
    let active = true;
    let statusEventReceived = false;
    let unlisten: (() => void) | undefined;

    void listenForControlServiceStatus((next) => {
      statusEventReceived = true;
      if (active) statusRef.current = next;
    }).then((stopListening) => {
      if (active) unlisten = stopListening;
      else stopListening();
    }).catch(() => {});

    void getControlServiceStatus().then((next) => {
      if (active && !statusEventReceived) statusRef.current = next;
    }).catch(() => {
      if (active && !statusEventReceived) statusRef.current = null;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return useCallback(() => {
    const status = statusRef.current;
    if (!status) return true;
    return shouldSuspendLocalControllerInput(status.running, status.foregroundProcess);
  }, []);
}
