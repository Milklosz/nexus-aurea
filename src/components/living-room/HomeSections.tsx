import { useState, type CSSProperties } from "react";
import type { StreamingService } from "../../data/streamingServices";
import type { AppManagerSnapshot } from "../../services/appManager";
import {
  readHomeFocusMemory,
  saveHomeSectionFocus,
  useHomeSections,
  type HomeSectionId,
  type HomeSectionTile,
} from "../../services/homeSections";
import { SERVICE_PRESENTATION } from "../../theme/living-room/content";
import { dockServiceState } from "./LivingDock";

type HomeSectionsProps = {
  services: StreamingService[];
  launchingIds: ReadonlySet<string>;
  appManager: AppManagerSnapshot;
  onActivate: (index: number) => void;
  onUnavailable: (name: string) => void;
};

const SHIMMER_SLOTS = 4;

/**
 * The context-aware sections row of the Living Room Home, rendered above the
 * dock: "Kontynuuj" only for services with an actually-known live session, and
 * "Ostatnio używane" from the local read-only recents store. Tiles are real
 * buttons, so keyboard, controller and remote reach them through the shared
 * zone model (homeZones.ts) and row handling (homeActions.ts).
 *
 * States: loading -> shimmer, error -> inline message + retry, empty -> subtle
 * placeholder. The zone exists when it contains tiles or a retry action.
 */
export function HomeSections(props: HomeSectionsProps) {
  const { status, sections, empty, retry } = useHomeSections({
    services: props.services,
    launchingIds: props.launchingIds,
  });
  // Last-focused section tile, restored on mount and marked data-remembered so
  // entering the zone (up/down) lands on it again.
  const [remembered, setRemembered] = useState<number | null>(() => readHomeFocusMemory().sectionIndex);

  if (status === "loading") {
    return (
      <div className="lr-sections-state" aria-busy="true" aria-label="Wczytywanie sekcji Home">
        {Array.from({ length: SHIMMER_SLOTS }, (_, index) => (
          <span key={index} className="lr-shimmer" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (empty && status === "error") {
    return (
      <div className="lr-sections lr-sections-state lr-sections-error" role="alert">
        <p className="lr-sections-error-text">Nie udało się odczytać stanu sesji.</p>
        <button type="button" className="lr-sections-retry" onClick={retry}>Spróbuj ponownie</button>
      </div>
    );
  }

  if (empty) {
    return <p className="lr-sections-state lr-sections-empty">Tutaj pojawią się ostatnio otwierane aplikacje.</p>;
  }

  let flatIndex = -1;
  const renderTile = (tile: HomeSectionTile, sectionId: HomeSectionId) => {
    flatIndex += 1;
    const index = flatIndex;
    const state = dockServiceState(tile.service, tile.launching, props.appManager);
    const presentation = SERVICE_PRESENTATION[tile.service.id];
    const classes = ["lr-section-tile"];
    if (state === "launching") classes.push("is-launching");
    if (state === "missing") classes.push("is-missing");
    const label = sectionId === "continue"
      ? `Kontynuuj ${tile.service.name}`
      : `Otwórz ponownie ${tile.service.name}`;
    return (
      <button
        key={`${sectionId}:${tile.service.id}`}
        type="button"
        className={classes.join(" ")}
        aria-label={label}
        aria-busy={state === "launching" ? true : undefined}
        data-lr-section-tile=""
        data-remembered={index === remembered ? "true" : undefined}
        style={{ "--acc": presentation.accent, "--acc-light": presentation.accentOnLight } as CSSProperties}
        onFocus={() => {
          setRemembered(index);
          saveHomeSectionFocus(index);
        }}
        onClick={() => {
          if (state === "missing") {
            props.onUnavailable(tile.service.name);
            return;
          }
          props.onActivate(tile.serviceIndex);
        }}
      >
        <span className="lr-section-name">{tile.service.name}</span>
        {tile.continuing && <span className="lr-section-badge">Kontynuuj</span>}
        <span className="lr-bar" aria-hidden="true" />
      </button>
    );
  };

  return (
    <section className="lr-sections" aria-label="Sekcje Home">
      {status === "error" && (
        <p className="lr-sections-notice" role="alert">
          Nie udało się odczytać stanu sesji.
          <button type="button" className="lr-sections-retry" onClick={retry}>Spróbuj ponownie</button>
        </p>
      )}
      {sections.map((section) => (
        <div className="lr-section" key={section.id}>
          <h2 className="lr-section-title">{section.title}</h2>
          <div className="lr-section-tiles" role="group" aria-label={section.title}>
            {section.tiles.map((tile) => renderTile(tile, section.id))}
          </div>
        </div>
      ))}
    </section>
  );
}
