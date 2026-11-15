import { useEffect, useRef, useState } from "react";
import { SCENE_URLS } from "../../theme/living-room/sceneAssets";

/** Wait this long after the last focus change before starting a crossfade, so scrubbing through the dock never thrashes the compositor. */
export const SCENE_DEBOUNCE_MS = 220;
/** Length of one crossfade (matches --lr-t-scene). The next crossfade never starts before the previous one has finished. */
export const SCENE_FADE_MS = 600;

type Slot = "a" | "b";

/**
 * Full-bleed background. Exactly two image slots exist: the visible one and a hidden
 * one that receives the next scene. A change retargets the hidden slot; a third layer
 * is never stacked. The new scene fades in over the old one, which stays fully opaque
 * underneath until the fade ends, so the screen never dips toward black mid-transition.
 * Only opacity and a one-off transform settle animate (see livingRoom.css).
 */
export function SceneLayer({ sceneId }: { sceneId: string }) {
  const [front, setFront] = useState<Slot>("a");
  const [prev, setPrev] = useState<Slot | null>(null);
  const fadeEndsAt = useRef(0);
  const [sources, setSources] = useState<Record<Slot, string>>(() => ({ a: SCENE_URLS[sceneId] ?? "", b: "" }));
  const frontRef = useRef<Slot>("a");
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  // Decode every scene once so a crossfade never waits for the image.
  useEffect(() => {
    for (const url of Object.values(SCENE_URLS)) {
      const image = new Image();
      image.src = url;
      void image.decode?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const target = SCENE_URLS[sceneId] ?? "";
    const current = sourcesRef.current[frontRef.current];
    if (target === current) return;
    let frame = 0;
    // Debounce, and never begin while the previous crossfade is still running.
    const wait = Math.max(SCENE_DEBOUNCE_MS, fadeEndsAt.current - Date.now());
    const timer = window.setTimeout(() => {
      const hidden: Slot = frontRef.current === "a" ? "b" : "a";
      setSources((previous) => ({ ...previous, [hidden]: target }));
      // Flip on the next frame so the hidden slot has painted the new source first.
      frame = window.requestAnimationFrame(() => {
        setPrev(frontRef.current);
        frontRef.current = hidden;
        setFront(hidden);
        fadeEndsAt.current = Date.now() + SCENE_FADE_MS;
      });
    }, wait);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [sceneId]);

  // Once the new scene is fully in, the old one is released (it becomes the next hidden slot).
  useEffect(() => {
    if (prev === null) return;
    const timer = window.setTimeout(() => setPrev(null), SCENE_FADE_MS + 40);
    return () => window.clearTimeout(timer);
  }, [prev, front]);

  return (
    <div className="lr-scenes" aria-hidden="true">
      {(["a", "b"] as const).map((slot) => (
        <img
          key={slot}
          className={`lr-scene${front === slot ? " is-on" : prev === slot ? " is-prev" : ""}`}
          src={sources[slot] || undefined}
          alt=""
          draggable={false}
        />
      ))}
      <div className="lr-scrim" />
      <div className="lr-grain" />
    </div>
  );
}
