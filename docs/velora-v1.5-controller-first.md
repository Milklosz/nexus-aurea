# VELORA 1.5 — Controller-First Experience

Status: **Draft PR. Hardware checks NOT RUN.** Ten dokument opisuje, co zostało
zaimplementowane i testowane w kontenerze Linux. Nic tutaj nie dowodzi działania
na prawdziwym MSI, Windows ani fizycznym DualShock 4.

## 1. Baza i zależności

- Kod opiera się na łańcuchu PR #20 → PR #21 (oba nadal drafty, nie scalone).
  Nawigacja, obsługa Home i fokus, które rozszerza ten sprint, nie są w `main`.
- Gałąź roboczą zbudowano na głowie PR #21 (`claude/zealous-ride-swcraj`). Head
  PR #21 został zmergowany do gałęzi roboczej, nie przepisany, więc gałąź
  przesuwa się do przodu bez force-push. Żaden istniejący PR nie został zmieniony.
- Po scaleniu #20 i #21 ten PR należy przepiąć na `main` (rebase albo zmiana bazy).

## 2. Kontroler: DualShock 4 jako cel

Cel sprzętowy to **DualShock 4** (Sony VID `0x054C`, PID `0x05C4` / `0x09CC`).
Profil PlayStation rozpoznaje go po identyfikatorze Gamepad API
(`Wireless Controller`, `054c`), a mapowanie standard po `mapping === "standard"`.

| Akcja | DS4, profil PlayStation (surowe) | Standard (`mapping: "standard"`) |
|---|---|---|
| Potwierdź | ✕ = B1 | A = B0 |
| Wstecz | ◯ = B2 | B = B1 |
| Options | B9 | B9 |
| Home | PS = B12, razem z Options w oknie 250 ms | PS = B16, razem z Options |
| Kierunki | hat na osi A9 + lewy analog (A0/A1) | D-pad B12–B15 + lewy analog |

Uwagi:

- W surowym układzie Sony B12 to PS, a nie D-pad. Dlatego D-pad czytany jest z hata
  na osi 9, a przyciski 12/13 są ignorowane w profilu PlayStation. Dekodowanie
  hata obejmuje osiem pozycji, a wartość neutralna i nieprawidłowe są ignorowane.
- Indeksy B1/B2 w profilu PlayStation to dotychczasowe mapowanie (diagnostyka
  pokazuje je jako ✕ B1 · ◯ B2). Nie zostały zmienione.

## 3. Home (PS + Options)

- Home = PS i Options naciśnięte w oknie 250 ms, w dowolnej kolejności.
  To ten sam chord, co w natywnej ścieżce `gamepad_home.rs`.
- Chord wyzwala się raz. Po nim Options musi zostać zwolniony, zanim zacznie się
  kolejny chord. Globalny cooldown wynosi 750 ms.
- **Options jest opóźnione o 250 ms** (okno chorda). Dzięki temu chord nie otwiera
  Control Center. Pojedyncze naciśnięcie Options nadal działa, ale z tym opóźnieniem.
- PS samo w sobie nie wywołuje Home. To świadome odwzorowanie natywnego chorda.
  Jeśli Home ma być na samo PS, to zmiana decyzji do zatwierdzenia.
- **Natywna ścieżka DualSense (`gamepad_home.rs`) nie obsługuje DS4.** Rozpoznaje
  wyłącznie PID `0x0CE6` i `0x0DF2`, a test w tym pliku wprost wyklucza `0x05C4`.
  Home dla DS4 działa więc tylko w WebView, gdy VELORA ma fokus i nic nie zabiera
  przycisku PS (np. Steam Input).

## 4. Nawigacja padem

| Kontekst | Kierunki | Potwierdź | Wstecz | Home |
|---|---|---|---|---|
| Ekran główny | ↑/↓ przechodzi między strefami: Control Center, odtwarzacz Background Mode, dock, Diagnostyka pada; ←/→ po kafelkach docka albo po przyciskach odtwarzacza | uruchamia usługę (w docku) albo wybiera przycisk | fokus na pierwszy kafelek | ekran główny (`returnVeloraHome`) |
| Dialog (Control Center, Diagnostyka) | poprzedni/następny element | klik fokusowanego elementu | zamyka dialog | ekran główny |
| Klawiatura ekranowa | ruch po klawiszach (↑/↓ między rzędami) | wpisuje fokusowany klawisz | anuluje i przywraca tekst | zamyka, tekst zostaje |
| Options | — | — | — | otwiera Control Center; ignorowane, gdy otwarta jest klawiatura |

Pilot iPhone używa tych samych ścieżek co pad dla ↑/↓ i ←/→. Gdy klawiatura jest
otwarta, pilot może cofnąć (Wstecz), wyjść (Home), ale nie wybiera klawiszy. Komenda
„wybierz” zwraca wtedy komunikat. Strzałki klawiatury komputera na ekranie głównym
zachowują dotychczasowe skróty.

## 5. Klawiatura ekranowa VELORY

- Otwierana **Confirm na polu tekstowym VELORY** (`input` typu text, search, email,
  url, tel albo `textarea`). Pola hasła i pola tylko do odczytu są odrzucane.
- Każdy klawisz zapisuje się przez zdarzenie `input` w polu (ustawienie wartości
  przez natywny setter). Właściciel pola pozostaje jedynym źródłem prawdy.
- **Back / Escape / Anuluj** przywracają tekst sprzed otwarcia i zamykają klawiaturę.
- **Gotowe** zostawia wpisany tekst i zamyka klawiaturę.
- **Home** zostawia wpisany tekst i oddaje fokus ekranowi głównemu, bo użytkownik
  opuszcza pole.
- Po Back i Gotowe fokus wraca do pola. Jeśli pole zniknęło, fokus idzie na dock.
- Klawisze fizyczne działają tylko przy otwartej klawiaturze. Tab nie wychodzi z
  klawiatury. Klawisze nie docierają do skrótów okna (F2, F3, strzałki docka).
- Limit długości bierze się z `maxLength` pola, a gdy go nie ma, wynosi 120 znaków.
- Układ: cyfry, litery w tym ą ć ę ł ń ó ś ź ż, znaki `. , - _ @`, Shift (działa
  jednorazowo), Spacja, Usuń, Gotowe, Anuluj.
- W tej wersji jedynym konsumentem jest **pole testowe w Diagnostyce pada**.
  VELORA nie ma innego pola tekstowego w głównym interfejsie. Gdzie klawiatura ma
  być używana na co dzień (np. wyszukiwarka Playnite), to decyzja produktowa.

## 6. Granice bezpieczeństwa

- Brak globalnego przechwytywania klawiatury. Klawisze są obsługiwane tylko wtedy,
  gdy zdarzenie dociera do WebView VELORY.
- Brak wstrzykiwania tekstu do innych aplikacji (brak `SendInput`, hooków, `enigo`,
  `rdev`, `uinput`). Testy niezmienników pilnują tego w kodzie klawiatury i silnika.
- Brak zmian w Rust, konfiguracji Tauri 2 i capabilities w tym sprincie.
- Brak `setFocus` w nowym kodzie. Test niezmienników pilnuje tego w `App.tsx`.
- Wygląd AUREA Grand Cinema zachowany. Nowe reguły CSS są dopisane na końcu
  `styles.css` i nie zmieniają istniejących selektorów.

## 7. Testy automatyczne

- `src/__tests__/controllerFirst.test.ts`: DS4 (rozpoznawanie, B12 to PS, hat,
  mapowanie standard), oś pionowa, chord Home (kolejność, cooldown, brak replay).
- `src/__tests__/controllerEngine.test.ts`: zaktualizowany test Options (opóźnienie
  o okno chorda).
- `src/__tests__/virtualKeyboard.test.ts`: układ, ruch kursora po nierównych rzędach,
  edycja, Shift, limit długości.
- `src/__tests__/virtualKeyboardFocus.test.tsx`: otwieranie z pola, Confirm wpisuje,
  Back przywraca tekst i fokus, Gotowe, Home, klawisze fizyczne, Tab, brak wycieku
  klawiszy do skrótów okna, odrzucanie haseł i pól tylko do odczytu, znikające pole.
- `src/__tests__/controllerFirstInvariants.test.ts`: zakaz przechwytywania globalnego
  i wstrzykiwania, routing w `App.tsx`, konfiguracja Tauri 2, obecność dokumentu.

## 8. Lista sprawdzeń na prawdziwym sprzęcie (NOT RUN)

Każdy punkt wymaga fizycznego DS4 i MSI. Żaden nie został wykonany w kontenerze.

1. **DS4 przez USB**: ✕ potwierdza, ◯ wraca, Options otwiera Control Center (z opóźnieniem 250 ms).
2. **DS4 przez Bluetooth**: to samo co wyżej. Sprawdzić, czy mapowanie się nie zmienia.
3. **D-pad DS4 (hat na osi A9)**: ←/→/↑/↓ w każdym kierunku, w tym po ukosie.
   Panel „Diagnostyka pada” pokazuje surowe osie. Jeśli hat nie jest na A9, trzeba
   zapisać wartości i poprawić dekodowanie.
4. **Lewy analog**: ruch w pionie i poziomie, brak dryfu przy puszczonym drążku.
5. **Home (PS + Options)**: uruchamia się raz, nie uruchamia się przy samym PS,
   nie otwiera Control Center, cooldown nie blokuje normalnego użycia.
6. **Steam Input włączony i wyłączony**: sprawdzić, czy VELORA dostaje przycisk PS,
   i co robi Steam przy PS.
7. **Klawiatura z pola testowego w Diagnostyce**: otwiera się, fokus trafia na klawisz,
   litery z Polski wpisują się poprawnie, Shift działa jednorazowo.
8. **Back i Gotowe**: Back przywraca tekst, Gotowe go zostawia, fokus wraca do pola.
9. **Home z klawiatury**: zamyka klawiaturę, ekran główny dostaje fokus, tekst zostaje.
10. **Powrót okna przy otwartej klawiaturze**: fokus nie wraca do docka.
11. **Pilot iPhone podczas klawiatury**: nawigacja nie wpisuje tekstu w nieoczekiwane miejsce.
12. **Brak wstrzykiwania**: w innej aplikacji (np. Notatnik) nic się nie pojawia, gdy
    klawiatura VELORY jest używana.
13. **Układ przy minimalnej szerokości 780 px**: klawiatura mieści się bez przewijania poziomego.
14. **Build Windows w GitHub Actions**: zielony na tym PR (sprawdzane przed utworzeniem PR).
