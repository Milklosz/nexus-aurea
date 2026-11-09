import type { RefObject } from "react";
import type { StreamingService } from "../data/streamingServices";

type AppDockProps = {
  services: StreamingService[];
  activeIndex: number;
  buttonRefs: RefObject<Array<HTMLButtonElement | null>>;
  onFocus: (index: number) => void;
  onActivate: (index: number) => void;
};

function ServiceMark({ service }: { service: StreamingService }) {
  if (service.id === "disney") return <>Disney<span>+</span></>;
  if (service.id === "prime") return <>prime<span>video</span></>;
  if (service.id === "youtube") return <>▶</>;
  if (service.id === "max") return <>max</>;
  return <>N</>;
}

export function AppDock({ services, activeIndex, buttonRefs, onFocus, onActivate }: AppDockProps) {
  const selectedService = services[activeIndex];

  return (
    <>
      <p className="dock-caption">TWOJE APLIKACJE</p>
      <section className="dock-wrap" aria-label="Aplikacje rozrywkowe">
        <nav className="dock" aria-label="Wybierz aplikację">
          {services.map((service, index) => (
            <button
              key={service.id}
              ref={(element) => {
                buttonRefs.current[index] = element;
              }}
              className={`app ${service.className}`}
              type="button"
              aria-label={`Otwórz ${service.name}`}
              aria-pressed={activeIndex === index}
              onFocus={() => onFocus(index)}
              onClick={() => onActivate(index)}
            >
              <span className="app-mark">
                <ServiceMark service={service} />
              </span>
              <span className="app-name">{service.label}</span>
            </button>
          ))}
        </nav>
        <aside className="focus-panel" aria-live="polite">
          <span className="focus-label">WYBRANA APLIKACJA</span>
          <span className="focus-name">{selectedService.name}</span>
          <span className="focus-hint">✕ &nbsp;Otwórz usługę</span>
        </aside>
      </section>
    </>
  );
}
