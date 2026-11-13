import netflix from "../../assets/scenes/netflix.webp";
import disney from "../../assets/scenes/disney.webp";
import max from "../../assets/scenes/max.webp";
import prime from "../../assets/scenes/prime.webp";
import youtube from "../../assets/scenes/youtube.webp";
import steam from "../../assets/scenes/steam.webp";
import playnite from "../../assets/scenes/playnite.webp";
import appleMusic from "../../assets/scenes/appleMusic.webp";

/** Pre-rendered 3840x2160 background per dock app, keyed by service id. */
export const SCENE_URLS: Readonly<Record<string, string>> = {
  netflix,
  disney,
  max,
  prime,
  youtube,
  steam,
  playnite,
  appleMusic,
};
