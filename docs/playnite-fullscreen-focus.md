# Playnite Fullscreen — obserwacja procesów i polityka fokusu

Dotyczy sesji uruchomionej z VELORA przez `launch_managed_app("playniteFullscreen")`.

## Co obserwuje backend

- Backend odczytuje jednym snapshotem Toolhelp dwa procesy: `Playnite.FullscreenApp.exe` i `Playnite.DesktopApp.exe`.
- Sesja Fullscreen zaczyna się dopiero po zaobserwowaniu procesu Fullscreen. Sama wcześniej uruchomiona aplikacja Desktop nie jest traktowana jako sesja Fullscreen.
- Przejście **Fullscreen → Desktop** (proces Fullscreen znika, ale Desktop nadal działa) jest zmianą trybu, a nie końcem sesji. VELORA nie wysyła wtedy zdarzenia zakończenia i nie zmienia fokusu; użytkownik pozostaje w Playnite Desktop.
- Koniec sesji jest zgłaszany dopiero wtedy, gdy **oba** procesy są nieobecne przez co najmniej 5 sekund. Pojedynczy błąd odczytu listy procesów zeruje ten czas i nie jest traktowany jako zakończenie.
- Jeśli proces Fullscreen nie pojawi się w ciągu 60 sekund od uruchomienia, watcher kończy się bez zdarzenia zakończenia, aby nie blokować kolejnych prób uruchomienia.
- Po 12 godzinach watcher kończy się bez zgłaszania zakończenia sesji.

## Kiedy VELORA wraca na pierwszy plan

Po potwierdzonym końcu sesji backend sprawdza proces okna pierwszoplanowego. VELORA prosi o fokus tylko wtedy, gdy na pierwszym planie jest:

- `explorer.exe`, ale tylko gdy aktywne okno to faktyczny pulpit Windows (klasa `Progman`, `WorkerW` lub `SHELLDLL_DefView`),
- `Playnite.FullscreenApp.exe` albo `Playnite.DesktopApp.exe` (kończąca się sesja Playnite),
- VELORA (`nexus-aurea.exe` / `velora.exe`),
- brak okna pierwszoplanowego.

Jeśli pierwszy plan należy do innej aplikacji (np. Chrome, Steam, edytor, gra, okno Eksploratora plików albo pasek zadań), VELORA **nie przejmuje fokusu**. Zdarzenie `managed-app-exited` zawiera wtedy `shouldFocus: false` oraz nazwę aktywnego procesu. Frontend nie wywołuje `unminimize`/`setFocus`; pokazuje jedynie komunikat, że sesja Playnite się zakończyła.

Jeśli istnieje aktywne okno, ale Windows nie pozwala ustalić nazwy jego procesu (np. aplikacja o podwyższonych uprawnieniach), VELORA traktuje to jak inną aplikację i również nie przejmuje fokusu.

Jeśli Windows odmówi aktywacji okna, VELORA pokazuje komunikat z awaryjnym powrotem przez `Alt+Tab`. Skrót Control Service `Ctrl+Alt+N` pozostaje niezależną drogą powrotu.

## Ochrona przed przejęciem fokusu

- Decyzja jest podejmowana po stronie backendu, na podstawie rzeczywistego procesu pierwszoplanowego, a nie nazwy zdarzenia.
- VELORA nie używa pętli wymuszającej foreground ani nie zamyka aplikacji użytkownika.
- Odczyt dotyczy nazwy procesu oraz klasy okna pierwszoplanowego; VELORA nie czyta tytułów okien, zawartości okien ani argumentów procesów.

## Ograniczenia

- Polityka zależy od tego, co Windows zgłasza jako okno pierwszoplanowe w momencie końca sesji. Jeśli użytkownik przełączy aplikację dokładnie w tej samej chwili, możliwy jest wyścig; VELORA nadal nie wymusza fokusu w pętli.
- Zachowanie wymaga testu na MSI z rzeczywistym Playnite Fullscreen i Desktop. Testy jednostkowe sprawdzają logikę przejść i decyzję o fokusie, nie politykę foreground Windows.
