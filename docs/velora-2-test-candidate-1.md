# VELORA 2.0 — Kandydat testowy 1 (plan, weryfikacja, instalacja, checklista)

Status: **przygotowany, NIE zainstalowany.** Instalacja na MSI wymaga osobnej,
wyraźnej zgody właściciela po zapoznaniu się z wynikami.

## 1. Identyfikacja kandydata

| Element | Wartość |
|---|---|
| Gałąź oznaczona | `test/velora-2-candidate-1` |
| Gałąź PR | `test/velora-rc-stabilization` (Draft PR #48 → `test/velora-2-combined`) |
| Kod kandydata (SHA) | `9b23ecabaa1045e9f3cb88b2cd692137e4621408` |
| Wersja aplikacji | 0.9.2 (`package.json`, `tauri.conf.json`) |
| Główna gałąź | `main` — nietknięta |

Zawartość (sprawdzone `git merge-base --is-ancestor`, wszystkie obecne w kandydacie):

| PR | Head | Obecny |
|---|---|---|
| #43 klawiatura ekranowa (UI) | `2abcdae49` | tak |
| #44 DualSense (normalizacja, D-pad z hat) | `1781e6adc` | tak |
| #45 dokumentacja integracji | `2a70dc93e` | tak (scalone 2026-11-13) |
| #46 rollback Edge bez ruszania cudzych okien | `9856163a4` | tak |
| #47 wyszukiwarka aplikacji | `da6489d4a` | tak |
| #48 stabilizacja RC (timeout odczytu statusu, testy integracyjne) | `f54d6c429` (+ `9b23eca`) | tak |
| `test/velora-2-combined` (baza) | `f82654c79` | tak |

Autorstwo istniejących commitów nie zostało zmienione. Commity dodane w tej sesji
mają autora `Claude Code <noreply@anthropic.com>` ustawionego tylko dla danego
polecenia, bez zmiany konfiguracji git.

## 2. Wyniki weryfikacji na SHA `9b23eca`

| Sprawdzenie | Wynik |
|---|---|
| `pnpm test` (vitest) | PASS: 75 plików, 651 testów |
| `pnpm build` (`tsc -b` + vite) | PASS |
| `cargo test --locked --lib` (src-tauri) | PASS: 264 testy |
| `git diff --check` | czysto |
| Instalator NSIS (`pnpm tauri build --ci --target x86_64-pc-windows-msvc`) | exit 0 |
| CI na PR #48 (`f54d6c4`) | run 43421457521 (PR): **success**, wszystkie joby |
| CI na `9b23eca` | w toku w chwili pisania; patrz raport |

Uwaga o SHA-256: instalator zbudowany z tego samego kodu Rust dwa razy dał różne
skróty (`832da9ad…` wcześniej, `89ca2e46…` teraz). NSIS osadza metadane czasu
budowy. Skrót identyfikuje konkretny plik, nie kod. Dlatego zapisujemy skrót
dla KONKRETNEGO pliku, który trafi na MSI.

## 3. Integralność instalatora

Kandydat (zbudowany lokalnie, nie instalowany):

- Plik: `VELORA_0.9.2_x64-setup.exe`, 4 027 543 B
- SHA-256: `89ca2e46e8be6ba7782305d2280ff79a0e06c15da100602d450355f98a613423`
- Binarka w środku: `nexus-aurea.exe`, SHA-256 `cd8857591091b8d1c091e5aa5c80bca84dd427184c485f912ea81a863057bd64`
  (plik w `src-tauri/target/x86_64-pc-windows-msvc/release/`)

Procedura sprawdzenia przed uruchomieniem (PowerShell, bez instalacji):

```powershell
Get-FileHash -LiteralPath "<ścieżka>\VELORA_0.9.2_x64-setup.exe" -Algorithm SHA256
Get-AuthenticodeSignature -LiteralPath "<ścieżka>\VELORA_0.9.2_x64-setup.exe"   # instalator nie jest podpisany (README)
```

Skrót musi być równy `89ca2e46…`. Dla CI: artefakt `VELORA-Windows-x64-9b23ecab…`
zawiera ten sam plik; jego skrót jest w podsumowaniu kroku „Record Windows installer SHA-256".

## 4. Plan bezpiecznej instalacji testowej (NIE WYKONYWAĆ bez zgody)

Zasada: nic poza VELORĄ nie jest dotykane (Steam, gry, Edge, Playnite, inne aplikacje).

### 4.1 Przed instalacją (wszystko tylko do odczytu lub kopiowania)

1. Zapisz wersję i skrót działającej wersji:
   `Get-FileHash` na zainstalowanym `nexus-aurea.exe`. Zapisz też datę instalacji.
2. Skopiuj **obecny instalator** 0.9.2 do osobnego folderu backupu, z datą w nazwie.
   Jeśli nie ma go na dysku, zachowaj bieżący plik `uninstall.exe` i cały katalog instalacji.
3. Zrób **backup działającego pliku EXE i katalogu instalacji** (jak w
   `C:\Users\milos\VELORA-rollback-2026-11-12\installed-0.9.2-app`):
   `nexus-aurea.exe`, `uninstall.exe`, skrót `VELORA.lnk`.
4. Zrób backup danych użytkownika: `velora-session.json` i pliku ustawień
   (wzór: `...\settings-and-shortcuts`). Zanotuj pełne ścieżki przed zmianami.
5. **Profil WebView2**: przed instalacją znajdź jego katalog (identyfikator
   `pl.nexus.aurea`, zwykle pod `%LOCALAPPDATA%`) i skopiuj go w całości.
   Nie usuwać go podczas instalacji ani rollbacku. Ścieżkę potwierdzić
   przez `dir`, nie zakładać.
6. Zamknij VELORĘ **normalnie** (okno, nie zabijanie procesu). Nie zamykaj Steam,
   gier ani innych aplikacji. Jeśli VELORA ma uruchomione okno Edge, zamknie je
   tylko polityka aplikacji (WM_CLOSE), nie ręcznie.

### 4.2 Instalacja (po zgodzie)

7. Sprawdź SHA-256 instalatora (sekcja 3). Jeśli nie zgadza się — stop.
8. Uruchom instalator (zalecany tryb interaktywny, bez `/S`, żeby widzieć, co się zmienia).
9. Nie zmieniaj folderu instalacji i nie wybieraj „usuń dane".

### 4.3 Kontrola po instalacji

10. Wersja: właściwości `nexus-aurea.exe` → wersja 0.9.2; SHA-256 zainstalowanego
    pliku musi równać się skrótowi binarki z sekcji 3.
11. Dane: `velora-session.json` i ustawienia są na miejscu i nie zostały wyczyszczone.
12. Profil WebView2 istnieje i ma tę samą lokalizację.
13. Brak zmian w Steam, grach i innych aplikacjach (sprawdzić wzrokiem, nie zakładać).

### 4.4 Szybki rollback (gdyby coś poszło źle)

14. Zamknij VELORĘ normalnie.
15. Odinstaluj kandydata (`uninstall.exe` z katalogu instalacji lub Ustawienia
    Windows → Aplikacje) i **nie usuwaj** folderów z danymi.
16. Przywróć backup: skopiuj zachowany `nexus-aurea.exe` i `uninstall.exe` z
    backupu do katalogu instalacji, albo zainstaluj zachowany instalator 0.9.2.
17. Przywróć `velora-session.json` i ustawienia z backupu, jeśli zostały nadpisane.
18. Przywróć profil WebView2 z kopii, jeśli został zmieniony.
19. Sprawdź SHA-256 przywróconego `nexus-aurea.exe` z wartością z punktu 1.
    Test rollbacku jest zaliczony dopiero po tym kroku.

## 5. Checklista testów z kanapy (pierwszy kontrolowany test)

Wynik każdego punktu: **PASS / FAIL / NOT RUN**. PASS wolno wpisać tylko po
faktycznym wykonaniu testu na sprzęcie.

| # | Test | Wynik | Uwagi |
|---|---|---|---|
| 1 | Start VELORY: ekran główny, dock, fokus, wygląd Grand Cinema | | |
| 2 | Nawigacja DualSense: D-pad, Cross (wybór), Circle (wstecz) | | |
| 3 | Wyszukiwarka: menu → Control Center → Szukaj, wpisanie, wynik | | |
| 4 | Klawiatura ekranowa: litery, Gotowe, Anuluj, powrót fokusu | | |
| 5 | Netflix: start, powrót do VELORY | | |
| 6 | Disney+: start, powrót do VELORY | | |
| 7 | YouTube: start, powrót do VELORY | | |
| 8 | Powrót do VELORY po zamknięciu aplikacji (fokus na kafelku) | | |
| 9 | Pilot iPhone: parowanie, nawigacja, Home | | |
| 10 | Restart VELORY: sesja odzyskana, brak utraty ustawień | | |
| 11 | Wybudzenie ze snu: VELORA nadal reaguje | | NOT RUN od poprzednich sprintów |
| 12 | Restart Windows i logowanie | | |

## 6. Czego ten dokument nie potwierdza

- Żaden punkt sprzętowy nie został wykonany: DualSense, pilot iPhone, Netflix,
  Disney+, YouTube, sen/wybudzenie, restart Windows.
- Instalator nie został zainstalowany ani uruchomiony na MSI.
- Działanie aplikacji streamingowych zależy od zewnętrznych klientów i kont.
