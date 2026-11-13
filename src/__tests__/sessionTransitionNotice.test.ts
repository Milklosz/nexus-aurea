import { describe, expect, it } from "vitest";
import { sessionTransitionFailureNotice } from "../services/sessionTransitionNotice";

describe("sessionTransitionFailureNotice", () => {
  it("uses the native error message when there is one", () => {
    const error = { code: "invalidTransition", message: "Desktop wymaga najpierw ekranu głównego." };
    expect(sessionTransitionFailureNotice(error)).toBe(
      "Nie udało się zmienić sesji VELORA: Desktop wymaga najpierw ekranu głównego.",
    );
  });

  it("trims surrounding whitespace from the native message", () => {
    expect(sessionTransitionFailureNotice({ message: "  Zajęte.  " })).toBe(
      "Nie udało się zmienić sesji VELORA: Zajęte.",
    );
  });

  it("falls back to a generic notice for a blank or missing message", () => {
    const fallback = sessionTransitionFailureNotice({ message: "   " });
    expect(fallback).toBe("Nie udało się zmienić sesji VELORA. Wróć do ekranu głównego i spróbuj ponownie.");
    expect(sessionTransitionFailureNotice({ code: "cancelled" })).toBe(fallback);
  });

  it("falls back for values that are not error objects", () => {
    const fallback = sessionTransitionFailureNotice(undefined);
    expect(sessionTransitionFailureNotice("boom")).toBe(fallback);
    expect(sessionTransitionFailureNotice(null)).toBe(fallback);
    expect(sessionTransitionFailureNotice(42)).toBe(fallback);
  });
});
