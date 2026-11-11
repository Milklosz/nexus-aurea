(() => {
  const databaseName = "nexus-aurea-remote-v1";
  const storeName = "device";
  const state = {
    secure: window.isSecureContext && window.location.protocol === "https:",
    serverReady: false,
    storageReady: false,
    paired: false,
    inFlight: false,
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
  const commandButtons = [...document.querySelectorAll("[data-command]")];
  const commandLabels = {
    up: "Góra",
    down: "Dół",
    left: "Lewo",
    right: "Prawo",
    select: "Wybierz",
    back: "Wstecz",
    home: "Home",
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
    const canSend = state.secure && state.serverReady && state.storageReady && state.paired && navigator.onLine && !state.inFlight;
    for (const button of commandButtons) button.disabled = !canSend;
    pairButton.disabled = !state.secure || !state.serverReady || !state.storageReady || state.paired || !navigator.onLine || state.inFlight;
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

  async function writeRecord(record) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(record, "active");
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(new Error("Nie można zapisać klucza na tym iPhonie."));
      transaction.onabort = () => reject(new Error("Nie można zapisać klucza na tym iPhonie."));
    });
  }

  async function clearRecord() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete("active");
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(new Error("Nie można usunąć klucza pilota."));
    });
  }

  async function refreshStatus() {
    const requestId = ++statusRequestId;
    if (!state.secure) {
      connection.textContent = "wymaga zaufanego HTTPS";
      server.textContent = "wyłączony";
      origin.textContent = "brak bezpiecznego kontekstu";
      pairingState.textContent = "parowanie wyłączone";
      updateControls();
      showMessage("Otwórz dokładny adres HTTPS pokazany w VELORA. Nie kontynuuj po ostrzeżeniu certyfikatu.", true);
      return;
    }

    if (!navigator.onLine) {
      showOfflineStatus();
      return;
    }

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
      state.serverReady = remote.enabled === true;
      server.textContent = state.serverReady ? "włączony" : "wyłączony";
      origin.textContent = "HTTPS";
      pairingState.textContent = state.serverReady ? "oczekuje na parowanie" : "niedostępne";
      pairedCount.textContent = String(Number.isInteger(remote.pairedDeviceCount) ? remote.pairedDeviceCount : 0);
      connection.textContent = state.serverReady ? "HTTPS · lokalnie" : "serwer LAN wyłączony";
      if (!state.serverReady) {
        state.storageReady = false;
        state.paired = false;
        state.record = null;
        state.rejectedUnconfirmedRecord = false;
        pairingForm.hidden = true;
        showMessage("Serwer LAN został wyłączony w VELORA.");
      } else {
        try {
          const storedRecord = await readRecord();
          if (requestId !== statusRequestId) return;
          const confirmed = Boolean(
            storedRecord
            && storedRecord.key
            && storedRecord.deviceId
            && storedRecord.confirmedByServer === true,
          );
          if (storedRecord && !confirmed) {
            try { await clearRecord(); } catch { /* the unconfirmed record stays unusable */ }
            if (requestId !== statusRequestId) return;
          }
          state.record = confirmed ? storedRecord : null;
          state.storageReady = true;
          state.rejectedUnconfirmedRecord = Boolean(storedRecord && !confirmed);
        } catch {
          if (requestId !== statusRequestId) return;
          state.record = null;
          state.storageReady = false;
          state.paired = false;
          state.rejectedUnconfirmedRecord = false;
          pairingForm.hidden = true;
          pairingState.textContent = "pamięć klucza niedostępna";
          connection.textContent = "wymagana bezpieczna pamięć";
          showMessage("Bezpieczna pamięć klucza jest niedostępna. Parowanie i polecenia pozostają wyłączone.", true);
          updateControls();
          return;
        }
        state.paired = Boolean(state.record);
        pairingForm.hidden = state.paired;
        if (state.paired) showMessage("Pilot jest sparowany. Każda komenda wymaga podpisu urządzenia.");
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
      connection.textContent = "brak połączenia";
      showMessage("Nie można połączyć z VELORA. Sprawdź tę samą sieć Wi‑Fi i czy serwer LAN działa.", true);
    }
    updateControls();
  }

  function showOfflineStatus() {
    connection.textContent = "offline";
    showMessage("iPhone jest offline. Polecenia są wstrzymane.", true);
    updateControls();
  }

  async function pair(event) {
    event.preventDefault();
    if (!state.secure || !state.serverReady || !state.storageReady || state.inFlight) return;
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
        try { await clearRecord(); } catch { /* the key remains unusable until a confirmed pairing */ }
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
      const record = { deviceId, key, sequence: 0, confirmedByServer: true };
      await writeRecord(record);
      state.record = record;
      state.paired = true;
      state.rejectedUnconfirmedRecord = false;
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

  async function sendCommand(command) {
    if (!state.storageReady || !state.paired || !state.record || state.inFlight || !navigator.onLine) return;
    const requestId = ++commandRequestId;
    state.inFlight = true;
    const commandLabel = commandLabels[command] || "polecenie";
    showMessage("Wysyłam: " + commandLabel + "…");
    updateControls();
    const record = state.record;
    const sequence = record.sequence + 1;
    record.sequence = sequence;
    try {
      await writeRecord(record);
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
        await clearRecord();
        if (requestId !== commandRequestId) return;
        state.record = null;
        state.paired = false;
        pairingForm.hidden = false;
        pairingState.textContent = "odwołane lub ponownie wymagane";
        connection.textContent = "wymagane parowanie";
        showMessage("Dostęp tego iPhone'a został odwołany. Sparuj urządzenie ponownie.", true);
      } else if (!response.ok) {
        showMessage("VELORA odrzuciła polecenie. Połączenie pozostaje zabezpieczone.", true);
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
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshStatus();
  });
})();
