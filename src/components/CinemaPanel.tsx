import type { CinemaProfile } from "../services/cinemaMode";

type Props = {
  profile: CinemaProfile;
  onChange: (profile: CinemaProfile) => void;
  onDesktop: () => void;
};

const profileLabels: Record<CinemaProfile, string> = {
  cinema: "Cinema",
  gaming: "Gaming",
  desktop: "Desktop",
};

const profileNotes: Record<CinemaProfile, string> = {
  cinema: "Streaming i multimedia · NEXUS w pełnym ekranie",
  gaming: "Steam i gry · mapowanie globalne pozostaje wyłączone",
  desktop: "Windows w oknie · ustawienia ekranu i audio bez zmian",
};

export function CinemaPanel({ profile, onChange, onDesktop }: Props) {
  return <section className="cinema-panel" aria-label="Cinema Mode">
    <h3>Cinema Mode</h3>
    <p>Profil: <strong>{profileLabels[profile]}</strong> · {profileNotes[profile]}</p>
    <div className="launcher-actions" role="group" aria-label="Profile salonowe">
      {(["cinema", "gaming", "desktop"] as const).map(option => <button
        key={option}
        type="button"
        aria-pressed={profile === option}
        className={profile === option ? "profile-active" : undefined}
        onClick={() => onChange(option)}
      >{profileLabels[option]}</button>)}
      <button type="button" onClick={onDesktop}>Pokaż pulpit Windows</button>
    </div>
    <p>Ostatni wybrany profil jest zapisywany lokalnie. NEXUS nie zmienia HDR, rozdzielczości, HDMI ani systemowego urządzenia audio.</p>
  </section>;
}
