import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { StreamingService } from "../../data/streamingServices";
import { useAppManagerSnapshot } from "../../hooks/useAppManagerSnapshot";
import { focusContext } from "../../theme/living-room/content";
import { readHomeFocusMemory, saveHomeDockFocus } from "../../services/homeSections";
import { FocusInfo } from "./FocusInfo";
import { dockServiceState, LivingDock } from "./LivingDock";
import { HomeSections } from "./HomeSections";
import { SceneLayer } from "./SceneLayer";
import { TopBar } from "./TopBar";
import "../../theme/living-room/livingRoom.css";

type LivingRoomHomeProps = {
  services: StreamingService[];
  activeIndex: number;
  launchingIds: ReadonlySet<string>;
  buttonRefs: RefObject<Array<HTMLButtonElement | null>>;
  weather: { temperatureText: string; condition: string; title: string; stale: boolean };
  onFocus: (index: number) => void;
  onActivate: (index: number) => void;
  onUnavailable: (name: string) => void;
  onSearch: () => void;
  onRemote: () => void;
  onSettings: () => void;
  /** Optional element shown under the top bar (the Apple Music background-mode player). */
  aside?: ReactNode;
};

/**
 * VELORA 2.0 "Living Room" Home: the selected app is the hero, one scene per app behind
 * it, a thin top line and one dock. The previous Grand Cinema Home stays available (see homeTheme.ts).
 */
export function LivingRoomHome(props: LivingRoomHomeProps) {
  const appManager = useAppManagerSnapshot();
  const selected = props.services[props.activeIndex] ?? props.services[0];
  const state = dockServiceState(selected, props.launchingIds.has(selected.id), appManager);
  const context = focusContext(selected, state);

  // Direction of the last horizontal move, for the title transition.
  const lastIndex = useRef(props.activeIndex);
  const direction = useRef<1 | -1>(1);
  if (props.activeIndex !== lastIndex.current) {
    direction.current = props.activeIndex > lastIndex.current ? 1 : -1;
    lastIndex.current = props.activeIndex;
  }

  // Focus memory: persist the last-focused dock tile and restore it on Home mount,
  // so returning to Home lands where the user left, not always on the first tile.
  const propsRef = useRef(props);
  propsRef.current = props;
  useEffect(() => {
    const initial = propsRef.current;
    const memory = readHomeFocusMemory();
    const index = memory.dockIndex;
    if (index !== null && index >= 0 && index < initial.services.length) {
      initial.onFocus(index);
      initial.buttonRefs.current[index]?.focus({ preventScroll: true });
    }
    // Runs once on Home mount; later focus changes go through handleDockFocus below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDockFocus = (index: number) => {
    saveHomeDockFocus(index);
    props.onFocus(index);
  };

  return (
    <>
      <SceneLayer sceneId={selected.id} />
      <TopBar
        temperatureText={props.weather.temperatureText}
        condition={props.weather.condition}
        weatherTitle={props.weather.title}
        weatherStale={props.weather.stale}
        onSearch={props.onSearch}
        onRemote={props.onRemote}
        onSettings={props.onSettings}
      />
      {props.aside}
      <div className="lr-home-content">
        <FocusInfo serviceId={selected.id} title={selected.name} parts={context.parts} direction={direction.current} />
        <HomeSections
          services={props.services}
          launchingIds={props.launchingIds}
          appManager={appManager}
          onActivate={props.onActivate}
          onUnavailable={props.onUnavailable}
        />
        <LivingDock
          services={props.services}
          activeIndex={props.activeIndex}
          launchingIds={props.launchingIds}
          appManager={appManager}
          buttonRefs={props.buttonRefs}
          onFocus={handleDockFocus}
          onActivate={props.onActivate}
          onUnavailable={props.onUnavailable}
        />
      </div>
    </>
  );
}
