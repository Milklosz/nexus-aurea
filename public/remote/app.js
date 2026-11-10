(() => {
  const state = Object.freeze({
    enabled: false,
    paired: false,
    connected: false,
    endpointAvailable: false,
  });
  const connection = document.getElementById("connection-state");
  const pairing = document.getElementById("pairing-state");
  if (connection) connection.textContent = "endpoint niedostępny";
  if (pairing) pairing.textContent = "Parowanie i polecenia są wyłączone. Ten podgląd nie łączy się z NEXUS ani nie przechowuje tokenów.";
  window.NEXUS_REMOTE_PREVIEW_STATE = state;

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      if (pairing) pairing.textContent = "Podgląd działa bez trybu offline. Zdalne sterowanie pozostaje wyłączone.";
    });
  }
})();