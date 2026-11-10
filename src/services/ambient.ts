export type AmbientSettings = {
  enabled: boolean;
  idleSeconds: number;
};

export const AMBIENT_IDLE_OPTIONS = [60, 300, 600, 900, 1800] as const;
export const DEFAULT_AMBIENT_SETTINGS: AmbientSettings = { enabled: false, idleSeconds: 300 };

const SETTINGS_KEY = "nexus.ambientSettings";

function storageOrUndefined(storage?: Pick<Storage, "getItem" | "setItem">): Pick<Storage, "getItem" | "setItem"> | undefined {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function normalizeAmbientDelay(value: unknown): number {
  return typeof value === "number" && AMBIENT_IDLE_OPTIONS.some((option) => option === value)
    ? value
    : DEFAULT_AMBIENT_SETTINGS.idleSeconds;
}

export function readAmbientSettings(storage?: Pick<Storage, "getItem" | "setItem">): AmbientSettings {
  try {
    const raw = storageOrUndefined(storage)?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AMBIENT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_AMBIENT_SETTINGS };
    const record = parsed as Record<string, unknown>;
    return { enabled: record.enabled === true, idleSeconds: normalizeAmbientDelay(record.idleSeconds) };
  } catch {
    return { ...DEFAULT_AMBIENT_SETTINGS };
  }
}

export function saveAmbientSettings(settings: AmbientSettings, storage?: Pick<Storage, "getItem" | "setItem">): void {
  try {
    storageOrUndefined(storage)?.setItem(SETTINGS_KEY, JSON.stringify({
      enabled: settings.enabled === true,
      idleSeconds: normalizeAmbientDelay(settings.idleSeconds),
    }));
  } catch {
    // The choice remains active for this session even when WebView storage is unavailable.
  }
}

export function idleDeadlineReached(lastActivityAt: number, now: number, delaySeconds: number): boolean {
  return now >= lastActivityAt && now - lastActivityAt >= normalizeAmbientDelay(delaySeconds) * 1000;
}

export function nextAmbientDelay(current: number): number {
  const index = AMBIENT_IDLE_OPTIONS.indexOf(normalizeAmbientDelay(current) as typeof AMBIENT_IDLE_OPTIONS[number]);
  return AMBIENT_IDLE_OPTIONS[(index + 1) % AMBIENT_IDLE_OPTIONS.length];
}