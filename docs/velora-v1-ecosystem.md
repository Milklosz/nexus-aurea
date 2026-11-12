# VELORA 1.0 — Ecosystem (Draft)

> **Status integracji (VELORA 1.0):** ta gałąź została włączona do
> `integration/velora-v1` razem z Core i System Intelligence. Poniższa nota o
> braku integracji DeepSeeka opisuje stan pierwotnego PR #18. Aktualny stan:
> [docs/velora-v1-integration.md](./velora-v1-integration.md).
>
> Gałąź `feat/velora-v1-ecosystem` bazuje na `feat/velora-v1-experience`
> (PR #15, `efa45d8`). Celem jest maksymalne zbliżenie projektu do kompletnego
> centrum rozrywki obsługiwanego z kanapy, bez klawiatury i myszy.
>
> **Draft — bez merge i bez release.** Nie zintegrowano żadnych zmian DeepSeeka
> (`fix/velora-deepseek-p1` / PR #14, `feat/velora-v1-core` / PR #16).
> PR #13, #14, #15 i #16 pozostają nietknięte. Zachowano AUREA Grand Cinema:
> nie zmieniono stylistyki, animacji, docka ani motywu.
> **Nie ogłaszamy finalnego wydania VELORA 1.0.**

## Mapa modułów i rozłączna własność plików

Praca została podzielona na moduły z rozłączną własnością plików. Jedynym
punktem integracji jest `src-tauri/src/lib.rs` (rejestracja komend), którym
zarządza główny inżynier integracji.

| Moduł | Własność plików (wyłączna) | Status |
| --- | --- | --- |
| **F — kontrakty** | `src/contracts/*`, `docs/velora-v1-ecosystem-contracts.md`, `docs/ipc-contract.md`, `docs/playnite-manifest-contract.md`, `docs/schemas/*.json` | Działa (typy + helpery czyste) |
| **A1 — eksporter Playnite** | `playnite-extension/**`, `docs/playnite-extension-install.md` | Kompletne źródło; **nieuruchomione** |
| **A2 — parser manifestu** | `src-tauri/src/playnite_manifest.rs`, `playnite_library.rs`, `src/services/playniteLibrary.ts`, `src/__tests__/playniteManifest.test.ts`, `docs/playnite-library-v1.md` | Działa (parser + testy); dane realne wymagają A1 na Windows |
| **B — Edge Cinema 2.0** | `src-tauri/src/edge_cinema.rs`, `src/services/edgeCinemaLifecycle.ts`, `src/__tests__/edgeCinemaLifecycle.test.ts`, `docs/edge-cinema-lifecycle-v2.md` | Adapter + typowane zdarzenia |
| **C — iPhone Remote 2.0** | `src-tauri/src/remote_reliability.rs`, `src/services/remoteReliability.ts`, 2 nowe testy, `docs/iphone-remote-cert-audit.md`, `docs/iphone-remote-reliability-plan.md` | Prymitywy + audyt + plan |
| **D — Autostart & Recovery** | `src-tauri/src/autostart.rs`, `src/services/autostart.ts`, `src/__tests__/autostartDiagnostics.test.ts`, `docs/autostart-recovery-v1.md` | Działa (diagnostyka tylko do odczytu) |
| **E — Couch-only control** | `src/services/appControl.ts`, 2 nowe testy, `docs/couch-control-flow.md` | Analiza + prototyp adaptera |
| **G — testy i security review** | `src/__tests__/ecosystemUiCompatibility.test.tsx`, `docs/velora-v1-ecosystem-security-review.md`, raport | Cross-cutting |
| **Integracja** | `src-tauri/src/lib.rs`, `README.md`, ten dokument, raport | Główny inżynier |

## A. Playnite Library — realne dane (priorytet najwyższy)

Zamiast czytać **nieudokumentowaną bazę danych Playnite**, VELORA przyjmuje
odwrotny kierunek: małe rozszerzenie Playnite (oficjalnie udokumentowany
mechanizm `GenericPlugin` + `IPlayniteAPI`) eksportuje **jawnie wybrane**
metadane do lokalnego, tylko do odczytu manifestu JSON:

```
%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json
```

- Kontrakt: [`docs/playnite-manifest-contract.md`](playnite-manifest-contract.md)
  i [`docs/schemas/velora-playnite-manifest.schema.json`](schemas/velora-playnite-manifest.schema.json).
- Parser Rust (`playnite_manifest.rs`) waliduje `schemaVersion`, `kind`,
  `readOnly`, `source`, okładki (wyłącznie `data:image/...;base64`), identyfikatory
  Guid, duplikaty, `lastPlayed`, ulubione, dostępność (`installed`) oraz
  referencję uruchomienia (`playnite://playnite/start/<id>` — oficjalne URI).
- `get_playnite_library()` zachowuje istniejącą sygnaturę i kształt odpowiedzi;
  przy ważnym manifeście zwraca `source: "playnite-api"`, `available: true`,
  `readOnly: true` z prawdziwymi grami — dotychczasowy UI działa bez zmian.
- Nowy `get_playnite_manifest()` udostępnia bogatszy, typowany widok dla
  przyszłego frontendu.
- **Twarde wyłączenia:** eksporter NIE kopiuje `PlayAction`/`GameActions`
  (argumenty mogą zawierać tokeny logowania launcherów), skryptów, notatek,
  `GameId`, `InstallDirectory`, ciasteczek ani danych logowania. VELORA nie
  uruchamia procesów na podstawie ścieżek z manifestu.

**Uczciwy status:** rozszerzenie **nie zostało skompilowane ani uruchomione**
(środowisko macOS; Playnite wymaga Windows + .NET Framework 4.6.2). Dostarczono
kompletny projekt źródłowy, testy parsera, kontrakt i instrukcję instalacji —
bez udawania, że integracja została uruchomiona.

## B. Edge Cinema — Lifecycle 2.0

- Sesja (`EdgeCinemaSessions`, zarządzana przez Tauri) rejestruje `pid`,
  `sessionId`, `url`, `launchedAt`, `profileDir` i stan
  (`idle|launching|active|closing|exited|error`).
- **Zapobieganie duplikatom:** `should_reject_duplicate()` blokuje ponowne
  uruchomienie, gdy okno jest aktywne.
- **Rozróżnienie aktywnego i zamkniętego okna:** `session_is_active()` /
  `session_is_closed()` + kontrakt `isActiveSession` / `isClosedSession`.
- **Bezpieczne wykrycie zamknięcia:** `report_edge_cinema_exit()` to adapter,
  który przyjmuje obserwację zamknięcia i emituje typowane zdarzenie
  `velora://cinema-exited`. VELORA sama nie odpytuje okien, nie wylicza HWND
  i nie zabija procesów.
- **Bezpieczne zamknięcie po potwierdzeniu:** `request_edge_cinema_close()`
  wymaga `confirm === true`, zgodności `sessionId` i `managedByVelora === true`;
  emituje zdarzenie dla przyszłego `WindowBroker` — nie kończy procesu.
- **Trwały profil** (`VELORA-EdgeCinema`), allowlista 5 adresów HTTPS i stały
  zestaw 6 flag uruchomieniowych pozostają nienaruszone.
- **Diagnostyka sesji** (`get_edge_cinema_session`) i **recovery**
  (`reset_edge_cinema_session`).
- **Pełny ekran / powrót do VELORA:** VELORA steruje wyłącznie własnym oknem
  (istniejący `windowMode.ts`); pełny ekran Edge to `--start-fullscreen`.
  Powrót do VELORA zaprojektowano przez `focusWindowSafely()` + zdarzenie —
  wzorzec z `App.tsx`, **bez modyfikacji `App.tsx`**.

**Nie zaimplementowano** `WindowBroker` ani `SessionOrchestrator` (dziedzina
DeepSeeka). Nie stosowano obejść DRM, HDCP ani zabezpieczeń przeglądarki;
nie deklarujemy 4K/HDR dla serwisów streamingowych.

## C. iPhone Remote 2.0

- Dostarczono **w pełni przetestowane, czyste prymitywy niezawodności**:
  kolejka poleceń z deduplikacją, reconnect z backoffem, timeouty, korelacja
  potwierdzeń (`AckTracker` / `AckCorrelator`), idempotencja (`IdempotencyStore`,
  `commandId`), klasyfikacja błędów sieciowych, bezpieczna obsługa utraty Wi-Fi
  (zawieszenie, **bez automatycznego odtwarzania poleceń**), bezpieczny lifecycle
  parowania (`safePairingReset` → wymusza ponowną weryfikację podpisem).
- **Niezależny audyt ryzyka modelu certyfikatów**
  ([`docs/iphone-remote-cert-audit.md`](iphone-remote-cert-audit.md)) oraz
  **plan integracji** ([`docs/iphone-remote-reliability-plan.md`](iphone-remote-reliability-plan.md)).
- **Security regression guard** (`remoteSecurityInvariants.test.ts`) pilnuje,
  że HMAC, replay protection, walidacja certyfikatów, `trust_confirmed`,
  nagłówki bezpieczeństwa i ograniczenia PWA nie zostały usunięte.
- **Nie usunięto / nie osłabiono** HMAC-SHA256, monotonicznego `sequence`,
  walidacji certyfikatów ani TLS. Nie zastosowano prowizorycznego obejścia:
  bezpieczna poprawka modelu certyfikatów wymaga zmiany UX + infrastruktury,
  więc przygotowano plan i testy.

## D. Autostart & Recovery

- Wykrywanie **błędnego wpisu** (`parse_command_value`, `detect_issues`),
  walidacja ścieżki executable, diagnostyka stanu, czytelne błędy.
- Tryb awaryjny `--windowed` zachowany; bezpieczne wyłączenie nadal usuwa
  dokładnie jeden wpis `VELORA`.
- Obsługa restartu Windows / aktualizacji VELORA: `get_autostart_recovery()`
  **zgłasza** nieaktualny wpis (`WrongExecutable`) i rekomenduje ponowne
  zastosowanie toggle — **nie naprawia automatycznie**.
- Nowe komendy są wyłącznie do odczytu. Nie zmieniono HKLM, Winlogon, powłoki
  ani folderu Startup.

## E. Couch-only Application Control

- Pełna analiza przepływu Home → aplikacja → sterowanie → zamknięcie → Home
  ([`docs/couch-control-flow.md`](couch-control-flow.md)).
- Typowane akcje pilota (`VeloraAction`), adaptery, obsługa Escape/Back,
  bezpieczne zamknięcie **wyłącznie zarządzanej aplikacji po potwierdzeniu**
  (token + `managedByVelora`), obsługa błędu uruchomienia, recovery po restarcie
  VELORA (tylko odczyt, bez automatycznych akcji), testy powrotu do Home.
- Nie zabijamy obcych procesów ani nie wymuszamy zamknięcia bez świadomej akcji.
- Warstwa to **przetestowany prototyp adaptera/reducera**, niewpięty w `App.tsx`
  (zgodnie z zasadą nienaruszania istniejącego UI i własności DeepSeeka).

## F. Przygotowanie do przyszłego redesignu

`src/contracts/` dostarcza stabilne, typowane modele aplikacji i gier, statusy
sesji, błędy, akcje, adaptery danych, zdarzenia oraz dokumentację IPC jako kod.
Dzięki temu przyszły model może całkowicie przebudować frontend bez
przepisywania backendu. **Nie zmieniono** stylistyki, animacji, docka ani motywu.

## G. Testy i bezpieczeństwo

Dodano testy: błędne manifesty, brak okładek, nieistniejące gry, błędy Edge,
duplikaty okien/uruchomień, rozłączenie iPhone, replay, timeouty, recovery
autostartu, brak dostępu do plików, niepoprawne ścieżki, kompatybilność z UI.
Wyniki (JS/Rust/Windows CI) oraz security review znajdują się w raporcie
[`docs/velora-v1-ecosystem-report.md`](velora-v1-ecosystem-report.md).

## Granice własności (niezmienione)

`SessionOrchestrator`, `WindowBroker`, globalny HID (`control_service.rs`),
natywny fokus (`app_manager.rs`, `focusWindowSafely.ts`,
`useFocusRestoreOnClose`, `useGamepad`) oraz logika control/music/remote service
pozostają w wyłącznej domenie DeepSeeka. Nie dotykano zabezpieczeń Tauri
(CSP / capabilities / permissions), `Cargo.toml`, `Cargo.lock`, DRM ani
zależności. Nie wykonano instalacji niczego na MSI, merge ani release.

## Czego nie twierdzimy

- Żadna integracja Playnite / Edge / Windows nie została uruchomiona na macOS.
- Nie wykonano testów sprzętowych ani testów na fizycznym MSI.
- Nie potwierdzono 4K / HDR / DRM / HDCP dla platform streamingowych.
- Nie ogłoszono finalnego wydania VELORA 1.0.
