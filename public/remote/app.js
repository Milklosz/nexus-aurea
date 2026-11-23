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
    verified: false,
    verificationInFlight: false,
    authorizationRejected: false,
    rejectedRecord: null,
    record: null,
    rejectedUnconfirmedRecord: false,
  };
  const RECONNECT_MAX_ATTEMPTS = 8;
  // Phase 3 (fail-closed outbound pipeline): bounded AUTOMATIC retries apply ONLY
  // to requests that provably never reached the server. An ambiguous timeout
  // after send is marked "unknown" and needs explicit re-confirmation — it is
  // never blindly retried (the server persists last_sequence before emit).
  const OUTBOUND_MAX_AUTO_RETRIES = 3;
  // Prepared outbound entries, deduped by commandId; at most one is in flight.
  const outboundQueue = [];
  // Entries whose outcome is unknown after send — re-sent ONLY on explicit
  // user re-confirmation, with the SAME sequence + signature (never re-signed).
  const unknownOutbound = [];
  // User taps accepted while another command is in flight or while offline.
  const pendingIntents = [];
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

  // A desktop QR may hand us a ONE-TIME code as a short-lived URL fragment.
  // The fragment is never sent in any fetch (no '#...' reaches the server or an
  // access log) and is cleared immediately after reading. It is only a prefill
  // hint: the server's own <=60s TTL and single-use rule remain the authority.
  function readPairingFragment() {
    let raw = "";
    try { raw = String(window.location.hash || ""); } catch { return null; }
    const match = /^#pair=(\d{6})&exp=(\d{1,12})$/.exec(raw);
    if (!match) return null;
    const exp = Number(match[2]);
    if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;
    return { code: match[1], exp };
  }

  function clearPairingFragment() {
    try {
      if (typeof history !== "undefined" && history.replaceState) {
        history.replaceState(null, "", (window.location.pathname || "/") + (window.location.search || ""));
      } else {
        window.location.hash = "";
      }
    } catch { /* the code is never written to durable storage */ }
  }

  function base64UrlToBytes(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    let bits = "";
    for (const character of normalized) {
      const index = alphabet.indexOf(character);
      if (index < 0) return null;
      bits += index.toString(2).padStart(6, "0");
    }
    const bytes = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
    return new Uint8Array(bytes);
  }

  // Deterministic correlation id (FNV-1a 32-bit over deviceId + sequence) — NOT a
  // signature, never sent to the server; used only to dedup the local queue.
  function commandIdFor(deviceId, sequence) {
    const joined = ["remote", String(deviceId), String(sequence)].join("\u001f");
    let hash = 0x811c9dc5;
    for (let index = 0; index < joined.length; index += 1) {
      hash ^= joined.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return "velora-" + hash.toString(16).padStart(8, "0");
  }

  function outboundHasId(commandId) {
    return outboundQueue.some((entry) => entry.commandId === commandId)
      || unknownOutbound.some((entry) => entry.commandId === commandId);
  }

  function removeOutboundEntry(entry) {
    let index = outboundQueue.indexOf(entry);
    if (index >= 0) outboundQueue.splice(index, 1);
    index = unknownOutbound.indexOf(entry);
    if (index >= 0) unknownOutbound.splice(index, 1);
    renderUnknownPanel();
  }

  // An outcome that is unknown after send (timeout / 409 / connection lost after
  // send) must never be blindly retried: the server may have applied it already.
  // The entry moves to the "unknown" list and waits for explicit re-confirmation.
  function markEntryUnknown(entry) {
    if (entry.state === "unknown") return;
    entry.state = "unknown";
    const index = outboundQueue.indexOf(entry);
    if (index >= 0) outboundQueue.splice(index, 1);
    if (!unknownOutbound.includes(entry)) unknownOutbound.push(entry);
    renderUnknownPanel();
  }

  function setElementText(id, text) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  }

  function renderUnknownPanel() {
    const panel = document.getElementById("unknown-panel");
    const confirm = document.getElementById("unknown-confirm");
    const note = document.getElementById("unknown-note");
    const hasUnknown = unknownOutbound.length > 0;
    if (panel) panel.hidden = !hasUnknown;
    if (confirm) {
      confirm.hidden = !hasUnknown;
      confirm.disabled = !state.secure || !navigator.onLine || state.inFlight || state.statusInFlight || !state.paired;
    }
    if (note && hasUnknown) {
      note.textContent = "Nieznany wynik: "
        + unknownOutbound.map((entry) => commandLabels[entry.command] || entry.command).join(", ")
        + ". Dotknij tego samego przycisku, aby potwierdzić wysłanie dokładnie tego samego podpisanego polecenia.";
    }
  }

  function waitMs(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  // Bounded exponential backoff for provably never-sent automatic retries.
  function outboundRetryDelayMs(attempt) {
    return Math.min(200 * 2 ** Math.max(0, attempt), 1600);
  }

  function updateControls() {
    const canSend = state.secure && state.serverReady && state.storageReady && state.paired && navigator.onLine && !state.inFlight && !state.statusInFlight;
    for (const button of commandButtons) button.disabled = !canSend;
    if (touchpad) touchpad.disabled = !canSend;
    if (!canSend) touchGesture = null;
    pairButton.disabled = !state.secure || !state.serverReady || !state.storageReady || state.paired || !navigator.onLine || state.inFlight || state.statusInFlight;
    if (retryButton) retryButton.disabled = !state.secure || !navigator.onLine || state.statusInFlight || state.inFlight;
    // Pairing lifecycle UX: this device's identity is visible once paired.
    setElementText("device-id", state.record && state.record.deviceId ? state.record.deviceId : "—");
    renderUnknownPanel();
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

  // Authenticated "hello": reuses the SAME non-exportable device HMAC key that
  // signs commands (no new key distribution). The server returns an ack bound
  // to our fresh nonce, a server epoch and the paired-device count; we accept
  // it only after recomputing the MAC ourselves. Fail closed on anything else.
  async function verifyPairedState() {
    const record = state.record;
    if (!record || !record.key || !state.paired || state.verificationInFlight) return false;
    state.verificationInFlight = true;
    try {
      const nonce = randomHex(16);
      const requestPayload = ["NEXUS-AUREA-REMOTE-V1", record.deviceId, "hello", nonce].join("\n");
      const requestSignature = await crypto.subtle.sign("HMAC", record.key, new TextEncoder().encode(requestPayload));
      let response;
      try {
        response = await fetchWithTimeout("./api/hello", {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId: record.deviceId,
            nonce,
            signature: bytesToBase64Url(new Uint8Array(requestSignature)),
          }),
        });
      } catch { return false; }
      if (!response.ok) return false;
      let ack;
      try { ack = await response.json(); } catch { return false; }
      if (!ack || ack.nonce !== nonce
        || !Number.isSafeInteger(ack.serverEpoch) || ack.serverEpoch <= 0
        || !Number.isSafeInteger(ack.pairedDeviceCount) || ack.pairedDeviceCount < 1) return false;
      const ackPayload = [
        "NEXUS-AUREA-REMOTE-V1", record.deviceId, "hello-ack",
        String(ack.serverEpoch), String(ack.pairedDeviceCount), nonce,
      ].join("\n");
      const expected = new Uint8Array(await crypto.subtle.sign("HMAC", record.key, new TextEncoder().encode(ackPayload)));
      const received = base64UrlToBytes(ack.signature);
      if (!received || received.length !== expected.length) return false;
      let diff = 0;
      for (let index = 0; index < expected.length; index += 1) diff |= expected[index] ^ received[index];
      return diff === 0;
    } catch {
      return false;
    } finally {
      state.verificationInFlight = false;
    }
  }

  // Wi-Fi reconnect (app resumed to the foreground): bounded exponential
  // backoff, then a FRESH signed status verification. No queued command is ever
  // replayed (sendCommand is only ever called by a direct user action).
  function reconnectDelayMs(attempt) {
    if (attempt >= RECONNECT_MAX_ATTEMPTS) return 0;
    return Math.min(400 * 2 ** attempt, 10_000);
  }

  async function reconnectStep(attempt, requirePriorVerification) {
    if (!state.secure || !navigator.onLine || !state.hasConnected) return;
    await refreshStatus();
    if (!state.serverReady) {
      if (attempt + 1 < RECONNECT_MAX_ATTEMPTS) {
        setTimeout(() => { void reconnectStep(attempt + 1, requirePriorVerification); }, reconnectDelayMs(attempt));
      }
      return;
    }
    // A fresh foreground session always re-verifies; a plain `online` event
    // only re-verifies a session that was already verified (first load keeps
    // the existing server-confirmed-record behaviour).
    if (state.paired && state.record && (!requirePriorVerification || state.verified)) {
      const ok = await verifyPairedState();
      state.verified = ok;
      if (!ok) {
        state.paired = false;
        pairingForm.hidden = false;
        pairingState.textContent = "wymagane ponowne parowanie";
        setConnectionState("wymagane parowanie", "needs-pairing");
        showMessage("Nie udało się zweryfikować sparowanego stanu podpisem urządzenia. Sparuj iPhone'a ponownie.", true);
      } else {
        pairingState.textContent = "sparowane · zweryfikowane";
        showMessage("Stan sparowania zweryfikowany podpisem urządzenia.");
      }
      updateControls();
    }
    // After a verified reconnect, resume ONLY the never-sent queued intents.
    // "unknown" entries are never auto-replayed — they need re-confirmation.
    void drainPendingIntents();
  }

  function onReconnect(requirePriorVerification = false) {
    if (!state.secure || !navigator.onLine || !state.hasConnected) {
      void refreshStatus();
      return;
    }
    void reconnectStep(0, requirePriorVerification);
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
      state.verified = true;
      state.rejectedUnconfirmedRecord = false;
      state.authorizationRejected = false;
      state.rejectedRecord = null;
      const codeInput = document.getElementById("pairing-code");
      if (codeInput) codeInput.value = "";
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
          await sendCommandQueued(command);
        });
      } catch {
        showMessage("Nie można bezpiecznie zarezerwować polecenia. Odśwież pilot.", true);
      }
      return;
    }
    await sendCommandQueued(command);
  }

  // Phase 3 fail-closed entry point. Re-tapping a command whose outcome is
  // "unknown" re-sends the SAME signed entry (explicit re-confirmation);
  // otherwise the tap joins the outbound queue behind the single in-flight
  // request — or waits while the iPhone is offline.
  async function sendCommandQueued(command) {
    if (!Object.prototype.hasOwnProperty.call(commandLabels, command)) return;
    if (!state.secure || !state.serverReady || !state.storageReady || !state.paired || !state.record) return;
    const unknown = unknownOutbound.find((entry) => entry.command === command);
    if (unknown) {
      if (state.inFlight || state.statusInFlight || !navigator.onLine) return;
      await reconfirmEntry(unknown);
      return;
    }
    if (!navigator.onLine) {
      // Wi-Fi loss: queue the command. It was never on the wire, so sending it
      // after a verified reconnect cannot replay anything.
      pendingIntents.push(command);
      showMessage("iPhone jest offline. Polecenie zapisane w kolejce — zostanie wysłane po ponownym połączeniu.", true);
      return;
    }
    if (state.inFlight || state.statusInFlight) {
      pendingIntents.push(command);
      showMessage("Polecenie czeka w kolejce za bieżącym.");
      return;
    }
    await runSingleCommand(command);
  }

  async function runSingleCommand(command) {
    state.inFlight = true;
    showMessage("Wysyłam: " + (commandLabels[command] || "polecenie") + "…");
    updateControls();
    try {
      await sendCommandUnlocked(command);
    } finally {
      state.inFlight = false;
      updateControls();
      void drainPendingIntents();
    }
  }

  // Sends the never-sent queued intents one at a time (single in-flight kept).
  // "unknown" entries are deliberately NOT drained here.
  async function drainPendingIntents() {
    while (pendingIntents.length > 0
      && !state.inFlight && !state.statusInFlight
      && navigator.onLine && state.secure && state.serverReady
      && state.storageReady && state.paired && state.record) {
      const next = pendingIntents.shift();
      await runSingleCommand(next);
    }
  }

  // Explicit user re-confirmation: re-sends the EXACT same signed entry (same
  // sequence + signature). The server can only answer dedup-2xx / 409 / 401 —
  // a second side effect is impossible.
  async function reconfirmEntry(entry) {
    state.inFlight = true;
    showMessage("Potwierdzam ponownie: " + (commandLabels[entry.command] || "polecenie") + "…");
    updateControls();
    try {
      await dispatchEntry(entry, state.record, ++commandRequestId);
    } finally {
      state.inFlight = false;
      updateControls();
    }
  }

  async function sendCommandUnlocked(command) {
    if (!Object.prototype.hasOwnProperty.call(commandLabels, command)
      || !state.secure || !state.serverReady || !state.storageReady || !state.paired
      || !state.record || state.statusInFlight || !navigator.onLine) return;
    const requestId = ++commandRequestId;
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
      const commandId = commandIdFor(record.deviceId, sequence);
      if (outboundHasId(commandId)) return; // dedup by commandId
      const entry = {
        command,
        sequence,
        commandId,
        deviceId: record.deviceId,
        credentialGeneration: record.credentialGeneration,
        signature: bytesToBase64Url(new Uint8Array(signature)),
        attempts: 0,
        state: "sending",
      };
      outboundQueue.push(entry);
      await dispatchEntry(entry, record, requestId);
    } catch {
      if (requestId === commandRequestId) {
        showMessage("Połączenie przerwane. Polecenie nie zostało automatycznie ponowione.", true);
      }
    }
  }

  // One outbound attempt loop with the fail-closed retry policy. EVERY attempt
  // reuses the entry's EXACT signed bytes — the sequence is never incremented
  // and the payload is never re-signed on a retry.
  async function dispatchEntry(entry, record, requestId) {
    const commandLabel = commandLabels[entry.command] || "polecenie";
    try {
      while (true) {
        let response;
        try {
          response = await fetchWithTimeout("./api/command", {
            method: "POST",
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              deviceId: entry.deviceId,
              sequence: entry.sequence,
              command: entry.command,
              signature: entry.signature,
            }),
          });
        } catch (error) {
          const label = String((error && (error.name + " " + error.message)) || error || "");
          // "never reached the server" is provable only when the browser is
          // offline, or on a DNS / connect-refused network error before send.
          const neverReached = !navigator.onLine
            || (!/abort|timeout|timed.?out/i.test(label)
              && /network|failed to fetch|fetch failed|econnreset|econnrefused|enotfound|dns/i.test(label));
          // Bounded automatic retries ONLY for provably never-sent requests,
          // with exponential backoff, reusing the SAME sequence + signature.
          if (neverReached && entry.attempts < OUTBOUND_MAX_AUTO_RETRIES) {
            entry.attempts += 1;
            await waitMs(outboundRetryDelayMs(entry.attempts));
            if (requestId !== commandRequestId) return;
            if (!navigator.onLine) {
              // Dropped again mid-wait: keep it queued for a verified
              // reconnect — it was never sent, so it is not "unknown".
              entry.state = "queued";
              return;
            }
            continue;
          }
          // Ambiguous after send (our deadline fired after the request left, or
          // any other post-send loss): NEVER blindly retried — the server may
          // have persisted the sequence and applied the command already.
          markEntryUnknown(entry);
          if (requestId === commandRequestId) {
            showMessage("Połączenie przerwane. Polecenie nie zostało automatycznie ponowione.", true);
          }
          return;
        }
        if (requestId !== commandRequestId) return;
        if (response.status === 401) {
          // Replay-rejected / revoked: surface a clear state and unpair.
          state.authorizationRejected = true;
          state.verified = false;
          state.rejectedRecord = { deviceId: entry.deviceId, credentialGeneration: entry.credentialGeneration };
          state.record = null;
          state.paired = false;
          pairingForm.hidden = false;
          pairingState.textContent = "wymagane ponowne parowanie";
          setConnectionState("wymagane parowanie", "needs-pairing");
          removeOutboundEntry(entry);
          await rejectStoredRecord(record);
          if (requestId !== commandRequestId) return;
          showMessage("VELORA nie akceptuje już poświadczeń tego iPhone'a. Sparuj go ponownie z nowym kodem.", true);
        } else if (response.status === 409) {
          // Sequence reserved but no receipt: the outcome is unknown. Surface
          // it; re-confirmation re-sends the same signed bytes.
          markEntryUnknown(entry);
          showMessage("VELORA nie może potwierdzić wyniku polecenia. Sprawdź stan urządzenia przed ręcznym ponowieniem.", true);
        } else if (response.status === 429) {
          removeOutboundEntry(entry);
          showMessage("VELORA chwilowo ogranicza liczbę poleceń. Poczekaj i sprawdź stan urządzenia.", true);
        } else if (!response.ok) {
          removeOutboundEntry(entry);
          showMessage("VELORA nie potwierdziła polecenia. Sprawdź stan urządzenia przed ręcznym ponowieniem.", true);
        } else {
          removeOutboundEntry(entry);
          showMessage("Wysłano: " + commandLabel + ".");
        }
        return;
      }
    } catch {
      if (requestId === commandRequestId) {
        showMessage("Połączenie przerwane. Polecenie nie zostało automatycznie ponowione.", true);
      }
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

  // Read and clear the short-lived fragment once, on every load. The value is
  // a transient prefill hint only; clearing prevents a later navigation from
  // reusing the code.
  let rawFragment = "";
  try { rawFragment = String(window.location.hash || ""); } catch { rawFragment = ""; }
  const hadPairFragment = /^#pair=\d{6}&exp=\d{1,12}$/.test(rawFragment);
  const fragmentPairing = readPairingFragment();
  clearPairingFragment();
  // QR onboarding status states (purely local — the code never leaves the page).
  setElementText("qr-onboarding-state", fragmentPairing
    ? "kod z QR aktywny"
    : hadPairFragment
      ? "kod z QR wygasł — wygeneruj nowy w Control Center"
      : "—");

  if (!state.secure || !window.crypto?.subtle || !window.indexedDB) {
    state.secure = false;
    showMessage("Ten iPhone nie udostępnia bezpiecznego HTTPS, WebCrypto i IndexedDB. Pilot pozostaje wyłączony.", true);
  } else {
    pairingForm.addEventListener("submit", pair);
    for (const button of commandButtons) {
      button.addEventListener("click", () => void sendCommand(button.dataset.command));
    }
    document.getElementById("unknown-confirm")?.addEventListener("click", () => {
      const entry = unknownOutbound[0];
      if (entry) void reconfirmEntry(entry);
    });
    if (fragmentPairing) {
      const codeInput = document.getElementById("pairing-code");
      if (codeInput) codeInput.value = fragmentPairing.code;
      const fragmentNote = document.getElementById("pairing-fragment-note");
      if (fragmentNote) fragmentNote.hidden = false;
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
    // Wi-Fi loss: an in-flight command is now AMBIGUOUS (it may or may not have
    // been applied). It is marked "unknown" and queued for explicit
    // re-confirmation — never automatically re-sent.
    for (const entry of [...outboundQueue]) {
      if (entry.state === "sending") markEntryUnknown(entry);
    }
    showOfflineStatus();
  });
    window.addEventListener("online", () => onReconnect(true));
    retryButton?.addEventListener("click", () => void refreshStatus());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void onReconnect();
  });
})();
