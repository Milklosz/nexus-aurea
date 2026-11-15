import type { StreamingService } from "../../data/streamingServices";

/**
 * Presentation data for the Living Room Home. Everything here is text and colour:
 * the dock never draws third-party logos, only the service name set in the system
 * font (see DESIGN_SPEC.md §5.5). One rule for every name:
 *  - a one-word name is set whole, in the accent colour, at 600;
 *  - a two-part name has the brand part in ink at 600 and the product part in the accent at 400.
 */
export interface WordmarkPart {
  text: string;
  /** Carries the service accent colour. */
  accent?: boolean;
  /** Regular (400) weight: the product part of a two-part name. */
  light?: boolean;
}

export interface ServicePresentation {
  /** The short, natural line under the selected app's name. */
  category: string;
  wordmark: readonly WordmarkPart[];
  /** Accent on the dark idle plate. */
  accent: string;
  /** Accent on the light focused plate (darker, for contrast >= 4.5:1). */
  accentOnLight: string;
}

export const SERVICE_PRESENTATION: Readonly<Record<StreamingService["id"], ServicePresentation>> = {
  netflix: {
    category: "Filmy i seriale",
    wordmark: [{ text: "Netflix", accent: true }],
    accent: "#F0484E",
    accentOnLight: "#C8161E",
  },
  disney: {
    category: "Filmy, seriale i animacje",
    wordmark: [{ text: "Disney" }, { text: "+", accent: true, light: true }],
    accent: "#7AA6FF",
    accentOnLight: "#1F54C9",
  },
  max: {
    category: "Filmy i seriale",
    wordmark: [{ text: "HBO " }, { text: "Max", accent: true, light: true }],
    accent: "#9A9AFF",
    accentOnLight: "#4338CA",
  },
  prime: {
    category: "Filmy, seriale i sport",
    wordmark: [{ text: "Prime " }, { text: "Video", accent: true, light: true }],
    accent: "#5CC8F2",
    accentOnLight: "#0B6E99",
  },
  youtube: {
    category: "Wideo",
    wordmark: [{ text: "YouTube", accent: true }],
    accent: "#FF7A45",
    accentOnLight: "#B8360E",
  },
  steam: {
    category: "Gry",
    wordmark: [{ text: "Steam", accent: true }],
    accent: "#9CCDF0",
    accentOnLight: "#1D5E8C",
  },
  playnite: {
    category: "Biblioteka gier",
    wordmark: [{ text: "Playnite", accent: true }],
    accent: "#C6A8FF",
    accentOnLight: "#6B3FD0",
  },
  appleMusic: {
    category: "Muzyka",
    wordmark: [{ text: "Apple " }, { text: "Music", accent: true, light: true }],
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
  // Which engine opens the app is a support detail and is never shown on Home.
  const parts = [SERVICE_PRESENTATION[service.id].category];
  return { text: parts.join(" · "), parts };
}
