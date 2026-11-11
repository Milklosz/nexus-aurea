# VELORA 1.0 — Experience (konsolidacja obszarów A–E)

- Gałąź: `feat/velora-v1-experience`
- Baza: **Night Build** (`7fd83c6`, PR #13 — **Draft**)
- Status: **Draft** — dokument zbiorczy obszarów A–E (bez merge i bez release)

## Zakres i brak integracji zewnętrznej

Ten dokument oraz cała gałąź `feat/velora-v1-experience` opisują wyłącznie
Experience V1. **Nie dotykamy i nie integrujemy**:

- **PR #13 (Night Build)** — pozostaje nienaruszony, bez merge,
- gałęzi **DeepSeek** `fix/velora-deepseek-p1` oraz `feat/velora-v1-core`,
- **stabilnych wydań (release)** — brak merge, brak release, brak publikacji.

Zmiany DeepSeek (`SessionOrchestrator`, `WindowBroker`, globalny HID, natywny
fokus okna, silnik kontrolera) **nie są włączone** do tej gałęzi i nie są tu
integrowane.

## Podsumowanie obszarów A–E

### A. Edge Cinema — [docs/edge-cinema-v1.md](./edge-cinema-v1.md)

Serwisy streamingowe (Netflix, Disney+, HBO Max, Prime Video, YouTube) są
otwierane w **dedykowanym oknie Microsoft Edge** (tryb aplikacji + pełny ekran)
zamiast w domyślnej przeglądarce. Dedykowany, **trwały** profil
`VELORA-EdgeCinema` zachowuje logowania między uruchomieniami. Dokładna
allowlista pięciu zweryfikowanych adresów HTTPS jest sprawdzana niezależnie w
TypeScript i w Rust; błędy (brak Edge, katalog profilu, spawn okna, DRM/4K/HDR)
są mapowane na czytelne komunikaty po polsku. Podgląd WWW używa
odizolowanego fallbacku `window.open`.

### B. Autostart — [docs/autostart-v1.md](./autostart-v1.md)

Funkcja **domyślnie wyłączona, wyłącznie opt-in**: jedyny zapis do systemu to
skutek świadomego kliknięcia przełącznika w `AutostartPanel` (montaż wykonuje
tylko odczyt). Dodaje jeden wpis `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\VELORA`
dla bieżącego użytkownika; wyłączenie usuwa dokładnie tę wartość. Dostępny jest
bezpieczny tryb awaryjny `--windowed` (okno zamiast pełnego ekranu).

### C. Playnite Library — [docs/playnite-library-v1.md](./playnite-library-v1.md)

Granica adaptera (`createTauriPlayniteAdapter` / `createFallbackPlayniteAdapter`):
metadane gier **tylko do odczytu** (`readOnly: true`). W tym buildzie brak
bezpiecznego API → jawny snapshot `unavailable`, **bez wymyślonych gier**.
Ulubione i „ostatnio grane" to stan lokalny VELORA (`localStorage` WebView), a
nie zapis w Playnite. Siatka okładek oferuje 2D nawigację strzałkami, roving
`tabIndex`, `aria-current` / `data-aurea-focus` i bezpieczny
`sanitizeCoverSource`.

### D. AUREA Navigation — [docs/aurea-navigation-v1.md](./aurea-navigation-v1.md)

Nawigacja 2D i czytelne stany fokusu wewnątrz UI VELORA (`resolveGridIndex`,
`moveAureaFocus`, `registerAureaGrid`, `focusStateAttributes`, hook
`useAureaFocusGrid`). `AppDock` wystawia `data-aurea-*`, `data-focus-source`,
`aria-current` i zaktualizowaną podpowiedź „dedykowane okno Edge Cinema".
`remoteCommand` preferuje `navigateDirection`, potem `moveAureaFocus`
(pomijane, gdy otwarty jest `dialog[open]`), a na końcu istniejący liniowy
fallback — bez zmiany sygnatury `useNavigation`. Wygląd AUREA Grand Cinema
pozostaje nienaruszony (nowe reguły CSS dopisano na końcu).

### E. Testy i dokumentacja (ten obszar)

Cross-cutting pokrycie zintegrowanych komponentów i ścieżek błędów:
`experienceAccessibility.test.tsx` (a11y, uczciwe ograniczenia, brak fałszywych
deklaracji o globalnym padzie), `experienceLaunchErrors.test.ts` (odrzucenie
niezaufanego URL przed `invoke`, mapowanie błędów Edge/Playnite/Autostart,
`--windowed`), `experienceAutostart.test.tsx` (brak zapisu przy montażu,
opt-in, retry). Dokumentacja: ten plik oraz sekcja w `README.md`.

## Granice własności

- `SessionOrchestrator`, `WindowBroker`, globalny HID, natywny fokus okna oraz
  silnik kontrolera pozostają **obszarem DeepSeek** i nie są tu modyfikowane ani
  integrowane.
- **VELORA nie deklaruje pełnej / globalnej obsługi pada poza własnym
  interfejsem.** AUREA Navigation obejmuje wyłącznie nawigację i fokus
  wewnątrz UI VELORA. `body[data-focus-source="gamepad"]` jest jedynie
  przygotowanym punktem podłączenia dla warstwy pada, nie dowodem globalnego
  mapowania przycisków.

## Bezpieczeństwo

- **Brak osłabiania** CSP / capabilities / uprawnień Tauri; brak zmian DRM,
  Widevine, PlayReady, HDCP; brak nowych zależności npm / cargo i brak zmian w
  `Cargo.lock`.
- **Edge Cinema:** dokładna allowlista zweryfikowanych adresów HTTPS
  niezależnie w TypeScript (`isOfficialHttpsUrl`) i Rust (stałe z
  `streamingServices.ts`); niezaufany adres jest odrzucany **przed** `invoke`.
  Do polecenia Edge trafia wyłącznie dopasowana stała (bez powłoki, bez
  wstrzykiwania flag). Dedykowany, **trwały** profil Edge (`VELORA-EdgeCinema`)
  to własny katalog danych aplikacji VELORA, nie ustawienie systemowe.
- **Playnite:** metadane wyłącznie do odczytu, bez otwierania / zgadywania bazy
  SQLite i plików biblioteki; **bez logowania** do GOG, Epic, EA i Ubisoft —
  integracje i launchery pozostają w Playnite i jego oficjalnych dodatkach.
- **Autostart:** wyłącznie opt-in, jeden wpis `HKCU\...\Run\VELORA` dla
  bieżącego użytkownika; bez zmian powłoki Windows, Winlogon, HKLM, folderu
  Startup ani innych ustawień systemowych; wyłączenie **usuwa** wartość;
  bezpieczny tryb `--windowed`.

## Ograniczenia

- VELORA **nie gwarantuje** DRM / Widevine / PlayReady, jakości 4K, HDR, HDCP,
  możliwości GPU, poziomu subskrypcji ani dostępności usług — zależą one od
  sprzętu, sterowników, przeglądarki Edge i dostawcy.
- W tym buildzie **nie istnieje bezpieczne, udokumentowane API metadanych
  Playnite** → adapter + jawny `fallback`; biblioteka pokazuje stan
  `unavailable` i **nie wyświetla żadnych wymyślonych gier**.
- **Edge Cinema jest tylko na Windows** (kod Rust zamknięty w
  `#[cfg(target_os = "windows")]`). W podglądzie WWW `launchEdgeCinema` rzuca
  jasny błąd, a `openStreamingService` zachowuje odizolowany fallback
  `window.open(..., "noopener,noreferrer")`.
- Ścieżki Rust specyficzne dla Windows są weryfikowane przez **Windows CI**, a
  nie lokalnie na macOS: na macOS moduły się kompilują, a komendy zwracają
  komunikat o dostępności wyłącznie w natywnej aplikacji Windows.

## Wyniki testów (LOKALNIE — macOS)

Stan wyjściowy gałęzi był GREEN. Wyniki lokalne **przed** dodaniem plików
obszaru E:

- `pnpm test` → **33 pliki testów / 253 testy — PASS**.
- `pnpm build` → **PASS** (TypeScript + Vite).
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` →
  **38 testów — PASS** (macOS).
- `cargo check` (macOS) → **PASS**.

Po dodaniu plików obszaru E uruchomiono **wyłącznie nowe testy**
(`experienceAccessibility.test.tsx`, `experienceLaunchErrors.test.ts`,
`experienceAutostart.test.tsx`): **3 pliki / 24 testy — PASS**, oraz
`tsc --noEmit -p tsconfig.app.json` → PASS. Pełny `pnpm test` / `pnpm build` /
`cargo` uruchamia integrator.

> **Windows CI: do uzupełnienia po pushu.** Nie podajemy tu żadnych wyników z
> Windows CI, ponieważ nie zostały jeszcze wygenerowane.

## Testy wymagane na MSI (ręczna lista kontrolna)

Żadnej z poniższych rzeczy **nie da się udowodnić syntetycznymi testami CI** —
wymagają realnej maszyny Windows z zainstalowanym MSI:

- [ ] **Edge Cinema:** wybór serwisu otwiera osobne okno Edge w trybie aplikacji
      i na pełnym ekranie (nie domyślną przeglądarkę); logowanie do serwisu
      **pozostaje** po zamknięciu okna i ponownym uruchomieniu VELORA
      (trwałość profilu `VELORA-EdgeCinema`).
- [ ] **DRM / 4K / HDR / HDCP:** odtwarzanie w każdym serwisie zgodnie z
      możliwościami sprzętu, GPU, sterowników i subskrypcji; VELORA nie
      obiecuje konkretnej jakości.
- [ ] **Autostart:** po włączeniu i wylogowaniu/zalogowaniu VELORA startuje
      sama; wyłączenie usuwa wpis `HKCU\...\Run\VELORA`; tryb `--windowed`
      startuje w oknie z dekoracjami (bez pełnego ekranu); brak zmian w
      powłoce, HKLM, Winlogon i folderze Startup.
- [ ] **Playnite:** gdy dostępne będzie realne, bezpieczne API — okładki,
      ulubione i „ostatnio grane" działają na prawdziwych danych; do tego czasu
      panel nie pokazuje żadnych wymyślonych gier, jest tylko do odczytu i nie
      prosi o logowanie GOG / Epic / EA / Ubisoft.
- [ ] **Nawigacja 2D:** fokus po siatce z klawiatury, pada i iPhone Remote;
      widoczne stany `data-aurea-focus` / `aria-current` per źródło.
- [ ] **Powrót fokusu:** po zamknięciu okna Edge / dialogu Control Center fokus
      wraca do VELORA; strzałki w `<dialog open>` nie przenoszą fokusu na kafle
      doka.
- [ ] **Brak zmian systemowych:** rejestr (poza jednym wpisem autostartu),
      powłoka, ustawienia domyślnej przeglądarki, DRM i pliki Playnite
      pozostają nienaruszone.
