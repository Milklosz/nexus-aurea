import { useEffect, useState } from "react";
import { useNativeControllerModel } from "../hooks/useNativeController";
import { nativeControllerStore } from "../services/nativeControllerStore";
import type { FocusOwner } from "../services/focusOwnership";
import {
  chooseInputSource,
  nativeLinkState,
  type ControllerLinkState,
  type Ds4ButtonName,
  type Ds4Revision,
  type Ds4Transport,
  type InputSource,
} from "../services/nativeController";

const linkLabels: Record<ControllerLinkState, string> = {
  disconnected: "brak kontrolera",
  connected: "połączony",
  active: "aktywny",
  unsupported: "natywny odczyt niedostępny",
};

const sourceLabels: Record<InputSource, string> = {
  native: "natywne (Raw Input)",
  "gamepad-api": "przeglądarkowe Gamepad API",
  none: "brak",
};

const revisionLabels: Record<Ds4Revision, string> = {
  v1: "DualShock 4 (v1)",
  v2: "DualShock 4 (v2)",
  usbAdapter: "DualShock 4 przez adapter USB Sony",
};

const transportLabels: Record<Ds4Transport, string> = { usb: "USB", bluetooth: "Bluetooth" };

const buttonLabels: Record<Ds4ButtonName, string> = {
  cross: "✕ Cross", circle: "◯ Circle", square: "□ Square", triangle: "△ Triangle",
  l1: "L1", r1: "R1", l2: "L2", r2: "R2", l3: "L3", r3: "R3",
  share: "Share", options: "Options", ps: "PS", touchpad: "Touchpad",
};

const ownerLabels: Record<FocusOwner, string> = {
  external: "inna aplikacja",
  ambient: "ekran Ambient",
  keyboard: "klawiatura ekranowa",
  diagnostics: "diagnostyka",
  search: "wyszukiwarka",
  "control-center": "Control Center",
  "home-actions": "górne akcje Home",
  "home-dock": "dok Home",
};

type Props = {
  /** Pads the browser Gamepad API currently lists. */
  gamepadApiPadCount: number;
  /** Read at render time, so the panel always shows the live owner. */
  getFocusOwner: () => FocusOwner;
  /** Where focus goes when this panel closes. */
  returnTo: string;
};

/**
 * Shows only what the native layer and the browser actually reported: nothing is inferred,
 * no raw packets or device identifiers are displayed or stored. Transport is read from the
 * report shape and the interface path; when neither says, it is not shown.
 */
export function NativeControllerStatus({ gamepadApiPadCount, getFocusOwner, returnTo }: Props) {
  const model = useNativeControllerModel();
  // Holding a reference keeps the single native listener alive while this panel is open.
  useEffect(() => nativeControllerStore.acquire(), []);
  const focusOwner = getFocusOwner();
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const link = nativeLinkState(model, now);
  const pad = model.pads.find((candidate) => candidate.device === model.activeDevice) ?? model.pads[0];
  const source = chooseInputSource(model, gamepadApiPadCount);

  return <section className="native-controller-status" aria-labelledby="native-controller-title">
    <h3 id="native-controller-title">Kontroler natywny</h3>
    <p>Stan: {linkLabels[link]}{model.pads.length > 1 ? ` · pady: ${model.pads.length}` : ""}</p>
    {pad && <p>Typ: {revisionLabels[pad.revision]} · Połączenie: {transportLabels[pad.transport]}</p>}
    {model.unavailableReason && <p>Powód: {model.unavailableReason}</p>}
    <p>Aktywne źródło wejścia: {sourceLabels[source]}</p>
    <p>Ostatni przycisk: {model.lastButton ? buttonLabels[model.lastButton] : "—"}</p>
    <p>Strefa fokusu: {ownerLabels[focusOwner]} · po zamknięciu wraca do: {returnTo}</p>
  </section>;
}
