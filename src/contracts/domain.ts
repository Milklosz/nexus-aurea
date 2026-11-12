/**
 * VELORA 1.0 — Ecosystem / typowane modele aplikacji i gier (moduł F).
 *
 * Stabilne, niezależne od UI modele danych. Backend (Rust) i przyszły frontend
 * komunikują się wyłącznie przez te kształty. Nie zawierają żadnej stylistyki,
 * animacji, motywu ani stanu docka — te pozostają nienaruszone.
 */

export type VeloraAppKind =
  | "internal-overlay"
  | "managed-launcher"
  | "streaming-window"
  | "game";

export type VeloraAppAvailability = "available" | "unavailable" | "unmanaged";

export type VeloraLaunchKind =
  | "tauri-command"
  | "playnite-uri"
  | "https-url"
  | "none";

/**
 * Referencja uruchomienia. `target` jest WYŁĄCZNIE jedną z bezpiecznych,
 * udokumentowanych form — nigdy surową ścieżką executable ani wierszem poleceń.
 * VELORA nie uruchamia procesów na podstawie tej referencji samodzielnie;
 * przekazuje ją do adaptera uruchomienia.
 */
export interface VeloraLaunchRef {
  readonly kind: VeloraLaunchKind;
  readonly target: string;
}

export interface VeloraApp {
  readonly id: string;
  readonly kind: VeloraAppKind;
  readonly label: string;
  readonly availability: VeloraAppAvailability;
  /** Czy proces/okno zostało uruchomione przez VELORA (można je bezpiecznie zamknąć po potwierdzeniu). */
  readonly managedByVelora: boolean;
  readonly launch: VeloraLaunchRef | null;
}

export type CoverKind = "data-uri" | "asset" | "none";

export interface CoverRef {
  readonly kind: CoverKind;
  readonly value: string;
}

export type GameId = string;

export interface VeloraGame {
  readonly id: GameId;
  readonly name: string;
  readonly cover: CoverRef;
  readonly source: string;
  readonly lastPlayed: string | null;
  readonly favorite: boolean;
  readonly installed: boolean;
  readonly launch: VeloraLaunchRef | null;
}

export type LibrarySource = "playnite-api" | "playnite-detected" | "unavailable";

/**
 * Kanoniczny kształt migawki biblioteki. `readOnly` jest literalnym `true`:
 * VELORA nigdy nie zapisuje danych do Playnite.
 */
export interface VeloraLibrarySnapshot<TGame = VeloraGame> {
  readonly source: LibrarySource;
  readonly available: boolean;
  readonly reason: string | null;
  readonly games: readonly TGame[];
  readonly readOnly: true;
}

/** Mapuje źródło okładki na trzy dozwolone schematy (parity z `sanitizeCoverSource`). */
export function coverRefFromSource(source: string | null): CoverRef {
  if (typeof source !== "string" || source.length === 0) {
    return { kind: "none", value: "" };
  }
  if (source.startsWith("data:image/")) return { kind: "data-uri", value: source };
  if (source.startsWith("asset:")) return { kind: "asset", value: source };
  return { kind: "none", value: "" };
}

/**
 * Buduje bezpieczną, oficjalnie udokumentowaną referencję uruchomienia gry
 * (`playnite://playnite/start/<Game.Id>`). Zwraca `null` dla niepoprawnego id.
 * Świadomie NIE eksportuje `PlayAction.Path` / `Arguments` — mogą zawierać
 * tokeny logowania launcherów.
 */
export function playniteLaunchRef(gameId: string): VeloraLaunchRef | null {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(gameId)) {
    return null;
  }
  return { kind: "playnite-uri", target: `playnite://playnite/start/${gameId}` };
}
