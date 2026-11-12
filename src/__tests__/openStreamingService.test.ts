// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamingServices } from "../data/streamingServices";
import { openStreamingService, streamingServiceErrorMessage } from "../services/openStreamingService";

// Mock warstwy Tauri: isTauri przełączalny, invoke rejestrowany.
// Nie mockujemy modułu edgeCinema — sprawdzamy realne wywołanie invoke.
const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.isTauri.mockReturnValue(false);
  mocks.invoke.mockReset();
});

describe("official streaming launcher", () => {
  it("opens HBO Max through its verified official HTTPS address", async () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const max = streamingServices.find((service) => service.id === "max");
    if (!max || max.kind !== "web") throw new Error("HBO Max web launcher is missing");
    await openStreamingService(max);
    expect(windowOpen).toHaveBeenCalledWith("https://www.hbomax.com/pl/pl", "_blank", "noopener,noreferrer");
  });

  it("refuses a streaming link outside the service's allowed HTTPS host", async () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const netflix = streamingServices.find((service) => service.id === "netflix");
    if (!netflix || netflix.kind !== "web") throw new Error("Netflix web launcher is missing");
    await expect(openStreamingService({ ...netflix, href: "https://example.org/" })).rejects.toThrow(/zaufanych stron/);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("keeps the untrusted-address reason explicit", () => {
    expect(streamingServiceErrorMessage(new Error("Adres usługi nie znajduje się na liście zaufanych stron."), "HBO Max"))
      .toBe("Adres usługi nie znajduje się na liście zaufanych stron.");
  });

  it("replaces technical browser errors with clear retry guidance", () => {
    expect(streamingServiceErrorMessage(new Error("webview2 failed with code 5"), "HBO Max"))
      .toBe("Nie udało się otworzyć HBO Max. Sprawdź połączenie z internetem i spróbuj ponownie.");
  });

  it("launches the dedicated Edge Cinema window with the exact verified URL in Tauri", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ launched: true, mode: "app-fullscreen", profileDir: "C:/VELORA/VELORA-EdgeCinema" });
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const max = streamingServices.find((service) => service.id === "max");
    if (!max || max.kind !== "web") throw new Error("HBO Max web launcher is missing");

    await openStreamingService(max);

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("launch_edge_cinema", { url: "https://www.hbomax.com/pl/pl" });
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("never forwards an untrusted address to the native launcher", async () => {
    mocks.isTauri.mockReturnValue(true);
    const netflix = streamingServices.find((service) => service.id === "netflix");
    if (!netflix || netflix.kind !== "web") throw new Error("Netflix web launcher is missing");

    await expect(openStreamingService({ ...netflix, href: "https://example.org/" })).rejects.toThrow(/zaufanych stron/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps web preview on window.open without touching the native launcher", async () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const youtube = streamingServices.find((service) => service.id === "youtube");
    if (!youtube || youtube.kind !== "web") throw new Error("YouTube web launcher is missing");

    await openStreamingService(youtube);

    expect(windowOpen).toHaveBeenCalledWith("https://www.youtube.com/", "_blank", "noopener,noreferrer");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("maps an Edge-not-installed error to clear Polish guidance", () => {
    expect(streamingServiceErrorMessage(
      "Nie wykryto przeglądarki Microsoft Edge. Zainstaluj Edge, aby uruchomić Edge Cinema.",
      "Netflix",
    )).toBe("Nie znaleziono przeglądarki Microsoft Edge. Zainstaluj Edge i spróbuj ponownie.");
  });

  it("maps a spawn/launch failure to clear Polish guidance", () => {
    expect(streamingServiceErrorMessage("Windows nie uruchomił okna Edge Cinema.", "Netflix"))
      .toBe("Nie udało się uruchomić okna Edge Cinema. Sprawdź instalację Edge i spróbuj ponownie.");
  });

  it("maps a profile-directory failure to clear Polish guidance", () => {
    expect(streamingServiceErrorMessage("Nie udało się przygotować katalogu profilu Edge Cinema.", "Disney+"))
      .toBe("Nie udało się przygotować dedykowanego profilu Edge Cinema. Sprawdź uprawnienia do folderu danych aplikacji i spróbuj ponownie.");
  });

  it("surfaces a short DRM/4K/HDR note when the native error is media-related", () => {
    expect(streamingServiceErrorMessage(new Error("Widevine DRM 4K HDR HDCP playback failed"), "Netflix"))
      .toMatch(/4K/);
  });
});
