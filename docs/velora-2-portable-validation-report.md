# VELORA 2.0 — Portable Validation Build — Final Report

**Outcome:** A portable, no-install Windows x64 validation candidate is built, published as a GitHub Actions artifact, verified for byte consistency, and observed to start and shut down cleanly in an isolated profile in CI. **No physical hardware validation is claimed.**

## 1. Build identity (exact)

| Item | Value |
| --- | --- |
| Canonical reviewed build commit | `95f3a953af9bc8ab5505839d091f1c3be00d3ed6` |
| Later rebuild of the final PR head | `b225f18dbfd503d736ea9a35aace1d8a5ddcacfb` (see §3.1) |
| Validated candidate base | Draft PR #65 @ `446ad37e8ff9a32ff0eff9b8e0cc7d3867bc40d8` |
| New Draft PR | **[#71](https://github.com/Milklosz/nexus-aurea/pull/71)** — base `feat/hy4-s2-5`, head `feat/portable-validation-build` |
| Portable workflow run | **[#44319186358](https://github.com/Milklosz/nexus-aurea/actions/runs/44319186358)** — `pull_request`, attempt 1, Windows x64 |
| Main CI run | **[#44319186524](https://github.com/Milklosz/nexus-aurea/actions/runs/44319186524)** — `pull_request`, attempt 1 |
| Companion push runs | portable `44319137151`, CI `44319136106` (same commit) |
| App version | `0.12.0-rc.1` |
| Build target | `x86_64-pc-windows-msvc`, release, `--no-bundle` |

An artifact is identified by the commit SHA in its name and by `manifest.source.sourceSha`; the manifest always names the commit that was actually compiled. `build.rs` embeds the source SHA in the binary, so every rebuild has its own EXE hash. The table above records both runs that were reviewed.

## 2. Why the standalone smoke artifact was skipped on PR #65

The Windows job only produces the NSIS installer. The "Upload verified Windows executable for no-install smoke" step (`.github/workflows/ci.yml:203-210`) is gated on `push` + `refs/heads/...`, and the `smoke_payload` output it consumes (`:161-165`) is written under the same condition. PR #65 runs as `pull_request` / `refs/pull/65/merge`, so both guards are false. Provenance write/verify and installer upload did run. This was a policy choice against publishing binaries from synthetic merge commits, not a build failure. Details: `docs/velora-2-portable-validation-build.md`.

## 3. Artifact and SHA-256 verification

Artifact name: `VELORA-Portable-Windows-x64-95f3a953af9bc8ab5505839d091f1c3be00d3ed6`
GitHub artifact id: `14434396600` · GitHub's own wrapper-ZIP digest: `sha256:a1c3f0592d30a6b1acd140bd60baef9244f66867c0083627758a4b52e33a8a71`.

Download it from the [portable run's Artifacts section](https://github.com/Milklosz/nexus-aurea/actions/runs/44319186358), or with:

```powershell
gh run download 44319186358 --repo Milklosz/nexus-aurea `
  --name VELORA-Portable-Windows-x64-95f3a953af9bc8ab5505839d091f1c3be00d3ed6
```

The downloaded artifact ZIP contains four files:

| File | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `VELORA-Portable-Windows-x64.zip` | 6,480,723 | `f75de0a7c469fe6513941691d2cd6e6786432fce475bd7f467317abd14fe93d3` |
| `nexus-aurea.exe` (inside the ZIP) | 17,535,488 | `5520a5c9ec93a7266c6b8ffbb30a8ab2af6aac8d39e3ee0b7d1671308ffe268b` |
| `velora-portable-manifest.json` | 4,381 | includes all per-file hashes, commit and run URL |
| `SHA256SUMS.txt` | 98 | `f75de0a7…fe93d3  VELORA-Portable-Windows-x64.zip` |
| `smoke-result.json` | 945 | CI startup/shutdown result |

Independent verification after download (the hash must equal the value above and the value in `SHA256SUMS.txt` / `manifest.artifacts.package.sha256`):

```powershell
Get-FileHash -Algorithm SHA256 '.\VELORA-Portable-Windows-x64.zip'
Get-Content '.\SHA256SUMS.txt'
$m = Get-Content '.\velora-portable-manifest.json' -Raw | ConvertFrom-Json
$m.source.sourceSha   # 95f3a953af9bc8ab5505839d091f1c3be00d3ed6
$m.source.runUrl      # https://github.com/Milklosz/nexus-aurea/actions/runs/44319186358
```

```cmd
certutil -hashfile VELORA-Portable-Windows-x64.zip SHA256
```

This was re-checked after downloading the published artifact: downloaded ZIP hash, `SHA256SUMS.txt` and manifest all matched. Hashes are **byte-consistency evidence, not a digital signature**; the build is unsigned.

### 3.1 Independent rebuild of the final PR head

After the report was added, a second portable run rebuilt from commit `b225f18dbfd503d736ea9a35aace1d8a5ddcacfb`:

| Item | Value |
| --- | --- |
| Run | [44321305906](https://github.com/Milklosz/nexus-aurea/actions/runs/44321305906) (`pull_request`), companion push run `44321293597` |
| Artifact | `VELORA-Portable-Windows-x64-b225f18dbfd503d736ea9a35aace1d8a5ddcacfb` |
| ZIP SHA-256 | `245797882646cce7d1953866a729c47c39c147e316d599a923b1c9f0e1b4d8be` |
| EXE SHA-256 | `ebb5b8e1cc164d912871250906549664e2e8c5bc7e2414a54f9312ac04d7b9bc` |
| Smoke | `PASS` (same isolation assertions) |

Both builds are valid candidates; use the one whose artifact name matches the commit you want to audit. The hashes differ because the build embeds the source SHA and ZIP metadata.

## 4. MSI download, extraction and launch

1. Download the artifact above from the run page (or `gh run download`). Extract GitHub's wrapper ZIP to a new folder, e.g. `C:\VELORA-Portable-Validation`. **Do not extract into the VELORA 0.9.2 install folder or `C:\Program Files`.**
2. Verify the hash as in §3.
3. Extract `VELORA-Portable-Windows-x64.zip` into the same folder (Explorer *Extract All…* or `Expand-Archive`). You get `nexus-aurea.exe`, `Run-VELORA-Portable.cmd`, `Start-VELORA-Portable.ps1`, `Preflight-WebView2.ps1`, `README-PORTABLE.md`.
4. Check prerequisites (read-only, no install): `powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\Preflight-WebView2.ps1'`. WebView2 Runtime (Evergreen) must already be present — standard on Windows 11. The portable package bundles and runs **no installer or bootstrapper**.
5. Launch by double-clicking `Run-VELORA-Portable.cmd`. For a non-fullscreen validation window: `Run-VELORA-Portable.cmd --windowed`.
6. Close with the window close button / `Alt+F4`; orderly shutdown releases workers and the single-instance guard.
7. All generated data is under `.\VELORA-Portable-Data`. To reset the candidate, delete that folder **only** (never touch `%APPDATA%\pl.nexus.aurea` or `%LOCALAPPDATA%\VELORA`).

**Safety:** no installer execution, no registry or system-setting writes, no overwrite of VELORA 0.9.2, no modification of existing user data, no credentials or pairing secrets in the artifact.

## 5. Evidence of data / profile isolation

- **CI smoke (run 44319186358, `smoke-result.json`):** status `PASS`, process alive after 15 s, `gracefulCloseRequested: true`, `exitCode: 0`. The isolated root received **179 files**, including `EBWebView\Local State`, `EBWebView\Default\…` and `EBWebView\Crashpad\…` — the real WebView2 user-data directory was created inside `VELORA-Portable-Data`, not in the installed profile. `installedProfileCreated: false`.
- **Source enforcement:** `src-tauri/src/lib.rs::portable_context()` applies `AppDirectoriesOverride::Root` from `VELORA_PORTABLE_DATA_DIR`; the launcher `scripts/portable/Start-VELORA-Portable.ps1` redirects `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP`, `TMP` for the child process only; `src-tauri/src/portable.rs` gives a disjoint Credential Manager service, mutex and window title; `autostart.rs` and `remote_access.rs` refuse the two remaining out-of-root writes.
- **Cross-check:** `scripts/portable-manifest-node-check.mjs` asserts that the manifest's isolation identity matches the Rust constants; `src-tauri/src/portable.rs` unit tests assert the installed identity is unchanged when the environment variable is absent.
- The CI smoke ran on a GitHub Windows runner, **not on MSI**.

## 6. Checks executed

| Check | Where | Result |
| --- | --- | --- |
| 1031 frontend tests (110 files) | local + CI run 44319186524 | PASS |
| Long-running controller soak, Claude adapter tests, provenance tests | local + CI | PASS |
| Rust lib tests (485 + Windows subprocess suites), `cargo check x86_64-pc-windows-msvc` | local + CI | PASS |
| `tsc -b` + `vite build` | local + CI | PASS |
| Windows NSIS installer + provenance write/verify/release preview | CI run 44319186524 | PASS |
| Playnite extension net462 build | CI run 44319186524 | PASS (37 s) |
| macOS React/Rust/Tauri | CI run 44319186524 | PASS (2 m 24 s) |
| Portable manifest tooling tests (8) | local + portable CI | PASS |
| Portable standalone build, package, manifest verify | portable CI run 44319186358 | PASS (7 m 5 s) |
| Portable startup/shutdown smoke | portable CI run 44319186358 | PASS (CI process only) |
| Downloaded artifact hash re-verification | local | PASS |

## 7. Not validated / still blocked

Hardware gates from `docs/velora-2-s2-5-8-hardware-gates.md` remain **NOT TESTED**: physical DS4 Bluetooth, Panasonic 4K pointer/DPI, iPhone TLS/QR pairing, live DRM streaming, display topology, installer upgrade/rollback, accessibility and endurance on MSI. The portable candidate is a tool to perform those tests; it is not evidence they happened. No result here may be reported as physical hardware PASS.

Webview dependency note: if WebView2 Runtime is absent, the Tauri app exits without a visible UI. The preflight reports this; the package deliberately does not install anything.
