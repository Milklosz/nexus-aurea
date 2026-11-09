import { useEffect, useRef, useState } from "react";
import { gamepadSnapshot } from "../services/gamepadSnapshot";

export function GamepadDiagnostics({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pads, setPads] = useState<ReturnType<typeof gamepadSnapshot>>([]);
  const supported = typeof navigator.getGamepads === "function";
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const update = () => setPads(supported ? gamepadSnapshot(navigator.getGamepads()) : []);
    update();
    const timer = window.setInterval(update, 100);
    return () => { window.clearInterval(timer); element?.close(); };
  }, [supported]);
  return <dialog ref={dialog} className="diagnostics" onCancel={onClose} aria-labelledby="pad-title">
    <h2 id="pad-title">Diagnostyka pada PlayStation</h2>
    <p>{supported ? "Gamepad API dostępne" : "Gamepad API niedostępne"} · Połączone: {pads.length}</p>
    <p>Naciśnij przycisk pada, gdy NEXUS ma fokus. Windows może wykrywać urządzenie, zanim udostępni je Gamepad API.</p>
    <p>Mapowanie standard: 0 ✕, 1 ◯, 2 □, 3 △, 9 Options. Pozostałe mapowania: surowe indeksy. Podgląd tylko w tym oknie.</p>
    {pads.map(pad => <section key={pad.index}>
      <h3>#{pad.index} {pad.id}</h3><p>Mapowanie: {pad.mapping || "niestandardowe"}</p>
      <div className="pad-values">{pad.buttons.map((button, i) => <span key={i} data-pressed={button.pressed}>B{i}: {button.value.toFixed(2)} {button.pressed ? "●" : "○"}</span>)}</div>
      <p>Osie: {pad.axes.map((value, i) => "A" + i + ": " + value.toFixed(3)).join(" · ")}</p>
    </section>)}
    <button onClick={onClose} autoFocus>Zamknij (Esc)</button>
  </dialog>;
}
