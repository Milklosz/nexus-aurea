import { useEffect, useState } from "react";
import { fetchZabrzeWeather } from "../services/weather";

type WeatherState = {
  temperature: number | null;
  condition: string;
  loading: boolean;
  stale: boolean;
};

const initialWeather: WeatherState = {
  temperature: null,
  condition: "",
  loading: true,
  stale: false,
};

export function useWeather() {
  const [weather, setWeather] = useState(initialWeather);

  useEffect(() => {
    let mounted = true;
    let controller: AbortController | undefined;

    const refresh = async () => {
      controller?.abort();
      const nextController = new AbortController();
      controller = nextController;
      const timeout = window.setTimeout(() => nextController.abort(), 10_000);

      try {
        const observation = await fetchZabrzeWeather(nextController.signal);
        if (mounted) setWeather({ ...observation, loading: false, stale: false });
      } catch {
        if (mounted) {
          setWeather((previous) =>
            previous.temperature !== null
              ? { ...previous, loading: false, stale: true }
              : { temperature: null, condition: "", loading: false, stale: false },
          );
        }
      } finally {
        window.clearTimeout(timeout);
      }
    };

    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), 15 * 60 * 1000);
    return () => {
      mounted = false;
      window.clearInterval(refreshTimer);
      controller?.abort();
    };
  }, []);

  const label =
    weather.temperature !== null
      ? `${Math.round(weather.temperature)}°  ${weather.condition}`
      : weather.loading
        ? "Pobieranie…"
        : "Pogoda niedostępna";
  const title = weather.stale
    ? "Wyświetlam ostatni odczyt. Ponowna próba nastąpi za 15 minut."
    : weather.loading
      ? "Pobieranie bieżącej pogody dla Zabrza."
      : weather.temperature === null
        ? "Nie udało się pobrać pogody. Ponowna próba nastąpi za 15 minut."
        : "Bieżąca pogoda dla Zabrza.";

  return { label, title };
}
