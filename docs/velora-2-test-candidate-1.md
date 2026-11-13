# VELORA 2.0 — Kandydat testowy 1 (plan, weryfikacja, instalacja, checklista)

Status: **przygotowany, NIE zainstalowany.** Instalacja na MSI wymaga osobnej,
wyraźnej zgody właściciela po zapoznaniu się z wynikami.

## 1. Identyfikacja kandydata

| Element | Wartość |
|---|---|
| Gałąź oznaczona | `test/velora-2-candidate-1` |
| Gałąź PR | `test/velora-rc-stabilization` (Draft PR #48 → `test/velora-2-combined`) |
| Kod kandydata (SHA) | `36312486cebb5b523c24cf0754f4a317ad87f042` |
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

Punkt odniesienia dla S0 to pełny SHA `36312486cebb5b523c24cf0754f4a317ad87f042`.
Gałąź `stabilization/velora-2-s0` została wyprowadzona dokładnie z tego kandydata;
nie zmienia `main` ani bazowej gałęzi PR #48.

Sprint S0 jest prowadzony na osobnych Draft PR-ach. S0a: [PR #49](https://github.com/Milklosz/nexus-aurea/pull/49), head `934fd664e4b21c2a3f342413aa89b277718e0ff6`; Windows i macOS CI zakończyły się sukcesem w runie `43467145834`. S0b ma osobną gałąź i Draft PR; wyniki będą przypisane do dokładnego SHA jego headu. `main`, PR #48 i działająca instalacja nie zostały zmienione.

## 2. Wyniki bazowe na SHA `36312486`

| Sprawdzenie | Wynik |
|---|---|
| `pnpm test` (vitest) | PASS: 75 plików, 651 testów w runie #43422380871 |
| `pnpm build` (`tsc -b` + vite) | PASS w runach #43422385690 i #43422380871 |
| `cargo test --locked --lib` (src-tauri) | PASS: 264 testy na SHA `36312486` |
| Windows MSVC check i NSIS build | PASS na SHA `36312486` w runie #43422380871 |
| PR #48 i push jego head | PASS: runy #43422385690 i #43422381045, oba na SHA `36312486` |
| F01 — Windows Credential Manager | Nadal występuje: feature `windows-native` nie jest włączony, a nowy uchwyt nie odczytuje testowego wpisu mock backendu |
| F12 — build provenance | Nadal występuje: build.rs zapisuje krótki SHA i śledzi tylko `.git/HEAD` |

Są to wyniki bazowego commita i nie są zaliczane jako testy zmian S0.

## 3. Integralność instalatora

Zapis bazowy CI z runu #43422380871:

- Commit: `36312486cebb5b523c24cf0754f4a317ad87f042`
- SHA-256 instalatora z tego runu: `484da73086e17b711aa6f4e38d2d763372198a9bc8120987722767d099e2a26c`
- Drugi build tego samego commita zapisał SHA-256 `6578bf309d3be220dcb8667bb3e0adc456d726f918aaeb69e1d0648b9b0e6dc5`
- GitHub Actions artifact ZIP: `sha256:e085ced658f7f3053222b2803c28df84d2128b3cf4f175bd2f540a3aaa98c163`

SHA pliku instalatora różni się między kolejnymi buildami tego samego commita;
nie zakładamy deterministycznego wyniku NSIS. Bazowy CI nie zapisał hasha EXE
wyciągniętego z instalatora, więc ten zestaw dowodów nie wiąże instalatora z
konkretnym payloadem. SHA artifact ZIP Actions to osobny hash i nie zastępuje
SHA instalatora.

Procedura sprawdzenia przed uruchomieniem (PowerShell, bez instalacji):

```powershell
Get-FileHash -LiteralPath "<ścieżka>\VELORA_0.9.2_x64-setup.exe" -Algorithm SHA256
Get-AuthenticodeSignature -LiteralPath "<ścieżka>\VELORA_0.9.2_x64-setup.exe"
```

Powyższe hashe są dowodem historycznym dokładnie tych dwóch plików i nie są
kandydatem do instalacji. S0b dodaje manifest wytwarzany przy buildzie, który
zapisuje SHA setup.exe oraz rzeczywistego EXE i porównuje EXE z payloadem NSIS.

## 4. Plan bezpiecznej instalacji testowej (NIE WYKONYWAĆ bez zgody)

Ta procedura nie została wykonana i nie wskazuje obecnie instalatora S0. Wartości
z sekcji 3 są wyłącznie historycznymi hashami bazowego commita i nie mogą służyć
do weryfikacji ani uruchomienia nowego builda. Przyszły test może użyć wyłącznie
instalatora wraz z manifestem z ukończonego CI S0b, po osobnej wyraźnej zgodzie.

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
