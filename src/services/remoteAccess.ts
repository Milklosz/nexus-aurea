export type RemoteAccessStatus = {
  enabled: false;
  paired: false;
  connected: false;
  endpointAvailable: false;
  secureOriginAvailable: false;
  pairingAvailable: false;
  pairedDeviceCount: 0;
  reason: "trustedHttpsRequired";
};

export type RemoteCommandContext = {
  enabled: boolean;
  paired: boolean;
  connected: boolean;
  authenticated: boolean;
};

export const REMOTE_ACCESS_DISABLED_REASON =
  "Brak HTTPS z certyfikatem zaufanym przez iPhone'a. HTTP w sieci lokalnej pozwoliłoby podmienić stronę i przechwycić kod parowania, więc serwer i komendy są wyłączone.";

const DISABLED_STATUS: RemoteAccessStatus = Object.freeze({
  enabled: false,
  paired: false,
  connected: false,
  endpointAvailable: false,
  secureOriginAvailable: false,
  pairingAvailable: false,
  pairedDeviceCount: 0,
  reason: "trustedHttpsRequired",
});

export function getRemoteAccessStatus(): RemoteAccessStatus {
  return { ...DISABLED_STATUS };
}

export async function beginRemotePairing(): Promise<never> {
  throw new Error(REMOTE_ACCESS_DISABLED_REASON);
}

export function authorizeRemoteCommand(_context: RemoteCommandContext): boolean {
  return false;
}

export function revokeRemoteAccess(): RemoteAccessStatus {
  return { ...DISABLED_STATUS };
}

export function remoteConnectionLost(): RemoteAccessStatus {
  return { ...DISABLED_STATUS };
}
