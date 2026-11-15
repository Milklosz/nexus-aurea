# S1.1 — trwały checkpoint ochrony przed replay

## Powód i zakres

Pełny lokalny test wykrył Execute dwukrotnie dla sekwencji 30. Pięć osobnych powtórzeń przeszło,
więc nie uznano tego za nieszkodliwy flaky test. Dokładnej przyczyny systemowej nie udowodniono.
Upstream Windows keyring opisuje utratę aktualizacji nawet różnych wpisów Credential Manager:
https://github.com/open-source-cooperative/windows-native-keyring-store#warning .

Użytkownik zatwierdził rozszerzenie S1.1 o trwały marker. Poprawka usuwa zależność decyzji anti-replay
od wyłącznie Credential Manager i pamięci jednego procesu: nowy proces musi potwierdzić ten sam indeks
w niezależnym lokalnym checkpoint. Dodatkowo wszystkie własne natywne calls do magazynu są serializowane
przez wspólną blokadę profilu, także pomiędzy różnymi testowymi/usługowymi przestrzeniami nazw.
Nie zakładamy, że inne aplikacje respektują tę blokadę ani że naprawiono sam Windows Credential Manager.

## Format i transakcja

Checkpoint leży w tym samym przypiętym state.lock od offsetu 1; bajt 0 nadal blokuje LockFileEx.
Guard posiada otwarty uchwyt do całego końca transakcji. JSON zawiera tylko version, phase,
revision i SHA-256 dokładnego indeksu. Nie ma tokenów, certyfikatów, nazw urządzeń ani kluczy.

Kolejność modyfikacji indeksu (pair/revoke/command/rollback):
1. Zablokować state.lock i ponownie odczytać/zweryfikować magazyn oraz checkpoint.
2. Utrwalić pending z docelową rewizją/skrótem przez write_all + set_len + sync_all.
3. Zapisać nowy indeks w Credential Manager.
4. Odczytać indeks kontrolnie i porównać dokładną rewizję/skróty.
5. Utrwalić committed z sync_all. Dopiero potem można zwrócić Execute i wykonać efekt komendy.

Nie zerujemy/truncate pliku przed zapisem. Częściowy lub zbyt duży checkpoint, nieznana wersja,
pending i mismatch zamykają autoryzację oraz wymagają jawnego recovery. Błąd IO nie jest stanem legacy.
Błąd zgłoszony po pełnym committed może zużyć sekwencję bez efektu; kolejne wykonanie tej samej sekwencji
nadal jest odrzucane. To świadomy fail-closed, zamiast ryzyka podwójnego efektu.

## Migracja i awarie

Wyłącznie nietknięty plik długości 0 oznacza stary format. Najpierw obowiązuje dotychczasowe wykrywanie
rollbacku względem cache. Dla istniejącego poprawnego indeksu legacy sama migracja wykonuje checked write
z nową rewizją i checkpointRequired=true, jeszcze przed pierwszą odpowiedzią status. Utrata checkpoint
po tej migracji nie prowadzi do ponownego automatycznego zaufania indeksowi. Pusty indeks bez sparowanych
urządzeń nie nadaje żadnych uprawnień. Plik długości 1 jest uszkodzony, nigdy legacy.

Przerwanie po pending lub CredWrite blokuje następny proces. Przerwanie po pełnym committed pozostawia
zużytą sekwencję, choć efekt mógł jeszcze nie nastąpić. Nie próbujemy odgadywać, czy użytkownik widział efekt.
Starszy build zapisujący indeks bez checkpoint wywoła mismatch w nowym buildzie; nie należy równolegle
uruchamiać starej i nowej VELORY dla tego samego magazynu.

## Jawne recovery

Zachowano lokalny wybór trybu, acknowledgement i jednorazowy kod potwierdzenia. Recovery zaczyna się od
pending, następnie wykonuje istniejący journal. Nowa rewizja przewyższa Credential Manager, cache,
poprawny committed/pending marker i zegar. Sprawdza readback pustego indeksu, usunięcia tokenów,
brak journal oraz brak CA dla efektywnego reset-trust (także gdy journal wymusił silniejszy tryb).
Dziennik nie jest usuwany przed potwierdzeniem cleanup. Dopiero na końcu zapisuje committed i używa
wspólnej verified ścieżki. Błąd nie publikuje pozornie zdrowego cache.

## Granice gwarancji

Chronimy nowe procesy VELORY przed samym cofnięciem/utraconą aktualizacją indeksu w Credential Manager,
również gdy ich lokalny cache nie widział nowszej rewizji. Nie chronimy przed lokalnym użytkownikiem,
który świadomie cofa lub usuwa oba magazyny i poświadczenia, przed starym buildem ignorującym checkpoint,
ani przed sprzętem kłamiącym o sync_all. Nie jest to transakcja exactly-once obejmująca zewnętrzny efekt.
Autoryzacja jest fail-closed; fizyczny serwer może nadal nasłuchiwać, lecz odrzuca mutacje do recovery.

## Dowody i regresje

Testy obejmują deterministyczny stale index w nowym procesie, samą migrację i natychmiastową utratę markera,
częściowy/zbyt duży plik, cztery granice awarii rzeczywistego procesu, sześć wariantów błędu zapisu markera,
rewizję pending jako recovery floor, pozornie skuteczne usunięcie CA i wznowienie silniejszego journalu.
Istniejący test konkurujących procesów pozostaje w pełnej sucie. Testy nie korzystają z prawdziwych sekretów.
Końcowe liczby: docs/velora-2-sprint-verification.md.
