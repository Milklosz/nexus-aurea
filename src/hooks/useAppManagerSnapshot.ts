import { useEffect, useState } from "react";
import { emptyAppManagerSnapshot, getAppManagerStatus, type AppManagerSnapshot } from "../services/appManager";

/** One read of the native app inventory (which managed apps are installed / running). */
export function useAppManagerSnapshot(): AppManagerSnapshot {
  const [snapshot, setSnapshot] = useState<AppManagerSnapshot>(emptyAppManagerSnapshot);
  useEffect(() => {
    let active = true;
    void getAppManagerStatus().then((next) => {
      if (active) setSnapshot(next);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  return snapshot;
}
