# AUREA Navigation v1 — nawigacja 2D i stany fokusu

Dokument opisuje obszar **D. AUREA Navigation** w VELORA 1.0 Experience. Celem jest
rozszerzenie interfejsu o nawigację 2D oraz czytelne stany fokusu dla klawiatury,
pada i iPhone Remote — bez zmiany wyglądu **AUREA Grand Cinema**.

## 1. Siatka fokusu 2D

- `resolveGridIndex(index, direction, columns, count)` w
  `src/services/aureaNavigation.ts` to czysta funkcja ruchu po siatce
  (układ wierszami, od lewej do prawej, od góry do dołu):
  - `left` / `right` poruszają się **w obrębie bieżącego wiersza** i są
    przycinane do jego granic (nie przechodzą do sąsiedniego wiersza),
  - `up` / `down` przesuwają o **cały wiersz** (`columns` pozycji) i są
    przycinane do zakresu `[0, count)`,
  - funkcja zawsze zwraca liczbę całkowitą z `[0, count)` — nigdy `NaN` ani
    wartości ujemnej; defensywnie obsługuje `count = 0`, `columns <= 0` oraz
    indeksy spoza zakresu.
- `useAureaFocusGrid(...)` (`src/hooks/useAureaFocusGrid.ts`) zakłada siatkę na
  kontenerze, którego elementy oznaczono atrybutem `data-aurea-item`. Obsługuje
  klawisze strzałek, przesuwa fokus DOM, odświeża atrybuty i rejestruje siatkę
  w jednym, globalnym rejestrze (`registerAureaGrid` / `unregisterAureaGrid` —
  **ostatnia zarejestrowana siatka wygrywa**). Przy odmontowaniu komponentu
  siatka jest wyrejestrowywana.
- `useNavigation(count, onActivate, onMenu, options?)` zachowuje pełną
  kompatybilność wsteczną. Bez `options` działa dokładnie tak jak dotychczas
  (skrót do Quick Settings, zawijanie `left/right`, `X` aktywuje, `F2` menu).
  Z opcją `{ columns }` klawisze `ArrowUp` / `ArrowDown` wykonują ruch 2D o
  wiersz zamiast skrótu do Quick Settings; `ArrowLeft` / `ArrowRight` nadal
  korzystają z `focusApp`. Opcjonalny `{ gridId }` rejestruje tę nawigację jako
  siatkę AUREA dla zdalnego fokusu 2D. Zwracany kształt obiektu
  (`moveApp`, `activeIndex`, `buttonRefs`, `focusApp`, `noteFocus`) nie uległ zmianie.

## 2. Stany fokusu per źródło

Wszystkie trzy źródła sterowania mają rozróżnialny, widoczny stan fokusu:

| Źródło | Kto ustawia `body[data-focus-source]` | Efekt w CSS |
| --- | --- | --- |
| **Klawiatura** | `useNavigation` / `useAureaFocusGrid` przy `keydown` (`keyboard`) | złota obwódka `.app:focus-visible`, pierścień `[data-focus-source="keyboard"] .app:focus` |
| **Pad** | warstwa pada (poza tym obszarem) (`gamepad`) | cieplejszy, mocniejszy pierścień `[data-focus-source="gamepad"] .app:focus` |
| **iPhone Remote** | `moveAureaFocus` (`remote`) | złoty pierścień `[data-focus-source="remote"] .app:focus` |

- `focusStateAttributes(active, source)` zwraca `data-aurea-focus`
  (`active` / `idle`), `data-focus-source` oraz `aria-current` (`"true"` tylko
  dla elementu aktywnego).
- `src/components/AppDock.tsx` dodaje na każdym przycisku `data-aurea-item`,
  `data-aurea-focus`, `data-focus-source`, `aria-current` na elemencie aktywnym
  oraz klasę `aurea-active`; przy `onFocus` (z zabezpieczeniem na brak DOM)
  synchronizuje `body.dataset.focusSource`, aby odróżnić pad / klawiaturę /
  Remote.
- Zaktualizowano nieaktualną podpowiedź: usługi `web` otwierają teraz
  **dedykowane okno Edge Cinema** („Oficjalna strona · dedykowane okno Edge Cinema”).

## 3. iPhone Remote — 2D bez zmiany `src/App.tsx`

`dispatchRemoteCommand(command, handlers)` zachowuje sygnaturę i union
`RemoteCommand`. Dodano opcjonalny handler
`navigateDirection(direction)`. Dla komend `up/down/left/right` kolejność jest
następująca:

1. `handlers.navigateDirection?.(dir)` — jeśli dostarczony (pełna kontrola,
   np. obsługa okien dialogowych),
2. inaczej `moveAureaFocus(dir)` z `./aureaNavigation` — 2D, gdy zarejestrowana
   jest siatka,
3. inaczej **istniejący** `handlers.navigate(-1)` (`up`/`left`) lub
   `handlers.navigate(1)` (`down`/`right`).

Gdy nie ma zarejestrowanej siatki lub nie ma DOM (testy Node), `moveAureaFocus`
zwraca `false` i używany jest dotychczasowy, liniowy fallback — dlatego nie
trzeba modyfikować wywołania w `src/App.tsx`. Wszelki dostęp do `document` w
`aureaNavigation.ts` jest zabezpieczony przez `typeof document === "undefined"`,
dzięki czemu import modułu nie wywala testów w środowisku Node.

## 4. Zachowany wygląd AUREA Grand Cinema

Nowe reguły w `src/styles.css` **wyłącznie dopisano na końcu pliku** — nie
zmieniono, nie usunięto ani nie przestawiono żadnej istniejącej reguły.
Nienaruszone pozostają:

- kinowe tło (`.screen` / `.sun` / `.ridge`),
- kremowa typografia (`--cream: #f5f0e7`),
- złote akcenty (`--gold: #d2b484`),
- przezroczysty, rozmyty dok (`backdrop-filter`).

Dodano jedynie złoty pierścień + subtelne uniesienie aktywnego elementu,
wzmocnioną złotą obwódkę `:focus-visible`, warianty pierścienia per źródło,
złotą obwódkę dla `.playnite-library [data-aurea-focus="active"]` oraz
`.cc-tabs button:focus-visible`. Osobny blok
`@media (prefers-reduced-motion: reduce)` wyłącza nowe przejścia.

## 5. Zakres — ważne zastrzeżenie

**VELORA nie deklaruje globalnej obsługi pada poza własnym interfejsem.**
Niniejszy obszar obejmuje wyłącznie nawigację i fokus **wewnątrz UI VELORA**
(siatka 2D, atrybuty `data-aurea-*`, stany per źródło, mapping komend Remote).
Globalne HID, natywny fokus okna, `SessionOrchestrator` / `WindowBroker` oraz
silnik kontrolera należą do **obszaru DeepSeek** i nie są tu modyfikowane ani
integrowane. Ustawienie `body[data-focus-source="gamepad"]` jest przygotowanym
punktem podłączenia — jego nadanie po stronie warstwy pada wykonuje integrator.

## 6. Checklista do sprawdzenia ręcznego na MSI (Windows)

> Do wykonania na maszynie MSI z uruchomioną aplikacją (build Tauri, Windows).
> Nie instaluj niczego dodatkowego w ramach tego obszaru.

- [ ] Ekran główny: 7 kafli doka ma atrybut `data-aurea-item`; aktywny ma
      `data-aurea-focus="active"`, `aria-current="true"` i klasę `aurea-active`.
- [ ] Klawiatura: strzałki `←`/`→` przesuwają fokus, `↑` przechodzi do Quick
      Settings (tryb legacy), `↓` wraca do doka; złota obwódka jest wyraźnie
      widoczna, `body[data-focus-source="keyboard"]`.
- [ ] Klawiatura w trybie 2D (gdy integrator poda `{ columns }`): `↑`/`↓`
      skaczą o cały wiersz i nie „uciekają" poza siatkę.
- [ ] iPhone Remote: po sparowaniu strzałki przesuwają fokus 2D, gdy siatka
      jest zarejestrowana; w przeciwnym razie działa liniowy fallback
      (brak regresji). `body[data-focus-source="remote"]` i złoty pierścień.
- [ ] Pad: po podłączeniu przez integratora fokus ma wariant
      `[data-focus-source="gamepad"]`; potwierdzić, że nie koliduje z
      globalnym HID (obszar DeepSeek).
- [ ] Control Center / Diagnostyka (`<dialog open>`): nawigacja strzałkami
      nadal działa wewnątrz okna dialogowego — integrator musi zapewnić
      `navigateDirection` albo wyrejestrować siatkę na czas otwartego dialogu
      (patrz: ryzyka w raporcie integracyjnym).
- [ ] Podpowiedź usług `web` wyświetla „Oficjalna strona · dedykowane okno
      Edge Cinema" i otwiera dedykowane okno Edge Cinema.
- [ ] Wygląd: tło kinowe, kremowy tekst, złote akcenty i przezroczysty dok
      wyglądają identycznie jak przed zmianą (brak przesunięć / zmian kolorów).
- [ ] `prefers-reduced-motion: reduce`: nowe animacje fokusu są wyłączone.
- [ ] Stany „uruchamianie w toku" / „Uruchamiam Steam… Poczekaj chwilę."
      oraz komunikaty panelu fokusu pozostały niezmienione.

## 7. Co musi podłączyć integrator

`src/App.tsx` nie był modyfikowany (ograniczenie obszaru). Aby włączyć realną
nawigację 2D dla iPhone Remote w działającej aplikacji, integrator powinien:

1. Użyć `useAureaFocusGrid({ columns, itemCount, containerRef })` na kontenerze
   siatki ekranu głównego (lub przekazać `{ columns, gridId }` do
   `useNavigation` w `App.tsx`) — to rejestruje aktywną siatkę, którą
   automatycznie wykorzysta `dispatchRemoteCommand`.
2. Zalecane: dostarczyć `navigateDirection` do `dispatchRemoteCommand`, aby
   zachować obsługę okien dialogowych (`dialog[open]`) i zminimalizować
   zależność od globalnego rejestru — handler ma pierwszeństwo przed
   `moveAureaFocus`.
3. Zadbać, aby siatka nie była aktywna, gdy otwarty jest `<dialog>` (Control
   Center / Diagnostyka), inaczej `moveAureaFocus` przeniesie fokus na kafle
   doka zamiast na kontrolki dialogu.
4. Nadać `body[data-focus-source="gamepad"]` po stronie warstwy pada
   (obszar DeepSeek) — styl CSS jest już przygotowany.
