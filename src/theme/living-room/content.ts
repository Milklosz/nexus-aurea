import type { StreamingService } from "../../data/streamingServices";

/**
 * Presentation data for the Living Room Home. Everything here is text and colour:
 * the dock never draws third-party logos, only the service name set in the system
 * font with one accented part (see DESIGN_SPEC.md §5.5).
 */
export interface WordmarkPart {
  text: string;
  /** Carries the service accent colour. */
  accent?: boolean;
  /** Light (350) weight. */
  light?: boolean;
}

export interface ServicePresentation {
  category: string;
  launchMode: string;
  wordmark: readonly WordmarkPart[];
  /** Accent on the dark idle plate. */
  accent: string;
  /** Accent on the light focused plate (darker, for contrast >= 4.5:1). */
  accentOnLight: string;
}

export const SERVICE_PRESENTATION: Readonly<Record<StreamingService["id"], ServicePresentation>> = {
  netflix: {
    category: "Filmy i seriale",
    launchMode: "Okno Edge Cinema",
    wordmark: [{ text: "Netflix", accent: true }],
    accent: "#F0484E",
    accentOnLight: "#C8161E",
  },
  disney: {
    category: "Filmy, seriale i animacje",
    launchMode: "Okno Edge Cinema",
    wordmark: [{ text: "Disney" }, { text: "+", accent: true, light: true }],
    accent: "#7AA6FF",
    accentOnLight: "#1F54C9",
  },
  max: {
    category: "Filmy i seriale",
    launchMode: "Okno Edge Cinema",
    wordmark: [{ text: "HBO " }, { text: "Max", accent: true, light: true }],
    accent: "#9A9AFF",
    accentOnLight: "#4338CA",
  },
  prime: {
    category: "Filmy, seriale i sport",
    launchMode: "Okno Edge Cinema",
    wordmark: [{ text: "prime " }, { text: "video", accent: true, light: true }],
    accent: "#5CC8F2",
    accentOnLight: "#0B6E99",
  },
  youtube: {
    category: "Wideo",
    launchMode: "Okno Edge Cinema",
    wordmark: [{ text: "You", light: true }, { text: "Tube", accent: true }],
    accent: "#FF5D52",
    accentOnLight: "#CC1A10",
  },
  steam: {
    category: "Gry",
    launchMode: "Steam Big Picture",
    wordmark: [{ text: "Steam", accent: true }],
    accent: "#9CCDF0",
    accentOnLight: "#1D5E8C",
  },
  playnite: {
    category: "Biblioteka gier",
    launchMode: "Pełny ekran Playnite",
    wordmark: [{ text: "Play" }, { text: "nite", accent: true }],
    accent: "#C6A8FF",
    accentOnLight: "#6B3FD0",
  },
  appleMusic: {
    category: "Muzyka",
    launchMode: "Aplikacja Windows",
    wordmark: [{ text: "Apple", light: true }, { text: " " }, { text: "Music", accent: true }],
    accent: "#FF7088",
    accentOnLight: "#C41E44",
  },
};

export type DockServiceState = "ready" | "launching" | "missing";

/** The context line under the focused app's name. Pure, so the states are testable. */
export function focusContext(service: StreamingService, state: DockServiceState): { text: string; parts: readonly string[] } {
  if (state === "launching") return { text: "Otwieranie…", parts: ["Otwieranie…"] };
  if (state === "missing") {
    const parts = ["Nie wykryto instalacji", "wybierz, aby zobaczyć pomoc"];
    return { text: parts.join(" · "), parts };
  }
  const presentation = SERVICE_PRESENTATION[service.id];
  const parts = [presentation.category, presentation.launchMode];
  return { text: parts.join(" · "), parts };
}
