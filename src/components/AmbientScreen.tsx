type AmbientScreenProps = { now: Date };

export function AmbientScreen({ now }: AmbientScreenProps) {
  const date = new Intl.DateTimeFormat("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);

  return <section className="ambient-screen" aria-label="VELORA Ambient" aria-live="off">
    <span className="ambient-eyebrow">VELORA · AMBIENT</span>
    <time className="ambient-clock" dateTime={now.toISOString()}>{now.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}</time>
    <span className="ambient-date">{date}</span>
    <span className="ambient-wake-hint">Porusz myszą, naciśnij klawisz lub przycisk kontrolera</span>
  </section>;
}