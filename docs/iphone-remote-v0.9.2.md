# VELORA iPhone Remote — v0.9.2

## Przygotowanie iPhone'a

1. W Control Center wybierz **Przygotuj profil zaufania iPhone'a**. Aplikacja zapisze profil `.mobileconfig` w Pobranych i pokaże odcisk SHA-256 certyfikatu.
2. Przenieś profil na iPhone'a zaufanym kanałem, na przykład AirDropem bezpośrednio do swojego urządzenia. Nie otwieraj profilu z nieznanego linku ani sieci publicznej.
3. Na iPhonie otwórz **Ustawienia → Ogólne → VPN i zarządzanie urządzeniem**, wybierz profil VELORA i zainstaluj go.
4. Wybierz **Ustawienia → Ogólne → To urządzenie → Ustawienia zaufania certyfikatów** i włącz pełne zaufanie dla VELORA LAN Remote CA.

Pełne zaufanie certyfikatowi głównemu pozwala iPhone'owi ufać certyfikatom TLS wystawionym przez ten urząd certyfikacji na całym urządzeniu. Prywatny klucz urzędu pozostaje w Magazynie poświadczeń Windows i nigdy nie trafia do profilu. Instaluj certyfikat tylko wtedy, gdy ufasz MSI, na którym wygenerowano profil. Po zakończeniu testów usuń profil VELORA z iPhone'a.

## Uruchomienie i parowanie

1. Po instalacji i włączeniu zaufania zaznacz potwierdzenie w Control Center i uruchom serwer HTTPS.
2. Upewnij się, że MSI i iPhone są połączone z tą samą prywatną siecią Wi-Fi. Aplikacja wybiera jeden prywatny adres IPv4 i nie dodaje reguł Zapory Windows.
3. W Safari wpisz dokładny adres HTTPS pokazany w Control Center. Jeśli Safari zgłasza błąd certyfikatu, zatrzymaj się i nie omijaj ostrzeżenia.
4. W Control Center wygeneruj kod. Wpisz go w Safari w ciągu 60 sekund, podając nazwę iPhone'a. Kod działa raz.
5. Opcjonalnie dodaj stronę do ekranu początkowego. Pilot oferuje wyłącznie nawigację, wybór, Wstecz, Home, głośność i profile Cinema/Gaming/Desktop.

## Ochrona i wyłączenie

- Klucz urządzenia jest zapisywany dopiero po odpowiedzi `201 Created` z serwera i zawiera znacznik potwierdzenia. Klucz bez tego znacznika (np. z wcześniejszej wersji pilota) jest odrzucany, więc po aktualizacji może być wymagane jednorazowe ponowne sparowanie.
- Zapytania statusu, parowania i poleceń mają limit czasu 8 sekund z `AbortController`. Utracona odpowiedź parowania nie oznacza sukcesu; formularz pozostaje otwarty, a użytkownik musi wygenerować nowy kod i spróbować ponownie.
- Serwer jest domyślnie wyłączony i wiąże się wyłącznie z wykrytym prywatnym adresem IPv4 na porcie 47862.
- Komendy wymagają TLS, sparowanego klucza HMAC, rosnącego numeru sekwencji i dokładnego Origin/Host. Kod parowania wygasa po minucie; próby są ograniczone. Serwer przyjmuje najwyżej 8 iPhone'ów i 20 komend na sekundę na urządzenie.
- Sekrety i klucz CA są przechowywane w Magazynie poświadczeń Windows. Safari przechowuje nieeksportowalny klucz HMAC w IndexedDB.
- W Control Center możesz odwołać dostęp jednego urządzenia lub wszystkich urządzeń. **Wyłącz serwer LAN** kończy nasłuchiwanie. Odwołanie połączenia iPhone'a nie usuwa profilu zaufania.
- Po teście usuń profil w **Ustawienia → Ogólne → VPN i zarządzanie urządzeniem**; sprawdź też, że pełne zaufanie dla certyfikatu jest wyłączone.

## Wersja przenośna — odwracalna walidacja parowania (bezpieczny tryb testowy)

W wersji przenośnej profil zaufania **nie jest** zapisywany do folderu Pobrane. Instalacja przebiega wyłącznie lokalnie i wymaga wyraźnej zgody:

1. W panelu iPhone Remote zaznacz zgodę na przygotowanie profilu (pole jest domyślnie niezaznaczone). Przed zaznaczeniem zostaje wyświetlona rozwiązana ścieżka `<VELORA-Portable-Data>\trust\VELORA-LAN-Remote.mobileconfig` oraz odcisk SHA-256 certyfikatu CA.
2. Kliknięcie **Przygotuj profil zaufania iPhone'a** wymaga jednorazowego potwierdzenia z lokalnego IPC (ważnego 120 sekund, jednorazowego). Profil jest zapisywany tylko w katalogu danych wersji przenośnej; weryfikacja w kodzie gwarantuje, że ścieżka znajduje się w tym katalogu. Ani certyfikat, ani magazyn zaufania systemu Windows nie są modyfikowane.
3. Porównaj wyświetlony odcisk SHA-256 z odciskiem pokazywanym przez iOS przy instalacji profilu. Jeśli się nie zgadza — zatrzymaj test.
4. Przenieś plik ręcznie zaufanym kanałem (np. AirDrop do własnego urządzenia) i zainstaluj go na iPhonie w **Ustawienia → Ogólne → VPN i zarządzanie urządzeniem**. Następnie włącz pełne zaufanie w **Ustawienia → Ogólne → To urządzenie → Ustawienia zaufania certyfikatów**.
5. MSI i iPhone muszą być w tej samej prywatnej sieci Wi-Fi. Otwórz dokładny adres HTTPS z Control Center. Kod QR zawiera w fragmencie URL wyłącznie jednorazowy kod, adres serwera i krótki czas ważności — bez tokenu, klucza ani odcisku. **Nie omijaj ostrzeżeń TLS w Safari.**
6. Po teście użyj **Wyczyść dane zaufania (cofnij)** z osobnym, wyraźnym potwierdzeniem: lokalna komenda zatrzymuje serwer, usuwa wygenerowany profil wyłącznie z katalogu przenośnego i odwołuje wszystkie urządzenia. Na iPhonie usuń profil w **Ustawienia → Ogólne → VPN i zarządzanie urządzeniem** i wyłącz pełne zaufanie w **Ustawienia zaufania certyfikatów**. Żadna z tych czynności nie jest dostępna przez sieć LAN.

To jest wyłącznie bezpieczna, odwracalna metoda testowa. **Parowanie z prawdziwym iPhonem / MSI nie zostało zwalidowane** i pozostaje bramą sprzętową dla Lundy. Nie zgłaszaj wyniku "parowanie PASS" bez testu na fizycznym urządzeniu.
