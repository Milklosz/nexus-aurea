type HeroPanelProps = { onWatch: () => void };

export function HeroPanel({ onWatch }: HeroPanelProps) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <p className="eyebrow">DZISIAJ W CENTRUM</p>
      <h1 id="hero-title">Nocna zmiana</h1>
      <p className="summary">Kiedy miasto gaśnie, zaczyna się prawdziwa historia.</p>
      <p className="metadata">DRAMAT &nbsp;·&nbsp; 1 SEZON &nbsp;·&nbsp; 8 ODCINKÓW</p>
      <div className="actions">
        <button className="watch" type="button" onClick={onWatch}>
          <span className="play">▶</span>OGLĄDAJ TERAZ
        </button>
        <span className="details">Szczegóły&nbsp; ↗</span>
      </div>
    </section>
  );
}
