const ZABRZE_WEATHER_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=50.3249&longitude=18.7857&current=temperature_2m,weather_code&timezone=Europe%2FWarsaw";

export type WeatherObservation = {
  temperature: number;
  condition: string;
};

type OpenMeteoResponse = {
  current?: {
    temperature_2m?: unknown;
    weather_code?: unknown;
  };
};

export function describeWeatherCode(code: number): string {
  if (code === 0) return "Pogodnie";
  if (code === 1) return "Przeważnie pogodnie";
  if (code === 2) return "Częściowe zachmurzenie";
  if (code === 3) return "Pochmurno";
  if (code === 45 || code === 48) return "Mgła";
  if (code >= 51 && code <= 57) return "Mżawka";
  if (code >= 61 && code <= 67) return "Deszcz";
  if (code >= 71 && code <= 77) return "Śnieg";
  if (code >= 80 && code <= 82) return "Przelotne opady";
  if (code === 85 || code === 86) return "Przelotny śnieg";
  if (code >= 95 && code <= 99) return "Burza";
  return "Warunki zmienne";
}

export async function fetchZabrzeWeather(signal: AbortSignal): Promise<WeatherObservation> {
  const response = await fetch(ZABRZE_WEATHER_URL, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Serwis pogodowy zwrócił ${response.status}.`);

  const data = (await response.json()) as OpenMeteoResponse;
  const temperature = data.current?.temperature_2m;
  const code = data.current?.weather_code;
  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    typeof code !== "number" ||
    !Number.isFinite(code)
  ) {
    throw new Error("Odpowiedź serwisu pogodowego jest niekompletna.");
  }

  return { temperature, condition: describeWeatherCode(code) };
}
