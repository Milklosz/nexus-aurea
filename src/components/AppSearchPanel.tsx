import { useMemo, useState } from "react";
import { searchEntries, type SearchEntry } from "../services/appSearch";
import { TEXT_ENTRY_ATTRIBUTE } from "../services/virtualKeyboardRouting";
import "./AppSearchPanel.css";

export interface AppSearchPanelProps {
  entries: readonly SearchEntry[];
  onLaunch: (entryId: string) => void;
}

/**
 * VELORA's own search. The field is marked as text entry, so select opens the
 * on-screen keyboard (DualSense, pilot or physical keys). Results are plain buttons,
 * so the same select launches them everywhere.
 */
export function AppSearchPanel({ entries, onLaunch }: AppSearchPanelProps) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchEntries(entries, query), [entries, query]);
  const trimmed = query.trim();
  const textEntryMarker = { [TEXT_ENTRY_ATTRIBUTE]: "" };

  return (
    <section className="cc-card cc-card-wide app-search-card" aria-label="Wyszukiwarka aplikacji">
      <div className="cc-card-heading">
        <span className="cc-card-index">09</span>
        <div>
          <h3>Szukaj</h3>
          <p>Wpisz nazwę aplikacji, a potem wybierz wynik, aby ją uruchomić.</p>
        </div>
      </div>
      <input
        type="search"
        className="app-search-input"
        aria-label="Szukaj aplikacji"
        placeholder="Nazwa aplikacji"
        value={query}
        autoComplete="off"
        spellCheck={false}
        data-remote-allow=""
        {...textEntryMarker}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <p className="app-search-status" role="status">
        {results.length === 0 ? `Brak wyników dla „${trimmed}”.` : `Wyniki: ${results.length}`}
      </p>
      <ul className="app-search-results" aria-label="Wyniki wyszukiwania">
        {results.map((entry) => (
          <li key={entry.id}>
            <button type="button" data-remote-allow="" onClick={() => onLaunch(entry.id)}>
              <span>{entry.title}</span>
              <small>{entry.group}</small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
