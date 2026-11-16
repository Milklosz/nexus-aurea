import { useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Local-only commands: the remote must never inherit permission from a parent. */
export function DesktopRecoveryControls() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (command: "restart_velora" | "exit_velora") => {
    if (inFlight.current || !isTauri()) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try { await invoke(command); }
    catch { setError("Nie udało się zamknąć lub uruchomić ponownie VELORA. Użyj trybu okienkowego albo Alt+Tab."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <section className="cc-card cc-card-wide" data-remote-admin="" aria-label="Odzyskiwanie pulpitu">
    <h3>Pulpit i ponowne uruchomienie</h3>
    <p>Otwarte aplikacje pozostają w Windows. VELORA nie zastępuje powłoki systemu.</p>
    <div className="cc-actions">
      <button type="button" disabled={busy || !isTauri()} onClick={() => void run("restart_velora")}>Uruchom ponownie VELORA</button>
      <button type="button" disabled={busy || !isTauri()} onClick={() => void run("exit_velora")}>Zakończ VELORA</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
