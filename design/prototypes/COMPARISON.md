# VELORA 2.0 — Home: four directions compared

All four prototypes are self-contained HTML files in this folder (no network, no build).
Open in Edge, use arrow keys / Enter / Esc / F3, or a DualShock 4 (Gamepad API: D-pad, Cross,
Circle, Options; D also uses L1/R1). Each one has the same content: 8 apps (Netflix, Disney+,
HBO Max, Prime Video, YouTube, Steam, Playnite, Apple Music), a live 24h Europe/Warsaw clock,
"2° Częściowe zachmurzenie", Szukaj, Pilot, Ustawienia (opens a Control Center with Pilot as its
first entry), a launching state, and a background that crossfades per focused app. All art is
generated in code (SVG gradients/paths + SVG-noise grain); no logos, posters or downloaded artwork.

Screenshots: `shots/` — `<name>-1080.jpg`, `<name>-2160.jpg` (4K, same layout at 2x),
`-focus3-1080` (Prime Video focused), `-top-1080` / `-system-1080` (system actions focused),
`-cc-1080` (Control Center), `-launch-1080` (Steam launching), `a-…-missing-1080` (app not installed).

---

## 0. Why the baseline reads as "AI-generated"

Looking at `design/baseline/home-1080.jpg` and `src/styles.css`:

1. **Letter-spaced micro-caps everywhere.** `V E L O R A`, `ENTERTAINMENT OS`, `GRAND CINEMA · VELORA BY
   MILKLOSH STUDIO`, `TWOJE APLIKACJE`, `WYBRANA APLIKACJA`, the footer — 9-11px with .2-.34em
   tracking. It is the single most recognisable template tell, and it is unreadable at 3 m
   (10px at 1080 = ~2.2 mm on a 49" panel).
2. **A headline with no content.** "Wybierz rozrywkę" / "Otwórz usługę z docka…" tells the user
   what they already know; it occupies the most valuable area of the screen and says nothing about
   what is focused.
3. **Clip-art landscape.** Two jagged `clip-path` polygons plus a blurred sun disc, *and* a flat
   rectangle (`.ridge`) whose straight edges cut across the art (visible as the hard box behind the
   headline in the screenshot). It reads as a stock vector placeholder.
4. **Gold-bordered glass dock + glowing focus box.** `backdrop-filter: blur(26px)`, gold 0.9-alpha
   border, `box-shadow` glow — the "luxury" signifiers of generic dashboards, and the most expensive
   things you can ask a WebView with GPU compositing disabled to do.
5. **Fake brand marks.** A serif red "N", a "▶" in a red rounded rectangle, "♫", "∞" for Steam,
   "prime/video" stacked — imitations that are neither the real logos nor an original system.
6. **Redundant side panel.** "WYBRANA APLIKACJA / Netflix / OFICJALNA STRONA…" repeats the focused
   tile in 9-10px text — a card next to a dock of cards.
7. **Decorative clutter.** Keyboard legend with F2/F11/ESC on a TV, version string, "by Milklosh
   Studio" twice, a "Control Center F3" debug-looking chip top-left, "Diagnostyka pada" button.
8. **No hierarchy.** Brand, headline, dock caption, dock, panel and footer all compete; the focused
   app — the only thing that matters — is a 10px label inside a tile.

Every direction below removes all eight problems; they differ in how they rebuild hierarchy.

---

## A — Cinema Minimal  (`a-cinema-minimal.html`)  ★ recommended

- **Rationale.** The screen is a film frame. A full-bleed, code-generated atmospheric horizon (10
  soft strata with aerial-perspective colour, a diffuse light, long haze streaks, grain) fills the
  TV; UI occupies a thin top line and the lower-left third. The "hero" is the focused app itself.
- **Home layout.** Top line: clock + weather (left), Szukaj · Pilot · Ustawienia pills (right).
  Lower-left: app name 72px + one functional context line ("Filmy i seriale · Okno Edge Cinema").
  Dock: 8 dark plates 176×100 in a left-anchored row (1548px), leaving the right 276px open —
  deliberate asymmetry, the light of the scene sits there.
- **Typography.** Segoe UI Variable Display. 72/600 title, 44/500 tabular clock, 26 wordmarks and
  context, 22-24 everything else. No uppercase tracking anywhere.
- **Palette.** Warm white ink `#F3F0EA` on near-black scrims; per-app colour lives only in the
  scene and one accent glyph per wordmark.
- **Navigation model.** Two zones (top actions / dock); Up/Down switch with memory per zone;
  Left/Right no wrap with an 8px edge "bump"; F3/Options → Control Center sheet from the right;
  Circle/Esc closes and returns focus.
- **Focus.** Inverted plate (solid warm white, dark text, accent switches to its on-light
  variant), lift 8px, scale 1.08, pre-baked shadow faded in. Selected-but-unfocused tile keeps a
  light plate so the place is never lost.
- **Motion.** 220ms focus; directional title "page turn" (110 out / 240 in, borrowed from B);
  scene crossfade 700ms + 1.03→1 settle, debounced 220ms.
- **Visual risks.** Inverted white plate is close to the tvOS idiom (accepted: it is the clearest
  focus signal at 3 m; no layout or artwork copied). Landscape art could drift back to "mountains +
  sun" if strata get sharp — the spec forbids discs and hard ridges. Scenes share one composition;
  variety is palette/horizon/texture only.
- **Feasibility.** High. Static SVG scenes (or pre-rendered WebP), two mounted layers, one
  full-screen opacity crossfade (the most expensive operation — hence debounce and 700ms cap).

## B — Editorial Entertainment  (`b-editorial-entertainment.html`)

- **Rationale.** A magazine spread. Left page: typography on warm ink paper. Right page: a
  912×812 "plate" of original modernist poster art, one motif per service (curtain, night arc,
  monolith, tide, ripples, vapour, stacked spines, grooves). The dock becomes a typographic index.
- **Home layout.** Masthead: 56px serif clock | date + weather + "Zabrze". Headline (Sitka Banner
  168px) with "03 / 08" kicker, deck line, "✕ Otwórz" cue. Index of 8 columns across the foot with
  hairline rules. Long names deliberately cross the gutter onto the plate.
- **Typography.** Sitka (system variable serif with optical sizes) for display, Segoe UI Variable
  Text for UI. Strongest typographic hierarchy of the four.
- **Palette.** Paper `#13110F`, ink `#EFE9DF`, muted `#9F978B`, hairline rules 18% ink; accent per
  service on its rule and numeral.
- **Navigation.** Masthead actions ↔ index; Up picks the spatially nearest action; no wrap.
- **Focus.** 8px accent rule (scaleY from a 2px hairline), name at full ink scaled 1.12, others
  56% ink. No filled surface — the weakest focus affordance of the four at 3 m (the headline
  compensates).
- **Motion.** Directional page turn of the headline; plate crossfade 600ms.
- **Risks.** Serif on a TV OS is unusual and can feel like a website; index focus is subtle;
  Sitka must be present (it is on this PC: `SitkaVF.ttf`).
- **Feasibility.** High; the plate is smaller than full screen, so its crossfade is the cheapest.

## C — Quiet Luxury  (`c-quiet-luxury.html`)

- **Rationale.** A dark room: graphite wall, floor line, two soft light shafts whose colour
  temperature follows the focused service. Tiles sit on the floor line like objects on a shelf.
  Services are two-letter monograms (Nf, D⁺, HM, Pv, Yt, St, Pn, Am) with full names beneath.
- **Home layout.** Top-left: 64px light clock, weather. Upper two thirds: only light. Centred dock
  of 152px matte squares; one centred context line; a quiet system row (Szukaj · Pilot ·
  Ustawienia) below it.
- **Typography.** Segoe UI Variable Display light weights for scale, Text for labels (22px names).
- **Palette.** Graphite, matte tile gradient, champagne focus ring `#E6D8BC`, 8px accent dot.
- **Navigation.** Different model: the top is ambient (not focusable); dock → Down → system row.
  All focusable things in one lower band; never more than 2 presses vertically.
- **Focus.** Scale 1.10, surface brightens, 3px champagne ring 9px outside (pre-drawn, opacity).
- **Motion.** Unhurried: 280ms, no overshoot; light crossfade 900ms.
- **Risks.** Low-contrast art depends heavily on the panel's black level; monograms slow
  recognition; centred dock is the most "expected" composition; the light shafts need SVG blur →
  must be pre-rendered images in production.
- **Feasibility.** Good *only* with pre-rendered light images.

## D — Modern Media Console  (`d-media-console.html`)

- **Rationale.** Controller first. 320×200 tiles on a rail whose focus stays anchored at the left
  safe edge while content slides; big hero name in Bahnschrift semi-condensed; permanent button
  legend (✕ Otwórz · ○ Wstecz · OPTIONS Menu); background tint follows the focused tile.
- **Home layout.** 72px-tall pills top-left, weather + clock top-right, hero 112px, rail with
  peeking off-screen tiles, legend bottom-left. Options raises a 4-card Quick Menu from the bottom.
- **Typography.** Bahnschrift (system DIN-style variable, width axis) for display + wordmarks;
  Segoe UI Variable Text for UI.
- **Navigation.** Top pills → rail → non-focusable legend; L1/R1 jump 4; held D-pad accelerates.
- **Focus.** 4px white ring + scale 1.12 from the left edge; following tiles slide 40px; unfocused
  tiles dimmed 26%. The most legible focus of the four.
- **Motion.** Snappy console tempo: 180-260ms, rail rubber-band at ends.
- **Risks.** Looks closest to existing consoles (PS5/Xbox dashboards) — weakest identity, risk of
  "generic gaming dashboard"; tinted tiles drift toward "grid of cards"; only 5 of 8 apps visible.
- **Feasibility.** High (one translateX + per-tile transforms).

---

## Scores (1 = poor, 5 = excellent)

| Criterion (weight)                       | A Cinema Minimal | B Editorial | C Quiet Luxury | D Media Console |
|------------------------------------------|:---:|:---:|:---:|:---:|
| Living-room legibility at 2-3 m (×2)     | 5   | 4   | 3   | 5   |
| Controller fit / focus clarity (×2)      | 4.5 | 3.5 | 4   | 5   |
| Distinctiveness vs. "AI look" (×1.5)     | 4   | 5   | 3.5 | 2.5 |
| Implementation risk / feasibility (×1.5) | 4   | 4.5 | 3   | 4.5 |
| Premium feel (×2)                        | 4.5 | 4.5 | 4   | 3   |
| **Weighted total (max 45)**              | **40.0** | **38.25** | **31.75** | **36.5** |

Notes on the numbers: B wins distinctiveness and premium typography but loses where it matters
most on a TV — reading focus from the sofa. D wins controller fit but is the most generic. C is
beautiful in a calibrated room and fragile everywhere else.

---

## Recommendation: **A — Cinema Minimal**, with three ideas grafted in

`a-cinema-minimal.html` already contains the grafts; it is the reference for `DESIGN_SPEC.md`.

**Why A, decisively:**

1. **It is the only direction that is excellent at both distance and identity.** The focused app
   name at 72px and an inverted plate are readable from 3 m without hunting (D-level legibility),
   while the full-bleed generated horizon gives VELORA a recognisable, ownable atmosphere that D
   lacks. B is more original but its focus signal is a rule, not a surface.
2. **It removes the most and keeps only functional text.** Clock, weather, three actions, the
   focused app with one honest line about what happens on Cross, and the dock. Nothing decorative
   survives; every element maps to an existing feature of the real app.
3. **It is cheap where it counts on WebView2 with GPU compositing disabled.** Focus is a class swap
   with transform-only motion; the background is static raster content with a single, debounced
   opacity crossfade between two layers; zero blur, zero backdrop-filter, no animated shadows.
   It maps 1:1 onto the existing `StatusBar` / `AppDock` components.

**Grafted from the others:**

- From **B**: the directional "page-turn" of the title (exits against travel, enters from the travel
  side) — gives navigation a sense of space without moving large layers.
- From **D**: held D-pad acceleration (420ms → 110ms → 70ms after 4 repeats) and the rule that the
  Options button always opens the Control Center.
- From **C**: debounce discipline for background changes, and a persistent "selected" plate when
  focus leaves the dock (focus memory you can see).

**Known weaknesses of the recommended prototype (honest list):**

- All eight scenes share one composition (horizon + light at right); they differ by palette,
  horizon height, texture (dunes / sea / mist / stars). Over months this may feel samey; a later
  iteration could add 2-3 composition families.
- The inverted white focus plate is a familiar TV idiom; identity relies on the art and typography.
- Full-screen crossfade at 4K in software compositing has not been profiled on the target PC; the
  spec gives a fallback (instant swap + 160ms fade of a half-resolution layer).
- Wordmarks are plain type with one accent; recognition of "Playnite" and "Steam" relies on the
  name only (no icon). This is a deliberate legal/aesthetic choice.
