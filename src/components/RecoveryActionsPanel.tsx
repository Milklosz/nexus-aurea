import { useCallback, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { REMOTE_CONFIRM_ATTRIBUTE } from "../services/remotePermissions";
import { useConfirmGate } from "./ConfirmDialog";
import {
  inspectRemoteRecovery,
  revokeAllRemoteDevices,
  runRemoteRecovery,
  stopRemoteAccess,
  type RemoteRecoveryMode,
  type RemoteRecoveryPlan,
} from "../services/remoteAccess";
import { resetEdgeCinemaSession } from "../services/edgeCinemaLifecycle";

/* ------------------------------------------------------------------------- *
 * Control Center 4.0 — recovery actions (ADDITIVE, fail-closed).
 *
 * Every button here is risky and carries `data-velora-confirm="<warning>"`:
 * the first click is intercepted by the ConfirmDialog gate and the action runs
 * only after an explicit local "Potwierdź". The whole card is a
 * `data-remote-admin` zone and `canRemoteSelect()` denies every
 * `[data-velora-confirm]` element, so the paired iPhone Remote can never
 * trigger any of these through a generic click.
 * ------------------------------------------------------------------------- */

const CONFIRM_EXIT = "Zakończenie VELORA zamyka całą aplikację na tym komputerze. Otwarte aplikacje w Windows pozostają otwarte. Kontynuować?";
const CONFIRM_RESTART = "Ponowne uruchomienie VELORA zamyka i natychmiast otwiera aplikację ponownie. Kontynuować?";
const CONFIRM_REVOKE_ALL = "Odwołanie dostępu jest trwałe: wszystkie sparowane urządzenia stracą dostęp do pilota i trzeba je sparować ponownie. Kontynuować?";
const CONFIRM_STOP_REMOTE = "Wyłączenie serwera LAN natychmiast odcina wszystkie połączone piloty. Kontynuować?";
const CONFIRM_RECOVERY_INSPECT = "Odzyskiwanie zaufania może trwale usunąć wpisy VELORA i wymagać ponownego sparowania urządzeń. Kontynuować?";
const CONFIRM_RECOVERY_RUN = "Wybrane odzyskiwanie trwale usuwa wybrane wpisy zaufania. Kontynuować?";
const CONFIRM_CINEMA_RESET = "Reset sesji Edge Cinema czyści bieżący stan sesji kina (tylko w pamięci, bez zamykania procesów). Kontynuować?";
const CONFIRM_DESKTOP = "Przywrócenie pulpitu Windows ukryje pełnoekranową VELORĘ; aplikacje pozostają otwarte. Kontynuować?";

type RecoveryActionsPanelProps = {
  onShowDesktop: () => void;
};

export function RecoveryActionsPanel({ onShowDesktop }: RecoveryActionsPanelProps) {
  const gate = useConfirmGate();
  const native = isTauri();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [recoveryPlan, setRecoveryPlan] = useState<RemoteRecoveryPlan | null>(null);
  const [recoveryChoice, setRecoveryChoice] = useState<RemoteRecoveryMode | null>(null);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const busyRef = useRef(false);

  const run = useCallback(async (action: () => Promise<unknown>, success: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Akcja odzyskiwania nie została wykonana.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const disabled = busy || !native;

  return <section className="cc-card cc-card-wide cc-recovery-actions" aria-label="Akcje odzyskiwania"
    data-remote-admin="" aria-busy={busy} onClickCapture={gate.captureClick}>
    <div className="cc-card-heading">
      <span className="cc-card-index">11</span>
      <div><h3>Akcje odzyskiwania</h3><p>Każda ryzykowna akcja wymaga lokalnego potwierdzenia.</p></div>
    </div>
    <p className="cc-card-note">
      Te przyciski nie są dostępne dla pilota iPhone: każdy wymaga jawnego potwierdzenia
      w okienku, które pojawia się po pierwszym kliknięciu.
    </p>
    <div className="cc-actions">
      <button type="button" data-velora-confirm={CONFIRM_REVOKE_ALL} disabled={disabled}
        onClick={() => void run(revokeAllRemoteDevices, "Dostęp wszystkich sparowanych urządzeń został odwołany.")}>
        Odwołaj wszystkie urządzenia zdalne
      </button>
      <button type="button" data-velora-confirm={CONFIRM_STOP_REMOTE} disabled={disabled}
        onClick={() => void run(stopRemoteAccess, "Serwer LAN został wyłączony.")}>
        Zatrzymaj dostęp zdalny (serwer LAN)
      </button>
      <button type="button" data-velora-confirm={CONFIRM_RECOVERY_INSPECT} disabled={disabled}
        onClick={() => void run(async () => {
          const plan = await inspectRemoteRecovery();
          setRecoveryPlan(plan);
          setRecoveryChoice(null);
          setRecoveryAcknowledged(false);
        }, "Stan odzyskiwania odczytany. Wybierz tryb poniżej.")}>
        Przygotuj odzyskiwanie zaufania…
      </button>
      <button type="button" data-velora-confirm={CONFIRM_CINEMA_RESET} disabled={disabled}
        onClick={() => void run(resetEdgeCinemaSession, "Sesja Edge Cinema została zresetowana.")}>
        Zresetuj sesję Edge Cinema
      </button>
      <button type="button" data-velora-confirm={CONFIRM_RESTART} disabled={disabled}
        onClick={() => void run(() => invoke("restart_velora"), "Wysłano polecenie ponownego uruchomienia VELORA.")}>
        Uruchom ponownie VELORA (z potwierdzeniem)
      </button>
      <button type="button" data-velora-confirm={CONFIRM_EXIT} disabled={disabled}
        onClick={() => void run(() => invoke("exit_velora"), "Wysłano polecenie zakończenia VELORA.")}>
        Zakończ VELORA (z potwierdzeniem)
      </button>
      <button type="button" data-velora-confirm={CONFIRM_DESKTOP} disabled={busy}
        onClick={() => onShowDesktop()}>
        Przywróć pulpit Windows (z potwierdzeniem)
      </button>
    </div>
    {recoveryPlan && <div className="cc-remote-actions" role="group" aria-label="Tryb odzyskiwania zaufania">
      <p>{recoveryPlan.message ?? "Wybierz tryb odzyskiwania."}</p>
      {recoveryPlan.options.map((option) => <label className="remote-trust-confirmation" key={option.mode}>
        <input type="radio" name="cc-recovery-mode" checked={recoveryChoice === option.mode}
          onChange={() => { setRecoveryChoice(option.mode); setRecoveryAcknowledged(false); }} />
        {option.summary}
      </label>)}
      {recoveryChoice && <label className="remote-trust-confirmation">
        <input type="checkbox" checked={recoveryAcknowledged}
          onChange={(event) => setRecoveryAcknowledged(event.target.checked)} />
        Rozumiem, że wybrane wpisy zostaną trwale usunięte, a urządzenia trzeba sparować ponownie.
      </label>}
      <button type="button" data-velora-confirm={CONFIRM_RECOVERY_RUN}
        disabled={busy || !recoveryChoice || !recoveryAcknowledged || !recoveryPlan.confirmation}
        onClick={() => void run(
          () => runRemoteRecovery(recoveryChoice as RemoteRecoveryMode, recoveryPlan.confirmation),
          "Odzyskiwanie zakończone.",
        )}>
        Wykonaj odzyskiwanie (z potwierdzeniem)
      </button>
    </div>}
    {error && <p className="cc-feedback cc-error" role="alert">{error}</p>}
    {notice && <p className="cc-feedback" role="status">{notice}</p>}
    {gate.dialog}
  </section>;
}

export { REMOTE_CONFIRM_ATTRIBUTE };
