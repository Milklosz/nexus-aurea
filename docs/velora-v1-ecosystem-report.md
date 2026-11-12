# VELORA 1.0 — NIGHT MEGA SPRINT II: raport z gałęzi Ecosystem

> **Draft.** Gałąź `feat/velora-v1-ecosystem` → Draft PR do `feat/velora-v1-experience` (PR #15).
> Bez merge, bez release, bez integracji DeepSeeka (PR #14 `fix/velora-deepseek-p1`,
> PR #16 `feat/velora-v1-core`). PR #13/#14/#15/#16 nietknięte.
> Środowisko: macOS. **Nie zainstalowano niczego na MSI, nie wykonano testów
> sprzętowych, nie ogłoszono finalnego wydania VELORA 1.0.**

## 1. Co rzeczywiście działa

| Element | Status | Weryfikacja |
| --- | --- | --- |
| **Stabilne kontrakty (F)** — typowane modele aplikacji/gier, statusy sesji, błędy, akcje, adaptery, zdarzenia, rejestr IPC (`src/contracts/*`) | Działa | `tsc -b` PASS; 10 testów kompatybilności potwierdza, że kontrakty nie importują UI ani stylów |
| **Parser manifestu Playnite (A2)** — ścisła walidacja `schemaVersion`/`kind`/`readOnly`/`source`, Guid id, okładki `data:image/*;base64`, `playnite://` URI, duplikaty, limity, czyste błędy | Działa | 30 testów Rust (`playnite_manifest::tests`) PASS |
| **`get_playnite_library()`** preferuje zwalidowany manifest; bez manifestu wraca do bezpiecznego `unavailable` / `playnite-detected`. Sygnatura, nazwa komendy i kształt odpowiedzi bez zmian | Działa | `cargo test` + testy TS kompatybilności (istniejące 277 testów zielone) |
| **`get_playnite_manifest()`** — bogatszy, typowany widok dla przyszłego frontendu | Działa | zarejestrowany w `lib.rs`, testy widoku PASS |
| **Autostart & Recovery (D)** — wykrywanie błędnego wpisu, walidacja ścieżki exe, diagnostyka stanu, raport nieaktualnego wpisu po restarcie/aktualizacji, czytelne błędy | Działa | 15 nowych testów Rust + 13 testów TS PASS; nowe komendy **tylko do odczytu** |
| **Prymitywy niezawodności iPhone (C)** — kolejka z deduplikacją, reconnect z backoffem, timeouty, korelacja ack, idempotencja, klasyfikacja błędów sieciowych, bezpieczna utrata Wi-Fi, lifecycle parowania | Działa (jako biblioteka) | 17 testów TS + 12 testów Rust PASS |
| **Security regression guard** — pilnuje HMAC / replay / cert / nagłówków / ograniczeń PWA | Działa | 7 testów `remoteSecurityInvariants.test.ts` PASS |
| **Kompatybilność z dotychczasowym UI** — dock, allowlista 5 HTTPS, nazwy komend, `edgeCinema.ts`, `openStreamingService.ts` | Działa | 10 testów `ecosystemUiCompatibility.test.tsx` PASS + wszystkie 277 testów bazowych PASS |
| **Izolacja / brak redesignu** — bez zmian w `styles.css`, `AppDock`, animacjach, docku, motywie, capabilities, CSP, `Cargo.toml`/`Cargo.lock`, `pnpm-lock.yaml` | Działa | `git diff --name-only` + `git diff --check` |

## 2. Co jest tylko adapterem / prototypem (uczciwie)

| Element | Dlaczego to nie jest uruchomiona integracja |
| --- | --- |
| **Rozszerzenie Playnite (A1)** — źródło C# (`playnite-extension/**`) | **Zbudowane** przeciwko `PlayniteSDK 6.18.0` (Playnite 10 / net462); DLL powstaje w Windows CI. **Nie załadowane jeszcze w Playnite** — test na MSI (E2). Instrukcja: `docs/playnite-extension-install.md`. **Realne dane gier nie zostały odczytane w CI.** |
| **Edge Cinema Lifecycle 2.0 (B)** | **Adapter + typowane zdarzenia**, nie `WindowBroker` / `SessionOrchestrator`. Sesja, blokada duplikatów, diagnostyka i bezpieczne *żądanie* zamknięcia są zaimplementowane, ale **wykrycie zamknięcia i faktyczne zamknięcie są delegowane** do przyszłego brokera DeepSeeka. Żaden proces nie jest zabijany, brak HWND/`EnumWindows`/watchera. `App.tsx` nietknięty. |
| **iPhone Remote 2.0 (C)** | Prymitywy są przetestowane, ale **NIE wpięte** w `public/remote/app.js` ani `remote_access.rs`. Protokół HTTP, format HMAC i odpowiedź `204` bez zmian. Plan 7 kroków: `docs/iphone-remote-reliability-plan.md`. **Wymóg wstępny:** idempotencja serwerowa przed jakimkolwiek retry. |
| **Model certyfikatów iPhone** | Niezależny audyt (`docs/iphone-remote-cert-audit.md`) wykazał, że bezpieczna poprawka **wymaga zmiany UX + infrastruktury** → dostarczono PLAN + TESTY, **bez prowizorycznego obejścia**. |
| **Couch-only Application Control (E)** | Analiza przepływu + typowane akcje + **przetestowany prototyp** reducera/adaptera. **NIE wpięty w `App.tsx`**; brak skutków ubocznych, brak zamykania obcych procesów. |
| **Przyszły redesign (F)** | Przygotowano kontrakty, **nie zaprojektowano nowego interfejsu**. |

## 3. Wyniki testów (lokalnie, macOS)

| Komenda | Wynik | Baseline PR #15 |
| --- | --- | --- |
| `pnpm test` (`vitest run`) | **44 pliki / 407 testów — PASS** | 36 / 277 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | **103 testy — PASS** | 38 |
| `pnpm build` (`tsc -b && vite build`) | **PASS** (80 modułów) | PASS |
| `git -c core.whitespace=cr-at-eol diff --check` | **PASS** | PASS |

Nowe testy obejmują: błędne manifesty, brak okładek, nieistniejące gry, błędy Edge,
duplikaty okien/uruchomień, rozłączenie iPhone, replay, timeouty, recovery
autostartu, brak dostępu do plików, niepoprawne ścieżki, kompatybilność z UI.

**Uwaga o `git diff --check`:** repo zawiera `src-tauri/src/lib.rs` w CRLF. CI
uruchamia `git diff --check` na czystym checkoutcie (pusty diff → no-op), dlatego
przechodzi; lokalnie na brudnym drzewie używamy `core.whitespace=cr-at-eol`,
dokładnie tak jak odnotowano w `docs/velora-v1-experience.md`.

## 4. Wyniki Windows CI

**CI: PASS — obie platformy, oba przebiegi, `gh pr checks 18` exit 0.**
`head` PR: `612ace57556be260a486fed4a754f2b6a1d7ba03`.

| Przebieg | macOS | Windows | Wniosek |
| --- | --- | --- | --- |
| `push` [43194820910](https://github.com/Milklosz/nexus-aurea/actions/runs/43194820910) | **pass** 1m36s | **pass** 10m31s | `success` |
| `pull_request` [43194911192](https://github.com/Milklosz/nexus-aurea/actions/runs/43194911192) | **pass** 4m19s | **pass** 4m21s | `success` |

`gh pr checks 18` → 4× `pass` + 2× `Publish GitHub Release` = `skipping`
(brak tagu / release'u). Windows zweryfikował m.in.
`cargo check --locked --target x86_64-pc-windows-msvc`,
`cargo test --locked --lib`, `pnpm test`, `pnpm build`, `git diff --check`
oraz **pełny build NSIS** (`pnpm tauri build --ci --target x86_64-pc-windows-msvc`).

- Artefakt: `VELORA-Windows-x64-dd709e85780482e6e23baf30a56bc20305712aa9`
  → `VELORA_0.9.2_x64-setup.exe` (3.57 MiB).
- SHA-256 (PR run, merge `dd709e8…`): `3c452891ca120fa06cc5b9de8316ba040fb3de9b9c4fadea74ab224bc41fab8e`
- SHA-256 (push run, head `612ace5…`): `110fb5d1c25c90a9a5075f1f45dcd9886eb33cf12bd408db6e880c491b9e7981`

NSIS osadza znacznik czasu, stąd różne hashe przy identycznym kodzie aplikacji
(zachowanie odnotowane już w `docs/velora-v1-experience.md`).

**Uczciwe ograniczenie:** lokalna weryfikacja krzyżowa
`cargo check --target x86_64-pc-windows-msvc` **nie jest możliwa na macOS** —
`aws-lc-sys v0.47.0` (Windows-only stos `axum-server`/`rustls`) w build-skrypcie
C wymaga nagłówków Windows SDK (`windows.h`, `stdlib.h`), niedostępnych w
cross-toolchainie. To ograniczenie środowiska, **nie błąd kodu**; nie deklarujemy
lokalnego PASS. Autorytatywny wynik powyżej pochodzi z `windows-latest`.
**Żaden instalator nie został zainstalowany na MSI.**

## 5. Bezpieczeństwo

Pełny przegląd: [`docs/velora-v1-ecosystem-security-review.md`](velora-v1-ecosystem-security-review.md).
Wykonano **dwie niezależne weryfikacje**: statyczny przegląd lead-engineera oraz
osobny, tylko-do-odczytu przegląd subagenta (8 obszarów, **8/8 PASS**, werdykt
*"No new security regressions introduced"*). Obie zgodne co do wszystkich
kontroli; jedyne trafienia grepa na „niebezpieczne" tokeny to literały w testach
negatywnych / asercjach strażniczych, zweryfikowane przez odczyt kontekstu.

**Werdykt: nie wprowadzono nowych regresji bezpieczeństwa.**

- HMAC-SHA256, replay protection (monotoniczny `sequence`) i walidacja certyfikatów
  / `trust_confirmed` — **bez zmian** (`remote_access.rs`, `app.js`, `sw.js`,
  `remoteCommand.ts`, `remoteAccess.ts` mają pusty diff).
- Brak plain-HTTP / TLS-bypass / `no-cors` / `danger_accept_invalid_certs`.
- Allowlista 5 HTTPS i 6 flag Edge bez zmian; brak obejść DRM / HDCP /
  zabezpieczeń przeglądarki; brak gwarancji 4K/HDR.
- Tylko jeden wpis `HKCU\...\Run /v VELORA`; nowe komendy autostartu tylko do odczytu;
  brak HKLM / Winlogon / powłoki / `cmd /c`.
- Brak zakończania procesów, enumeracji okien, przejmowania cudzych okien.
- Brak odczytu nieudokumentowanej bazy Playnite; eksporter nie czyta
  `PlayAction` / argumentów / skryptów / `GameId` / `InstallDirectory` —
  **żadnych tokenów, ciasteczek ani danych logowania**.
- Brak nowych zależności, capabilities, uprawnień, zmian CSP.
- Nie obniżono żadnej kontroli dla wygody; nie zastosowano prowizorycznego obejścia.

## 6. Integracja z Core

- Baza: `feat/velora-v1-experience` (PR #15, `efa45d8`). Nowa gałąź
  `feat/velora-v1-ecosystem` utworzona od aktualnego HEAD Experience.
- **Nie zintegrowano** `fix/velora-deepseek-p1` (PR #14) ani
  `feat/velora-v1-core` (PR #16). `WindowBroker`, `SessionOrchestrator`, globalny
  HID, natywny fokus i silnik kontrolera pozostają w wyłącznej domenie DeepSeeka.
- Jedyny punkt integracji backendu: `src-tauri/src/lib.rs` — 2 nowe deklaracje
  `mod`, `.manage(edge_cinema::EdgeCinemaSessions::default())` oraz 7 nowych
  rejestracji w `generate_handler!`. Żadna istniejąca komenda nie została zmieniona.
- Kontrakty (`src/contracts/*`, `docs/ipc-contract.md`) przygotowują grunt pod
  przyszłe wpięcie Core przez typowane zdarzenia **bez przebudowy backendu**.
- 8 małych commitów (F, backend, A, B, C, D, E, G+integracja) — po każdym
  zachowano spójność modułów.

## 7. Link do Draft PR

**PR #18 — https://github.com/Milklosz/nexus-aurea/pull/18**

- Tytuł: *VELORA 1.0 — Ecosystem: Playnite real-data manifest, Edge Lifecycle 2.0,
  iPhone Remote 2.0, Recovery, Couch Control & Contracts (Draft)*.
- Kierunek: `feat/velora-v1-ecosystem` → **`feat/velora-v1-experience`** (PR #15).
- Stan: **Draft / OPEN**, bez merge i bez release; `Publish GitHub Release`
  pozostaje `skipping` (brak tagu / release'u).
- Utworzony po 9 małych commitach; `gh pr checks 18` raportuje przebiegi CI
  (`push` + `pull_request`, macOS + Windows).

## 8. Instrukcja testów na MSI (Windows) — do wykonania ręcznie

> **Nic nie zostało zainstalowane na MSI. Poniższa lista NIE została wykonana.**

1. Zbudować `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm tauri:windows`
   (NSIS, `currentUser`). Zainstalować `VELORA_0.9.2_x64-setup.exe` na maszynie MSI.
2. **Playnite (A):** zainstalować rozszerzenie wg
   `docs/playnite-extension-install.md` (przypiąć `PlayniteSDK`, zbudować DLL,
   `%AppData%\Playnite\Extensions\VeloraLibraryExporter\` lub „For developers").
   W Playnite: Extensions → VELORA → „eksportuj bibliotekę". Sprawdzić, że pojawił
   się `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json` i że jest
   zgodny ze schematem. W Control Center → Gaming sprawdzić **realne** tytuły,
   okładki, ulubione, ostatnio grane, `installed` oraz `playnite://` URI.
   Sprawdzić, że katalog danych Playnite **nie został zmieniony** i że nie pojawiły
   się żadne prompty logowania GOG/Epic/EA/Ubisoft. Sprawdzić fallback przy
   usuniętym / uszkodzonym manifeście (czysty `unavailable`, bez zgadywania gier).
3. **Edge Cinema (B):** uruchomić każdy z 5 serwisów; sprawdzić dedykowane okno
   Edge, trwałość logowania w profilu `VELORA-EdgeCinema`, brak duplikatu przy
   ponownym kliknięciu, czytelne błędy (brak Edge / profil / spawn), diagnostykę
   sesji, powrót fokusu do VELORA po zamknięciu, `--windowed`. **Nie weryfikować
   jako gwarancji 4K/HDR/DRM/HDCP** — zależą od sprzętu i dostawcy.
4. **iPhone Remote (C):** zweryfikować parowanie, HMAC/replay, odłączenie Wi-Fi,
   reconnect, timeout, brak automatycznego powtórzenia polecenia, oraz że
   `.mobileconfig` nadal wymaga ręcznego pełnego zaufania. Potwierdzić, że guard
   bezpieczeństwa nie został osłabiony.
5. **Autostart (D):** świeża instalacja nie ma wpisu `VELORA`; panel tylko czyta;
   toggle dodaje dokładnie jeden `REG_SZ`; `--windowed`; wyłączenie usuwa wpis;
   zasymulować nieaktualny wpis (zmiana ścieżki exe) → raport recovery bez
   automatycznej naprawy; brak zmian w HKLM/Winlogon/powłoce/Startup.
6. **Sterowanie z kanapy (E):** przejść Home → aplikacja → sterowanie →
   potwierdzone zamknięcie → Home; sprawdzić Escape/Back, błąd uruchomienia,
   recovery po restarcie VELORA (brak auto-akcji), brak zamykania obcych procesów.
7. **AUREA / kompatybilność:** nawigacja 2D padem/klawiaturą/iPhone Remote,
   `data-aurea-focus`, `aria-current`, złote obrysy `focus-visible`, kinowe tło,
   kremowa typografia, przezroczysty dock — bez zmian względem PR #15.
8. **System:** brak zapisów poza `HKCU\...\Run /v VELORA` i katalogiem danych
   VELORA; brak instalacji na MSI w ramach tego sprintu; brak merge/release.

## Oświadczenie końcowe

Nie zadeklarowano żadnego testu sprzętowego, którego nie wykonano. Nie wykonano
merge ani release. Nie zmieniono istniejących Draft PR. Nie wykonano redesignu.
**Nie ogłoszono finalnego wydania VELORA 1.0.**
