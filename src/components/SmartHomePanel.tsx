import { useRef, useState, useSyncExternalStore } from "react";
import { streamingServices, type StreamingService } from "../data/streamingServices";
import {
  getSmartHomeSnapshot, subscribeSmartHome, setSmartHomeFavorite,
  moveSmartHomeFavorite, restoreSmartHomeFavorites,
} from "../services/smartHome";
import "./SmartHomePanel.css";

export interface SmartHomePanelProps {
  onLaunch: (id: StreamingService["id"]) => void;
  onSessions?: () => void;
  services?: readonly StreamingService[];
  unavailableIds?: ReadonlySet<string>;
}

/** Compact disclosure preserves Cinema Minimal. Session resume lives in the native session panel. */
export function SmartHomePanel({ onLaunch, onSessions, services = streamingServices, unavailableIds }: SmartHomePanelProps) {
  const snapshot = useSyncExternalStore(subscribeSmartHome, getSmartHomeSnapshot, getSmartHomeSnapshot);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const byId = new Map(services.map((service) => [service.id, service]));
  const favorites = snapshot.favorites.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const recents = snapshot.recents.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const launchButton = (service: StreamingService) => (
    <button type="button" data-remote-allow="" data-smart-home-app={service.id} disabled={unavailableIds?.has(service.id)}
      onClick={() => onLaunch(service.id)}>
      {service.name}{unavailableIds?.has(service.id) ? " · niedostępne" : ""}
    </button>
  );
  return <section className="smart-home smart-home-panel home-actions" aria-label="Moje aplikacje" data-remote-allow="" data-home-disclosure="" data-expanded={expanded}>
    <button ref={triggerRef} type="button" className="smart-home-toggle" data-remote-allow="" aria-expanded={expanded}
      onClick={() => {
        setExpanded((value) => !value); setEditing(false);
        if (expanded) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
      }}>
      Moje aplikacje <span>{expanded ? "Zwiń" : "Ulubione i ostatnie"}</span>
    </button>
    {expanded && <div className="smart-home-content">
      {onSessions && <button type="button" data-remote-allow="" onClick={onSessions}>Wznów sesję aplikacji</button>}
      <div className="smart-home-heading"><h3>Ulubione</h3>
        <button type="button" data-remote-allow="" aria-pressed={editing} onClick={() => setEditing((value) => !value)}>
          {editing ? "Gotowe" : "Edytuj ulubione"}
        </button>
      </div>
      {favorites.length === 0 && <p>Dodaj aplikacje do ulubionych przez Edytuj ulubione.</p>}
      <ul className="smart-home-list" aria-label="Ulubione aplikacje">
        {favorites.map((service, index) => <li key={service.id}>
          {launchButton(service)}
          {editing && <div className="smart-home-edit-actions">
            <button type="button" data-remote-allow="" aria-label={`Przesuń ${service.name} wcześniej`} disabled={index === 0}
              onClick={() => moveSmartHomeFavorite(service.id, -1)}>Wcześniej</button>
            <button type="button" data-remote-allow="" aria-label={`Przesuń ${service.name} później`} disabled={index === favorites.length - 1}
              onClick={() => moveSmartHomeFavorite(service.id, 1)}>Później</button>
            <button type="button" data-remote-allow="" aria-label={`Odepnij ${service.name}`}
              onClick={() => setSmartHomeFavorite(service.id, false)}>Odepnij</button>
          </div>}
        </li>)}
      </ul>
      {editing && <div className="smart-home-add">
        <p>Dodaj do ulubionych</p>
        {services.filter((service) => !snapshot.favorites.includes(service.id)).map((service) =>
          <button key={service.id} type="button" data-remote-allow="" onClick={() => setSmartHomeFavorite(service.id, true)}>
            Przypnij {service.name}
          </button>)}
        <button type="button" data-remote-allow="" onClick={restoreSmartHomeFavorites}>Przywróć domyślne ulubione</button>
      </div>}
      <h3>Ostatnio otwierane</h3>
      {recents.length === 0 ? <p>Tu pojawią się aplikacje otwarte przez VELORA.</p> :
        <ul className="smart-home-list" aria-label="Ostatnio otwierane aplikacje">
          {recents.map((service) => <li key={service.id}>{launchButton(service)}</li>)}
        </ul>}
      <p className="smart-home-note">Otwórz aplikację lub wróć do jej sesji. Postęp oglądania pozostaje w serwisie.</p>
      {snapshot.persistence !== "saved" && <p role="status">
        {snapshot.persistence === "newerVersion"
          ? "Ustawienia zapisano w nowszej wersji VELORA. Zmiany działają tylko do zamknięcia aplikacji."
          : "Nie można zapisać ustawień. Zmiany działają tylko do zamknięcia aplikacji."}
      </p>}
    </div>}
  </section>;
}
