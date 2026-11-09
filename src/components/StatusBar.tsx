type StatusBarProps = {
  time: string;
  now: Date;
  weatherLabel: string;
  weatherTitle: string;
};

export function StatusBar({ time, now, weatherLabel, weatherTitle }: StatusBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="wordmark">N E X U S</span>
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
