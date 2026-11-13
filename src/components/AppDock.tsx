import { useEffect, useState, type RefObject } from "react";
import type { StreamingService } from "../data/streamingServices";
import { emptyAppManagerSnapshot, getAppManagerStatus, type AppManagerSnapshot } from "../services/appManager";

type AppDockProps = {
  services: StreamingService[];
  activeIndex: number;
  launchingIds: ReadonlySet<string>;
  buttonRefs: RefObject<Array<HTMLButtonElement | null>>;
  onFocus: (index: number) => void;
  onActivate: (index: number) => void;
  onUnavailable: (name: string) => void;
};

type FocusSource = "keyboard" | "gamepad" | "remote";

function ServiceMark({ service }: { service: StreamingService }) {
  if (service.id === "appleMusic") return <>♫</>;
  if (service.id === "steam") return <>∞</>;
  if (service.id === "playnite") return <>P</>;
  if (service.id === "disney") return <>Disney<span>+</span></>;
  if (service.id === "prime") return <>prime<span>video</span></>;
  if (service.id === "youtube") return <>▶</>;
  if (service.id === "max") return <>max</>;
  return <>N</>;
}

export function AppDock({ services, activeIndex, launchingIds, buttonRefs, onFocus, onActivate, onUnavailable }: AppDockProps) {
  const [appManager, setAppManager] = useState<AppManagerSnapshot>(emptyAppManagerSnapshot);
  const [focusSource, setFocusSource] = useState<FocusSource>("keyboard");
  const selectedService = services[activeIndex];
  const selectedServiceLaunching = launchingIds.has(selectedService.id);

  useEffect(() => {
    let active = true;
    void getAppManagerStatus().then((snapshot) => {
      if (active) setAppManager(snapshot);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const selectedManagedApp = selectedService.kind === "managed"
    ? appManager.apps.find((app) => app.id === selectedService.managedAppId)
    : undefined;

  // Keep the body-level focus source (set by keyboard / remote / gamepad input)
  // in sync and mirror it onto the dock, so all three sources are distinguishable.
  const handleItemFocus = (index: number) => {
    if (typeof document !== "undefined" && document.body) {
      const current = document.body.dataset.focusSource;
      const source: FocusSource = current === "remote" || current === "gamepad" || current === "keyboard"
        ? current
        : "keyboard";
      setFocusSource(source);
      document.body.dataset.focusSource = source;
    }
    onFocus(index);
  };

  return (
    <>
      <p className="dock-caption">TWOJE APLIKACJE</p>
      <section className="dock-wrap" aria-label="Aplikacje rozrywkowe">
        <nav className="dock" aria-label="Wybierz aplikację">
          {services.map((service, index) => {
            const active = activeIndex === index;
            return (
              <button
                key={service.id}
                ref={(element) => {
                  buttonRefs.current[index] = element;
                }}
                className={`app ${service.className}${active ? " aurea-active" : ""}`}
                type="button"
                aria-label={`Otwórz ${service.name}`}
                aria-busy={launchingIds.has(service.id)}
                aria-pressed={active}
                aria-current={active ? "true" : undefined}
                data-aurea-item=""
                data-aurea-focus={active ? "active" : "idle"}
                data-focus-source={focusSource}
                onFocus={() => handleItemFocus(index)}
                onClick={() => {
                  if (service.kind === "managed" && appManager.windows && !appManager.apps.find((app) => app.id === service.managedAppId)?.installed) {
                    onUnavailable(service.name);
                    return;
                  }
                  onActivate(index);
                }}
              >
                <span className="app-mark">
                  <ServiceMark service={service} />
                </span>
                <span className="app-name">{service.label}</span>
              </button>
            );
          })}
        </nav>
        <aside className="focus-panel" aria-live="polite">
          <span className="focus-label">WYBRANA APLIKACJA</span>
          <span className="focus-name">{selectedService.name}</span>
          <span className="focus-status">
            {selectedServiceLaunching
              ? "uruchamianie w toku"
              : selectedService.kind === "web"
              ? "oficjalna strona internetowa"
              : !appManager.windows
                ? "aplikacja Windows"
                : selectedManagedApp?.installed ? "aplikacja wykryta" : "brak wykrytej instalacji"}
          </span>
          <span className="focus-hint">
            {selectedServiceLaunching
              ? `Uruchamiam ${selectedService.name}… Poczekaj chwilę.`
              : selectedService.kind === "managed"
              ? !appManager.windows
                ? "Aplikacja Windows · sprawdź dostępność po uruchomieniu"
                : selectedManagedApp?.installed
                  ? `Wykryto · ${selectedManagedApp.runningInstances ? "działa" : "gotowa do uruchomienia"}`
                  : "Nie wykryto instalacji · wybierz, aby zobaczyć pomoc"
              : "Oficjalna strona · dedykowane okno Edge Cinema"}
            {!selectedServiceLaunching && <><br />✕ / Enter &nbsp;Otwórz</>}
          </span>
        </aside>
      </section>
    </>
  );
}
