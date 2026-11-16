// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartHomePanel } from "../components/SmartHomePanel";

afterEach(cleanup);

describe("Smart Home panel", () => {
  it("keeps collections hidden until deliberately expanded and launches an identity", () => {
    const onLaunch = vi.fn();
    render(<SmartHomePanel onLaunch={onLaunch} />);
    expect(screen.queryByRole("list", { name: "Ulubione aplikacje" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Moje aplikacje/ }));
    const favorites = screen.getByRole("list", { name: "Ulubione aplikacje" });
    const netflix = within(favorites).getByRole("button", { name: "Netflix" });
    expect(netflix.getAttribute("data-remote-allow")).toBe("");
    fireEvent.click(netflix);
    expect(onLaunch).toHaveBeenCalledWith("netflix");
    expect(screen.queryByRole("button", { name: "Odepnij Netflix" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edytuj ulubione" }));
    expect(screen.getByRole("button", { name: "Odepnij Netflix" })).toBeTruthy();
  });

  it("marks known unavailable apps without claiming session or playback progress", () => {
    const onLaunch = vi.fn();
    render(<SmartHomePanel onLaunch={onLaunch} unavailableIds={new Set(["netflix"])} />);
    fireEvent.click(screen.getByRole("button", { name: /Moje aplikacje/ }));
    const button = screen.getByRole("button", { name: "Netflix · niedostępne" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByText(/Postęp oglądania pozostaje w serwisie/)).toBeTruthy();
  });
});
