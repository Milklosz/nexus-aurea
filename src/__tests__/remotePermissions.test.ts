// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { canRemoteSelect } from "../services/remotePermissions";

afterEach(() => {
  document.body.replaceChildren();
});

function dialogWith(html: string): HTMLElement {
  const dialog = document.createElement("dialog");
  dialog.open = true;
  dialog.innerHTML = html;
  document.body.append(dialog);
  return dialog;
}

describe("iPhone Remote select permissions", () => {
  it("allows the focused Home dock item outside a dialog", () => {
    const button = document.createElement("button");
    document.body.append(button);
    expect(canRemoteSelect(button)).toBe(true);
  });

  it("denies administrative controls even when focused", () => {
    dialogWith(`
      <section data-remote-admin>
        <button id="revoke">Odwołaj wszystkie urządzenia</button>
        <button id="stop">Wyłącz serwer LAN</button>
      </section>
    `);
    expect(canRemoteSelect(document.querySelector("#revoke"))).toBe(false);
    expect(canRemoteSelect(document.querySelector("#stop"))).toBe(false);
  });

  it("allows explicitly marked safe dialog actions", () => {
    dialogWith(`
      <button id="close" data-remote-allow>Zamknij</button>
      <button id="tab" data-remote-allow>Gaming</button>
      <button id="profile" data-remote-allow>Cinema</button>
      <button id="unmarked">Eksport administracyjny</button>
    `);
    expect(canRemoteSelect(document.querySelector("#close"))).toBe(true);
    expect(canRemoteSelect(document.querySelector("#tab"))).toBe(true);
    expect(canRemoteSelect(document.querySelector("#profile"))).toBe(true);
    expect(canRemoteSelect(document.querySelector("#unmarked"))).toBe(false);
  });

  it("uses default-deny for future dialog controls without an explicit marker", () => {
    dialogWith(`<button id="future">Nowa akcja</button>`);
    expect(canRemoteSelect(document.querySelector("#future"))).toBe(false);
  });

  it("honours an explicit allow override only outside admin zones", () => {
    dialogWith(`
      <section data-remote-admin>
        <button id="override" data-remote-allow>Wyraźnie dozwolone</button>
      </section>
    `);
    expect(canRemoteSelect(document.querySelector("#override"))).toBe(true);
  });
});
