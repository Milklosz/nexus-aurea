import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import metadata from "../../package.json";

export function useAppVersion() {
  const [version, setVersion] = useState(isTauri() ? "…" : metadata.version);
  useEffect(() => {
    let active = true;
    if (isTauri()) void getVersion().then(value => { if (active) setVersion(value); })
      .catch(() => { if (active) setVersion("nieznana"); });
    return () => { active = false; };
  }, []);
  return version;
}
