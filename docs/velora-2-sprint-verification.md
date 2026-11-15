# Weryfikacja S1.1 + S1.2 — 2026-11-15

Stan początkowy: integration/velora-2-s1-1-sprint, HEAD 978501a, merge 8d1fc3e.
Brak zmienionych plików śledzonych i operacji Git, pozostawiony istniejący cache target-int.

## Dotychczasowe wyniki końcowe lokalne

- TypeScript tsc -b: pass.
- Vitest: 88 plików / 825 passed, 0 failed. Przejściowo node:test został omyłkowo zebrany jako pusta suita Vitest; plik przeniesiono do *-node-check.mjs i pełne ponowienie przeszło.
- Node test:claude-usage: 6 passed, 0 failed; bez prawdziwego konta.
- Node test:provenance: 31 passed, 0 failed, 0 skipped.
- Pełny Rust: 369 passed, 0 failed, 2 ignored. Osobno cały S1.1: 351/351 passed w trzech kolejnych przebiegach. Te 2 ignored są wyłącznie helperami fixture procesu, jawnie uruchamianymi jako dzieci przez test timeoutu i dziedziczonego stdout.
- Produkcyjny frontend build: pass po końcowych zmianach.
- Clippy --all-targets: pass po końcowych zmianach, z ostrzeżeniami stylu/dead code; nie uruchamiano cargo fix.
- Cargo fmt --all -- --check: FAIL, istniejące rozbieżności także w niezmienianych modułach (np. app_manager.rs). Nowy moduł claude_usage.rs jest formatowany rustfmt.

## Ograniczenia środowiska i wyniki pośrednie

Pierwszy pełny Rust w sandboxie: 313 pass / 25 fail (testowy Credential Manager niedostępny oraz długi TEMP/linker provenance).
Po eskalacji i krótkim TEMP poza checkoutem: 343/343 pass dla początkowego S1.1.
Pierwszy Clippy w sandboxie zatrzymała kompilacja aws-lc-sys; poza sandboxem przeszedł.
Późniejszy pełny Rust przed checkpoint: 355 pass / 1 fail / 2 ignored — rzeczywisty duplicate Execute sekwencji 30.
Pięć osobnych powtórzeń tego testu przeszło, lecz nie uznano tego za naprawę. Dodano zatwierdzony checkpoint
z niezależnym audytem i deterministycznymi testami stale/corrupt/crash/migration/recovery.
Cztery stare oczekiwania testów dostosowano do bardziej restrykcyjnego 503/recovery po przerwanym lub niejednoznacznym zapisie;
nie wyłączono ochrony ani testów konkurencji.

## UI i sprzęt

Przeglądarka 1280x720: widget nie przesuwa docka ani nie zasłania zegara/pogody; rozwijanie, strzałki,
Enter, ręczne odświeżenie i Escape/powrót focusu sprawdzone. Po dodaniu adaptera testy UI obejmują
awaitingUsage i bezpieczny polling lokalnego pliku co 15 minut. To test UI, nie fizycznego DS4 ani WebView2.
Nie instalowano VELORY, nie zmieniano globalnych ustawień Windows, Steam lub Claude Code.
Nie skonfigurowano status line użytkownika i nie wysłano zapytania modelowego; realny payload konta nie został pobrany. Przygotowany lokalny plik work/claude-statusline-settings.json umożliwia ręczne użycie --settings tylko dla nowej sesji.

## Audyt i CI

Oddzielny agent przejrzał bezpieczeństwo/S0.1, procesy, cache/parser/focus oraz checkpoint. Po poprawkach nie znalazł pozostałych actionable blockerów; to niezależny przegląd kodu, nie test sprzętu.
Ustalenia P2 i ich poprawki opisano w dokumentach modułów; wykryty P1 replay wymusił rozszerzenie zatwierdzone przez użytkownika.
Draft PR A: https://github.com/Milklosz/nexus-aurea/pull/55 (base hardening/velora-2-s0-1).
CI dla a176e73 zweryfikowane: Windows, macOS, Playnite success. Aktualny A head fbf1514: macOS i Playnite success, Windows testy/check przeszły, trwa build instalatora; wynik końcowy do sprawdzenia.
Brak merge/release/instalacji. Końcowe SHA/PR B/CI zostaną dopisane po push.
