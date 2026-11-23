# VELORA 3.0 — Operation Ascension: final engineering report

- Branch: `feat/velora-3-ascension` (Draft PR, see §8)
- Base: `4a431768f85d4ba81161b331ebcce93b4684dd2e` = `origin/feat/s2-9-hardware-recovery` (Draft PR #72)
- Scope of change: **24 commits, 56 files, +7 409 / −124** (`git diff 4a43176..HEAD`)
- Environment: macOS engineering host. Target hardware: MSI GP76 Leopard 11UG · Windows 11 · RTX 3070 Laptop · Panasonic TX-49EX610E 4K · DS4 BT · iPhone LAN remote.
- **No merge to `main`, no release/tag, no installer executed, no hardware operated. All physical tests remain NOT TESTED.**

## 1. What was delivered (by phase)

| Phase | Branch merged | Key commits | Content |
| --- | --- | --- | --- |
| 0 Recon | — | `bbf76fd` | Architecture map, dependency graph, risk register, backlog: `docs/velora-3-ascension-recon.md` |
| 1 Controller-first (Agent A) | `ascension-a-input` | `345fe48`, `29ed1f0`, `b26a2c8`, `8403b1e`, `d0f0fdf`, `d6b8a63` | Four-source cross-source gate (native/gamepad/keyboard/remote) with 90 ms suppression window + monotonic epoch; deterministic DS4 disconnect/reconnect resync (connection epoch survives store restart; held button across BT drop can never complete PS+Options chord — Rust `ComboTracker.require_device_rearm`); Home-chord recovery from dialogs bound to one session revision; exactly-once focus-owner recovery. Doc: `docs/velora-3-ascension-input.md` |
| 2 Session intelligence (Agent B) | `ascension-b-sessions` | `6e66b7a`, `4c80ddc`, `4a86e35`, `cd21381` | Shared deterministic lifecycle machine (idle→launching→active→closing→exited/error) mirrored TS↔Rust; `SessionLaunchCoordinator` with duplicate-launch prevention (in-flight/closing/active-adopt/stale-generation-reject); bounded transition receipts; `SessionsPanel` diagnostics + focus-regain selection restore; `PLAYBACK_STATE_READ_SUPPORTED=false` pinned. Doc: `docs/velora-3-ascension-sessions.md` |
| 3 iPhone Remote 4.0 (Agent D) | `ascension-d-remote` | `34576c4`, `906326c`, `6c756e3`, `78e38ee`, `5d035bb`, `d1e3259` | Fail-closed outbound pipeline wired into the PWA: dedup by commandId, single in-flight, ≤3 backoff retries **only** for provably never-reached failures, reusing identical sequence+signature; ambiguous timeout → "unknown" + explicit re-confirmation (never blind retry); Wi-Fi loss sweeps in-flight to unknown, reconnect re-syncs with stale-read guards; pairing lifecycle UX (deviceId, QR states, revocation). Protocol byte-identical. Doc: `docs/velora-3-ascension-remote.md` |
| 6 Testing/CI/provenance (Agent E) | `ascension-e-ci` | `d08b2f1`, `f149343`, `080db9d` | `scripts/sha256-manifest.mjs` (write/verify/show; deterministic, symlink-safe, secret-excluding) + node --test suite (`pnpm test:manifest`, 12 tests); CI now runs every proof suite (test, soak, provenance, portable-manifest, claude-usage, manifest) on both OSes + dist SHA-256 manifest step; portable workflow triggers on ascension pushes and uploads a verified `dist/portable` manifest; `docs/velora-3-ascension-release-readiness.md` |
| Integration | `feat/velora-3-ascension` | `434bca4`, `7d52427`, `5b86783`, `3b596c0` | Sequential merges of the four disjoint branches — zero conflicts |

## 2. Verification matrix (local, macOS, on integrated tip)

| Check | Baseline (4a43176) | Ascension tip | Result |
| --- | --- | --- | --- |
| `pnpm test` (vitest) | 112 files / 1046 | **121 files / 1171** | PASS (+125 tests) |
| `cargo test --locked --lib` | 432 / 0 fail / 1 ign | **461 / 0 fail / 1 ign** | PASS (+29) |
| `pnpm build` (tsc -b + vite) | PASS | PASS | PASS |
| `pnpm test:soak` | 3 | 3 | PASS |
| `pnpm test:provenance` | 31/0 | 31/0 | PASS |
| `pnpm test:portable-manifest` | 8/0 | **9/0** | PASS |
| `pnpm test:claude-usage` | 6/0 | 6/0 | PASS |
| `pnpm test:manifest` (new) | — | **12/0** | PASS |
| `git diff --check` | clean | clean | PASS |

Authoritative Windows checks (MSVC target, NSIS installer, portable candidate) run in CI on `windows-latest` — **not reproducible on macOS** (`aws-lc-sys` requires Windows SDK headers) and therefore **not claimed locally**. The Draft PR's CI run is the authoritative result.

## 3. Independent security & regression review (Agent F)

Read-only audit of the full diff: **VERDICT: PASS.**

- `capabilities/default.json`, `tauri.conf.json` (CSP), `Cargo.toml`, `Cargo.lock`, `pnpm-lock.yaml` byte-identical; `package.json` +2 script entries only.
- Remote production security code byte-identical (only `#[cfg(test)]` hunks); HMAC prefix, 4096-byte limit, `trust_confirmed`, rustls, replay guard (persist-before-emit), Host/Origin, 11-route allowlist all intact and now pinned by new source-text guard tests.
- Fail-closed retry verified: no blind retry of ambiguous timeouts, identical signed bytes on retry, server-side dedup makes double execution impossible.
- No new process termination, window enumeration, global input hooks, registry writes beyond the single HKCU Run entry, cert installation, DRM bypass, Playnite DB/credential reads, or hardcoded secrets.
- Zero removed lines in existing tests; no skips added; `lib.rs` byte-identical (command set unchanged); UI preserved (only additive PWA/SessionsPanel affordances).
- Informational findings only (no fix required): optimistic `never-reached` label in a narrow online-fetch race (safe via server dedup); recon doc wording clarified in this branch.

## 4. Known limitations (honest)

1. **All physical hardware gates remain NOT TESTED**: DS4 BT reconnect/chord on MSI, PS+Options Home on hardware, Panasonic 4K pointer accuracy, iPhone QR/TLS pairing on a real device, streaming cross-provider soak on hardware, display topology/HDMI, installer upgrade/rollback, SmartScreen (unsigned installer).
2. No provider playback-state read/persist/restore — blind media toggle only; DRM boundaries untouched (`PLAYBACK_STATE_READ_SUPPORTED=false`).
3. Windows foreground focus can be denied by the OS; unexplained denials surface as truthful `unknown`, never fabricated.
4. Session exit/crash detection is observation-only via existing read-only markers; no process killing, ever.
5. iPhone certificate model residual risk (device-wide root trust, no pinning/CRL) remains documented in `docs/iphone-remote-cert-audit.md`; safe fix requires UX+infra change, deliberately not hacked around.
6. Windows-vault tests need Credential Manager on real Windows; sandbox exclusions are documented, not passes.
7. NSIS embeds a timestamp → identical code yields different installer hashes; provenance records commit SHA alongside.

## 5. Hardware acceptance plan

Execute `docs/velora-2-s2-9-luna-test-procedure.md` on the MSI with the **portable validation candidate** from this PR's `Portable Windows validation build` workflow (no install, no registry, isolated `<VELORA-Portable-Data>`). Extend it with the new Ascension checks: four-source double-input (pad+keyboard+remote same tick), DS4 BT drop/reconnect mid-navigation and mid-chord, Home from every overlay, session duplicate-launch attempts, remote "unknown outcome" re-confirmation panel, Wi-Fi toggle during command send. Record results as evidence JSON under `docs/evidence/`; only then may any hardware gate be marked PASS.

## 6. Next-stage roadmap

1. Merge Draft PR #72 (S2.9) and then this PR into the integration line after hardware gates; keep everything Draft until Luna's evidence exists.
2. Cert model decision for iPhone Remote (SPKI pinning out-of-band vs mTLS per-device vs scoped CA + rotation) — needs UX change, planned in `docs/iphone-remote-reliability-plan.md`.
3. Optional: wire the one-line `accept("keyboard"|"remote", …)` calls in `App.tsx`/`navIntent.ts` to the new four-source gate (owned by lead; gate already arbitrates and is tested).
4. Windows reliability deep-dive: WebView2 GPU compositing on the RTX 3070 (`fix/webview2-gpu-compositing` branch exists), display scaling/negative coordinates, HDMI audio device switching.
5. Consider publisher signing to remove SmartScreen friction (requires a code-signing cert — decision for the owner).

## 7. Safety compliance

No force push · no merge to `main` · no release/tag · no installer run or replacement of installed VELORA · no destructive Windows operations · no new dependencies · no weakened TLS/HMAC/replay/CSP/capabilities · no global input hooks · no DRM bypass · no credential exposure · no false hardware PASS claims. All agent work stayed on separate branches/worktrees with disjoint file ownership; nothing was pushed by agents.

## 8. Pull request

Draft PR `feat/velora-3-ascension` → `feat/s2-9-hardware-recovery` (created with `gh pr create --draft`; URL recorded in git notes of the tip commit and in the PR list). CI on the PR is authoritative for Windows/MSVC/NSIS/portable.
