# VELORA 1.0 — Edge Cinema (obszar A)

Dokument opisuje bezpieczne, dedykowane uruchamianie serwisów streamingowych
w okienku **Microsoft Edge** zamiast domyślnej przeglądarki systemowej.

## Idea

Do tej pory adresy serwisów (Netflix, Disney+, HBO Max, Prime Video, YouTube)
były otwierane przez `openUrl`, czyli w domyślnej przeglądarce systemu.
Edge Cinema zastępuje to **osobnym oknem Edge w trybie aplikacji i na pełnym
ekranie**, ze stałym, odizolowanym profilem.

## Dedykowany profil i trwałość logowań

- Profil: `VELORA-EdgeCinema`, katalog
  `<LOCALAPPDATA>/VELORA/VELORA-EdgeCinema`.
- Jest to **własny folder danych aplikacji VELORA** tworzony przez
  `std::fs::create_dir_all` — nie jest to żadne ustawienie systemowe ani zmiana
  w powłoce Windows.
- Profil jest **trwały**: zalogowania do serwisów, ciasteczka i ustawienia
  pozostają między kolejnymi uruchomieniami VELORA. Użytkownik loguje się
  jednorazowo, tak jak w zwykłym Edge.
- Flaga `--no-first-run` i `--no-default-browser-check` wyłączają ekrany
  powitalne; VELORA nie zmienia domyślnej przeglądarki.

## Tryb uruchomienia (app-mode / pełny ekran)

Okno jest uruchamiane przez `std::process::Command` ze **stałym, zamkniętym
zestawem flag**:

```
--app=<dokładnie dopasowany, zaufany adres>
--start-fullscreen
--user-data-dir=<LOCALAPPDATA>/VELORA/VELORA-EdgeCinema
--no-first-run
--no-default-browser-check
--window-name=VELORA-EdgeCinema
```

Proces jest **odłączany** (`spawn` + `drop(child)`): VELORA na niego nie czeka,
nie zabija go i nie przejmuje jego cyklu życia.

**Flagi zabronione** (nie są używane i są sprawdzane w testach): `--kiosk`,
`--incognito`, `--disable-gpu`, `--disable-drm`, `--disable-features=...`,
`--no-sandbox`, a także jakikolwiek `--user-data-dir` wskazujący poza profil
VELORA. Dzięki temu nie osłabiamy DRM, logowania ani izolacji procesu.

## Allowlista zweryfikowanych adresów (TS + Rust)

Walidacja jest **dwupoziomowa (defense in depth)**:

1. **TypeScript** (`openStreamingService.ts`): `isOfficialHttpsUrl(href,
   allowedHost)` sprawdza protokół `https:`, dokładny host, brak portu i danych
   użytkownika. Niezaufany adres jest odrzucany z komunikatem
   `Adres usługi nie znajduje się na liście zaufanych stron.` — zanim cokolwiek
   zostanie wywołane.
2. **Rust** (`edge_cinema.rs`): niezależna, **dokładna** allowlista pięciu
   oficjalnych adresów HTTPS z `src/data/streamingServices.ts`. Każdy inny ciąg
   jest odrzucany polskim błędem.

Do polecenia Edge trafia **wyłącznie dopasowana stała z allowlisty**, nigdy
surowy ciąg z frontendu. Adres jest przekazywany jako jedna, nieprzezroczysta
wartość `--app=...` (bez dzielenia na argumenty, bez powłoki), co uniemożliwia
wstrzyknięcie dodatkowych flag (argument injection). Nie używamy żadnej
biblioteki do parsowania URL po stronie Rust.

Pięć dozwolonych adresów:

- `https://www.netflix.com/pl/`
- `https://www.disneyplus.com/pl-pl`
- `https://www.hbomax.com/pl/pl`
- `https://www.primevideo.com/-/pl_PL/?tr=pl`
- `https://www.youtube.com/`

## Obsługa błędów

Błędy warstwy natywnej są mapowane na czytelne, polskie wskazówki
(`streamingServiceErrorMessage` / `edgeCinemaErrorMessage`):

| Sytuacja | Wskazówka |
| --- | --- |
| Nie wykryto `msedge.exe` | „Nie znaleziono przeglądarki Microsoft Edge. Zainstaluj Edge i spróbuj ponownie." |
| Nie udało się utworzyć katalogu profilu | „Nie udało się przygotować dedykowanego profilu Edge Cinema. Sprawdź uprawnienia do folderu danych aplikacji i spróbuj ponownie." |
| Błąd `spawn` okna | „Nie udało się uruchomić okna Edge Cinema. Sprawdź instalację Edge i spróbuj ponownie." |
| Błąd związany z DRM/4K/HDR | Krótka notatka o braku gwarancji (patrz niżej) |
| Nieznany błąd | Dotychczasowy komunikat ogólny, bez zmian |

`msedge.exe` jest wykrywany w `ProgramFiles`, `ProgramFiles(x86)` i
`LOCALAPPDATA` (wzorzec `browser_paths` z `app_manager.rs`) wyłącznie przez
odczytowe `Path::is_file()`.

W podglądzie WWW (poza Tauri) `launchEdgeCinema` rzuca jasny błąd i **nigdy**
nie wywołuje `window.open`; serwis nie dotyka natywnej warstwy. Wyłącznie
`openStreamingService` zachowuje w podglądzie jawnie udokumentowany fallback
`window.open(..., "_blank", "noopener,noreferrer")`.

## Czego VELORA NIE gwarantuje

VELORA **nie gwarantuje ani nie zmienia**:

- obsługi DRM / Widevine / PlayReady,
- jakości 4K, HDR, HDCP,
- możliwości GPU i sterowników,
- poziomu subskrypcji oraz dostępności usługi i jej katalogu.

Te właściwości zależą wyłącznie od sprzętu, systemu Windows, sterowników,
przeglądarki Edge, planu subskrypcji i samego dostawcy streamingu. VELORA
**nie wyłącza, nie omija i nie osłabia** DRM, Widevine, PlayReady ani HDCP;
nie dodaje flag, które psułyby DRM lub trwałość logowania.

## Brak zmian systemowych

- Brak zmian w systemie Windows, powłoce, rejestrze, ustawieniach domyślnej
  przeglądarki czy grupach zasad.
- Brak nowych zależności npm / cargo i brak zmian w `Cargo.lock`.
- Brak edycji CSP, capabilities i uprawnień Tauri (bez osłabiania
  bezpieczeństwa).
- Kod specyficzny dla Windows jest zamknięty w blokach
  `#[cfg(target_os = "windows")]`; na macOS moduł się kompiluje, a komendy
  zwracają błąd „Edge Cinema jest dostępne tylko w natywnej aplikacji
  Windows.".

## Ręczna lista kontrolna (MSI, Windows)

Do sprawdzenia na czystej maszynie z zainstalowanym MSI:

- [ ] VELORA uruchamia się; w Control Center wybór Netflix/Disney+/HBO Max/
      Prime Video/YouTube otwiera **osobne okno Edge**, a nie domyślną
      przeglądarkę (np. Chrome/Firefox).
- [ ] Okno startuje w trybie aplikacji (brak paska adresu/kart) i na pełnym
      ekranie; tytuł okna to `VELORA-EdgeCinema`.
- [ ] Katalog `%LOCALAPPDATA%\VELORA\VELORA-EdgeCinema` istnieje i jest
      tworzony przy pierwszym uruchomieniu.
- [ ] Logowanie do serwisu działa i **pozostaje** po zamknięciu okna oraz
      ponownym uruchomieniu VELORA (trwałość profilu).
- [ ] VELORA nie ustawia się jako domyślna przeglądarka; nie pojawia się
      ekran pierwszego uruchomienia Edge.
- [ ] Po odinstalowaniu / braku Edge pojawia się komunikat
      „Nie znaleziono przeglądarki Microsoft Edge...".
- [ ] Próba użycia niezaufanego adresu jest odrzucana (TS i Rust) — okno Edge
      się nie uruchamia.
- [ ] Odtwarzanie w jakości zależnej od DRM/4K/HDR jest weryfikowane zgodnie z
      możliwościami sprzętu/subskrypcji; VELORA nie obiecuje konkretnej
      jakości.
- [ ] Zamknięcie okna Edge nie wyłącza ani nie zawiesza VELORY (proces
      odłączony).
- [ ] Brak zmian w `msedge.exe`, systemie, powłoce i ustawieniach DRM.
