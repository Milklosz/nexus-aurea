import { useState, type ReactNode } from "react";
import { useClock } from "../../hooks/useClock";

type ActionId = "search" | "remote" | "settings";

type TopBarProps = {
  /** "2°" or "" when there is no reading. Nothing is shown (and nothing invented) without one. */
  temperatureText: string;
  condition: string;
  weatherTitle: string;
  weatherStale: boolean;
  onSearch: () => void;
  onRemote: () => void;
  onSettings: () => void;
};

const icons: Record<ActionId, ReactNode> = {
  search: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 20 20" /></svg>
  ),
  remote: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="3" /><circle cx="12" cy="8" r="1.6" /><path d="M10 13.5h4M10 16.5h4" /></svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2.3" /><circle cx="15" cy="17" r="2.3" /></svg>
  ),
};

/**
 * Clock and weather on the left, the three system entries on the right.
 * The clock ticks every second and subscribes here, so only this bar re-renders.
 */
export function TopBar({ temperatureText, condition, weatherTitle, weatherStale, onSearch, onRemote, onSettings }: TopBarProps) {
  const { now, time } = useClock();
  const [focused, setFocused] = useState<ActionId | null>(null);
  const [remembered, setRemembered] = useState<ActionId>("search");
  const actions: Array<{ id: ActionId; label: string; aria: string; run: () => void }> = [
    { id: "search", label: "Szukaj", aria: "Szukaj aplikacji", run: onSearch },
    { id: "remote", label: "Pilot", aria: "Pilot iPhone", run: onRemote },
    { id: "settings", label: "Ustawienia", aria: "Otwórz ustawienia", run: onSettings },
  ];
  return (
    <header className="lr-top">
      <div className="lr-when">
        <time className="lr-clock" dateTime={now.toISOString()} aria-label={`Godzina ${time}`}>{time}</time>
        {temperatureText !== "" && (
          <span className={`lr-weather${weatherStale ? " is-stale" : ""}`} title={weatherTitle} aria-live="polite">
            <b>{temperatureText}</b>{condition}
          </span>
        )}
      </div>
      <nav className="home-actions lr-actions" aria-label="System">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`lr-action${focused === action.id ? " is-focused" : ""}`}
            data-remembered={remembered === action.id ? "true" : undefined}
            aria-label={action.aria}
            onFocus={() => { setFocused(action.id); setRemembered(action.id); }}
            onBlur={() => setFocused((current) => (current === action.id ? null : current))}
            onClick={action.run}
          >
            {icons[action.id]}
            {action.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
