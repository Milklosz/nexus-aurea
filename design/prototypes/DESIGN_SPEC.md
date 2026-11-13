# VELORA 2.0 — Home design spec: "Cinema Minimal"

Reference implementation: `design/prototypes/a-cinema-minimal.html` (open it next to this file —
every value below is the value used there). Screenshots: `shots/a-cinema-minimal-*.jpg`.

All dimensions are in **reference px (rpx) on a 1920×1080 canvas**. 1 rpx = 1 CSS px at 1080p and
2 physical px at 4K. Language of all UI copy: Polish (strings given verbatim).

---

## 1. Principles (apply when something here is ambiguous)

1. The focused app is the hero. Nothing else on Home may be larger or brighter than its name.
2. Every visible element maps to a working feature. If it does not help the user choose, open, or
   orient (time/weather), it does not belong on Home.
3. Only `transform` and `opacity` animate. No blur, no `backdrop-filter`, no animated
   `box-shadow`/`filter`/`width`/`top`. (WebView2 runs with GPU compositing disabled.)
4. Minimum text size 20 rpx; body/context 24-26 rpx. No letter-spaced uppercase, ever.
5. Focus is always visible and always in exactly one place.

---

## 2. Scaling strategy

```css
html { font-size: calc(10 * min(100vw / 1920, 100vh / 1080)); }  /* 1rem = 10 rpx */
```

- Author every size in `rem` = rpx / 10 (e.g. 72 rpx → `7.2rem`, 20 rpx → `2rem`).
- Works regardless of Windows display scaling (100% at 4K → viewport 3840 → 1rem = 20 CSS px;
  200% at 4K → viewport 1920 → 1rem = 10 CSS px; same physical result).
- `min()` keeps 16:9 content inside the screen on any other aspect ratio (letterboxed by the
  background, which is always full-bleed with `preserveAspectRatio="xMidYMid slice"` / `object-fit: cover`).
- Do not use `vw`/`vh` directly for layout; do not use `px` except 1px hairlines.
- Remove the old `body { min-width: 780px }`, `clamp()` sizes and the `@media (max-width/height)` blocks.

---

## 3. Design tokens

### 3.1 Colour

```css
:root {
  color-scheme: dark;
  /* surfaces */
  --bg:            #050506;                    /* page behind everything */
  --plate:         rgba(12, 12, 14, .64);      /* idle dock tile */
  --plate-line:    rgba(255, 255, 255, .12);   /* 1px inset hairline on idle tile */
  --plate-sel:     rgba(243, 240, 234, .18);   /* tile that is selected but not focused */
  --action-bg:     rgba(255, 255, 255, .07);   /* idle top-bar pill */
  --sheet-bg:      #0D0D0F;                    /* Control Center sheet (opaque) */
  --sheet-scrim:   rgba(0, 0, 0, .55);
  /* text */
  --ink:           #F3F0EA;                    /* primary text, warm white */
  --ink-2:         rgba(243, 240, 234, .80);   /* secondary: context line, weather, idle actions */
  --ink-3:         rgba(243, 240, 234, .62);   /* tertiary: sheet values, hints (≥ 20 rpx only) */
  /* focus */
  --focus-bg:      #F3F0EA;                    /* focused tile / pill / row surface */
  --focus-ink:     #121214;                    /* text on focus surface */
  --focus-ink-2:   rgba(18, 18, 20, .66);      /* secondary text on focus surface */
}
```

Contrast (measured against the darkest realistic backdrop under the scrims, ≈ #0B0B0C):

| Pair | Ratio | Use |
|---|---|---|
| `--ink` on #0B0B0C | ≈ 17:1 | titles, clock |
| `--ink-2` on #0B0B0C | ≈ 11:1 | context, weather |
| `--ink-3` on `--sheet-bg` | ≈ 6.5:1 | sheet values (≥ 20 rpx) |
| `--focus-ink` on `--focus-bg` | ≈ 16:1 | focused tile text |
| every `accentOnLight` on `--focus-bg` | 4.9–6.9:1 | accent part of focused wordmark |
| every `accent` on idle plate | 5.2–8:1 | accent part of idle wordmark |

Per-app accents (wordmark accent glyph only — never borders, glows or backgrounds):

| id | accent (on dark) | accentOnLight (on focus plate) |
|---|---|---|
| netflix | `#F0484E` | `#C8161E` |
| disney | `#7AA6FF` | `#1F54C9` |
| max | `#9A9AFF` | `#4338CA` |
| prime | `#5CC8F2` | `#0B6E99` |
| youtube | `#FF5D52` | `#CC1A10` |
| steam | `#9CCDF0` | `#1D5E8C` |
| playnite | `#C6A8FF` | `#6B3FD0` |
| appleMusic | `#FF7088` | `#C41E44` |

There is no light theme for Home (it is a cinema surface). `color-scheme: dark` stays.

### 3.2 Spacing scale (rpx)

`4 · 8 · 12 · 16 · 20 · 24 · 28 · 32 · 40 · 48 · 56 · 64 · 72 · 96`
Tokens: `--s-1: .4rem … --s-96: 9.6rem`. No other values on Home except the component sizes in §5.

### 3.3 Typography

Font stack (system fonts only, nothing downloaded):

```css
--font: "Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
```

`-webkit-font-smoothing: antialiased`. Numbers in the clock: `font-variant-numeric: tabular-nums`.

| Token | Size / line-height (rpx) | Weight | Tracking | Use |
|---|---|---|---|---|
| `title` | 72 / 72 | 600 | -0.025em | focused app name |
| `clock` | 44 / 56 | 500 | -0.01em | 24h clock |
| `wordmark` | 26 / 26 | 600 (light part 350) | -0.012em | dock tiles |
| `context` | 26 / 34 | 400 | 0 | line under title |
| `weather` | 24 / 32 | 400 (temperature 600, `--ink`) | 0 | top bar |
| `sheet-title` | 40 / 48 | 600 | -0.02em | Control Center heading |
| `row-label` | 26 / 34 | 500 | 0 | Control Center rows |
| `label` | 22 / 28 | 500 | 0 | top-bar pills, toast |
| `small` | 20 / 28 | 400 | 0 | row values, hints — the floor |

### 3.4 Radii

`--r-tile: 1.4rem` (14) · `--r-row: 1.6rem` (16) · `--r-pill: 2.8rem` (28, = full height of 56 pill).

### 3.5 Elevation

Exactly one shadow exists: the focused tile's `0 1.8rem 3.6rem rgba(0,0,0,.55)`, drawn on a
`::after` pseudo-element that is always present and only changes `opacity` (0 → 1). No glows.

### 3.6 Motion

```css
--ease-out: cubic-bezier(.2, .8, .2, 1);   /* everything that moves */
--ease-std: cubic-bezier(.4, 0, .2, 1);    /* fades, crossfades */
```

| Interaction | Property | Duration | Easing | Notes |
|---|---|---|---|---|
| Tile focus in/out | transform | 220ms | ease-out | translateY(-0.8rem) scale(1.08) |
| Tile surface swap | background-color | 140ms | linear | small element, one repaint |
| Focus shadow | opacity | 220ms | linear | pseudo-element |
| Press (Cross down) | transform | 90ms | ease-out | translateY(-0.4rem) scale(1.04) |
| Title/context exit | opacity, translateX(∓2.4rem) | 110ms | ease-out | against travel direction |
| Title/context enter | opacity, translateX(±2.4rem → 0) | 240ms | ease-out | from travel side |
| Edge bump | translateX(±0.8rem) and back | 260ms | ease-out | on the dock container |
| Scene crossfade | opacity | 700ms | ease-std | after 220ms debounce |
| Scene settle | transform scale(1.03 → 1) | 1400ms | ease-out | incoming layer only |
| Top pill / sheet row focus | transform scale(1.06 / 1.02) | 220ms | ease-out | |
| Control Center open/close | transform translateX(100% ↔ 0) | 320ms | ease-out | + scrim opacity 260ms linear |
| Toast in/out | opacity 200ms linear + translateY(-1.2rem → 0) 240ms | | ease-out | visible 2600ms |
| Launching sweep | translateX loop | 1200ms, infinite | ease-std | 35%-wide segment |

**Reduced motion** (`@media (prefers-reduced-motion: reduce)` and a VELORA setting that forces it):
no scale/translate anywhere (focus = surface swap only), no title movement (instant text swap),
no bump, no scene settle, scene crossfade 120ms, sheet appears with 120ms opacity only, launching
segment static at 35% with "Otwieranie…" text.

---

## 4. Layout grid & safe areas

```
 ┌──────────────────────────────────────────────────────────────── 1920 ─┐
 │ 64 top safe                                                           │
 │ 96 ┌ clock 44 · weather 24 ───────────────── [Szukaj][Pilot][Ustawienia] ┐ 96
 │    └────────────────────────── top bar, height 56 ───────────────────┘ │
 │                                                                       │
 │                      (scene art — no UI)                              │
 │                                                                       │
 │ 96 Title 72                                         ← bottom 224      │
 │    Context 26 (margin-top 18)                                         │
 │    [tile][tile][tile][tile][tile][tile][tile][tile]  ← 8×176 + 7×20 = 1548
 │ 72 bottom safe                                                        │
 └───────────────────────────────────────────────────────────────────────┘
```

- Safe area: left/right **96** (5.0%), top **64** (5.9%), bottom **72** (6.7%). Nothing focusable or
  textual outside it; only the background bleeds. (TV should run with overscan off; the margins
  cover TVs that do not.)
- Top bar: `top: 64; left: 96; right: 96; height: 56`; flex, `align-items: center`,
  `justify-content: space-between`.
- Info block: `left: 96; bottom: 224; max-width: 1100`.
- Dock: `left: 96; bottom: 72`; flex, `gap: 20`. Left-anchored; the 276 rpx to the right of it stay
  empty on purpose (asymmetry; the scene's light lives there). Never centre it.
- Control Center sheet: `top: 0; right: 0; bottom: 0; width: 660`; padding `64 96 72 56`.

---

## 5. Home elements

### 5.1 Background / art layer (`<SceneLayer activeId>`)

- Stack (bottom → top): scene layer(s) → scrim → grain → UI.
- **Scenes** are original, generated by the `sceneSVG(params)` function in the prototype
  (deterministic seeds → identical output every build). In production generate them at build time
  and **pre-rasterise to WebP 3840×2160** (`src/assets/scenes/<id>.webp`, quality ~80); decode all 8
  at startup (`new Image(); img.decode()`), render as `<img>` with `object-fit: cover`. Never
  rasterise SVG with 20+ gradients at runtime on a focus change.
- Scene parameters (from the prototype, `SCENES` array, index = dock order):

| app | type | sky top → mid → horizon | glow | glow x | glow α | horizon y | haze → foreground |
|---|---|---|---|---|---|---|---|
| Netflix | dunes | #050506 → #13080a → #3a1214 | #ff6a4a | 1380 | .55 | 612 | #5a1e1c → #050404 |
| Disney+ | dunes + 70 stars | #020309 → #070f28 → #1b336c | #86a8ff | 1500 | .42 | 640 | #1b2a58 → #020309 |
| HBO Max | dunes | #040309 → #110b25 → #37226c | #a586ff | 1200 | .50 | 598 | #2b1f50 → #040308 |
| Prime Video | sea (+ light path) | #020a10 → #092331 → #2b6a82 | #a8e6f4 | 1330 | .48 | 624 | #1a4858 → #02070a |
| YouTube | dunes | #060302 → #1c0c06 → #582311 | #ff8c4a | 1470 | .58 | 622 | #682b17 → #060302 |
| Steam | mist | #03050a → #0e1722 → #334c64 | #b8d6f0 | 1250 | .34 | 560 | #283a4e → #03050a |
| Playnite | dunes | #020605 → #091c17 → #205646 | #80e2bf | 1410 | .40 | 632 | #1a483c → #020504 |
| Apple Music | dunes | #070205 → #1c0911 → #581a35 | #ff7ca2 | 1310 | .50 | 602 | #581d37 → #060204 |

  Construction rules: sky linear gradient; elliptical glow (rx 1000, ry 460) + small warm core
  (rx 320, ry 120) **centred on the horizon, never a visible disc**; 5 long haze streaks
  (ry 14–40); 10 strata whose amplitude grows toward the viewer (4 → 124 rpx) and whose colour
  moves from haze to foreground (aerial perspective) with a thin rim tint toward the glow; a second,
  35%-opacity glow over the strata. Light always sits right of centre (x ≥ 1200) so the left third
  stays dark for text.
- **Scrim** (static, one element, never animated):
  ```css
  background:
    linear-gradient(90deg,  rgba(4,4,5,.66) 0%, rgba(4,4,5,.30) 36%, rgba(4,4,5,0) 60%),
    linear-gradient(0deg,   rgba(4,4,5,.88) 0%, rgba(4,4,5,.50) 24%, rgba(4,4,5,0) 50%),
    linear-gradient(180deg, rgba(4,4,5,.50) 0%, rgba(4,4,5,0) 20%);
  ```
- **Grain**: SVG `feTurbulence` (`baseFrequency .85`, 2 octaves, white, alpha .55) as a 220-rpx
  tiled `background-image`, layer opacity **.07**. Static. (May also be baked into the WebP.)
- **Crossfade per focused app**: exactly **two** slots (`current`, `next`). On dock focus change,
  wait **220ms** (debounce: rapid scrubbing never starts a fade); put the new image in the hidden
  slot, then toggle `.on` (opacity 0→1, 700ms; incoming scale 1.03→1, 1400ms); when done, the old
  slot becomes the hidden one. If focus changes mid-fade, retarget the hidden slot — never stack a
  third layer. Focus moving to the top bar or the sheet does **not** change the scene (scene follows
  the *selected* app).
- Performance fallback (decide after profiling on the target PC at 4K): if the crossfade drops
  frames, (1) shorten to 400ms, then (2) drop the settle scale, then (3) instant swap with a 160ms
  fade of the outgoing layer only. The scene must never block input.

### 5.2 Top bar (`<TopBar>` — replaces `StatusBar`)

- **Left, baseline-aligned row, gap 28:**
  - Clock: `HH:mm`, 24h, `Intl.DateTimeFormat("pl-PL", {hour:"2-digit", minute:"2-digit", hour12:false, timeZone:"Europe/Warsaw"})`; token `clock`; `--ink`. Keep the existing `useClock` subscription (re-render only the clock).
  - Weather: `2°` (600, `--ink`, margin-right 8) + `Częściowe zachmurzenie` (`--ink-2`); token
    `weather`. City name is not shown on Home (it is the only city; it lives in Control Center).
    If weather is unavailable: hide the weather span entirely (no placeholder, no dash).
- **Right: three system actions**, `gap 12`. Each is a `<button>`: height 56, padding `0 26 0 22`,
  radius 28, icon 24 (stroke 1.8, round caps, `currentColor`) + label (token `label`), gap 12,
  idle `background: --action-bg; color: --ink-2`.
  1. **Szukaj** — magnifier icon — opens Search (the existing app search / virtual keyboard flow).
  2. **Pilot** — remote icon (rounded rect, dot, two lines) — opens Control Center scrolled to and
     focused on the iPhone remote ("Pilot") section.
  3. **Ustawienia** — two-sliders icon — opens Control Center focused on its first general item.
- Nothing else in the top bar: no VELORA wordmark, no "Entertainment OS", no version, no
  "Control Center F3" chip.

### 5.3 Focus info (`<FocusInfo>` — replaces `HeroPanel` and the side `focus-panel`)

- Title = `service.name` (e.g. "HBO Max"), token `title`, `--ink`, `margin: 0`.
- Context line (token `context`, `--ink-2`, `margin-top 18`): `{category}<sep>{launch mode}` where
  `<sep>` is a "·" at 50% opacity with 10 rpx side margins.

| app | category | launch mode |
|---|---|---|
| Netflix | Filmy i seriale | Okno Edge Cinema |
| Disney+ | Filmy, seriale i animacje | Okno Edge Cinema |
| HBO Max | Filmy i seriale | Okno Edge Cinema |
| Prime Video | Filmy, seriale i sport | Okno Edge Cinema |
| YouTube | Wideo | Okno Edge Cinema |
| Steam | Gry | Steam Big Picture |
| Playnite | Biblioteka gier | Pełny ekran Playnite |
| Apple Music | Muzyka | Aplikacja Windows |

- State overrides of the context line: launching → `Otwieranie…`; not installed →
  `Nie wykryto instalacji · wybierz, aby zobaczyć pomoc`.
- `aria-live="polite"` on the block. It always describes the **selected** dock app, also while
  focus is in the top bar.
- Change animation: see §3.6 (direction = +1 when moving right, -1 when moving left). A change that
  only toggles launching/missing text on the same app swaps instantly (no motion).

### 5.4 Dock (`<AppDock>`)

- `<nav aria-label="Aplikacje">` containing 8 `<button>` tiles in this order:
  **Netflix, Disney+, HBO Max (id `max`), Prime Video, YouTube, Steam, Playnite, Apple Music.**
  (Add `playnite` to `streamingServices` as a managed app; move `appleMusic` to the end.)
- Tile: 176 × 100, radius 14, `background: --plate`, `box-shadow: inset 0 0 0 1px --plate-line`,
  content centred (`display: grid; place-items: center`). No caption under the tile, no icon, no
  status badge. `aria-label="Otwórz {name}"`.
- No dock container surface (no glass bar, no border, no caption "TWOJE APLIKACJE").

### 5.5 Wordmarks (original, type-only)

Rule: the service name in the system font, token `wordmark`, `--ink`; exactly **one distinctive
part** carries the service accent (`accent` on idle, `accentOnLight` when focused). "Light" parts
use weight 350. No logos, symbols, icons, outlines or imitation shapes.

| app | Markup (`.a` = accent, `.l` = weight 350) | Reads as |
|---|---|---|
| Netflix | `<i class="a">Netflix</i>` | **Netflix** entirely in red accent |
| Disney+ | `Disney<i class="a l">+</i>` | Disney + light blue "+" |
| HBO Max | `HBO <i class="a l">Max</i>` | bold "HBO", light violet "Max" |
| Prime Video | `prime <i class="a l">video</i>` | bold lowercase "prime", light cyan "video" |
| YouTube | `<i class="l">You</i><i class="a">Tube</i>` | light "You", bold red "Tube" |
| Steam | `<i class="a">Steam</i>` | **Steam** entirely in steel blue |
| Playnite | `Play<i class="a">nite</i>` | "Play" ink, "nite" violet |
| Apple Music | `<i class="l">Apple</i> <i class="a">Music</i>` | light "Apple", bold rose "Music" |

`i { font-style: normal }`. Single line, `white-space: nowrap`. Longest ("Apple Music",
"prime video") ≈ 140 rpx inside a 176 tile — fits at 1.08 scale with ≥ 14 rpx side room.

### 5.6 Control Center entry (sheet) — Home's view of it only

Home opens the existing Control Center as a right-hand sheet (660 wide, `--sheet-bg`, inset 1px
`rgba(255,255,255,.08)` left edge, scrim `--sheet-scrim` over Home). Heading "Ustawienia"
(`sheet-title`, margin-bottom 32). Rows: padding `20 24`, radius 16, gap 8; label `row-label`,
value `small` `--ink-3`. **Pilot is a row** ("Pilot" / "iPhone · otwórz velora.local w Safari").
Footer hint `○ / Esc  Zamknij` (`small`, `--ink-3`), pinned to the bottom. The diagnostics
("Diagnostyka pada") and other system features move **into** Control Center — none of them appear
on Home.

### 5.7 Toast

Top-centre at `top: 64`, height auto, padding `14 26`, radius 28, `--focus-bg` / `--focus-ink`,
token `label`, single line. 2600ms visible. Used for: search placeholder, launch failure,
"Nie wykryto aplikacji {name}. Zainstaluj ją w Windows.", Playnite-exit notice.

---

## 6. States

### 6.1 Dock tile

| State | Trigger | Visual |
|---|---|---|
| idle | default | `--plate`, hairline, wordmark `--ink` + `accent` |
| **focused** | focus in dock on this tile | `background: --focus-bg`, no hairline, `transform: translateY(-.8rem) scale(1.08)`, wordmark `--focus-ink` + `accentOnLight`, shadow pseudo opacity 1, `z-index: 2` |
| selected (unfocused) | focus is in top bar or sheet; this is the remembered tile | `background: --plate-sel`, no transform |
| pressed | Cross/Enter down while focused | `translateY(-.4rem) scale(1.04)`, 90ms; activation fires on **release** |
| launching | after activation until the launcher reports the window shown / failed | wordmark opacity .55; 4-rpx track at `bottom 12, left/right 16`, 16% ink; 35%-wide segment sweeping (1200ms loop); context "Otwieranie…"; further presses on this tile ignored; other tiles stay navigable. Timeout 15s → reset + toast "Nie udało się otworzyć {name}." |
| not installed ("disabled") | managed app not detected | wordmark opacity .42 (.50 when focused); context "Nie wykryto instalacji · …"; **still focusable** (never skipped); Cross → toast with install hint |
| error | launch failed | reset to idle/focused + toast with the error string from the launcher |

### 6.2 Top-bar action

idle: `--action-bg`, `--ink-2` · **focused**: `--focus-bg`, `--focus-ink`, `scale(1.06)` ·
pressed: `scale(1.02)` 90ms · disabled (e.g. search unavailable): opacity .4, still focusable,
Cross → toast explaining why.

### 6.3 Control Center row

idle: transparent · **focused**: `--focus-bg`, `--focus-ink`, value `--focus-ink-2`, `scale(1.02)`.

Focus rendering must be driven by app state (`data-focused` / class), not by `:focus`/`:hover`, so
gamepad, keyboard, iPhone remote and mouse all produce identical visuals. Call
`button.focus({ preventScroll: true })` on the focused element for accessibility, but style from state.

---

## 7. Navigation (vertical zones)

Zones on Home, top to bottom: **Z1 top actions (3)** → **Z2 dock (8)**. There is no focusable
bottom zone on Home (the old footer legend is removed).

| Input (DS4 / keyboard / iPhone remote) | In Z2 dock | In Z1 top actions | Sheet open |
|---|---|---|---|
| ← / → | ±1 tile; at an end: no move + 260ms bump | ±1 action; at an end: nothing | — |
| ↑ | go to Z1, restore last Z1 index (default 0 = Szukaj) | nothing | previous row (clamp) |
| ↓ | nothing | go to Z2, restore remembered tile | next row (clamp) |
| Cross / Enter / Space | press → launch on release | activate action | activate row |
| Circle / Esc / Backspace | nothing (Home is root) | return to Z2 | close sheet, restore previous focus |
| Options / F3 | open Control Center | open Control Center | close sheet |

- **Memory:** each zone remembers its index for the session; returning from a launched app focuses
  the tile that was launched.
- **No wrap** anywhere. **No focus traps:** Circle always has a defined exit; the sheet returns
  focus to the element that opened it.
- **Repeat:** held D-pad / held arrow = first move immediately, repeat after 420ms, then every
  110ms, every 70ms after the 4th repeat. Keyboard auto-repeat is accepted as-is.
- **Initial focus** on Home mount: dock tile 0 (Netflix) or the last launched tile.
- **Mouse** (fallback only): click on any element = focus + activate; there are no hover-only
  affordances; hide the cursor after 2s of no mouse movement.
- **Remote (iPhone, LAN):** sends the same logical commands (`up/down/left/right/select/back/menu`)
  into the same handler; no special UI on Home.

---

## 8. React/CSS implementation notes

- Components: `HomeScreen` = `SceneLayer` + `Scrim` + `Grain` + `TopBar` (`Clock`, `Weather`,
  `SystemActions`) + `FocusInfo` + `AppDock` + `Toast` (+ existing `ControlCenter` restyled as §5.6).
- Delete from Home: `HeroPanel`, `.focus-panel`, `.dock-caption`, `footer.controls`, `.sun`,
  `.ridge`, `.quick-settings-trigger`, `.diagnostics-trigger`, brand wordmark/edition.
- Extend service data with: `category`, `launchMode`, `accent`, `accentOnLight`, `wordmark`
  (structured parts, not HTML strings), and `scene` (asset id).
- Focus state lives in the existing navigation hook; add `zone: "top" | "dock"`, `topIndex`, and
  `direction` (last horizontal move) for `FocusInfo`'s enter/exit classes.
- Keep `will-change: transform` only on the dock tiles and the two scene slots; nowhere else.
- The clock re-render must stay isolated (as today) so the dock never re-renders every second.

---

## 9. Explicitly do NOT

- Letter-spaced uppercase labels, eyebrows, "kickers", captions like "TWOJE APLIKACJE".
- A marketing headline ("Wybierz rozrywkę") or any text that does not describe the focused app.
- Glass: `backdrop-filter`, blurred panels, frosted dock bars.
- Gold, champagne or coloured borders; glowing/neon focus; animated `box-shadow`.
- Brand logos or look-alikes (red serif "N", play-button rectangle, Apple glyph, ∞, ♫).
- A sun disc, jagged polygon mountains, flat rectangles cutting through the art, stock waves.
- A second panel describing the focused app; cards inside cards; badges, counters, "LIVE" dots.
- A keyboard-shortcut legend, version number or studio credit on Home.
- Wrap-around navigation; skipping disabled tiles; hover-only actions.
- Centring the dock or making it full-width.
- Any text under 20 rpx, or `--ink-3` on anything but the opaque sheet.
- Animating anything other than `transform`/`opacity`; more than two scene layers in the DOM.
