(() => {
  const databaseName = "nexus-aurea-remote-v1";
  const storeName = "device";
  const state = {
    secure: window.isSecureContext && window.location.protocol === "https:",
    serverReady: false,
    storageReady: false,
    paired: false,
    inFlight: false,
    statusInFlight: false,
    hasConnected: false,
    authorizationRejected: false,
    rejectedRecord: null,
    record: null,
    rejectedUnconfirmedRecord: false,
  };
  let statusRequestId = 0;
  let commandRequestId = 0;
  const connection = document.getElementById("connection-state");
  const server = document.getElementById("server-state");
  const origin = document.getElementById("origin-state");
  const pairingState = document.getElementById("pairing-state");
  const pairedCount = document.getElementById("paired-count");
  const message = document.getElementById("remote-message");
  const pairingForm = document.getElementById("pairing-form");
  const pairButton = document.getElementById("pair-button");
  const retryButton = document.getElementById("retry-button");
  const commandButtons = [...document.querySelectorAll("[data-command]")];
  const touchpad = document.getElementById("navigation-touchpad");
  const padMode = document.getElementById("pad-mode");
  const touchMode = document.getElementById("touch-mode");
  const directionPad = document.querySelector?.(".remote-pad");
  let touchGesture = null;
  const commandLabels = {
    up: "Góra",
    down: "Dół",
    left: "Lewo",
    right: "Prawo",
    select: "Wybierz",
    back: "Wstecz",
    home: "Home",
    menu: "Control Center",
    "switch-apps": "Aplikacje",
    "volume-up": "Głośniej",
    "volume-down": "Ciszej",
    mute: "Wycisz",
    "profile-cinema": "Cinema",
    "profile-gaming": "Gaming",
    "profile-desktop": "Desktop",
  };

  function showMessage(text, error = false) {
    if (!message) return;
    message.textContent = text;
    message.dataset.kind = error ? "error" : "normal";
  }

  function setConnectionState(text, kind) {
    connection.textContent = text;
    connection.dataset.state = kind;
  }

  function showRetryButton(label) {
    if (!retryButton) return;
    retryButton.hidden = false;
    retryButton.textContent = label;
    retryButton.disabled = !state.secure || !navigator.onLine || state.statusInFlight || state.inFlight;
  }

  function hideRetryButton() {
    if (retryButton) retryButton.hidden = true;
  }

  const requestTimeoutMs = 8000;

  async function fetchWithTimeout(resource, options) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;
    try {
      return await fetch(resource, controller ? { ...options, signal: controller.signal } : options);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function updateControls() {
    const canSend = state.secure && state.serverReady && state.storageReady && state.paired && navigator.onLine && !state.inFlight && !state.statusInFlight;
    for (const button of commandButtons) button.disabled = !canSend;
    if (touchpad) touchpad.disabled = !canSend;
    if (!canSend) touchGesture = null;
    pairButton.disabled = !state.secure || !state.serverReady || !state.storageReady || state.paired || !navigator.onLine || state.inFlight || state.statusInFlight;
    if (retryButton) retryButton.disabled = !state.secure || !navigator.onLine || state.statusInFlight || state.inFlight;
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function randomHex(byteCount) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Pamięć bezpiecznego klucza jest niedostępna."));
    });
  }

  async function readRecord() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get("active");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error("Nie można odczytać klucza pilota."));
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => reject(new Error("Nie można odczytać klucza pilota."));
    });
  }

  function sameCredential(current, expected) {
    if (!current || !expected) return current === expected;
    // A pairing always generates a new random deviceId. The local generation
    // also distinguishes new records; absent generations keep legacy keys usable.
    return current.deviceId === expected.deviceId
      && current.credentialGeneration === expected.credentialGeneration;
  }

  function sameRecordVersion(current, expected) {
    return sameCredential(current, expected) && (!current || (
      current.sequence === expected.sequence
      && current.confirmedByServer === expected.confirmedByServer
      && current.rejectedByServer === expected.rejectedByServer
      && Boolean(current.key) === Boolean(expected.key)
    ));
  }

  // All read/check/write operations stay in one IndexedDB readwrite transaction.
  // Web Locks improve command ordering but are never the storage safety boundary.
  async function mutateRecord(mutate) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.get("active");
      let result = null;
      request.onsuccess = () => {
        const next = mutate(request.result || null);
        if (next === undefined) return;
        if (next === null) store.delete("active");
        else store.put(next, "active");
        result = { record: next };
      };
      transaction.oncomplete = () => {
        database.close();
        resolve(result);
      };
      const fail = () => { database.close(); reject(new Error("Nie można bezpiecznie zmienić klucza pilota.")); };
      request.onerror = fail;
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
  }

  async function reserveSequence(expected) {
    const result = await mutateRecord(record => {
      if (!record || !sameCredential(record, expected) || !record.key
        || record.confirmedByServer !== true || record.rejectedByServer === true
        || !Number.isSafeInteger(record.sequence) || record.sequence < 0
        || record.sequence >= Number.MAX_SAFE_INTEGER) return undefined;
      return { ...record, sequence: record.sequence + 1 };
    });
    return result?.record || null;
  }

  async function clearObservedRecord(expected) {
    return mutateRecord(current => sameRecordVersion(current, expected) ? null : undefined);
  }

  async function rejectStoredRecord(expected) {
    try {
      await mutateRecord(current => sameCredential(current, expected) ? null : undefined);
    } catch {
      // A failed deletion may leave a matching credential. A guarded, non-secret
      // tombstone must never replace a different tab's newly confirmed pairing.
      try {
        await mutateRecord(current => sameCredential(current, expected) ? {
          deviceId: expected.deviceId,
          credentialGeneration: expected.credentialGeneration,
          rejectedByServer: true,
        } : undefined);
      } catch { /* authorizationRejected still fails closed for this key in this page */ }
    }
  }

  async function refreshStatus() {
    const requestId = ++statusRequestId;
    if (!state.secure) {
      state.statusInFlight = false;
      setConnectionState("wymaga zaufanego HTTPS", "insecure");
      server.textContent = "wyłączony";
      origin.textContent = "brak bezpiecznego kontekstu";
      pairingState.textContent = "parowanie wyłączone";
      hideRetryButton();
      updateControls();
      showMessage("Otwórz dokładny adres HTTPS pokazany w VELORA. Nie kontynuuj po ostrzeżeniu certyfikatu.", true);
      return;
    }

    if (!navigator.onLine) {
      state.statusInFlight = false;
      showOfflineStatus();
      return;
    }

    state.statusInFlight = true;
    setConnectionState(state.hasConnected ? "ponowne łączenie…" : "sprawdzam połączenie…", state.hasConnected ? "reconnecting" : "checking");
    hideRetryButton();
    if (state.hasConnected) showMessage("Sprawdzam ponownie bezpieczne połączenie. Polecenia są chwilowo wstrzymane.");
    updateControls();

    try {
      const response = await fetchWithTimeout("./api/status", {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (requestId !== statusRequestId) return;
      if (!response.ok) throw new Error("Serwer pilota jest niedostępny.");
      const remote = await response.json();
      if (requestId !== statusRequestId) return;
      state.hasConnected = true;
      state.serverReady = remote.enabled === true;
      server.textContent = state.serverReady ? "włączony" : "wyłączony";
      origin.textContent = "HTTPS";
      pairingState.textContent = state.serverReady ? "oczekuje na parowanie" : "niedostępne";
      pairedCount.textContent = String(Number.isInteger(remote.pairedDeviceCount) ? remote.pairedDeviceCount : 0);
      setConnectionState(state.serverReady ? "HTTPS · połączono" : "serwer LAN wyłączony", state.serverReady ? "connected" : "server-off");
      if (!state.serverReady) {
        state.storageReady = false;
        state.paired = false;
        state.record = null;
        state.rejectedUnconfirmedRecord = false;
        pairingForm.hidden = true;
        showRetryButton("Sprawdź ponownie");
        showMessage("Serwer LAN został wyłączony w VELORA.");
      } else {
        try {
          const storedRecord = await readRecord();
          if (requestId !== statusRequestId) return;
          if (storedRecord) state.authorizationRejected = storedRecord.rejectedByServer === true
            || Boolean(state.rejectedRecord && sameCredential(storedRecord, state.rejectedRecord));
          const confirmed = Boolean(
            storedRecord
            && storedRecord.key
            && storedRecord.deviceId
            && storedRecord.confirmedByServer === true,
          );
          if (storedRecord && (!confirmed || state.authorizationRejected)) {
            try { await clearObservedRecord(storedRecord); } catch { /* the unconfirmed record stays unusable */ }
            if (requestId !== statusRequestId) return;
          }
          state.record = confirmed && !state.authorizationRejected ? storedRecord : null;
          state.storageReady = true;
          state.rejectedUnconfirmedRecord = Boolean(storedRecord && !confirmed && storedRecord.rejectedByServer !== true);
        } catch {
          if (requestId !== statusRequestId) return;
          state.record = null;
          state.storageReady = false;
          state.paired = false;
          state.rejectedUnconfirmedRecord = false;
          pairingForm.hidden = true;
          pairingState.textContent = "pamięć klucza niedostępna";
          setConnectionState("wymagana bezpieczna pamięć", "storage-error");
          showMessage("Bezpieczna pamięć klucza jest niedostępna. Parowanie i polecenia pozostają wyłączone.", true);
          updateControls();
          return;
        }
        state.paired = Boolean(state.record);
        pairingState.textContent = state.authorizationRejected
          ? "wymagane ponowne parowanie"
          : state.paired ? "sparowane" : "oczekuje na parowanie";
        pairingForm.hidden = state.paired;
        if (state.authorizationRejected) {
          pairingForm.hidden = false;
          pairingState.textContent = "wymagane ponowne parowanie";
          setConnectionState("wymagane parowanie", "needs-pairing");
          showMessage("VELORA nie akceptuje już poświadczeń tego iPhone'a. Sparuj go ponownie z nowym kodem.", true);
        } else if (state.paired) showMessage("Pilot jest sparowany. Każda komenda wymaga podpisu urządzenia.");
        else if (state.rejectedUnconfirmedRecord) showMessage("Zapisany klucz nie ma potwierdzenia serwera. Sparuj iPhone'a ponownie.", true);
        else showMessage("Wpisz jednorazowy kod wygenerowany w Control Center.");
      }
    } catch {
      if (requestId !== statusRequestId) return;
      state.serverReady = false;
      state.paired = false;
      state.record = null;
      state.rejectedUnconfirmedRecord = false;
      pairingForm.hidden = true;
      server.textContent = "niedostępny";
      origin.textContent = "HTTPS bez odpowiedzi";
      pairingState.textContent = "niedostępne";
      setConnectionState("brak odpowiedzi · ponów połączenie", "disconnected");
      showRetryButton("Ponów połączenie");
      showMessage("Nie można połączyć z VELORA. Sprawdź tę samą sieć Wi‑Fi i czy serwer LAN działa.", true);
    } finally {
      if (requestId === statusRequestId) {
        state.statusInFlight = false;
        updateControls();
      }
    }
  }

  function showOfflineStatus() {
    state.statusInFlight = false;
    setConnectionState("offline", "offline");
    showRetryButton("Sprawdź połączenie");
    showMessage("iPhone jest offline. Polecenia są wstrzymane.", true);
    updateControls();
  }

  async function pair(event) {
    event.preventDefault();
    if (!state.secure || !state.serverReady || !state.storageReady || state.paired || state.inFlight || state.statusInFlight) return;
    const code = document.getElementById("pairing-code").value.trim();
    const name = document.getElementById("device-name").value.trim().slice(0, 32);
    if (!/^\d{6}$/.test(code) || !name) {
      showMessage("Wpisz sześciocyfrowy kod z Control Center.", true);
      return;
    }

    state.inFlight = true;
    updateControls();
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = bytesToBase64Url(tokenBytes);
    const deviceId = randomHex(16);
    try {
      const previousRecord = await readRecord();
      if (previousRecord?.confirmedByServer === true && previousRecord.key
        && !(state.rejectedRecord && sameCredential(previousRecord, state.rejectedRecord))) {
        await refreshStatus();
        showMessage("Inna karta zapisała już parowanie. Korzystaj z aktualnego klucza pilota.");
        return;
      }
      const key = await crypto.subtle.importKey(
        "raw",
        tokenBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      let response;
      try {
        response = await fetchWithTimeout("./api/pair", {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, deviceId, deviceName: name, token }),
        });
      } catch (error) {
        // A lost response is not proof that the server stored this device.
        // Keep the pairing form open and require a fresh server-confirmed attempt.
        state.record = null;
        state.paired = false;
        state.rejectedUnconfirmedRecord = false;
        pairingForm.hidden = false;
        pairingState.textContent = "parowanie niepotwierdzone";
        connection.textContent = "HTTPS · brak potwierdzenia";
        showMessage(error?.name === "AbortError"
          ? "VELORA nie potwierdziła parowania w wyznaczonym czasie. Wygeneruj nowy kod i spróbuj ponownie."
          : "Parowanie nie zostało potwierdzone przez VELORA. Sprawdź połączenie, wygeneruj nowy kod i spróbuj ponownie.", true);
        return;
      }
      if (response.status !== 201) {
        // This attempt has not stored a key. A failed response cannot revoke
        // a confirmed pairing written by another tab in the meantime.
        state.record = null;
        state.paired = false;
        pairingForm.hidden = false;
        const reason = response.status === 429
          ? "Za dużo prób. Wygeneruj nowy kod później."
          : response.status === 409
            ? "Limit urządzeń został osiągnięty albo iPhone jest już sparowany. Odwołaj stare urządzenie w Control Center."
            : response.status >= 500
              ? "VELORA nie zapisała bezpiecznie parowania. Sprawdź Magazyn poświadczeń Windows i spróbuj ponownie."
              : "Kod wygasł lub jest nieprawidłowy. Wygeneruj nowy kod w Control Center.";
        showMessage(reason, true);
        return;
      }
      const record = { deviceId, key, credentialGeneration: randomHex(16), sequence: 0, confirmedByServer: true };
      const saved = await mutateRecord(current => sameCredential(current, previousRecord) ? record : undefined);
      if (!saved) {
        await refreshStatus();
        showMessage("Parowanie zmieniło się w innej karcie. Zachowano nowszy klucz; sprawdź połączenie.", true);
        return;
      }
      state.record = record;
      state.paired = true;
      state.rejectedUnconfirmedRecord = false;
      state.authorizationRejected = false;
      state.rejectedRecord = null;
      pairingForm.hidden = true;
      pairedCount.textContent = String(Number(pairedCount.textContent || "0") + 1);
      pairingState.textContent = "sparowane";
      connection.textContent = "HTTPS · sparowano";
      showMessage("iPhone sparowany. Klucz podpisu zapisano jako nieeksportowalny klucz WebCrypto.");
    } catch {
      state.record = null;
      state.paired = false;
      state.rejectedUnconfirmedRecord = false;
      pairingForm.hidden = false;
      pairingState.textContent = "parowanie niepotwierdzone";
      connection.textContent = "HTTPS · brak potwierdzenia";
      showMessage("Nie udało się bezpiecznie przygotować klucza na tym iPhonie. Sparuj ponownie.", true);
    } finally {
      tokenBytes.fill(0);
      state.inFlight = false;
      updateControls();
    }
  }

  // Do not queue user actions behind another tab. Each accepted action reads
  // the latest persisted sequence while holding the same-origin browser lock.
  async function sendCommand(command) {
    if (navigator.locks?.request) {
      try {
        await navigator.locks.request("velora-remote-command", { ifAvailable: true }, async (lock) => {
          if (!lock) {
            showMessage("Inna karta pilota wysyła polecenie. Poczekaj i spróbuj ręcznie.", true);
            return;
          }
          await sendCommandUnlocked(command);
        });
      } catch {
        showMessage("Nie można bezpiecznie zarezerwować polecenia. Odśwież pilot.", true);
      }
      return;
    }
    await sendCommandUnlocked(command);
  }

  async function sendCommandUnlocked(command) {
    if (!Object.prototype.hasOwnProperty.call(commandLabels, command)
      || !state.secure || !state.serverReady || !state.storageReady || !state.paired
      || !state.record || state.inFlight || state.statusInFlight || !navigator.onLine) return;
    const requestId = ++commandRequestId;
    state.inFlight = true;
    const commandLabel = commandLabels[command] || "polecenie";
    showMessage("Wysyłam: " + commandLabel + "…");
    updateControls();
    try {
      const expectedRecord = state.record;
      const record = await reserveSequence(expectedRecord);
      if (!record) {
        showMessage("Zapisane parowanie zmieniło się lub jest nieprawidłowe. Sprawdź połączenie pilota.", true);
        return;
      }
      if (requestId !== commandRequestId || !navigator.onLine) return;
      const sequence = record.sequence;
      state.record = record;
      if (requestId !== commandRequestId) return;
      const payload = ["NEXUS-AUREA-REMOTE-V1", record.deviceId, String(sequence), command].join("\n");
      const signature = await crypto.subtle.sign(
        "HMAC",
        record.key,
        new TextEncoder().encode(payload),
      );
      if (requestId !== commandRequestId) return;
      const response = await fetchWithTimeout("./api/command", {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: record.deviceId,
          sequence,
          command,
          signature: bytesToBase64Url(new Uint8Array(signature)),
        }),
      });
      if (requestId !== commandRequestId) return;
      if (response.status === 401) {
        state.authorizationRejected = true;
        state.rejectedRecord = { deviceId: record.deviceId, credentialGeneration: record.credentialGeneration };
        state.record = null;
        state.paired = false;
        pairingForm.hidden = false;
        pairingState.textContent = "wymagane ponowne parowanie";
        setConnectionState("wymagane parowanie", "needs-pairing");
        await rejectStoredRecord(record);
        if (requestId !== commandRequestId) return;
        showMessage("VELORA nie akceptuje już poświadczeń tego iPhone'a. Sparuj go ponownie z nowym kodem.", true);
      } else if (response.status === 409) {
        showMessage("VELORA nie może potwierdzić wyniku polecenia. Sprawdź stan urządzenia przed ręcznym ponowieniem.", true);
      } else if (response.status === 429) {
        showMessage("VELORA chwilowo ogranicza liczbę poleceń. Poczekaj i sprawdź stan urządzenia.", true);
      } else if (!response.ok) {
        showMessage("VELORA nie potwierdziła polecenia. Sprawdź stan urządzenia przed ręcznym ponowieniem.", true);
      } else {
        showMessage("Wysłano: " + commandLabel + ".");
      }
    } catch {
      if (requestId === commandRequestId) {
        showMessage("Połączenie przerwane. Polecenie nie zostało automatycznie ponowione.", true);
      }
    } finally {
      state.inFlight = false;
      updateControls();
    }
  }

  function selectInputMode(useTouchpad) {
    touchGesture = null;
    if (touchpad) touchpad.hidden = !useTouchpad;
    if (directionPad) directionPad.hidden = useTouchpad;
    padMode?.setAttribute("aria-pressed", String(!useTouchpad));
    touchMode?.setAttribute("aria-pressed", String(useTouchpad));
  }

  padMode?.addEventListener("click", () => selectInputMode(false));
  touchMode?.addEventListener("click", () => selectInputMode(true));
  touchpad?.addEventListener("pointerdown", (event) => {
    // A second finger, cancellation, connection change or mode switch cancels
    // the gesture. Send at most one allowlisted command on a clean release.
    if (touchpad.disabled || touchpad.hidden || event.isPrimary === false || event.button !== 0) {
      touchGesture = null;
      return;
    }
    touchGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
    try { touchpad.setPointerCapture(event.pointerId); } catch { touchGesture = null; }
  });
  touchpad?.addEventListener("pointerup", (event) => {
    const gesture = touchGesture;
    touchGesture = null;
    if (!gesture || gesture.id !== event.pointerId || touchpad.disabled || touchpad.hidden) return;
    const x = event.clientX - gesture.x;
    const y = event.clientY - gesture.y;
    const elapsed = event.timeStamp - gesture.time;
    if (elapsed < 0 || elapsed > 1500 || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const distance = Math.max(Math.abs(x), Math.abs(y));
    if (distance >= 24) {
      void sendCommand(Math.abs(x) > Math.abs(y) ? (x > 0 ? "right" : "left") : (y > 0 ? "down" : "up"));
    } else if (distance <= 8 && elapsed <= 450) {
      void sendCommand("select");
    }
  });
  for (const type of ["pointercancel", "lostpointercapture"]) {
    touchpad?.addEventListener(type, () => { touchGesture = null; });
  }
  touchpad?.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat && !touchpad.disabled) {
      event.preventDefault();
      void sendCommand("select");
    }
  });

  if (!state.secure || !window.crypto?.subtle || !window.indexedDB) {
    state.secure = false;
    showMessage("Ten iPhone nie udostępnia bezpiecznego HTTPS, WebCrypto i IndexedDB. Pilot pozostaje wyłączony.", true);
  } else {
    pairingForm.addEventListener("submit", pair);
    for (const button of commandButtons) {
      button.addEventListener("click", () => void sendCommand(button.dataset.command));
    }
    void refreshStatus();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        showMessage("Połączenie HTTPS działa, ale tryb offline nie jest dostępny.", true);
      });
    }
  }

  window.addEventListener("offline", () => {
    statusRequestId += 1;
    commandRequestId += 1;
    showOfflineStatus();
  });
    window.addEventListener("online", () => void refreshStatus());
    retryButton?.addEventListener("click", () => void refreshStatus());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshStatus();
  });
})();
