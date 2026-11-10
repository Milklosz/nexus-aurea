# iPhone Remote v0.9.1 — bezpieczny status

**Status: transport wyłączony.** NEXUS nie otwiera portu, nie hostuje pilota w LAN, nie przyjmuje poleceń i nie zapisuje sekretów.

## Dlaczego

PWA z `public/remote/` jest wyłącznie podglądem interfejsu. Zwykły HTTP w sieci lokalnej nie daje zaufanego originu: ktoś w tej samej sieci mógłby podmienić JavaScript strony i przechwycić kod parowania lub sekret urządzenia. Service Worker i bezpieczne funkcje przeglądarki wymagają secure context; dla hosta LAN oznacza to HTTPS z certyfikatem zaufanym przez iPhone'a. `localhost` jest wyjątkiem dla lokalnego developmentu, ale na iPhonie wskazuje sam iPhone, a nie komputer NEXUS.

Repozytorium nie ma serwera HTTPS, procedury wydania i zaufania certyfikatowi dla iPhone'a ani magazynu kluczy dla sekretów sparowanych urządzeń. Nie dodajemy samopodpisanego certyfikatu ani obejścia kontroli TLS. Dlatego PWA nie próbuje łączyć się z NEXUS, wszystkie komendy i parowanie pozostają niedostępne, a aplikacja nie wystawia listenera.

## Stany widoczne w aplikacji

- Serwer LAN: wyłączony.
- Bezpieczny HTTPS: niedostępny.
- Parowanie: niedostępne.
- Sparowane urządzenia: brak.
- Komendy: odrzucane przez warstwę fail-closed.

## Warunki przed włączeniem transportu

Przyszła implementacja musi dostarczyć zaufane HTTPS dla originu LAN bez obchodzenia walidacji TLS; domyślnie pozostawić listener wyłączony i wymagać jawnego włączenia przez użytkownika; ograniczyć bind do prywatnego interfejsu i hosta/originu; używać jednorazowego, krótkotrwałego kodu parowania z limitami prób; uwierzytelniać każdą komendę i odrzucać powtórzenia; przechowywać sekret w systemowym magazynie poświadczeń i w bezpiecznym magazynie przeglądarki; umożliwić odwołanie urządzenia; nie udostępniać arbitralnego wykonywania komend; nie zapisywać kodów, tokenów ani payloadów w logach; oraz zamykać połączenie po wyłączeniu serwera i przy utracie sesji.

Manifest PWA nie potwierdza instalowalności na iOS. Dodanie do ekranu początkowego i działanie pilota na fizycznym iPhonie wymagają osobnej walidacji po skonfigurowaniu zaufanego HTTPS.
