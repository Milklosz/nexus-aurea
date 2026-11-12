# VELORA 1.0 — Ecosystem: niezależny przegląd bezpieczeństwa (static review)

> **Status: Draft PR, bez merge i bez release.**
> Gałąź `feat/velora-v1-ecosystem` (baza: `feat/velora-v1-experience` / PR #15).
>
> **Metoda:** statyczny, tylko-do-odczytu przegląd pełnego diffu
> (`git diff feat/velora-v1-experience..HEAD`) + weryfikacja konkretnych
> invariantów przez `git diff --name-only`, `grep` i odczyt plików źródłowych.
> **Środowisko:** macOS. **Nie wykonano** buildu Windows, instalacji na MSI,
> testów sprzętowych, testów na fizycznym iPhonie ani uruchomienia Playnite/Edge.
> Autorytatywna weryfikacja Windows MSVC + NSIS należy do CI (`windows-latest`).
>
> **Werdykt: NIE WPROWADZONO NOWYCH REGRESJI BEZPIECZEŃSTWA.**
> Żadna kontrola bezpieczeństwa nie została usunięta, osłabiona ani obejściowo
> zastąpiona. Wszystkie nowe moduły są addytywne; istniejące powierzchnie
> HMAC / replay / TLS / rejestr / allowlista pozostają byte-for-byte bez zmian.

## 1. Tabela ustaleń

| # | Obszar | Ustalenie | Severity | Dowód |
| --- | --- | --- | --- | --- |
| 1 | Izolacja / supply chain | `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `capabilities/default.json`, `tauri.conf.json`, `.github/workflows/ci.yml` — **bez zmian**. Brak nowych zależności, brak nowych uprawnień Tauri, brak zmian CSP. | none | `git diff --name-only feat/velora-v1-experience..HEAD` → brak tych ścieżek |
| 2 | Własność DeepSeek | `app_manager.rs`, `control_service.rs`, `focusWindowSafely.ts`, `useFocusRestoreOnClose.ts`, `useGamepad.ts` — **bez zmian**. Nie zaimplementowano `WindowBroker` / `SessionOrchestrator`. | none | j.w. |
| 3 | iPhone Remote — rdzeń | `remote_access.rs`, `public/remote/app.js`, `public/remote/sw.js`, `remoteCommand.ts`, `remoteAccess.ts` — **bez zmian** (`git diff --stat` pusty). HMAC (`verify_command_signature`, `remote_command_payload`), replay (`sequence_is_fresh`, `last_sequence`), cert/TLS (`RustlsConfig::from_pem`, `prepare_trust_profile`, `trust_confirmed`), Host/Origin, CSP/headers, `DefaultBodyLimit::max` pozostają nienaruszone. | none | pusty diff + `remoteSecurityInvariants.test.ts` (7 testów negatywnych) |
| 4 | iPhone Remote — guard | `remoteSecurityInvariants.test.ts` to genuine negative regression guard (odczyt źródeł przez `process.cwd()`, asercja obecności kontroli i **braku** `danger_accept_invalid_certs` / `no-cors` / `WebSocket` / `localStorage` / `sendBeacon`). Forbidden tokeny występują wyłącznie jako literały asercji negatywnych. | none | `src/__tests__/remoteSecurityInvariants.test.ts:52-55,81` |
| 5 | Certyfikaty iPhone | Audyt (`iphone-remote-cert-audit.md`) prawidłowo konkluduje, że bezpieczna poprawka (pinning / mTLS / scoped CA / rotacja) **wymaga zmiany UX + infrastruktury**. Dostarczono PLAN + TESTY, **nie zastosowano prowizorycznego obejścia**. | none (ryzyko rezydualne udokumentowane) | `docs/iphone-remote-cert-audit.md`, `docs/iphone-remote-reliability-plan.md` |
| 6 | Playnite — granica zaufania | Parser w **nowym** module `playnite_manifest.rs`; `playnite_library.rs` nie zawiera `.db` / `sqlite` / `database.json` (0/0/0, guard test przechodzi). `resolve_manifest_path` odrzuca ścieżki względne / `..` / NUL / znaki sterujące; limit 32 MiB przed parsowaniem; `fs::read` tylko do odczytu. | none | `src-tauri/src/playnite_manifest.rs`, `src-tauri/src/playnite_library.rs` |
| 7 | Playnite — walidacja | `schemaVersion==1`, `kind`, `readOnly==true`, `source=="playnite-api"`, `extension.id`, ISO-8601, ≤10 000 gier, Guid `id`, okładka **wyłącznie** `data:image/(png\|jpeg\|webp\|gif);base64,…` (odrzuca `file:` / `javascript:` / `http(s):`), `launch.uri` musi być **dokładnie** `playnite://playnite/start/<to-samo-id>` (brak wstrzyknięcia), duplikaty `id` odrzucane. `user_message()` nie wycieka ścieżek / `os error` / payloadów. | none | `parse_manifest`, 30 testów + dedykowany test no-leak |
| 8 | Playnite — eksporter C# | Czyta **jawną allowlistę** (`Id`, `Name`, `CoverImage` przez udokumentowane `GetFullFilePath`, `LastActivity`, `Favorite`, `IsInstalled`, `Hidden`, `Source`, `PlayCount`, `Playtime`). `grep` potwierdza: **zero** odczytów `PlayAction` / `GameActions` / `InstallDirectory` / `GameId` / `Notes` / `Links` / skryptów. Żadnych tokenów, ciasteczek, danych logowania. Zapis atomowy do katalogu VELORA, nie do danych Playnite. | none | `playnite-extension/VeloraLibraryExporterPlugin.cs:103-128` (HARD EXCLUSIONS) |
| 9 | Playnite — testy I/O | Jedyny `fs::write` / `remove_file` w `playnite_manifest.rs` znajduje się w `#[cfg(test)]` (roundtrip na `std::env::temp_dir()` z `Drop` cleanup) — **nie** w kodzie produkcyjnym, **nie** pod prawdziwą ścieżką manifestu. | none | `src-tauri/src/playnite_manifest.rs:978-1002` |
| 10 | Edge Cinema | Brak `EnumWindows` / HWND / `WM_CLOSE` / `PostMessageW` / `TerminateProcess` / `taskkill` / watcher thread. `request_edge_cinema_close` wymaga `confirm==true` + zgodnego `sessionId` + `managed_by_velora==true`; `report_edge_cinema_exit` waliduje id. **Żaden proces nie jest zabijany.** | none | `src-tauri/src/edge_cinema.rs` (komendy + 8 testów `lifecycle_tests`) |
| 11 | Edge Cinema — allowlista | 5 adresów HTTPS i dokładnie 6 flag uruchomieniowych bez zmian. Flagi `--kiosk` / `--incognito` / `--disable-*` / `--no-sandbox` / `--disable-drm` występują **wyłącznie** w istniejących testach negatywnych (asercja odrzucenia). Brak obejść DRM / HDCP / zabezpieczeń przeglądarki, brak gwarancji 4K/HDR. | none | `src-tauri/src/edge_cinema.rs:21,504-567` |
| 12 | Autostart | Tylko `set_autostart_enabled` pisze, wyłącznie jeden wpis `HKCU\...\Run /v VELORA`. Nowe komendy (`get_autostart_diagnostics`, `get_autostart_recovery`) są **tylko do odczytu**; recovery **zgłasza**, nie naprawia. `HKLM` / `WINLOGON` / `SHELL` / `CMD` występują wyłącznie w istniejącym teście strażniczym. `validate_executable_path` odrzuca wstrzyknięcia; `issues` zawiera tylko kody. | none | `src-tauri/src/autostart.rs:68,716-719` + 15 nowych testów |
| 13 | Couch control | `appControl.ts`: zamknięcie wyłącznie po ważnym tokenie + `managedByVelora`; `navigation.escape` z `confirm-close` **anuluje**; recovery tylko do odczytu, bez auto-relaunch/auto-close; brak zakończenia obcych procesów. `App.tsx` nietknięty. | none | `src/services/appControl.ts`, `appControl.test.ts`, `homeReturn.test.ts` |
| 14 | Higiena nowego kodu | Brak `eval`, `dangerouslySetInnerHTML`, `unsafe`, `Command::new` z danymi użytkownika, `http://` bindów serwera, wbudowanych kluczy prywatnych/tokenów. `window.open` w istniejącym kodzie zachowuje `noopener,noreferrer` (potwierdzone testem kompatybilności). | none | grep po 47 nowych/zmienionych plikach + `ecosystemUiCompatibility.test.tsx` |
| 15 | Redesign / UI | `styles.css`, `AppDock.tsx`, motyw, animacje, dock — bez zmian. Kontrakty (`src/contracts/*`) nie importują React ani stylów (guard w teście kompatybilności). | none | `git diff --name-only` + `ecosystemUiCompatibility.test.tsx` |

**Uwaga interpretacyjna:** jedyne trafienia grepa na „niebezpieczne" tokeny (`--kiosk`, `danger_accept_invalid_certs`, `no-cors`, `HKLM`, …) to **literały w testach negatywnych / asercjach strażniczych / komentarzach dokumentujących wyłączenia** — nigdy kod funkcjonalny. Zostały zweryfikowane przez odczyt kontekstu.

## 2. Werdykt regresji

**Brak nowych regresji bezpieczeństwa.** Nie obniżono żadnego zabezpieczenia dla wygody:

- Nie usunięto HMAC-SHA256, replay protection (monotoniczny `sequence`) ani walidacji certyfikatów / `trust_confirmed`.
- Nie dodano plain-HTTP / TLS-bypass / `no-cors` / `danger_accept_invalid_certs`.
- Nie zmieniono allowlisty HTTPS ani nie dodano flag omijających DRM / HDCP / sandbox przeglądarki.
- Nie rozszerzono zapisów do rejestru poza jeden istniejący wpis HKCU.
- Nie dodano zakończania procesów, enumeracji okien ani przejmowania cudzych okien.
- Nie odczytano nieudokumentowanej bazy Playnite, nie skopiowano tokenów / ciasteczek / danych logowania.
- Nie zmieniono capabilities, CSP, Cargo.toml/Cargo.lock ani zależności.

## 3. Kontrole zachowane (checklista)

| Kontrola | Status |
| --- | --- |
| HMAC-SHA256 + `remote_command_payload` | zachowana, bez zmian |
| Replay protection (`sequence_is_fresh`, `last_sequence`) | zachowana, bez zmian |
| Walidacja certyfikatów / TLS / `trust_confirmed` / `isSecureContext` | zachowana, bez zmian |
| Host + Origin exact match, CSP, security headers, body limit | zachowane, bez zmian |
| Dokładna allowlista 5 adresów HTTPS (TS + Rust) | zachowana, bez zmian |
| Stały zestaw 6 flag Edge (bez bypassów) | zachowany, bez zmian |
| Pojedynczy wpis `HKCU ...\Run /v VELORA` | zachowany, bez zmian |
| AUREA Grand Cinema (stylistyka / dock / animacje) | zachowana, bez zmian |
| Brak odczytu bazy Playnite / brak tokenów | zachowane, wzmocnione jawnym kontraktem |
| Izolacja od gałęzi DeepSeek (PR #14, #16) | zachowana |
| PR #13 / #14 / #15 / #16 nietknięte | zachowane |

## 4. Ryzyka rezydualne i zaakceptowane prototypy (uczciwie)

1. **Rozszerzenie Playnite jest zbudowane, ale nie załadowane w Playnite.** Projekt używa przypiętego `PlayniteSDK 6.18.0` (net462 / Playnite 10) i przechodzi build lokalny oraz Windows CI. Parser VELORA jest przetestowany, ale **realne dane gier nie zostały odczytane** — wymaga testu E2 na MSI.
2. **Model certyfikatów iPhone pozostaje z identyfikowanymi ryzykami** (device-wide root trust, CA key współdzielony z tokenami HMAC w jednym blobie w Credential Manager, brak pinningu, brak CRL/rotacji, niezweryfikowany checkbox `trust_confirmed`). Zgodnie z wymaganiem misji **nie zastosowano prowizorycznego obejścia** — bezpieczna poprawka wymaga zmiany UX + infrastruktury i jest dostarczona jako plan + testy.
3. **Niezawodność iPhone Remote ma wdrożoną idempotencję serwerową**, ale klient nadal nie auto-retryuje. Serwer rezerwuje sekwencję przed skutkiem, serializuje transakcję i zwraca 409 Ambiguous dla przerwanego wykonania (bez rozparowania). Kolejka/retry PWA pozostaje planem.
4. **Edge Cinema Lifecycle to adapter + typowane zdarzenia**, nie `WindowBroker`. Wykrycie zamknięcia i bezpieczne zamknięcie są delegowane do przyszłej integracji (dziedzina DeepSeek). VELORA nie odpytuje okien ani nie zabija procesów.
5. **Couch-only app control nie jest wpięty w `App.tsx`** — przetestowany reducer/adapter bez skutków ubocznych.
6. **Brak testów sprzętowych / MSI / 4K-HDR-DRM-HDCP.** Lokalna weryfikacja krzyżowa `x86_64-pc-windows-msvc` nie jest możliwa na macOS (`aws-lc-sys` wymaga nagłówków Windows SDK); autorytatywny wynik daje CI na `windows-latest`.

## 5. Rekomendacje przed merge do `main` (nieblokujące dla tego Draftu)

1. Przypiąć wersję `PlayniteSDK`, **zbudować** rozszerzenie na Windows i zweryfikować wygenerowany manifest przeciwko `docs/schemas/velora-playnite-manifest.schema.json`.
2. Wykonać ręczną listę kontrolną MSI (okładki, ulubione, ostatnio grane, `playnite://` URI, brak zapisów w danych Playnite, brak promptów logowania).
3. Podjąć decyzję architektoniczną w sprawie modelu certyfikatów: pinning SPKI dostarczony out-of-band + weryfikacja w PWA, mTLS z certyfikatami per-urządzenie, lub scoped CA + rotacja/CRL. Wymaga to zmiany UX parowania i `CACHE_NAME` w SW.
4. Zaimplementować **idempotencję serwerową** przed włączeniem kolejki/retry w PWA; zachować format podpisu HMAC bez zmian.
5. Zintegrować adapter Edge Cinema z `WindowBroker` DeepSeeka wyłącznie przez przygotowane typowane zdarzenia — bez duplikowania brokera.
6. Utrzymać `remoteSecurityInvariants.test.ts` jako obowiązkowy guard w CI.

## 6. Oświadczenie

> **Nie zastosowano żadnego prowizorycznego obejścia. Nie obniżono żadnej kontroli
> bezpieczeństwa dla wygody.** Nie wykonano instalacji na MSI, merge ani release.
> Nie ogłoszono finalnego wydania VELORA 1.0.
