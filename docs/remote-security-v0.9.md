# iPhone Remote v0.9 — status bezpieczeństwa

**Status: UI preview only. Nie ma działającego zdalnego sterowania ani endpointu sieciowego.**

- NEXUS nie otwiera portu i nie nasłuchuje w sieci LAN.
- PWA pod \`public/remote/\` jest statycznym, offline'owym podglądem. Wszystkie przyciski poleceń są wyłączone; skrypt klienta nie wysyła żądań, nie tworzy WebSocketów i nie zapisuje tokenów.
- Parowanie jest odrzucane przez warstwę fail-closed. Uwierzytelnienie komend zwraca odmowę, a odwołanie i utrata połączenia pozostają stanem wyłączonym.
- Nie deklarujemy dostępu LAN, parowania, sterowania iPhone'em ani testu na urządzeniu.

Aby w przyszłości bezpiecznie włączyć transport, trzeba najpierw zaimplementować i przetestować jednorazowe parowanie, ochronę każdej komendy, ochronę przed powtórzeniem, ograniczenie do interfejsów/prywatnej podsieci, odwoływanie sparowania i brak sekretów w logach. Do tego czasu nie wolno rejestrować listenera ani odblokowywać przycisków PWA.
