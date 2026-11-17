# S2.4 — audyt wyświetlaczy i audio

## Odczyt sprzętu

17 listopada 2026 wykonano odczyt CIM/WMI bez zmiany konfiguracji. Sandbox początkowo odmówił dostępu CIM; powtórzony, wąski odczyt z eskalacją zakończył się powodzeniem. Dowód: `docs/evidence/s2-4-hardware-cim.json`.

| Właściwość | Obserwacja API Windows |
|---|---|
| Komputer | Micro-Star International, GP76 Leopard 11UG |
| CPU | Intel Core i7-11800H |
| RAM zgłoszony przez system | 34 046 590 976 bajtów |
| Intel UHD | tryb 1920 × 1080, 240 Hz |
| NVIDIA RTX 3070 Laptop | tryb 3840 × 2160, 60 Hz |
| Aktywne nazwy EDID | SHP LQ173M1JW05, MEI Panasonic-TV |

Tryby GPU WMI nie stanowią samodzielnie dowodu mapowania konkretnego monitora do GPU. Nazwa `Panasonic-TV` nie identyfikuje dokładnego modelu TX-49EX610E. Nie wywnioskowano obsługi HDR, ustawień kolorów ani domyślnego wyjścia HDMI z nazwy telewizora.

## Ustalenia z inspekcji kodu

1. S2.3 miał dwa uzupełniające odczyty: TV Mode przez Tauri raportował fizyczną pozycję i skalę monitora, natomiast eksport diagnostyki zawierał tylko wymiary trybu, całkowite Hz i stan zaawansowanego koloru. Brakowało geometrii oraz DPI w eksportowanym dowodzie.
2. Diagnostyka wybierała pierwszy cel DisplayConfig dla źródła GDI. Przy klonowaniu ekranów mogła przypisać nazwę, transport i HDR niewłaściwego celu. S2.4 oznacza takie powiązanie jako niejednoznaczne i nie zgaduje EDID.
3. Sygnatura zmiany ekranu nie obejmowała położenia i DPI. Przesunięcie pulpitu lub zmiana skali mogły nie uruchomić istniejącej ścieżki odzyskiwania okna.
4. Prostokąty UIA są fizyczne. Warstwa diagnostyczna nie mnoży ich ponownie przez skalę. TV Mode nadal używa `PhysicalPosition` i `PhysicalSize`; nie zmienia ustawień systemowych.

## Zmiany S2.4

Rozszerzono istniejący kontrakt `DisplayInfo` o `diagnostics`: fizyczny początek i rozmiar pulpitu, skalę procentową z `GetScaleFactorForMonitor`, ułamkowe odświeżanie z aktywnej ścieżki QueryDisplayConfig w mHz, rodzaj połączenia, nazwę adaptera i niebędące numerem seryjnym identyfikatory producenta/produktu EDID. Identyfikatory EDID są odczytywane wyłącznie, gdy Windows ustawi `edidIdsValid`. Braki pozostają `null`; źródło zastępcze i lustrzane są jawne.

Nie użyto bezwarunkowo wyniku `GetDpiForMonitor` jako dowodu rzeczywistej skali: ten odczyt zależy od deklaracji świadomości DPI procesu i w zwykłym programie testowym może zwrócić 96 niezależnie od ekranu. `GetScaleFactorForMonitor` raportuje przedział doboru zasobów API, który także nie musi być równy efektywnemu DPI okna. Geometria jest odczytywana w ograniczonym, przywracanym kontekście DPI PMv2 bieżącego wątku; nie zmienia to skali Windows ani kontekstu innych wątków. Jeśli nie można ustanowić fizycznej przestrzeni współrzędnych, odczyt zgłasza błąd zamiast podawać wartości logiczne jako fizyczne.

Finalny kontrakt dodaje osobne `effectiveDpiX/Y` i `dpiProvenance`: `GetDpiForMonitor(MDT_EFFECTIVE_DPI)` jest raportowane wyłącznie po potwierdzeniu `GetProcessDpiAwareness == PROCESS_PER_MONITOR_DPI_AWARE`. W procesie nieświadomym DPI lub przy niedostępnym API wartości pozostają `null`; nie używa się domyślnego 96 DPI. Nie zmieniono świadomości DPI procesu. Panel prezentuje efektywne DPI i procent osobno od przedziału API, a bez potwierdzonego pochodzenia oznacza efektywne DPI jako nieznane.

Eksport nadal ukrywa ścieżki urządzeń za skrótami. Nowe etykiety przechodzą istniejącą redakcję diagnostyczną. Nie dodano nowych poleceń mutujących, automatycznego przełączania audio, zapisu EDID ani zmiany HDR. Odczyty mają istniejące ograniczenia 16 monitorów, 64 ścieżek, 256 trybów i 32 punktów audio; monitorowanie pozostaje co 10 sekund.

Panel System Intelligence pokazuje geometrię, skalę API z ostrzeżeniem o różnicy względem DPI okna, dokładne odświeżanie i GPU. Wysokie wartości rozdzielczości nie są automatycznie oznaczane jako zaakceptowany przebieg 4K.

## Odczyt natywny i efektywne DPI

Dowód `docs/evidence/s2-4-display-audio-native.json` potwierdził na etapie implementacji jeden aktywny ekran Panasonic-TV jako główny, 3840 × 2160 w fizycznym pulpicie (0, 0), HDMI przez NVIDIA RTX 3070 Laptop, 60 000 mHz. Windows raportował zaawansowany kolor wyłączony (`hdr=false`); nie jest to orzeczenie o możliwościach HDR telewizora.

Odczyt audio potwierdził domyślny aktywny Panasonic-TV (NVIDIA High Definition Audio), 100%, niewyciszony. Windows zgłosił 62 punkty końcowe, a ograniczony raport pokazuje 32 i jawny komunikat o obcięciu. Nie przełączano wyjścia ani nie zmieniano głośności.

Wykryto rzeczywistą rozbieżność: `GetScaleFactorForMonitor` zwrócił 140%, podczas gdy odczyt istniejącego izolowanego okna S2.3 `GetDpiForWindow` zwrócił **144 DPI, czyli 150%**, przy potwierdzonym kontekście **Per-Monitor V2**. Dowód: `docs/evidence/s2-4-window-dpi-native.json`. Nie wolno traktować przedziału 140% jako dokładnego efektywnego DPI. Do geometrii konkretnego okna należy używać DPI tego okna lub natywnego `scaleFactor` Tauri. Żadnego ustawienia Windows nie zmieniano. Ten pomiar nie zalicza jeszcze trafiania kursorem ani pełnego ekranu S2.4.

## Weryfikacja i otwarte warunki

- Testy frontendowe `displayAudio.test.ts` i `systemDiagnosticsPanel.test.tsx`: 9 PASS, w tym ujemny początek drugiego monitora, efektywna skala 150% wobec przedziału 140%, 59,94 Hz bez założenia HDMI oraz odrzucenie niepotwierdzonego 96 DPI jako dowodu skali.
- Dodano testy Rust dla zmiany topologii/DPI w sygnaturze oraz ułamkowego odświeżania i niepoprawnych mianowników. Wyniki centralnego przebiegu Rust należy odczytać z raportu integracyjnego.
- Jawny, domyślnie ignorowany test `display_audio::tests::live_display_audio_snapshot` służy wyłącznie odczytowi rzeczywistych danych i wydrukowi JSON; nie jest akceptacją sprzętową ani testem zmieniającym ustawienia.
- Odczyt natywny QueryDisplayConfig/audio wykonano w implementacji S2.4; efektywne DPI odczytano dla działającego izolowanego okna S2.3. Pełny ekran kandydata, trafianie kursorem, rzeczywiste odłączenie HDMI, odtwarzanie chronione i fizyczny DS4 nadal wymagają osobnych dowodów. Niniejszy audyt nie oznacza ich PASS.

Źródła API: [EDID flags](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-displayconfig_target_device_name_flags), [target device name](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-displayconfig_target_device_name), [monitor scale](https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/nf-shellscalingapi-getscalefactorformonitor), [DPI awareness caveat](https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/nf-shellscalingapi-getdpiformonitor). Dane o sprzęcie pochodzą z odczytu Windows, a ustalenia o zachowaniu kodu z inspekcji źródeł S2.3/S2.4.
