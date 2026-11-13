import { useState, type RefObject } from "react";
import type { StreamingService } from "../../data/streamingServices";
import type { AppManagerSnapshot } from "../../services/appManager";
import { SERVICE_PRESENTATION, type DockServiceState } from "../../theme/living-room/content";

type LivingDockProps = {
  services: StreamingService[];
  activeIndex: number;
  launchingIds: ReadonlySet<string>;
  appManager: AppManagerSnapshot;
  buttonRefs: RefObject<Array<HTMLButtonElement | null>>;
  onFocus: (index: number) => void;
  onActivate: (index: number) => void;
  onUnavailable: (name: string) => void;
};

/** State of one dock app. Web services are always ready; managed apps are "missing" only when the native inventory says so. */
export function dockServiceState(service: StreamingService, launching: boolean, appManager: AppManagerSnapshot): DockServiceState {
  if (launching) return "launching";
  if (service.kind === "managed" && appManager.windows) {
    const app = appManager.apps.find((candidate) => candidate.id === service.managedAppId);
    if (!app?.installed) return "missing";
  }
  return "ready";
}

type FocusSource = "keyboard" | "gamepad" | "remote";

export function LivingDock({ services, activeIndex, launchingIds, appManager, buttonRefs, onFocus, onActivate, onUnavailable }: LivingDockProps) {
  const [dockHasFocus, setDockHasFocus] = useState(false);
  const [focusSource, setFocusSource] = useState<FocusSource>("keyboard");

  const handleItemFocus = (index: number) => {
    const current = typeof document !== "undefined" ? document.body?.dataset.focusSource : undefined;
    const source: FocusSource = current === "remote" || current === "gamepad" || current === "keyboard" ? current : "keyboard";
    setFocusSource(source);
    setDockHasFocus(true);
    onFocus(index);
  };

  return (
    <nav
      className="lr-dock"
      aria-label="Aplikacje"
      onBlur={(event) => {
        // Focus moved outside the dock (top bar, a dialog, another window): the tile stays "selected", not "focused".
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDockHasFocus(false);
      }}
    >
      {services.map((service, index) => {
        const active = activeIndex === index;
        const state = dockServiceState(service, launchingIds.has(service.id), appManager);
        const presentation = SERVICE_PRESENTATION[service.id];
        const classes = ["lr-tile", `lr-tile-${service.id}`];
        if (active) classes.push("aurea-active", dockHasFocus ? "is-focused" : "is-selected");
        if (state === "launching") classes.push("is-launching");
        if (state === "missing") classes.push("is-missing");
        return (
          <button
            key={service.id}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            className={classes.join(" ")}
            type="button"
            aria-label={`Otwórz ${service.name}`}
            aria-busy={state === "launching"}
            aria-pressed={active}
            aria-current={active ? "true" : undefined}
            data-aurea-item=""
            data-aurea-focus={active ? "active" : "idle"}
            data-focus-source={focusSource}
            style={{ "--acc": presentation.accent, "--acc-light": presentation.accentOnLight } as React.CSSProperties}
            onFocus={() => handleItemFocus(index)}
            onClick={() => {
              if (state === "missing") {
                onUnavailable(service.name);
                return;
              }
              onActivate(index);
            }}
          >
            <span className="lr-wordmark">
              {presentation.wordmark.map((part, partIndex) => (
                <i key={partIndex} className={`${part.accent ? "a" : ""}${part.light ? " l" : ""}`.trim() || undefined}>{part.text}</i>
              ))}
            </span>
            <span className="lr-bar" aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}
