/**
 * Original background scenes for the Living Room Home, generated from code.
 * `sceneSvg()` is deterministic (seeded) and has no runtime consumers: the scenes are
 * rendered once by `design/tools/render-scenes.mjs` into `src/assets/scenes/<id>.webp`
 * (3840x2160) and the app only crossfades those images. Keep this file free of
 * imports and of non-erasable TypeScript so the script can load it with plain Node.
 */

export type SceneKind = "dunes" | "sea" | "mist";

export interface SceneParams {
  /** Service id this scene belongs to (same ids as `streamingServices`). */
  id: string;
  type: SceneKind;
  sky: [string, string, string];
  glow: string;
  /** Horizontal glow position in the 1920-wide reference canvas. Always right of centre so the left third stays dark for text. */
  gx: number;
  /** Glow opacity. */
  ga: number;
  /** Horizon y in the 1080-high reference canvas. */
  hz: number;
  haze: string;
  fg: string;
  seed: number;
  stars?: boolean;
}

export const SCENES: readonly SceneParams[] = [
  { id: "netflix", type: "dunes", sky: ["#050506", "#13080a", "#3a1214"], glow: "#ff6a4a", gx: 1380, ga: 0.55, hz: 612, haze: "#5a1e1c", fg: "#050404", seed: 2.1 },
  { id: "disney", type: "dunes", sky: ["#020309", "#070f28", "#1b336c"], glow: "#86a8ff", gx: 1500, ga: 0.42, hz: 640, haze: "#1b2a58", fg: "#020309", seed: 5.7, stars: true },
  { id: "max", type: "dunes", sky: ["#040309", "#110b25", "#37226c"], glow: "#a586ff", gx: 1200, ga: 0.5, hz: 598, haze: "#2b1f50", fg: "#040308", seed: 8.2 },
  { id: "prime", type: "sea", sky: ["#020a10", "#092331", "#2b6a82"], glow: "#a8e6f4", gx: 1330, ga: 0.48, hz: 624, haze: "#1a4858", fg: "#02070a", seed: 3.3 },
  { id: "youtube", type: "dunes", sky: ["#060302", "#1c0c06", "#582311"], glow: "#ff8c4a", gx: 1470, ga: 0.58, hz: 622, haze: "#682b17", fg: "#060302", seed: 11.4 },
  { id: "steam", type: "mist", sky: ["#03050a", "#0e1722", "#334c64"], glow: "#b8d6f0", gx: 1250, ga: 0.34, hz: 560, haze: "#283a4e", fg: "#03050a", seed: 4.8 },
  { id: "playnite", type: "dunes", sky: ["#020605", "#091c17", "#205646"], glow: "#80e2bf", gx: 1410, ga: 0.4, hz: 632, haze: "#1a483c", fg: "#020504", seed: 6.6 },
  { id: "appleMusic", type: "dunes", sky: ["#070205", "#1c0911", "#581a35"], glow: "#ff7ca2", gx: 1310, ga: 0.5, hz: 602, haze: "#581d37", fg: "#060204", seed: 9.9 },
];

const hex = (h: string): number[] => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
const mix = (a: string, b: string, t: number): string => {
  const A = hex(a);
  const B = hex(b);
  return "#" + A.map((v, k) => Math.round(v + (B[k] - v) * t).toString(16).padStart(2, "0")).join("");
};
function rng(seed: number): () => number {
  let s = Math.floor(seed * 9973) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Full-bleed 16:9 SVG (viewBox 1920x1080) for one scene. `i` only namespaces gradient ids. */
export function sceneSvg(sc: SceneParams, i = 0): string {
  const H = 1080;
  const N = 10;
  const r = rng(sc.seed);
  let defs = `<linearGradient id="sky${i}" x1="0" y1="0" x2="0" y2="${sc.hz}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${sc.sky[0]}"/><stop offset=".58" stop-color="${sc.sky[1]}"/><stop offset="1" stop-color="${sc.sky[2]}"/></linearGradient>
    <radialGradient id="g${i}"><stop offset="0" stop-color="${sc.glow}" stop-opacity="${sc.ga}"/><stop offset=".32" stop-color="${sc.glow}" stop-opacity="${sc.ga * 0.32}"/><stop offset="1" stop-color="${sc.glow}" stop-opacity="0"/></radialGradient>
    <radialGradient id="c${i}"><stop offset="0" stop-color="#fff6ea" stop-opacity="${sc.ga * 0.9}"/><stop offset=".4" stop-color="${sc.glow}" stop-opacity="${sc.ga * 0.4}"/><stop offset="1" stop-color="${sc.glow}" stop-opacity="0"/></radialGradient>`;
  const hazeL = mix(sc.haze, sc.sky[2], 0.5);
  defs += `<linearGradient id="h${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hazeL}" stop-opacity="0"/><stop offset=".12" stop-color="${hazeL}"/></linearGradient>`;
  let body = `<rect width="1920" height="1080" fill="url(#sky${i})"/><rect y="${sc.hz - 40}" width="1920" height="${H - sc.hz + 40}" fill="url(#h${i})"/>`;
  if (sc.stars) {
    for (let k = 0; k < 70; k++) {
      body += `<circle cx="${(r() * 1920).toFixed(0)}" cy="${(r() * sc.hz * 0.62).toFixed(0)}" r="${(0.6 + r() * 1.1).toFixed(2)}" fill="#dfe8ff" opacity="${(0.15 + r() * 0.45).toFixed(2)}"/>`;
    }
  }
  // Long, soft atmospheric streaks (cinematic haze rather than clouds-as-clipart).
  for (let k = 0; k < 5; k++) {
    const cy = sc.hz - 60 - r() * 300;
    const cx = sc.gx + (r() - 0.6) * 900;
    body += `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${(500 + r() * 500).toFixed(0)}" ry="${(14 + r() * 26).toFixed(0)}" fill="url(#g${i})" opacity="${(0.25 + r() * 0.3).toFixed(2)}"/>`;
  }
  body += `<ellipse cx="${sc.gx}" cy="${sc.hz}" rx="1000" ry="460" fill="url(#g${i})"/><ellipse cx="${sc.gx}" cy="${sc.hz}" rx="320" ry="120" fill="url(#c${i})"/>`;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const base = sc.hz + (H - sc.hz) * Math.pow(t, 1.4) * 1.02 - 6;
    const amp = sc.type === "sea" ? 1.2 + 2 * t : sc.type === "mist" ? 30 + 90 * Math.pow(t, 1.2) : 4 + 120 * Math.pow(t, 1.35);
    const f = 0.0011 + 0.0024 * (1 - t);
    const p1 = r() * 6.28;
    const p2 = r() * 6.28;
    const p3 = r() * 6.28;
    const col = mix(hazeL, sc.fg, Math.pow(t, 0.62));
    const rim = mix(col, sc.glow, 0.3 * (1 - t) + 0.07);
    let d = `M-20 ${H} `;
    for (let x = -20; x <= 1940; x += 16) {
      const n = 0.5 + 0.5 * (0.56 * Math.sin(x * f + p1) + 0.3 * Math.sin(x * f * 2.17 + p2) + 0.14 * Math.sin(x * f * 4.9 + p3));
      d += `L${x} ${(base - amp * n).toFixed(1)} `;
    }
    d += `L1940 ${H} Z`;
    defs += `<linearGradient id="s${i}_${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${rim}"/><stop offset="${(0.06 + 0.18 * t).toFixed(2)}" stop-color="${col}"/></linearGradient>`;
    body += `<path d="${d}" fill="url(#s${i}_${k})"/>`;
    if (sc.type === "mist" && k < N - 2) {
      body += `<rect x="0" y="${(base - 40).toFixed(0)}" width="1920" height="90" fill="${sc.glow}" opacity="${(0.05 * (1 - t)).toFixed(3)}"/>`;
    }
  }
  if (sc.type === "sea") {
    for (let j = 0; j < 22; j++) {
      const y = sc.hz + 5 + j * j * 0.5;
      const w = 300 - j * 11 + r() * 50;
      const x = sc.gx - w / 2 + (r() - 0.5) * 40;
      body += `<rect x="${x.toFixed(0)}" y="${y.toFixed(1)}" width="${w.toFixed(0)}" height="${(1.4 + j * 0.16).toFixed(1)}" rx="1" fill="${sc.glow}" opacity="${(0.22 * Math.pow(1 - j / 22, 1.6)).toFixed(3)}"/>`;
    }
  }
  body += `<ellipse cx="${sc.gx}" cy="${sc.hz + 20}" rx="900" ry="200" fill="url(#g${i})" opacity=".35"/>`;
  return `<svg viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${body}</svg>`;
}
