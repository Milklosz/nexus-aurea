// @vitest-environment jsdom
// Integration coverage for the VELORA 2.0 search path: Control Center -> Szukaj tab ->
// on-screen keyboard -> result. The harness mirrors App.tsx: the keyboard host owns the
// keyboard, select opens it only for a marked text field (as confirmControllerFocus does),
// and pad intents reach an open keyboard first (as offerIntentToKeyboard does).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlCenter } from "../components/ControlCenter";
import { VirtualKeyboard } from "../components/VirtualKeyboard";
import { useVirtualKeyboardHost } from "../hooks/useVirtualKeyboardHost";
import type { SearchEntry } from "../services/appSearch";
import type { NavIntent } from "../services/navIntent";
import { offerIntentToKeyboard, textEntryTargetFromFocus } from "../services/virtualKeyboardRouting";

const mocks = vi.hoisted(() => {
  const controlStatus = {
    windows: false, running: false, gameMode: false, controllerCount: 0, playstationControllerCount: 0,
    foregroundProcess: null, returnHotkeyRegistered: false, lastError: null,
  };
  const remoteStatus = {
    enabled: false, secureOriginAvailable: false, pairingAvailable: false, pairedDeviceCount: 0,
    pairedDevices: [], origin: null, caFingerprint: null, trustProfilePath: null, pairingCode: null,
    pairingExpiresInSeconds: 0,
  };
  return {
    controlStatus,
    remoteStatus,
    getStatus: vi.fn(async () => controlStatus),
    getRemoteStatus: vi.fn(async () => remoteStatus),
    listenRemoteStatus: vi.fn(async () => () => {}),
  };
});

vi.mock("../services/controlService", () => ({
  disabledControlServiceStatus: mocks.controlStatus,
  getControlServiceStatus: mocks.getStatus,
  getFallbackHotkeyOptions: vi.fn(async () => []),
  setFallbackHotkey: vi.fn(async () => mocks.controlStatus),
}));
vi.mock("../services/remoteAccess", () => ({
  disabledRemoteAccessStatus: mocks.remoteStatus,
  REMOTE_ACCESS_DISABLED_REASON: "Serwer domyślnie nie nasłuchuje w sieci.",
  getRemoteAccessStatus: mocks.getRemoteStatus,
  listenForRemoteAccessStatus: mocks.listenRemoteStatus,
  prepareRemoteTrustProfile: vi.fn(async () => mocks.remoteStatus),
  startRemoteAccess: vi.fn(async () => mocks.remoteStatus),
  beginRemotePairing: vi.fn(async () => mocks.remoteStatus),
  stopRemoteAccess: vi.fn(async () => mocks.remoteStatus),
  revokeAllRemoteDevices: vi.fn(async () => mocks.remoteStatus),
  revokeRemoteDevice: vi.fn(async () => mocks.remoteStatus),
}));

const entries: SearchEntry[] = [
  { id: "tile:netflix", title: "Netflix", group: "Streaming", keywords: ["NETFLIX", "wideo film serial"] },
  { id: "tile:disney", title: "Disney+", group: "Streaming", keywords: ["DISNEY+", "wideo film serial"] },
  { id: "tile:steam", title: "Steam", group: "Aplikacja", keywords: ["STEAM", "muzyka aplikacja"] },
];

/** Pad-side entry points, set by the harness on every render. */
const pad = {
  /** Mirrors confirmControllerFocus: select opens the keyboard only for a marked text field. */
  select: (): void => {},
  /** Mirrors the pad path: an open keyboard claims the intent first. Returns true when it did. */
  intent: (_intent: NavIntent): boolean => false,
};

function Harness({ onLaunch, onProfileChange }: { onLaunch: (id: string) => void; onProfileChange: () => Promise<boolean> }) {
  const keyboard = useVirtualKeyboardHost();
  pad.select = () => {
    const field = textEntryTargetFromFocus(document.activeElement);
    if (field) keyboard.openFor(field);
  };
  pad.intent = (intent) => offerIntentToKeyboard(intent, keyboard.sinkRef.current);
  return (
    <>
      <ControlCenter
        profile="cinema"
        onProfileChange={onProfileChange}
        onShowDesktop={vi.fn()}
        onSystemVolume={vi.fn(async () => {})}
        ambientSettings={{ enabled: false, idleSeconds: 300 }}
        onAmbientSettingsChange={vi.fn()}
        mediaPlaying={false}
        onOpenDiagnostics={vi.fn()}
        onReturnToNexus={vi.fn()}
        onClose={vi.fn()}
        appSearch={{ entries, onLaunch }}
      />
      {keyboard.field && (
        <VirtualKeyboard field={keyboard.field} sinkRef={keyboard.sinkRef} onDone={keyboard.commit} onCancel={keyboard.cancel} />
      )}
    </>
  );
}

function renderShell(onLaunch = vi.fn(), onProfileChange = vi.fn(async () => true)) {
  render(<Harness onLaunch={onLaunch} onProfileChange={onProfileChange} />);
  return { onLaunch, onProfileChange };
}

function openSearchTab() {
  fireEvent.click(screen.getByRole("tab", { name: "Szukaj" }));
  return screen.getByLabelText("Szukaj aplikacji") as HTMLInputElement;
}

function keyboardDialog(): HTMLElement | null {
  return document.querySelector("dialog.virtual-keyboard");
}

function typeKeys(text: string) {
  for (const char of text) fireEvent.click(screen.getByRole("button", { name: char }));
}

function resultTitles(): string[] {
  const list = screen.getByRole("list", { name: "Wyniki wyszukiwania" });
  return Array.from(list.querySelectorAll("button")).map((button) => button.textContent ?? "");
}

function setupDialogs() {
  // jsdom has no showModal. Mirror the browser: showModal opens the dialog, close shuts it.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); }),
  });
}

describe("search and keyboard integration (Control Center)", () => {
  beforeEach(() => {
    setupDialogs();
    mocks.getStatus.mockImplementation(async () => mocks.controlStatus);
    mocks.getRemoteStatus.mockImplementation(async () => mocks.remoteStatus);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the Szukaj tab from the Control Center and shows the search field", () => {
    renderShell();
    const input = openSearchTab();
    expect(input.getAttribute("data-velora-text-entry")).not.toBeNull();
    expect(resultTitles()).toEqual(["Netflix" + "Streaming", "Disney+" + "Streaming", "Steam" + "Aplikacja"]);
  });

  it("select on the search field opens the keyboard, types a query and launches the chosen result", async () => {
    const { onLaunch } = renderShell();
    const input = openSearchTab();
    act(() => input.focus());

    act(() => pad.select());
    expect(keyboardDialog()?.hasAttribute("open")).toBe(true);
    expect(screen.getByLabelText("Wpisany tekst").textContent).toBe("Pole jest puste");

    typeKeys("dis");
    expect(screen.getByLabelText("Wpisany tekst").textContent).toBe("dis");
    // Typing alone never writes the field: only Gotowe commits the draft.
    expect(input.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Gotowe, zapisz tekst" }));
    await waitFor(() => expect(keyboardDialog()).toBeNull());
    expect(input.value).toBe("dis");
    expect(resultTitles()).toEqual(["Disney+" + "Streaming"]);
    expect(screen.getByRole("status").textContent).toBe("Wyniki: 1");

    fireEvent.click(screen.getByRole("button", { name: /Disney\+/ }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith("tile:disney");
  });

  it("cancelling the keyboard leaves the field untouched and returns focus to the search field", async () => {
    const { onLaunch } = renderShell();
    const input = openSearchTab();
    act(() => input.focus());
    act(() => pad.select());

    typeKeys("xy");
    fireEvent.click(screen.getByRole("button", { name: "Anuluj bez zmian" }));

    await waitFor(() => expect(keyboardDialog()).toBeNull());
    expect(input.value).toBe("");
    expect(resultTitles()).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("Escape (dialog cancel) closes the keyboard without writing and restores focus", async () => {
    renderShell();
    const input = openSearchTab();
    act(() => input.focus());
    act(() => pad.select());
    typeKeys("q");

    fireEvent(keyboardDialog() as HTMLElement, new Event("cancel", { cancelable: true }));

    await waitFor(() => expect(keyboardDialog()).toBeNull());
    expect(input.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("with the keyboard open, a pad menu press is claimed and Home cancels the draft without writing", async () => {
    renderShell();
    const input = openSearchTab();
    act(() => input.focus());
    act(() => pad.select());
    typeKeys("a");

    // Menu belongs to the keyboard while typing: Control Center must not open under it.
    expect(pad.intent({ kind: "menu" })).toBe(true);
    expect(keyboardDialog()).not.toBeNull();

    // Home cancels the keyboard and then lets the normal home action run (returns false).
    expect(pad.intent({ kind: "home" })).toBe(false);
    await waitFor(() => expect(keyboardDialog()).toBeNull());
    expect(input.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("with the keyboard open, pad moves and select go to the keyboard, not to the tabs behind it", async () => {
    renderShell();
    const input = openSearchTab();
    act(() => input.focus());
    act(() => pad.select());

    expect(pad.intent({ kind: "select" })).toBe(true);
    expect(keyboardDialog()).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Szukaj" }).getAttribute("aria-selected")).toBe("true");
  });

  it("select on a tab or a result button does not open the keyboard", () => {
    renderShell();
    openSearchTab();

    screen.getByRole("tab", { name: "Szukaj" }).focus();
    act(() => pad.select());
    expect(keyboardDialog()).toBeNull();

    const result = screen.getByRole("button", { name: /Netflix/ });
    act(() => result.focus());
    act(() => pad.select());
    expect(keyboardDialog()).toBeNull();
  });

  it("an empty query names the search and launches nothing", () => {
    const { onLaunch } = renderShell();
    const input = openSearchTab();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByRole("status").textContent).toBe("Brak wyników dla „zzz”.");
    expect(resultTitles()).toEqual([]);
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("a failed Windows status read shows an error but search still works", async () => {
    mocks.getStatus.mockImplementation(async () => {
      throw new Error("backend unavailable");
    });
    const { onLaunch } = renderShell();
    const input = openSearchTab();

    expect(await screen.findByText(/Nie udało się odczytać stanu Windows/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "steam" } });
    expect(resultTitles()).toEqual(["Steam" + "Aplikacja"]);
    fireEvent.click(screen.getByRole("button", { name: /Steam/ }));
    expect(onLaunch).toHaveBeenCalledWith("tile:steam");
  });
});
