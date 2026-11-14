# VELORA 2.0 — Visual Polish (Cinema Minimal)

Dopracowanie szczegółów zaakceptowanego wyglądu Cinema Minimal. Kompozycja, paleta i układ Home nie zostały zmienione.
Baza: PR #52 (`design/velora-2-living-room`, 30c1e50). Zrzuty: `before/` (PR #52), `after/` (1920×1080 i 3840×2160), `after-reduced/` (prefers-reduced-motion).

## Zmiany

**Dock**
- Kafelki 176→195 px, odstęp 20→24 px: dock kończy się dokładnie tam, gdzie górne akcje (8×195 + 7×24 = 1728).
- Jedna zasada znaków słownych (bez logotypów firm trzecich): nazwa jednoczłonowa w całości w kolorze akcentu (600); dwuczłonowa = marka w kolorze tekstu (600) + produkt w akcencie (400). „Prime Video”, „Apple Music” zapisane normalnie.
- Akcent YouTube przesunięty na pomarańczowy (odróżnia się od Netflix).
- Stany: *idle* (ciemna płytka), *selected* (jaśniejsza płytka + podkreślenie 40 px, gdy fokus jest gdzie indziej), *focused* (jasna płytka, uniesiona, jedyny cień), *pressed* (140 ms po potwierdzeniu, także z klawiatury/pada/pilota).
- Jasna płytka fokusu to `::before` animowane tylko `opacity`; usunięte `will-change` z kafelka i animacje `background-color`.
- Skala fokusu 1.08→1.06; skrajne kafelki rosną do środka (nie wychodzą poza margines 96 px).
- Kafelek „nie zainstalowano” czytelniejszy (opacity .42→.62).

**Hero**: bez opisów technicznych („Okno Edge Cinema”, „Steam Big Picture” itd.) — tylko krótka kategoria. Tytuł: kerning −.03em.

**Tła**: Netflix bez zmian (oryginalny plik). Pozostałe sceny przeparametryzowane i wyrenderowane od nowa (37–55 KB): Disney – księżycowa noc z rzadkimi gwiazdami, Max – spokojniejszy fiolet, Prime – morze z delikatnym odblaskiem (zniknął „jajowaty księżyc”), YouTube – bursztyn, Steam – grafitowa mgła, Playnite – leśna mgła, Apple Music – różowa śliwka nad wodą. Horyzonty w pasie 570–650 px, żeby przenikanie nie „skakało”. Przenikanie: stara scena zostaje w pełni kryjąca pod nową (brak zapadania jasności); kolejne przenikanie startuje dopiero po zakończeniu poprzedniego.

**Pasek górny**: zegar 40 px, pogoda 22 px, akcje 52 px; bez animacji koloru.

**Control Center**: arkusz 960 px (lewa krawędź w szczelinie między Prime Video a YouTube), czcionka zakładek (wcześniej Arial), rysowany znak ✓, wiersze statusu bez wypełnienia, spójne wcięcia, wyraźniejszy wybrany profil, stopka w grupach: *Pulpit Windows* · *Ekran główny* | *Diagnostyka* (te same akcje i handlery; zmiana wyłącznie prezentacyjna, tylko w motywie Living Room), uproszczone teksty, bez zdublikowanego nagłówka „Szukaj”, fade tła dialogu.

## Przegląd Opus (2 rundy)
Runda 1 wskazała m.in.: techniczne opisy na Home, złoty gradient w CC, font zakładek, dock niewyrównany do siatki, niespójne znaki słowne, scena Prime. Runda 2 (na rzeczywistych zrzutach) — zablokowała: kolor zegara, rozmyty odblask w scenach morskich (naprawione); nieaktualny zrzut Search z szerokim arkuszem (zrzut odświeżony, szerokość 960). Z uwag pomocniczych wdrożono: separację Disney/Steam/Apple Music, pas horyzontów, kontrast wybranego profilu, grupowanie stopki, ukrycie powtórzonego nagłówka, orientację skrajnych kafelków.

## Znane ograniczenia
- Brak animacji zamykania Control Center (dialog jest odmontowywany; dodano tylko wejście tła). Zmiana wymagałaby ingerencji w obsługę fokusu.
- Ekran awaryjny „Grand Cinema” (stary motyw) nadal zawiera własne, odręcznie narysowane ikony — poza zakresem tego sprintu, motyw jest tylko fallbackiem.
- Nie mierzono FPS ani nie testowano na MSI/telewizorze; zrzuty pochodzą z headless Edge w 1080p i 4K.
- Stan *pressed* zweryfikowany wartościami CSS (scale 1.06→1.03) i testem jednostkowym, nie zrzutem.
