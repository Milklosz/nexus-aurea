import { useCallback, useRef, useState } from "react";

export function useLaunchGuard() {
  const activeLaunches = useRef(new Set<string>());
  const [launchingIds, setLaunchingIds] = useState<ReadonlySet<string>>(new Set());

  const run = useCallback(async (id: string, action: () => Promise<void>): Promise<void> => {
    if (activeLaunches.current.has(id)) return;

    activeLaunches.current.add(id);
    setLaunchingIds(new Set(activeLaunches.current));
    try {
      await action();
    } finally {
      activeLaunches.current.delete(id);
      setLaunchingIds(new Set(activeLaunches.current));
    }
  }, []);

  return { launchingIds, run };
}
