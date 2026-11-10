export type RemoteAccessStatus = {
  enabled: false;
  paired: false;
  connected: false;
  endpointAvailable: false;
};

export type RemoteCommandContext = {
  enabled: boolean;
  paired: boolean;
  connected: boolean;
  authenticated: boolean;
};

export const REMOTE_ACCESS_DISABLED_REASON =
  "Bez sprawdzonego parowania i uwierzytelnionego transportu nie wystawiamy endpointu w sieci lokalnej.";

const DISABLED_STATUS: RemoteAccessStatus = Object.freeze({
  enabled: false,
  paired: false,
  connected: false,
  endpointAvailable: false,
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