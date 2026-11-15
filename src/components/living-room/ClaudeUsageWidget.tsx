import { useCallback, useEffect, useRef, useState } from "react";
import { formatUsageTime, getClaudeUsage, unavailableClaudeUsage, usageLabel, type ClaudeUsageError } from "../../services/claudeUsage";

const messages: Record<ClaudeUsageError, string> = {
  notInstalled: "Claude Code nie jest zainstalowany.",
  notAuthenticated: "Zaloguj się w Claude Code.",
  usageUnavailable: "Automatyczny odczyt /usage jest niedostępny.",
  parserIncompatible: "Format danych Claude Code jest niezgodny.",
  timeout: "Claude Code nie odpowiedział na czas.",
  awaitingUsage: "Uruchom Claude Code z integracją status line i wykonaj pierwsze zapytanie.",
};

/** Read-only status: updates never move focus. No polling while usage export is unsupported. */
export function ClaudeUsageWidget() {
  const [snapshot, setSnapshot] = useState(unavailableClaudeUsage);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async (manual: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const result = await getClaudeUsage(manual);
      if (mounted.current) setSnapshot((previous) => previous.fetchedAt !== null && result.fetchedAt === null
        ? { ...previous, stale: true, status: "stale", errorCode: result.errorCode } : result);
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh(false);
    return () => { mounted.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (!snapshot.automaticUsageSupported) return;
    const timer = window.setInterval(() => void refresh(false), 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [snapshot.automaticUsageSupported, refresh]);
  useEffect(() => {
    if (snapshot.stale || snapshot.fetchedAt === null) return;
    const resets = snapshot.limits.flatMap((limit) => limit.resetAt ? [Date.parse(limit.resetAt)] : []).filter(Number.isFinite);
    if (resets.length === 0) return;
    // A local freshness timer only: reaching reset never sends a model request
    // or triggers extra CLI polling, and never moves focus.
    const delay = Math.min(...resets) - Date.now();
    const timer = window.setTimeout(() => setSnapshot((previous) => ({ ...previous, stale: true, status: "stale" })), Math.max(0, Math.min(delay, 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [snapshot]);
  const toggle = () => {
    setExpanded((value) => !value);
    if (expanded) trigger.current?.focus({ preventScroll: true });
  };
  return <section className="claude-usage" data-home-disclosure="" aria-label="Claude Usage"
    onKeyDown={(event) => {
      if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); toggle(); }
    }}>
    <button ref={trigger} className="lr-action claude-usage-trigger" type="button" aria-expanded={expanded}
      aria-controls="claude-usage-details" onClick={toggle}>
      <span>Claude Usage</span><small>{loading ? "Odczyt…" : snapshot.stale ? "Nieaktualne" : snapshot.status === "available" ? "Limity" : "Niedostępne"}</small>
    </button>
    {expanded && <div id="claude-usage-details" className="claude-usage-details">
      <p className="claude-usage-caption">Claude Usage</p>
      <div role="status" aria-live="polite">
        {loading && <p>{snapshot.fetchedAt === null ? "Sprawdzanie Claude Code…" : "Odświeżanie…"}</p>}
        {snapshot.stale && <p>Dane nieaktualne — ostatni poprawny odczyt poniżej.</p>}
        {snapshot.errorCode && <p>{messages[snapshot.errorCode]}</p>}
        {snapshot.refreshing && !loading && <p>Odczyt już trwa. Odśwież za chwilę.</p>}
      </div>
      <div className="claude-usage-limits">{snapshot.limits.map((limit) => <div key={limit.categoryId}>
        <p><span>{usageLabel(limit.categoryLabel)}</span><b>{limit.usedPercent}%</b></p>
        <meter min={0} max={100} value={limit.usedPercent} aria-label={usageLabel(limit.categoryLabel)} />
        {(limit.resetAt || limit.resetText) && <small>Reset — {limit.resetAt
          ? `${formatUsageTime(limit.resetAt, limit.resetTimezone ?? "Europe/Warsaw")} (${limit.resetTimezone ?? "Europe/Warsaw"})`
          : limit.resetText}</small>}
      </div>)}</div>
      {snapshot.fetchedAt !== null && <p className="claude-usage-updated">Updated — {formatUsageTime(snapshot.fetchedAt)} (Europe/Warsaw)</p>}
      {(snapshot.errorCode === "awaitingUsage" || !snapshot.automaticUsageSupported) && <p className="claude-usage-help">Limity pochodzą z oficjalnego status line Claude Code. Integracja wymaga jednorazowej ręcznej konfiguracji. Bez niej sprawdź /usage w swoim terminalu.</p>}
      <button type="button" className="claude-usage-refresh" aria-disabled={loading}
        onFocus={(event) => event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" })}
        onClick={() => { if (!loading) void refresh(true); }}>Odśwież Claude Usage</button>
      {snapshot.sourceVersion && <small className="claude-usage-version">{snapshot.sourceVersion}</small>}
    </div>}
  </section>;
}
