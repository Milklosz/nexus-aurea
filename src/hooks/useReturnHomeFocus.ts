import { useEffect, useRef } from "react";
import { listenForReturnHome, type ReturnHomeEvent } from "../services/sessionOrchestrator";

/**
 * Which dock tile gets focus when VELORA regains the foreground after an app.
 * The tile the user launched from is kept; anything out of range falls back to
 * the first tile. (README: "When Windows returns focus to NEXUS, the selected
 * tile is restored.")
 */
export function returnHomeFocusTarget(selectedIndex: number, count: number): number {
  if (!Number.isInteger(selectedIndex) || count <= 0) return 0;
  if (selectedIndex < 0 || selectedIndex >= count) return 0;
  return selectedIndex;
}

/**
 * Subscribes to `velora-return-home`. The latest handler is used, so the
 * subscription is not recreated when the handler identity changes, and the
 * listener is removed on unmount even if the subscription resolves late.
 */
export function useReturnHomeListener(
  onReturnHome: (event: ReturnHomeEvent) => void,
  listen: (callback: (event: ReturnHomeEvent) => void) => Promise<() => void> = listenForReturnHome,
): void {
  const handlerRef = useRef(onReturnHome);

  useEffect(() => {
    handlerRef.current = onReturnHome;
  }, [onReturnHome]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen((event) => {
      if (active) handlerRef.current(event);
    })
      .then((stopListening) => {
        if (active) unlisten = stopListening;
        else stopListening();
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [listen]);
}
