(() => {
  const state = Object.freeze({
    enabled: false,
    paired: false,
    connected: false,
    endpointAvailable: false,
  });
  const connection = document.getElementById("connection-state");
  const pairing = document.getElementById("pairing-state");
  const origin = document.getElementById("origin-state");
  if (connection) connection.textContent = "serwer LAN: wyłączony";
  if (origin) origin.textContent = window.isSecureContext
    ? "bezpieczny kontekst przeglądarki; serwer NEXUS nadal wyłączony"
    : "wymaga HTTPS zaufanego przez iPhone'a";
  if (pairing) {
    pairing.textContent = window.isSecureContext
      ? "Origin jest bezpieczny, ale NEXUS nie udostępnia endpointu. Serwer, parowanie i polecenia pozostają wyłączone."
      : "Ta strona nie ma zaufanego HTTPS. Serwer, parowanie i polecenia pozostają wyłączone.";
  }
  window.NEXUS_REMOTE_PREVIEW_STATE = state;

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      if (pairing) pairing.textContent = "Podgląd działa bez trybu offline. Zdalne sterowanie pozostaje wyłączone.";
    });
  }
})();
