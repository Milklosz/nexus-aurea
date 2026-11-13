// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FocusInfo } from "../components/living-room/FocusInfo";
import { SCENE_DEBOUNCE_MS, SceneLayer } from "../components/living-room/SceneLayer";
import { streamingServices } from "../data/streamingServices";
import { focusContext, SERVICE_PRESENTATION } from "../theme/living-room/content";
import { SCENE_URLS } from "../theme/living-room/sceneAssets";
import { SCENES, sceneSvg } from "../theme/living-room/scenes";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("service presentation", () => {
  it("has presentation, a scene image and a scene definition for every dock app", () => {
    for (const service of streamingServices) {
      expect(SERVICE_PRESENTATION[service.id], service.id).toBeDefined();
      expect(SCENE_URLS[service.id], service.id).toBeTruthy();
      expect(SCENES.some((scene) => scene.id === service.id), service.id).toBe(true);
    }
  });

  it("keeps wordmark accents legible: >= 4.5:1 on the dark plate and on the light focus plate", () => {
    for (const service of streamingServices) {
      const { accent, accentOnLight } = SERVICE_PRESENTATION[service.id];
      expect(contrast(accent, "#0c0c0e"), `${service.id} on dark`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accentOnLight, "#f3f0ea"), `${service.id} on light`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("spells each wordmark as the service name (type only, no logos)", () => {
    const flat = (id: (typeof streamingServices)[number]["id"]) => SERVICE_PRESENTATION[id].wordmark.map((p) => p.text).join("");
    expect(flat("netflix")).toBe("Netflix");
    expect(flat("disney")).toBe("Disney+");
    expect(flat("max")).toBe("HBO Max");
    expect(flat("prime")).toBe("prime video");
    expect(flat("youtube")).toBe("YouTube");
    expect(flat("appleMusic")).toBe("Apple Music");
  });

  it("describes ready, launching and missing states in the context line", () => {
    const steam = streamingServices.find((service) => service.id === "steam")!;
    expect(focusContext(steam, "ready").text).toBe("Gry · Steam Big Picture");
    expect(focusContext(steam, "launching").text).toBe("Otwieranie…");
    expect(focusContext(steam, "missing").text).toBe("Nie wykryto instalacji · wybierz, aby zobaczyć pomoc");
  });
});

describe("generated scenes", () => {
  it("are deterministic and keep the light right of centre so the left third stays dark for text", () => {
    for (const scene of SCENES) {
      expect(sceneSvg(scene, 0)).toBe(sceneSvg(scene, 0));
      expect(scene.gx).toBeGreaterThanOrEqual(1200);
    }
  });
});

describe("SceneLayer", () => {
  it("crossfades by retargeting the hidden slot after a debounce, never stacking a third layer", () => {
    const { container, rerender } = render(<SceneLayer sceneId="netflix" />);
    const images = () => Array.from(container.querySelectorAll<HTMLImageElement>("img.lr-scene"));
    expect(images()).toHaveLength(2);
    expect(images()[0].getAttribute("src")).toBe(SCENE_URLS.netflix);
    expect(images()[0].classList.contains("is-on")).toBe(true);

    rerender(<SceneLayer sceneId="prime" />);
    act(() => { vi.advanceTimersByTime(SCENE_DEBOUNCE_MS - 20); });
    expect(images()[1].getAttribute("src")).toBeNull(); // still debouncing

    act(() => { vi.advanceTimersByTime(40); vi.advanceTimersByTime(40); });
    expect(images()).toHaveLength(2);
    expect(images()[1].getAttribute("src")).toBe(SCENE_URLS.prime);
    expect(images()[1].classList.contains("is-on")).toBe(true);
    expect(images()[0].classList.contains("is-on")).toBe(false);
  });

  it("starts no fade while the user is still scrubbing", () => {
    const { container, rerender } = render(<SceneLayer sceneId="netflix" />);
    for (const id of ["disney", "max", "prime"]) {
      rerender(<SceneLayer sceneId={id} />);
      act(() => { vi.advanceTimersByTime(100); });
    }
    expect(container.querySelectorAll("img.lr-scene")[1].getAttribute("src")).toBeNull();
    act(() => { vi.advanceTimersByTime(SCENE_DEBOUNCE_MS + 40); });
    expect(container.querySelectorAll("img.lr-scene")[1].getAttribute("src")).toBe(SCENE_URLS.prime);
  });
});

describe("FocusInfo", () => {
  const text = (container: HTMLElement) => container.querySelector(".lr-title")?.textContent;

  it("swaps the title after the exit transition when the app changes", () => {
    const { container, rerender } = render(<FocusInfo serviceId="netflix" title="Netflix" parts={["Filmy i seriale"]} direction={1} />);
    rerender(<FocusInfo serviceId="disney" title="Disney+" parts={["Filmy"]} direction={1} />);
    expect(container.querySelector(".lr-info")?.className).toContain("is-out-l");
    expect(text(container)).toBe("Netflix");
    act(() => { vi.advanceTimersByTime(130); });
    expect(text(container)).toBe("Disney+");
  });

  it("updates the context for the same app instantly, with no motion", () => {
    const { container, rerender } = render(<FocusInfo serviceId="steam" title="Steam" parts={["Gry", "Steam Big Picture"]} direction={1} />);
    rerender(<FocusInfo serviceId="steam" title="Steam" parts={["Otwieranie…"]} direction={1} />);
    expect(container.querySelector(".lr-context")?.textContent).toBe("Otwieranie…");
    expect(container.querySelector(".lr-info")?.className).toBe("lr-info");
  });

  it("is a polite live region", () => {
    const { container } = render(<FocusInfo serviceId="netflix" title="Netflix" parts={["x"]} direction={1} />);
    expect(container.querySelector(".lr-info")?.getAttribute("aria-live")).toBe("polite");
  });
});
