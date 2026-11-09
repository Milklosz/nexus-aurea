export type CinemaProfile = "cinema" | "gaming" | "desktop";

const STORAGE_KEY = "nexus.cinemaProfile";

export function readCinemaProfile(storage: Pick<Storage, "getItem"> = localStorage): CinemaProfile {
  try {
    const profile = storage.getItem(STORAGE_KEY);
    if (profile === "cinema" || profile === "gaming" || profile === "desktop") return profile;
  } catch {
    // Storage can be unavailable in restricted WebViews; Cinema remains the safe UI default.
  }
  return "cinema";
}

export function saveCinemaProfile(profile: CinemaProfile, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, profile);
  } catch {
    // The selected profile still applies for this session.
  }
}
