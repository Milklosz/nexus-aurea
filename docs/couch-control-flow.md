# VELORA 1.0 — Moduł E: Couch-only Application Control (analiza + prototyp)

- Gałąź: `feat/velora-v1-ecosystem`
- Status: **analiza + typowany kontrakt + przetestowany prototyp reducera/adaptera**.
- Zakres: wyłącznie **NOWY, czysty, wstrzykiwalny moduł TypeScript**. Brak zmian w
  `App.tsx`, brak nowych komend Tauri, brak zmian w `lib.rs`, brak nowych
  zależności npm, brak testów MSI / sprzętowych.

Pliki należące do tego modułu (wyłączna własność):

| Plik | Rola |
| --- | --- |
| `src/services/appControl.ts` | czysty reducer przepływu, kreatory akcji, helpery bezpieczeństwa, prototypowy adapter, recovery (do odczytu) |
| `src/__tests__/appControl.test.ts` | pełna ścieżka, bezpieczne zamknięcie, adapter, błędy, recovery |
| `src/__tests__/homeReturn.test.ts` | dedykowana suita „powrót do Home" z każdej fazy |
| `docs/couch-control-flow.md` | ten dokument (analiza + plan wpięcia + granice) |

Wszystkie typy (`VeloraAction`, `AppControlSession`, `VeloraError`, `TypedEvent`,
`VELORA_EVENTS`, `AppControlAdapter`, …) pochodzą z istniejącego, nienaruszonego
`src/contracts/*` (moduł F). Moduł E ich nie modyfikuje.

---

## 1. Analiza REALNEGO, obecnego przepływu (Home → aplikacja → sterowanie → zamknięcie → Home)

Poniższy opis dotyczy kodu, który **dziś działa** i którego nie zmieniamy.
`App.tsx` jest jedynym właścicielem stanu jednego ekranu; nie ma osobnej maszyny
stanów aplikacji, natywnego `WindowBroker` ani `SessionOrchestrator`.

### 1.1 Home i uruchomienie aplikacji

- **Ekran główny / dock:** `src/App.tsx` renderuje `<AppDock>` (linie 376–384).
  `src/components/AppDock.tsx` (linie 27–125) mapuje kafle, oznacza fokus AUREA
  (`data-aurea-focus`, `data-focus-source`) i woła `onActivate(index)` (linia 87)
  po kliknięciu; `getAppManagerStatus()` (linie 33–39) zasila podpowiedź o
  dostępności aplikacji.
- **`openService`:** `src/App.tsx` linie 74–96. Dla `kind === "web"` woła
  `openStreamingService`, dla zarządzanych aplikacji `launchManagedApp(...)`.
  Błędy mapuje przez `managedAppErrorMessage` / `streamingServiceErrorMessage`
  i pokazuje jako `showToast`.
- **`useLaunchGuard`:** `src/hooks/useLaunchGuard.ts` linie 3–21 oraz użycie w
  `src/App.tsx` linia 71. Zbiór `activeLaunches` zapobiega podwójnemu
  uruchomieniu tego samego `id` (idempotencja po stronie UI). Uruchomienie jest
  **świadomą akcją użytkownika**.
- **`src/services/appManager.ts`:** `launchManagedApp` (linie 86–89) wywołuje
  komendę Tauri `launch_managed_app` ze stałej allowlisty; mapowanie błędów
  spawn (`os error 2 / 5`) na czytelne komunikaty (linie 48–66).

### 1.2 Sterowanie z kanapy (fokus, Wstecz, Home, pilot)

- **`useNavigation` / AUREA:** `src/hooks/useNavigation.ts` linie 17–129 oraz
  `src/services/aureaNavigation.ts`. `useNavigation` rejestruje siatkę docka
  (`gridId: "home-dock"`, `src/App.tsx` linia 100), obsługuje strzałki, `x`,
  `F2` i `focusApp`. `aureaNavigation.ts` jest celowo DOM-agnostyczny przy imporcie.
- **Kontroler (pad):** `useGamepad` (`src/App.tsx` linie 239–244) dostaje
  `move`, `confirm` (`confirmControllerFocus`, linie 141–149), `back`
  (`backControllerFocus`, linie 150–160), `options`. `backControllerFocus`
  zamyka Control Center / Diagnostykę albo resetuje fokus do kafla 0 — **nie
  zamyka żadnej aplikacji**.
- **iPhone Remote:** `listenForRemoteCommand` → `dispatchRemoteCommand`
  (`src/App.tsx` linie 307–330, `src/services/remoteCommand.ts` linie 45–87).
  `dispatchRemoteCommand` mapuje `up/down/left/right/select/back/home/volume/profile`;
  `home` woła `returnToNexus`, `back` woła `backControllerFocus`. Protokół HMAC /
  replay / TLS pozostaje nienaruszony.
- **Control Center `<dialog>`:** `src/components/ControlCenter.tsx` linie 55–423.
  `showModal()` (linia 131), `onCancel` → `props.onClose()` (linia 242), przycisk
  „Wróć do VELORA" (`onReturnToNexus`, linia 418), `onClose` przekazane z
  `src/App.tsx` linia 404. Zamknięcie dialogu to `closeControlCenter` — czysto
  UI, bez dotykania procesów.

### 1.3 Escape / Backspace / BrowserBack (efekt odzyskiwania fokusu)

`src/App.tsx` linie 245–287 (`recover`):

- `Escape` + otwarty `dialog[open]` → zamyka Control Center / Diagnostykę
  (linie 248–253);
- `Backspace` / `BrowserBack` + otwarty dialog → to samo (linie 263–269);
- `Backspace` / `BrowserBack` bez dialogu → `navigation.focusApp(0)` (linie
  270–274) — powrót fokusu do docka, nie zamknięcie aplikacji;
- `Escape` / `F11` → `windowMode(...)` (linie 275–279) — zmiana trybu okna
  VELORY, nie procesu zewnętrznego;
- `F2` menu, `F3` Control Center (linie 280–281).

`src/services/windowMode.ts` (`windowMode`, `minimizeWindowToDesktop`) oraz
`showDesktop` / `changeCinemaProfile` (`src/App.tsx` linie 169–202) zmieniają
**własne okno VELORY** (fullscreen / dekoracje / minimalizacja), nigdy okno
obcej aplikacji.

### 1.4 Zamknięcie i powrót fokusu (bez zabijania procesów)

- **`returnToNexus`:** `src/App.tsx` linie 110–116 → `setControlCenterOpen(false)`,
  `setDiagnostics(false)` i **`focusWindowSafely(getCurrentWindow(), onBlocked)`**.
  VELORA wyłącznie **PROSI** o fokus swojego okna; przy odmowie Windows pokazuje
  toast „Wróć do aplikacji przez Alt+Tab".
- **`focusWindowSafely`:** `src/services/focusWindowSafely.ts` linie 6–18 —
  `unminimize()` + `setFocus()` w `try/catch`, bez pętli wymuszania foreground.
- **`listenForNexusControlReturn`:** `src/App.tsx` linie 289–305 → również tylko
  `focusWindowSafely`.
- **`listenForManagedAppExit`:** `src/App.tsx` linie 332–348. Tylko dla
  `id === "playniteFullscreen"` (proces uruchomiony bezpośrednio przez VELORA).
  Zdarzenie `managed-app-exited` (`src/services/appManager.ts` linie 100–103)
  wywołuje **`focusWindowSafely`** (linie 337–339) z toastem — ponownie wyłącznie
  prośba o fokus.
- **Polityka bezpieczeństwa w README:** `README.md` linia 108 —
  *„NEXUS never terminates an application."*; linia 110 — *„Only a Playnite
  Fullscreen process started directly by NEXUS is monitored for exit. Focus is
  requested only if Windows has returned to Explorer or NEXUS … Windows can still
  deny foreground activation."*; linia 70 — *„No process watcher, forced
  foreground loop or browser termination is used."*; linia 84 — *„NEXUS does not
  monitor or terminate either process, force foreground focus …"*.

**Wniosek z analizy:** obecny „powrót do Home" to w rzeczywistości (a) przywrócenie
fokusu w UI VELORY i (b) bezpieczna prośba o fokus okna — nigdy `kill`, nigdy
`force-close`. Nie istnieje jawna maszyna faz aplikacji ani potwierdzane
zamknięcie zarządzanej sesji. Moduł E modeluje to **jako kontrakt**, nie zmieniając
działającego kodu.

---

## 2. Nowa warstwa (prototyp, NIE wpięta)

### 2.1 Typowane akcje i kontrakty

Źródłem prawdy jest `VeloraAction` z `src/contracts/actions.ts`. Moduł E dodaje nad
nim cienką, czystą warstwę:

- `isNavigationAction(action)` — rodzina `navigation.back/escape/home`;
- `isDestructiveAction(action)` — **wyłącznie** `app.close.request` i
  `app.close.confirm`;
- kreatory: `requestClose`, `confirmClose`, `cancelClose`, `backAction`,
  `escapeAction`, `homeAction`;
- `appControlErrorMessage(cause)` i `classifyLaunchError(cause)` — czytelne
  komunikaty po polsku, bez wycieku surowych `os error` / ścieżek / stosów
  (`toVeloraError`, `messageFromUnknown`, `veloraError`).

### 2.2 Czysty reducer przepływu

`reduceAppControlFlow(state, action)` realizuje
`home → app-launch → app-active → confirm-close → returning-home → home`:

- `app.launch` **tylko z `home`** buduje minimalną `VeloraApp` z
  `managedByVelora: true`, `availability: "available"`, `launch: null` i
  deterministyczny `sessionId` (`idempotencyKey`).
- `app.focus` / `status.refresh` → `app-active`.
- `app.close.request` → `confirm-close` z **deterministycznym tokenem**
  (`idempotencyKey(sessionId + requestId)`, czysty FNV-1a, bez kryptografii).
- `app.close.confirm` → `returning-home` **tylko gdy** token się zgadza **ORAZ**
  `managedByVelora === true`. W przeciwnym razie odrzucenie z `lastError`
  (`app-close-unconfirmed` dla złego tokenu, `foreign-process` dla obcej apki).
- `app.close.cancel` → `app-active` (czyści token).
- `navigation.back / escape / home` → **z dowolnej fazy** do bezpiecznego `home`.
  `navigation.escape` w `confirm-close` **anuluje** zamknięcie (brak przejścia
  przez `returning-home`, brak wywołania zamknięcia).
- `remote.command` mapuje `back/home/escape` na akcje nawigacyjne; `select` i
  strzałki są ruchem fokusu wewnątrz UI (no-op dla fazy); nieznane → no-op.
- `display.fullscreen` nie zmienia fazy (zapis w historii).
- `history` ograniczona do ostatnich 16 faz.
- Reducer **nigdy** nie zwraca stanu zamykającego obcy / niezarządzany proces.

`canSafelyClose(session)` i `confirmCloseRequiresToken(state)` to jawne, testowalne
bramki bezpieczeństwa.

### 2.3 Bezpieczne, potwierdzone zamknięcie (token + gate managed)

`createAppControlAdapter(deps)` to **prototyp nad wstrzykniętymi zależnościami**
(`AppControlDeps`: `dispatchClose`, `requestFocus`, opcjonalny `nowMs`).
Nie importuje `@tauri-apps` na poziomie modułu, więc testy działają w `node`.

- `dispatch(action)` napędza reducer wewnętrznie i zwraca `ActionAck` z
  `idempotencyKey`.
- `deps.dispatchClose` jest wywoływane **wyłącznie** dla potwierdzonego
  `app.close.confirm` na sesji **MANAGED**, który reducer faktycznie przyjął do
  `returning-home`. Zły token / brak tokenu / obca aplikacja → brak wywołania.
- `deps.requestFocus` jest wywoływane przy powrocie do Home — VELORA nadal
  wyłącznie **PROSI** o fokus (zgodnie z `focusWindowSafely`).
- `subscribe()` to rejestr listenerów w pamięci emitujący
  `typedEvent(VELORA_EVENTS.appControlSessionChanged, { session })`.

Nagłówek adaptera wprost stwierdza: *„Prototype adapter over injected deps; NOT
wired into App.tsx. Wiring plan in docs/couch-control-flow.md. No process is
killed."*

### 2.4 Obsługa błędów uruchomienia

`classifyLaunchError(cause)` zawsze zwraca typowany `VeloraError` o kodzie
`launch-failed` i nigdy nie rzuca; `appControlErrorMessage` mapuje
`app-close-unconfirmed`, `foreign-process`, `launch-failed` i przypadek ogólny na
czyste komunikaty. Surowe przyczyny (`os error`, ścieżki, stosy) są mapowane na
stałe teksty i nie trafiają do użytkownika.

### 2.5 Recovery po restarcie VELORA (wyłącznie do odczytu, BEZ auto-akcji)

`RecoveryStorage` jest wstrzykiwalny (brak DOM / `localStorage` w module).
`persistAppControlSession` / `readRecoveredSession` / `clearRecoveredSession`
używają klucza `velora.v1.appControl.session` z **surową walidacją JSON** i
bezpiecznym domyślnym `null` (`try/catch`). Odczytany stan jest **zawsze**
`phase: "home"`, `app: null`, `closeConfirmationToken: null`, z `lastError`
zawierającym `recoveryNotice(...)`. **Nie ma żadnego auto-relaunch, auto-close,
auto-focus ani auto-resume** — powrót jest ręczny, zgodnie z wymogiem
„NEVER auto-relaunch/auto-close on recovery after a VELORA restart".

### 2.6 Testy powrotu do Home

- `src/__tests__/appControl.test.ts` — pełna ścieżka, odrzucenia (zły token,
  obca apka, brak tokenu), `canSafelyClose`, helpery, brak wycieków, adapter
  (`dispatchClose` tylko dla managed, `requestFocus`, `subscribe`), recovery.
- `src/__tests__/homeReturn.test.ts` — 11 skupionych testów: `backAction()`,
  `homeAction()`, `escapeAction()` z **każdej** z 5 faz kończą w `home`;
  `escape` z `confirm-close` anuluje; historia `returning-home` przed `home`;
  błąd uruchomienia + Home; `INITIAL_APP_CONTROL_STATE.session ===
  HOME_APP_CONTROL_SESSION`.

Uruchomienie (dozwolone, wyłącznie własne pliki):
`pnpm exec vitest run src/__tests__/appControl.test.ts src/__tests__/homeReturn.test.ts`.

---

## 3. Plan wpięcia (przyszłość — NIE zrealizowany w tym buildzie)

Gdy właściciel `App.tsx` zdecyduje się wpiąć warstwę:

1. Jeden `useReducer(reduceAppControlFlow, INITIAL_APP_CONTROL_STATE)` obok
   istniejącego stanu ekranu; `App.tsx` pozostaje jedynym właścicielem stanu.
2. `openService` / `launchManagedApp` emitują `app.launch` → `app.focus`;
   `useLaunchGuard` nadal chroni przed podwójnym uruchomieniem.
3. `backControllerFocus` oraz efekt `recover` (Escape/Backspace/BrowserBack)
   emitują `navigation.back` / `navigation.escape`; `returnToNexus` i
   `dispatchRemoteCommand(home)` emitują `navigation.home`.
4. `deps.requestFocus` = istniejący `focusWindowSafely(getCurrentWindow(), …)`;
   `deps.dispatchClose` = wyłącznie bezpieczna, **potwierdzona** prośba dla
   sesji MANAGED (odpowiednik `request_edge_cinema_close` / `managed-app-exited`,
   nigdy `taskkill` / `TerminateProcess`).
5. `readRecoveredSession` przy starcie czyta stan i **tylko pokazuje** notatkę
   recovery — bez automatycznego wznawiania.
6. `subscribe` zasila przyszły `SessionOrchestrator` / `WindowBroker` (DeepSeek)
   przez `VELORA_EVENTS.appControlSessionChanged`.

**Żaden z powyższych kroków nie został wykonany.** Adapter nie jest importowany
przez `App.tsx`.

---

## 4. Granice własności — pliki pozostawione NIENARUSZONE

Pliki owns by DeepSeek (zabronione do modyfikacji przez ten moduł):

| Plik (DeepSeek) | Dlaczego nienaruszony |
| --- | --- |
| `src-tauri/src/app_manager.rs` | natywny App Manager, allowlista, `tasklist`, lifecycle procesów |
| `src-tauri/src/control_service.rs` | Control Service, HID, hotkey `Ctrl+Alt+N`, game mode |
| `src/services/focusWindowSafely.ts` | jedyna bezpieczna prośba o fokus (unminimize + setFocus) |
| `src/hooks/useFocusRestoreOnClose.ts` | przywracanie fokusu po zamknięciu dialogu |
| `src/hooks/useGamepad.ts` | globalny odczyt Gamepad API, mapowanie pada |

Pozostałe pliki, których moduł E nie dotyka (HARD RULES): `src/App.tsx`,
wszystkie istniejące komponenty / hooki / serwisy, `src-tauri/src/lib.rs`,
`src/contracts/*`, `README.md`, `Cargo.toml`, `package.json`, `pnpm-lock.yaml`,
istniejące testy. `SessionOrchestrator`, `WindowBroker`, globalny HID i natywny
fokus okna pozostają w domenie DeepSeek i nie są tu integrowane (zgodnie z
`docs/velora-v1-experience.md`, sekcja „Granice własności").

---

## 5. Uczciwe oświadczenie

> This is analysis + typed contracts + a tested prototype reducer/adapter. It is
> NOT wired into App.tsx and does NOT kill or force-close any process. No
> MSI/hardware tests were performed.

Moduł nie dodaje komend Tauri, nie zmienia `lib.rs`, nie wprowadza zależności,
nie wykonuje testów na realnej maszynie Windows / MSI / kontrolerach. Zachowuje
politykę README: VELORA wyłącznie **PROSI** o fokus (`focusWindowSafely`), a
kandydatem do zamknięcia może być wyłącznie **świadomie potwierdzona**,
**przez VELORA uruchomiona (MANAGED)** sesja. Po restarcie VELORA nie ma żadnej
automatycznej akcji.
