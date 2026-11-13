import { useEffect, useRef, useState } from "react";

type FocusInfoProps = {
  /** Identity of the selected app. A change of id plays the directional title transition. */
  serviceId: string;
  title: string;
  /** Context parts, rendered with a quiet "·" between them. */
  parts: readonly string[];
  /** Last horizontal travel: +1 moved right, -1 moved left. */
  direction: 1 | -1;
};

type Phase = "idle" | "out" | "in";

const EXIT_MS = 110;

/**
 * The selected app's name and one functional line: the hero of the screen. Text for
 * the same app (launching, not installed) swaps instantly; a different app exits against
 * the direction of travel and enters from the travel side.
 */
export function FocusInfo({ serviceId, title, parts, direction }: FocusInfoProps) {
  const [shown, setShown] = useState({ serviceId, title, parts });
  const [phase, setPhase] = useState<Phase>("idle");
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    const current = shownRef.current;
    if (current.serviceId === serviceId) {
      if (current.title !== title || current.parts.join("|") !== parts.join("|")) setShown({ serviceId, title, parts });
      return;
    }
    setPhase("out");
    let frame = 0;
    const timer = window.setTimeout(() => {
      setShown({ serviceId, title, parts });
      setPhase("in");
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setPhase("idle"));
      });
    }, EXIT_MS);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
    // `parts` is a fresh array each render; its content is compared above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, title, parts.join("|")]);

  const side = direction > 0 ? "r" : "l";
  // Exit goes against travel (moving right -> content leaves to the left); entry comes from the travel side.
  const phaseClass = phase === "out" ? ` is-out-${direction > 0 ? "l" : "r"}` : phase === "in" ? ` is-in-${side}` : "";
  return (
    <section className={`lr-info${phaseClass}`} aria-live="polite" aria-atomic="true">
      <h1 className="lr-title">{shown.title}</h1>
      <p className="lr-context">
        {shown.parts.map((part, index) => (
          <span key={part}>
            {index > 0 && <span className="lr-sep" aria-hidden="true">·</span>}
            {part}
          </span>
        ))}
      </p>
    </section>
  );
}
