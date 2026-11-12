import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

import {
  createManifestPlayniteAdapter,
  createTauriPlayniteAdapter,
  playniteLaunchRefFor,
  readPlayniteLibrary,
  readPlayniteManifest,
  sanitizeCoverSource,
} from "../services/playniteLibrary";

const GAME_ID = "64f78cd1-0b00-4271-a9e1-89abc55f66cc";
const OTHER_ID = "64f78cd1-0b00-4271-a9e1-89abc55f66cd";
const LAUNCH_URI = `playnite://playnite/start/${GAME_ID}`;

function validGame() {
  return {
    id: GAME_ID,
    name: "Example Game",
    cover: "data:image/png;base64,AAAA",
    source: "Steam",
    lastPlayed: "2026-11-10T18:22:00Z",
    favorite: true,
    installed: true,
    playCount: 12,
    playtimeSeconds: 36000,
    launch: { kind: "playnite-uri", uri: LAUNCH_URI },
  };
}

function validView() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-11-12T00:00:00Z",
    source: "playnite-api",
    readOnly: true,
    gameCount: 1,
    games: [validGame()],
    diagnostics: [] as string[],
  };
}

function withUnsafeCover(cover: string): unknown {
  const view = validView();
  view.games[0].cover = cover;
  return view;
}

function withInjectedLaunch(uri: string): unknown {
  const view = validView();
  view.games[0].launch.uri = uri;
  return view;
}

function withDuplicateIds(): unknown {
  const view = validView();
  view.games = [validGame(), validGame()];
  view.gameCount = 2;
  return view;
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(true);
});

describe("readPlayniteManifest — valid view", () => {
  it("passes a valid typed view through and uses the new command", async () => {
    mocks.invoke.mockResolvedValueOnce(validView());
    expect(await readPlayniteManifest()).toEqual(validView());
    expect(mocks.invoke).toHaveBeenCalledWith("get_playnite_manifest");
  });

  it("never calls invoke in the web preview and returns null", async () => {
    mocks.isTauri.mockReturnValue(false);
    expect(await readPlayniteManifest()).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("maps an invoke rejection to null instead of throwing", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("komenda niedostępna"));
    await expect(readPlayniteManifest()).resolves.toBeNull();
  });
});

describe("readPlayniteManifest — strict validation of malformed wire payloads", () => {
  const cases: { name: string; payload: () => unknown }[] = [
    { name: "wrong schemaVersion", payload: () => ({ ...validView(), schemaVersion: 2 }) },
    { name: "readOnly false", payload: () => ({ ...validView(), readOnly: false }) },
    { name: "bad source", payload: () => ({ ...validView(), source: "unknown-source" }) },
    { name: "games not an array", payload: () => ({ ...validView(), games: {} }) },
    { name: "game with javascript: cover", payload: () => withUnsafeCover("javascript:alert(1)") },
    { name: "game with file: cover", payload: () => withUnsafeCover("file:///C:/cover.png") },
    { name: "game with injected launch uri", payload: () => withInjectedLaunch("file:///C:/x.exe") },
    { name: "game with launch uri for another id", payload: () => withInjectedLaunch(`playnite://playnite/start/${OTHER_ID}`) },
    { name: "duplicate ids", payload: () => withDuplicateIds() },
    { name: "wrong kind", payload: () => ({ ...validView(), kind: "evil" }) },
    { name: "non-record payload", payload: () => 42 },
    { name: "bad generatedAt", payload: () => ({ ...validView(), generatedAt: "not-a-date" }) },
  ];

  for (const { name, payload } of cases) {
    it(`rejects ${name} -> null, never throws`, async () => {
      mocks.invoke.mockResolvedValueOnce(payload());
      await expect(readPlayniteManifest()).resolves.toBeNull();
    });
  }
});

describe("createManifestPlayniteAdapter", () => {
  it("maps a valid view to a read-only playnite-api snapshot whose games survive normalizeSnapshot", async () => {
    mocks.invoke.mockResolvedValueOnce(validView());
    const snapshot = await createManifestPlayniteAdapter().read();
    expect(snapshot.source).toBe("playnite-api");
    expect(snapshot.available).toBe(true);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.reason).toBeNull();
    expect(snapshot.games).toHaveLength(1);
    expect(snapshot.games[0]).toEqual({
      id: GAME_ID,
      name: "Example Game",
      cover: "data:image/png;base64,AAAA",
      source: "Steam",
      lastPlayed: "2026-11-10T18:22:00Z",
    });
  });

  it("falls back to an honest unavailable snapshot when the view is null", async () => {
    mocks.invoke.mockResolvedValueOnce({ schemaVersion: 2, readOnly: false });
    const snapshot = await createManifestPlayniteAdapter().read();
    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.available).toBe(false);
    expect(snapshot.games).toEqual([]);
    expect(snapshot.readOnly).toBe(true);
  });
});

describe("playniteLaunchRefFor", () => {
  it("accepts the exact uri derived from the game id", () => {
    expect(playniteLaunchRefFor(validGame())).toEqual({ kind: "playnite-uri", uri: LAUNCH_URI });
  });

  it("rejects injected uris, wrong kinds, null launch and invalid ids", () => {
    const game = validGame();
    expect(playniteLaunchRefFor({ ...game, launch: { kind: "playnite-uri", uri: "file:///C:/x.exe" } })).toBeNull();
    expect(playniteLaunchRefFor({ ...game, launch: { kind: "playnite-uri", uri: `playnite://playnite/start/${OTHER_ID}` } })).toBeNull();
    expect(playniteLaunchRefFor({ ...game, launch: { kind: "file", uri: LAUNCH_URI } })).toBeNull();
    expect(playniteLaunchRefFor({ ...game, launch: null })).toBeNull();
    expect(playniteLaunchRefFor({ ...game, id: "not-a-guid" })).toBeNull();
  });
});

describe("compatibility guards", () => {
  it("sanitizeCoverSource still blocks file: and javascript:", () => {
    expect(sanitizeCoverSource("file:///C:/cover.png")).toBeNull();
    expect(sanitizeCoverSource("javascript:alert(1)")).toBeNull();
  });

  it("readPlayniteLibrary(createTauriPlayniteAdapter()) still invokes get_playnite_library", async () => {
    mocks.invoke.mockResolvedValueOnce({
      source: "unavailable", available: false, reason: null, games: [], readOnly: true,
    });
    await readPlayniteLibrary(createTauriPlayniteAdapter());
    expect(mocks.invoke).toHaveBeenCalledWith("get_playnite_library");
  });

  it("readPlayniteLibrary() default still invokes get_playnite_library", async () => {
    mocks.invoke.mockResolvedValueOnce({
      source: "unavailable", available: false, reason: null, games: [], readOnly: true,
    });
    await readPlayniteLibrary();
    expect(mocks.invoke).toHaveBeenCalledWith("get_playnite_library");
  });
});
