# VELORA 1.0 — Ecosystem: dokumentacja IPC

> **Draft.** Rejestr jako kod: `src/contracts/ipc.ts` (`IPC_COMMANDS`).
> Poniższa tabela jest przeznaczona dla przyszłego frontendu i integratorów.
> Nie zmieniono zabezpieczeń Tauri (CSP / capabilities / permissions).

## Konwencje

- Wszystkie komendy wywołuje się przez `invoke()` z `@tauri-apps/api/core`.
- Rejestracja odbywa się w `src-tauri/src/lib.rs` w `tauri::generate_handler![...]`.
- `Result<_, String>` oznacza czytelny, polski komunikat błędu (bez wycieku
  surowych `os error`, ścieżek ani stosów).
- Kolumna **Skutek** rozróżnia komendy tylko do odczytu od zapisu/uruchomienia.
- `sideEffect: "close-request"` oznacza **prośbę** (zdarzenie + potwierdzenie),
  nigdy zabicie procesu.

## Komendy — biblioteka gier (A)

| Komenda | Argumenty | Zwraca | Skutek | Od |
| --- | --- | --- | --- | --- |
| `get_playnite_library` | — | `PlayniteLibrarySnapshot` | read-only | v1-experience |
| `get_playnite_manifest` | — | `Result<PlayniteManifestView, String>` | read-only | v1-ecosystem |

`get_playnite_library` zachowuje sygnaturę bez argumentów i istniejący kształt
odpowiedzi. Od wersji v1-ecosystem czyta **lokalny, jawny manifest JSON**; przy
braku/invalidacji manifestu wraca do bezpiecznego `unavailable` / `playnite-detected`.
`get_playnite_manifest` udostępnia pełny, typowany widok (ulubione, zainstalowane,
`playnite://` URI, czas generacji) dla przyszłego frontendu.

## Komendy — Edge Cinema (B)

| Komenda | Argumenty | Zwraca | Skutek | Od |
| --- | --- | --- | --- | --- |
| `launch_edge_cinema` | `{ url }` | `Result<EdgeCinemaReceipt, String>` | launch | v1-experience |
| `get_edge_cinema_status` | — | `EdgeCinemaStatus` | read-only | v1-experience |
| `get_edge_cinema_session` | — | `EdgeCinemaSession` | read-only | v1-ecosystem |
| `request_edge_cinema_close` | `{ sessionId, confirm }` | `Result<EdgeCinemaSession, String>` | close-request | v1-ecosystem |
| `report_edge_cinema_exit` | `{ sessionId }` | `Result<EdgeCinemaSession, String>` | event | v1-ecosystem |
| `reset_edge_cinema_session` | — | `EdgeCinemaSession` | write | v1-ecosystem |

`launch_edge_cinema` otrzymuje dodatkowy, wstrzykiwany przez Tauri parametr
`State<EdgeCinemaSessions>` — **argumenty po stronie JS pozostają `{ url }`**.
Allowlista 5 adresów HTTPS i stały zestaw 6 flag uruchomieniowych pozostają
nienaruszone; nie dodano żadnych flag DRM / HDCP / `--no-sandbox` / `--kiosk`.

`request_edge_cinema_close` / `report_edge_cinema_exit` to **adaptery**: emitują
typowane zdarzenia dla przyszłego `WindowBroker`. Nie implementują brokera, nie
wyliczają HWND, nie zabijają procesów.

## Komendy — Autostart & Recovery (D)

| Komenda | Argumenty | Zwraca | Skutek | Od |
| --- | --- | --- | --- | --- |
| `get_autostart_status` | — | `AutostartStatus` | read-only | v1-experience |
| `set_autostart_enabled` | `{ enabled, windowed }` | `Result<AutostartStatus, String>` | write | v1-experience |
| `get_startup_mode` | — | `StartupMode` | read-only | v1-experience |
| `get_autostart_diagnostics` | — | `AutostartDiagnostics` | read-only | v1-ecosystem |
| `get_autostart_recovery` | — | `AutostartRecoveryReport` | read-only | v1-ecosystem |

Jedyny zapis systemowy pozostaje w `set_autostart_enabled`: dokładnie jeden wpis
`VELORA` w `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Nie dotykamy
HKLM, Winlogon, powłoki, folderu Startup. Nowe komendy są wyłącznie diagnostyczne
(odczyt + walidacja), nie naprawiają wpisu automatycznie.

## Komendy — iPhone Remote (C)

Komendy `get_remote_access_status`, `prepare_remote_trust_profile`,
`start_remote_access`, `begin_remote_pairing`, `stop_remote_access`,
`revoke_all_remote_devices`, `revoke_remote_device` pozostają **bez zmian**.
Endpointy HTTP (`/api/status`, `/api/pair`, `/api/command`) oraz format podpisu
HMAC i monotoniczny `sequence` również pozostają bez zmian. Warstwa niezawodności
(reconnect / kolejka / ack / idempotencja) jest dostarczona jako przetestowany,
czysty moduł + plan integracji — bez prowizorycznej zmiany protokołu, która
mogłaby osłabić HMAC / replay / walidację certyfikatów.

## Zdarzenia (kontrakty dla przyszłej integracji)

| Nazwa | Ładunek | Producent docelowy |
| --- | --- | --- |
| `velora://library-changed` | `{ source, gameCount }` | reader manifestu |
| `velora://cinema-session-changed` | `{ session }` | sesja Edge Cinema |
| `velora://cinema-exited` | `{ sessionId, reason }` | przyszły `WindowBroker` |
| `velora://cinema-close-requested` | `{ sessionId, confirmed }` | `AppControlAdapter` |
| `velora://app-control-session-changed` | `{ session }` | `AppControlAdapter` |
| `velora://remote-state-changed` | `{ state, attempt, reason }` | `RemoteTransportAdapter` |
| `velora://remote-command-envelope` | `RemoteCommandEnvelope` | przyszły serwer z `commandId` |
| `velora://remote-command-ack` | `{ commandId, executed, error }` | przyszły serwer z ack |

Zdarzenia opisane w `src/contracts/events.ts`. VELORA nie implementuje
`WindowBroker` ani `SessionOrchestrator` — te moduły należą do DeepSeeka.

## Zabezpieczenia, których nie zmieniamy

- `src-tauri/capabilities/default.json`, `tauri.conf.json`, CSP.
- `Cargo.toml` / `Cargo.lock` (brak nowych zależności).
- HMAC-SHA256, replay protection, walidacja certyfikatów / `trust_confirmed`
  w `remote_access.rs` oraz `isSecureContext` po stronie PWA.
- Allowlista adresów HTTPS i brak obejść DRM / HDCP.
