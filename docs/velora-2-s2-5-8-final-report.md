# VELORA 2.0 — Operation Autonomous Evolution: final engineering report

Candidate `0.12.0-rc.1`, branch `feat/hy4-s2-5`, integrated from baseline `7878b83` on
`integration/velora-2-s2-3-s2-4`. Draft PR **#65**. Report date 2026-11-17 (Europe/Warsaw).

## Outcome

All authorized sprint work (S2.5–S2.8) was implemented, reviewed and integrated without touching
`main`, PR #62/#63/#64, the stable installation or Windows configuration. Every sprint landed as a
real commit from a bounded subagent workstream with disjoint file ownership; each was reviewed and
tested before sequential integration. No physical hardware, GUI, desktop-focus, installer or
Computer Use action was performed.

## What works (AUTOMATED / SOURCE evidence)

| Area | Delivered |
|---|---|
| S2.5-A | Closed 16-variant `SpatialFailureKind`; string `contains(...)` classification removed; counters/denials preserved; no page text in diagnostics |
| S2.5-B | Typed fallback eligibility; ownership/authorization/target/platform failures can never fall back; Remote excluded; failed Confirm never replayed as a Click; persistent mode banner |
| S2.5-C | Home reuse bound to full session identity; streaming generation/epoch revoked exactly once per real transition; supervisor neutral rearm; explicit frontend readiness |
| S2.5-D | Deterministic display signature; confirmed-DPI-only geometry conversion; negative-origin helpers; DPI divergence notes; DPI-derived pointer scaling (no 1920×1080 constant) |
| S2.6 | QR short-lived bootstrap in URL fragment + prefill/manual fallback; live countdown; HMAC-reuse signed hello; Wi-Fi recovery with no replay; SW `command-9`; all limits preserved |
| S2.7 | Deterministic close/crash and transition soaks; one `Ended` event per session; conservative identity/close guards preserved; honest failure feedback; five profiles intact |
| S2.8 | Expanded diagnostics redaction + browser mirror; 3000-transition CrossSourceGate soak in CI; provenance chain preserved; security review and hardware gates documented |

### Final validation matrix

| Check | Result |
|---|---|
| `pnpm test` | **1031 passed / 110 files** (baseline 980/109) |
| `pnpm test:soak` | **3 passed** |
| `pnpm build` (tsc -b + vite build) | PASS |
| `pnpm test:provenance` / `pnpm test:claude-usage` | PASS / PASS |
| `cargo test --lib` | **481 passed / 0 failed / 3 ignored** (baseline 450) |
| `git diff --check`, secret scan | clean |

3 Rust tests are intentionally ignored live-hardware evidence probes (`live_display_audio_snapshot`
and remote credential-process probes), not failures. Integration evidence is in the security review
appendix and the progress checkpoint.

### CI (GitHub Actions, PR #65)

- `Windows / Playnite extension (net462)`: **PASS** (35 s).
- `macos-latest / React, Tauri, Rust`: **PASS** (3 m 20 s) — includes `pnpm test`, soak,
  provenance, `cargo test --lib`, `pnpm build`, `git diff --check`, macOS Tauri build.
- `windows-latest / React, Tauri, Rust`: **PASS (5 m 53 s)** — all test steps including the new
  soak gate, Rust unit tests, `pnpm build`, `git diff --check` and locked MSVC check, plus the
  Windows x64 NSIS installer build, provenance write/verify/release preview and installer artifact
  upload.
- Local `cargo check --locked --target x86_64-pc-windows-msvc`: PASS (pre-existing warnings only).
- CI run `44191168364` (PR event) and `44191154859` (push event) both passed the test jobs; the
  Windows packaging result above is from the PR run. CI is an integrity/automation gate, not a
  digital signature or hardware acceptance.

## What remains unverified (NOT TESTED — no claim made)

- **Automated test PASS** is established for logic, typed contracts, receipts, UI rendering and
  sanitized diagnostics. **Windows runtime PASS** is not claimed for this candidate.
- **Physical hardware NOT TESTED:** DualShock 4 over Bluetooth; Panasonic 4K pointer accuracy at
  3840×2160 / 150% effective DPI; real UIA provider behavior; HDMI disconnect/reconnect.
- **iPhone Remote:** real camera QR scanning, iOS trust-profile/TLS acceptance, Safari HTTPS signed
  hello round trip, real Wi-Fi interruption recovery. Connection state does not prove key
  authorization until a signed command is accepted.
- **Streaming:** live Edge/app-mode windows, real close/crash, DRM/Widevine/PlayReady/HDCP and
  site-specific navigation for Netflix, YouTube, Disney+, Max and Prime Video. No compatibility or
  playback claim is made; no DRM or anti-bot control was bypassed.
- **Installer:** upgrade/rollback execution, artifact installation and stable release remain
  NOT TESTED / NOT AUTHORIZED. CI provenance is an integrity check, not a digital signature.
- **BLOCKED by authorization:** merging into `main`, merging/closing PR #62/#63/#64, publishing a
  stable release, installing the candidate, changing Windows settings, accessing personal browser
  sessions or streaming accounts, taking desktop focus/Computer Use.

## What should be tested on the physical MSI (prioritized)

See `velora-2-s2-5-8-hardware-gates.md` for the full P0–P2 matrix (H1 DS4, H2 4K pointer
accuracy, H3 iPhone/TLS, H4 streaming services, H5 display topology, H6 close/crash, H7
installer, H8 accessibility, H9 endurance, H10 startup/shutdown). Execution requires a separately
authorized hardware session; close the installed VELORA normally before any candidate run because
single-instance identity and application data are shared. Rollback = exit the candidate and reopen
the unchanged installation, with no data deletion (see `velora-2-grand-release-gate.md`).

## Final determination

**Engineering release candidate ready for review.** Source-review PASS with no unresolved
critical/high issue; complete automated matrix green; no secret or unrelated change in the final
diff. This is not a stable release and not an acceptance/hardware sign-off.
