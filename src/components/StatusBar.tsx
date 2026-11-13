import { useClock } from "../hooks/useClock";

type StatusBarProps = {
  weatherLabel: string;
  weatherTitle: string;
};

/**
 * The clock ticks every second. It subscribes here, not in App, so the
 * once-per-second update re-renders only the top bar.
 */
export function StatusBar({ weatherLabel, weatherTitle }: StatusBarProps) {
  const { now, time } = useClock();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="wordmark">V E L O R A</span>
        <span className="brand-line" />
        <span className="edition">ENTERTAINMENT OS</span>
      </div>
      <div className="status">
        <div>
          <span className="weather-label">ZABRZE</span>
          <span className="weather" title={weatherTitle} aria-live="polite">
            ◦ &nbsp;{weatherLabel}
          </span>
        </div>
        <time className="clock" dateTime={now.toISOString()} aria-label={`Godzina ${time}`}>
          {time}
        </time>
      </div>
    </header>
  );
}
