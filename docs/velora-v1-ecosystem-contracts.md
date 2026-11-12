# VELORA 1.0 — Ecosystem: stabilne kontrakty (moduł F)

> **Draft.** Gałąź `feat/velora-v1-ecosystem` bazuje na `feat/velora-v1-experience` (PR #15).
> Nie zintegrowano zmian DeepSeeka (`fix/velora-deepseek-p1`, `feat/velora-v1-core`).
> Nie zmieniono PR #13 / #14 / #15 / #16. Nie wykonano redesignu.

## Cel

Przygotowanie **stabilnych kontraktów danych i akcji**, aby przyszły model mógł
całkowicie przebudować frontend VELORA bez przepisywania backendu. Warstwa jest
czysto typowana: bez zależności od React, Tauri, DOM, platformy ani od stylistyki.

**Czego świadomie NIE zmieniamy:** `src/styles.css`, `AppDock`, animacje, motyw
AUREA Grand Cinema, `focus-visible`, dock, siatka `home-dock`, `useNavigation`,
`useGamepad` (dziedzina DeepSeeka). Kontrakty nie importują żadnego z tych modułów.

## Pliki

| Plik | Zawartość |
| --- | --- |
| `src/contracts/errors.ts` | `VeloraErrorCode`, `VeloraError`, `veloraError()`, `toVeloraError()`, sanityzacja `cause` |
| `src/contracts/domain.ts` | `VeloraApp`, `VeloraGame`, `CoverRef`, `VeloraLaunchRef`, `VeloraLibrarySnapshot`, `playniteLaunchRef()` |
| `src/contracts/session.ts` | `SessionStatus`, `SessionPhase`, `CinemaSession`, `AppControlSession`, `isActiveSession()` / `isClosedSession()` |
| `src/contracts/actions.ts` | `VeloraAction` (dyskryminowana unia), `ActionAck`, `idempotencyKey()` |
| `src/contracts/events.ts` | `VELORA_EVENTS`, `TypedEvent<T>`, ładunki zdarzeń, `RemoteCommandEnvelope` |
| `src/contracts/adapters.ts` | `LibraryAdapter`, `CinemaLifecycleAdapter`, `AppControlAdapter`, `RemoteTransportAdapter` |
| `src/contracts/ipc.ts` | `IPC_COMMANDS` — typowany rejestr komend + `IpcDescriptor` |
| `src/contracts/index.ts` | Barrel (`export *`) |

Szczegółowa dokumentacja IPC: [`docs/ipc-contract.md`](ipc-contract.md).
Kontrakt manifestu Playnite: [`docs/playnite-manifest-contract.md`](playnite-manifest-contract.md).

## Zasady projektowe

1. **Tylko do odczytu wobec danych obcych.** `VeloraLibrarySnapshot.readOnly` jest
   literalnym `true`. VELORA nie zapisuje do Playnite, nie modyfikuje rejestru poza
   jednym wpisem `HKCU\...\Run /v VELORA`, nie czyta nieudokumentowanej bazy danych.
2. **Bezpieczne referencje uruchomienia.** `VeloraLaunchRef.target` przyjmuje
   wyłącznie: nazwę komendy Tauri, `playnite://playnite/start/<Guid>`, albo
   allowlistowy adres HTTPS. Nigdy surową ścieżkę `.exe` ani wiersz argumentów.
3. **Rozróżnienie okna aktywnego od zamkniętego.** `isActiveSession()` obejmuje
   `launching | active`; `isClosedSession()` obejmuje `exited | error`. To jest
   kontrakt dla przyszłego `WindowBroker` (DeepSeek), nie jego implementacja.
4. **Idempotencja bez zmiany protokołu HMAC.** `idempotencyKey()` i
   `RemoteCommandEnvelope.commandId` są czysto korelacyjne. Format podpisu
   `NEXUS-AUREA-REMOTE-V1\n{deviceId}\n{sequence}\n{command}` pozostaje
   nienaruszony; replay protection (monotoniczny `sequence`) pozostaje w backendzie.
5. **Adaptery jawnie oznaczają prototyp.** `AdapterDescriptor.prototype: true`
   oznacza kontrakt przygotowany do integracji, a nie uruchomioną integrację.
6. **Błędy bez wycieków.** `VeloraError.message` jest komunikatem dla użytkownika;
   `cause` jest zsanityzowany (bez znaków sterujących, maks. 240 znaków, bez
   surowych stosów/ścieżek/sekretów).

## Co jest kontraktem, a co działającym kodem

| Warstwa | Status |
| --- | --- |
| Typy, unie, `VELORA_EVENTS`, `IPC_COMMANDS`, helpery czyste | **Działa** (skompilowane, przetestowane) |
| `LibraryAdapter` / `CinemaLifecycleAdapter` / `AppControlAdapter` / `RemoteTransportAdapter` | **Interfejsy** (implementacje w modułach A–E, część to prototypy) |
| Integracja z `WindowBroker` / `SessionOrchestrator` | **Nie wykonana** — dziedzina DeepSeeka, przygotowano tylko zdarzenia |

## Zgodność wsteczna

Wszystkie dotychczasowe eksporty serwisów (`playniteLibrary.ts`, `edgeCinema.ts`,
`autostart.ts`, `remoteCommand.ts`, `openStreamingService.ts`) pozostają
nienaruszone. Nowe kontrakty są **addytywne**: żaden istniejący komponent nie
musi ich importować, aby nadal działać. Dzięki temu przyszła przebudowa
frontendu może przejść na `../contracts` stopniowo.
