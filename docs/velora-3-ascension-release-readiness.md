# VELORA 3.0 — Operation Ascension: release-readiness checklist

- Branch family: `feat/velora-3-ascension*` (integration branch `feat/velora-3-ascension`,
  agent branches `ascension-a-input`, `ascension-b-sessions`, `ascension-d-remote`,
  `ascension-e-ci`).
- Base commit: `4a431768f85d4ba81161b331ebcce93b4684dd2e` (`origin/feat/s2-9-hardware-recovery`,
  Draft PR #72) — VELORA 2.0 / `v0.12.0-rc.1`.
- Status: **engineering draft. No merge to `main`, no tag, no release, no installer run on the
  MSI, no hardware claim.** This document is the checklist a release must satisfy; it is not a
  release authorization.

## 1. CI matrix — what every Ascension PR must prove

All of the following run automatically on every `pull_request` and every `push`
(`.github/workflows/ci.yml`, job `test-and-build`, matrix `macos-latest` + `windows-latest`,
`fail-fast: false`, top-level `permissions: contents: read`):

| # | Step | Command | Fails the build on regression |
| --- | --- | --- | --- |
| 1 | Frontend unit/integration suite | `pnpm test` (vitest, full `src/__tests__`) | yes |
| 2 | Session-transition soak | `pnpm test:soak` (3000-transition CrossSourceGate soak) | yes |
| 3 | Claude status-line adapter fixtures | `pnpm test:claude-usage` (`node --test`) | yes |
| 4 | Build-provenance manifest suite | `pnpm test:provenance` (`node --test`) | yes |
| 5 | Portable-manifest suite | `pnpm test:portable-manifest` (`node --test`) | yes |
| 6 | SHA-256 artifact manifest suite | `pnpm test:manifest` (`node --test`, `scripts/sha256-manifest-node-check.mjs`) | yes |
| 7 | Rust unit tests | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | yes |
| 8 | Frontend build | `pnpm build` (`tsc -b && vite build`) | yes |
| 9 | dist SHA-256 manifest | `pnpm manifest:sha256` + `node scripts/sha256-manifest.mjs verify --manifest dist/sha256-manifest.json` | yes |
| 10 | Whitespace check | `git diff --check` over the event commit range | yes |
| 11 | Rust backend check | `cargo check --locked … --target x86_64-pc-windows-msvc` (Windows) / `cargo check --locked …` (macOS) | yes |
| 12 | Windows NSIS installer + provenance | `pnpm tauri build --ci --target x86_64-pc-windows-msvc`, then `scripts/build-provenance.mjs write/verify --ci` and a release-asset preview (`release-assets`, `verify-release --preview`) | yes |
| 13 | macOS app build | `pnpm tauri build --no-bundle --ci` | yes |

Additional jobs in `ci.yml`: `playnite-extension` (Windows, MSBuild, Playnite SDK 6.18.0,
net462 DLL + `extension.yaml`, uploaded as artifact) and `publish-release` (**only** on
`push` to `refs/tags/v*`, the only job with `permissions: contents: write`; it verifies the
installer + manifest pair with `verify-release` before `gh release create/upload --verify-tag`).

Portable candidate (`.github/workflows/portable-windows.yml`, `permissions: contents: read`):

- Triggers: **every `pull_request`** (this covers PRs from `feat/velora-3-ascension*` branches)
  and `push` to `feat/portable-validation-build` or `feat/velora-3-ascension*`.
- Steps: checkout of the exact PR head SHA (dirty check refuses to build), `pnpm install
  --frozen-lockfile`, `pnpm test:portable-manifest`, `pnpm test:manifest`, `pnpm build`,
  `pnpm tauri build --no-bundle --ci --target x86_64-pc-windows-msvc` (**no installer is ever
  produced or run**), staging, a bounded startup/shutdown smoke test (best-effort evidence,
  `hardwareValidated: false`, never fails the build), then packaging:
  `VELORA-Portable-Windows-x64.zip` + `velora-portable-manifest.json` + `SHA256SUMS.txt` +
  `smoke-result.json` + `sha256-manifest.json`/`.md`, written and verified by
  `scripts/portable-manifest.mjs` and `scripts/sha256-manifest.mjs`, uploaded as artifact
  `VELORA-Portable-Windows-x64-<SOURCE_SHA>`.

## 2. Provenance and hash recording

- **Installer**: on Windows CI, `scripts/build-provenance.mjs write --ci …` records the source
  SHA, checkout SHA, event/ref, dirty flag, tool versions (node/pnpm/rustc/cargo/tauriCli/MSVC/
  Windows SDK), and SHA-256 + size of the installer `*-setup.exe`, the built
  `nexus-aurea.exe`, and the packaged payload EXE, plus the single allowed bundler
  transformation between built and packaged EXE. `verify --ci` recomputes everything and
  compares with the runner's GitHub context. The manifest `velora-build-provenance.json` is
  uploaded next to the installer and published on the tag release. The step summary prints all
  hashes for review.
- **Portable candidate**: `velora-portable-manifest.json` records the exact source commit, the
  Actions run URL, SHA-256 + size of the packaged **ZIP** (`artifacts.package.sha256`) and of
  the packaged **EXE** (`artifacts.executable.sha256`), every support file hash, the isolation
  identity, and the smoke result. `SHA256SUMS.txt` carries the ZIP digest in standard
  `sha256sum` format; `dist/portable/sha256-manifest.json` (new) adds a per-file SHA-256 record
  of the whole output folder.
- **Local frontend artifacts**: `pnpm manifest:sha256` writes `dist/sha256-manifest.json` +
  `dist/sha256-manifest.md` (file, bytes, SHA-256, `git rev-parse HEAD` commit, dirty flag, UTC
  timestamp; deterministic ordering; secret-looking files excluded by name; contents never
  embedded). Verify with `node scripts/sha256-manifest.mjs verify --manifest
  dist/sha256-manifest.json`.
- **Honesty rule**: all of these are hash-consistency records, **not digital signatures** —
  they prove the bytes match the record, not who produced them. The unsigned build means
  Windows SmartScreen will show a warning; the manifest does not change that.

## 3. Release checklist (when a tag is eventually authorized)

- [ ] All PRs from `feat/velora-3-ascension*` green on the full matrix in §1, including
      `test:soak`, all four `node --test` suites, `cargo test --lib` on both OSes, and the
      portable candidate artifact with a clean checkout SHA.
- [ ] Independent security + regression review of the full ascension diff (Agent F) closed.
- [ ] Hardware acceptance executed on the MSI per
      `docs/velora-2-s2-9-luna-test-procedure.md` — every gate recorded PASS/FAIL/NOT-RUN with
      the artifact source SHA. Until then all hardware gates remain **NOT TESTED**.
- [ ] Portable artifact verified on the MSI with `Get-FileHash` vs `SHA256SUMS.txt` and
      `node scripts/portable-manifest.mjs verify …` before first launch; no installer run.
- [ ] Installer hash recorded: confirm `velora-build-provenance.json` (uploaded with the
      `*-setup.exe` artifact and attached to the tag release) matches `Get-FileHash` of the
      downloaded installer.
- [ ] Tag `v*` pushed only after the above; `publish-release` verifies the asset pair before
      uploading (`--verify-tag`), so a mismatched installer/manifest pair cannot ship.
- [ ] Release notes state: unsigned build (SmartScreen warning expected), hashes are not
      signatures, hardware status per the Luna procedure, and the known limitations in §4.

## 4. Known limitations (carried from the risk register; none closed by this branch)

- **Hardware gates NOT TESTED** — DS4 Bluetooth reconnect / PS+Options Home chord /
  cross-source double-input on the MSI (R1), iPhone QR/TLS pairing and the portable
  trust-profile flow on a real device (R2), HDMI/display topology (R9). Engineering evidence is
  deterministic tests only; see `docs/velora-2-s2-9-luna-test-procedure.md`.
- **Playback-state limits** — streaming media control is a blind toggle (Space/K) with no
  playback-state readback for Netflix/Prime/YouTube; preserving provider playback state is
  explicitly out of scope (R4). Session-transition fixes quiesce our own input state only.
- **Cert model residual risk** — the iPhone Remote CA uses device-wide root trust, the shared
  CA key and HMAC tokens live in one vault blob, and there is no pinning or CRL (R6); accepted
  residual, plan only.
- **Code-fixed but hardware-unverified**: first-launch focus asymmetry in `launch_edge_cinema`
  (R3) and the `get_control_service_status` >8 s race now degrading to a typed `unknown` (R5).
- **Environmental**: 39 Windows-vault (Credential Manager) tests are excluded, not failed, in
  sandboxed runners (R7). Rust test counts differ by OS (432 passed on macOS at base; PR #72
  reports 491 on Windows because Windows-only modules are compiled there). The authoritative
  Windows MSVC check + NSIS build run only in CI (`aws-lc-sys` needs the Windows SDK).
- **Unsigned installer**: SmartScreen warning; upgrade/rollback paths NOT TESTED (R8).

## 5. Rollback notes

- The portable candidate is the rollback-friendly validation path: it never installs, never
  writes the registry, and keeps all writable state under `VELORA-Portable-Data` with a
  disjoint credential service, single-instance mutex and window title, so it can be deleted
  without touching the installed VELORA 0.9.2 profile (CI asserts `installedProfileCreated:
  false` in the smoke record).
- The installed-app upgrade/rollback over 0.9.2 is **NOT TESTED**; do not claim it. If a
  release must be pulled, delete the GitHub release + tag (the installer is unsigned, so there
  is no signature to revoke) and communicate that already-downloaded installers can only be
  checked against the published `velora-build-provenance.json` hashes.
- iPhone trust-profile changes are reversible per the portable cleanup procedure (stop server,
  remove only the generated `.mobileconfig` from the portable root, revoke devices, remove the
  profile on the iPhone); no system trust store is modified.

## 6. Hardware acceptance plan (pointer)

`docs/velora-2-s2-9-luna-test-procedure.md` is the authoritative physical acceptance plan for
Luna on the MSI GP76 Leopard 11UG (Panasonic TX-49EX610E 4K, DS4 BT, iPhone LAN remote). It
defines the regression-critical PASS list, the remaining gates H1/H2/…, the acquire-and-verify
procedure (hash check before launch, portable only, no installer), and the rule that no gate
may be reported PASS unless executed.

## 7. Local verification commands (run before reporting)

```bash
pnpm install --frozen-lockfile
pnpm test                 # vitest full suite
pnpm test:soak            # session-transition soak (fails the build in CI on regression)
pnpm test:provenance      # node --test scripts/build-provenance-node-check.mjs
pnpm test:portable-manifest
pnpm test:claude-usage
pnpm test:manifest        # node --test scripts/sha256-manifest-node-check.mjs
pnpm build
pnpm manifest:sha256      # writes dist/sha256-manifest.json + .md
node scripts/sha256-manifest.mjs verify --manifest dist/sha256-manifest.json
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

The cargo Windows-target check (`--target x86_64-pc-windows-msvc`) is CI-only and is not
reproduced locally on macOS.
