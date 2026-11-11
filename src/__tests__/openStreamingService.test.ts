// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamingServices } from "../data/streamingServices";
import { openStreamingService, streamingServiceErrorMessage } from "../services/openStreamingService";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));

afterEach(() => { vi.restoreAllMocks(); });

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
});
