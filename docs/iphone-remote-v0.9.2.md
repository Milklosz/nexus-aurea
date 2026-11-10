# NEXUS AUREA iPhone Remote — v0.9.2

## Przygotowanie iPhone'a

1. W Control Center wybierz **Przygotuj profil zaufania iPhone'a**. Aplikacja zapisze profil `.mobileconfig` w Pobranych i pokaże odcisk SHA-256 certyfikatu.
2. Przenieś profil na iPhone'a zaufanym kanałem, na przykład AirDropem bezpośrednio do swojego urządzenia. Nie otwieraj profilu z nieznanego linku ani sieci publicznej.
3. Na iPhonie otwórz **Ustawienia → Ogólne → VPN i zarządzanie urządzeniem**, wybierz profil NEXUS AUREA i zainstaluj go.
4. Wybierz **Ustawienia → Ogólne → To urządzenie → Ustawienia zaufania certyfikatów** i włącz pełne zaufanie dla NEXUS AUREA LAN Remote CA.

Pełne zaufanie certyfikatowi głównemu pozwala iPhone'owi ufać certyfikatom TLS wystawionym przez ten urząd certyfikacji na całym urządzeniu. Prywatny klucz urzędu pozostaje w Magazynie poświadczeń Windows i nigdy nie trafia do profilu. Instaluj certyfikat tylko wtedy, gdy ufasz MSI, na którym wygenerowano profil. Po zakończeniu testów usuń profil NEXUS z iPhone'a.

## Uruchomienie i parowanie

1. Po instalacji i włączeniu zaufania zaznacz potwierdzenie w Control Center i uruchom serwer HTTPS.
2. Upewnij się, że MSI i iPhone są połączone z tą samą prywatną siecią Wi-Fi. Aplikacja wybiera jeden prywatny adres IPv4 i nie dodaje reguł Zapory Windows.
3. W Safari wpisz dokładny adres HTTPS pokazany w Control Center. Jeśli Safari zgłasza błąd certyfikatu, zatrzymaj się i nie omijaj ostrzeżenia.
4. W Control Center wygeneruj kod. Wpisz go w Safari w ciągu 60 sekund, podając nazwę iPhone'a. Kod działa raz.
5. Opcjonalnie dodaj stronę do ekranu początkowego. Pilot oferuje wyłącznie nawigację, wybór, Wstecz, Home, głośność i profile Cinema/Gaming/Desktop.

## Ochrona i wyłączenie

- Serwer jest domyślnie wyłączony i wiąże się wyłącznie z wykrytym prywatnym adresem IPv4 na porcie 47862.
- Komendy wymagają TLS, sparowanego klucza HMAC, rosnącego numeru sekwencji i dokładnego Origin/Host. Kod parowania wygasa po minucie; próby są ograniczone. Serwer przyjmuje najwyżej 8 iPhone'ów i 20 komend na sekundę na urządzenie.
- Sekrety i klucz CA są przechowywane w Magazynie poświadczeń Windows. Safari przechowuje nieeksportowalny klucz HMAC w IndexedDB.
- W Control Center możesz odwołać dostęp jednego urządzenia lub wszystkich urządzeń. **Wyłącz serwer LAN** kończy nasłuchiwanie. Odwołanie połączenia iPhone'a nie usuwa profilu zaufania.
- Po teście usuń profil w **Ustawienia → Ogólne → VPN i zarządzanie urządzeniem**; sprawdź też, że pełne zaufanie dla certyfikatu jest wyłączone.

Ten przepływ nie był jeszcze sprawdzony na fizycznym iPhonie ani MSI. Wymaga testu na urządzeniach użytkownika przed użyciem poza kontrolowanym pilotem.
