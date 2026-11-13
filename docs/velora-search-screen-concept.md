# Koncepcja: osobny ekran wyszukiwania w stylu Grand Cinema

Status: **koncepcja, bez wdrożenia.** Ten dokument nie zmienia kodu. Wdrożenie
wymaga testu ergonomii na sprzęcie (kanapa, TV, DualSense, pilot iPhone) i decyzji
właściciela.

## 1. Stan obecny (sprawdzony w kodzie)

- Wyszukiwarka to zakładka „Szukaj" w Control Center:
  `src/components/AppSearchPanel.tsx` (58 linii): pole, linia statusu i lista
  przycisków wyników.
- Ścieżka z ekranu głównego do uruchomienia aplikacji: menu (F2 / Options) →
  Control Center → zakładka Szukaj → select na polu → klawiatura ekranowa →
  „Gotowe" → wybór wyniku → select. To pięć kroków i dwa modale nałożone na siebie.
- Klawiatura zapisuje tekst dopiero po „Gotowe" (`useVirtualKeyboardHost.commit`),
  więc wyniki nie zmieniają się podczas pisania.
- Wyniki to lista. Ekran główny używa kafelków w siatce `home-dock`, więc wyszukiwarka
  wygląda inaczej niż reszta VELORY.

## 2. Ograniczenia, których nie wolno naruszyć

- README: wygląd i układ **AUREA Grand Cinema** pozostają bez zmian. Nowy ekran
  używa tych samych tokenów kolorów, typografii i kafelków.
- Wejście: DualSense, pilot iPhone i klawiatura fizyczna przechodzą przez wspólny
  model intencji (`src/services/navIntent.ts`). Ekran nie może dodać drugiej
  ścieżki wejścia.
- Polityka Edge i Steam/Playnite nie zmienia się: ekran wyszukiwania tylko
  uruchamia pozycje przez istniejące ścieżki startu.
- Ergonomia na TV nie była sprawdzona w tej sesji (brak sprzętu). Wszystkie
  decyzje poniżej są hipotezami do sprawdzenia.

## 3. Propozycja

1. **Wejście jednym przyciskiem** z ekranu głównego (np. osobny element docka),
   zamiast przez Control Center.
2. **Pełnoekranowy overlay** w stylu Grand Cinema: pole na górze, pod nim siatka
   wyników w tym samym układzie kafelków co `home-dock`.
3. **Wyniki na żywo.** Każdy znak odświeża listę. Wymaga to zmiany semantyki
   zapisu klawiatury (dziś zapis tylko przy „Gotowe"). Decyzja po teście:
   podgląd na żywo albo nadal „Gotowe".
4. **Fokus:** pole → klawiatura (modal) → z powrotem do pola. Z pola w dół do
   siatki wyników. Back zamyka ekran i przywraca fokus na docku.
5. **Control Center:** zakładka Szukaj zostaje jako rezerwa, aż ekran zostanie
   sprawdzony na sprzęcie. Nie usuwać jej przed tym.

## 4. Pytania do sprawdzenia na sprzęcie (przed wdrożeniem)

- Ile wyników jest czytelnych z kanapy bez przewijania; czy 3–4 kolumny to
  właściwy rozmiar kafelka.
- Czy użytkownik pada oczekuje wyników na żywo, czy wolałby „Gotowe".
- Czy przejście fokusu z klawiatury do siatki na DualSense jest intuicyjne
  (kierunki, Cross, Circle).
- Czy Home zawsze wraca do ekranu głównego, a nie do zamkniętego ekranu
  wyszukiwania albo do Control Center.
- Czy pilot iPhone (zob. `remoteCommand.ts`) prowadzi fokus tak samo jak pad.

## 5. Ryzyka

- **Trzecia warstwa modalna** (ekran → klawiatura → Control Center, jeśli zostaje
  otwarte pod spodem). Komplikuje fokus i Escape. Każda warstwa musi mieć jedno
  miejsce zamknięcia.
- **Duplikacja listy wyników** z `AppSearchPanel`. Wspólny komponent wyników
  rozwiązuje to przed wdrożeniem.
- **Wyniki na żywo** zmieniają semantykę `commit`. Testy
  `virtualKeyboard*.test.ts` i nowy `searchKeyboardIntegration.test.tsx`
  muszą zostać zaktualizowane w tym samym PR.

## 6. Kryteria akceptacji (dla przyszłego Draft PR, nie teraz)

- Ekran otwiera się jednym przyciskiem z ekranu głównego.
- Wszystkie scenariusze z `src/__tests__/searchKeyboardIntegration.test.tsx`
  nadal przechodzą.
- Nawigacja po strefach z otwartym modalem (`navigationZones.test.tsx`) bez regresji.
- Test na sprzęcie: DualSense Cross/Circle i D-pad, pilot iPhone, klawiatura
  fizyczna, Back i Home. Wynik zapisany jako PASS albo NOT RUN, nigdy bez testu.
