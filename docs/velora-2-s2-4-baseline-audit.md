# S2.4 — baseline and forensic audit

Audit date: 2026-11-17 (Europe/Warsaw). Evidence labels: **SOURCE** (inspection), **AUTOMATED**, **COMPUTER USE**, **HARDWARE** (physical acceptance only). This document records the starting state; candidate results are recorded separately.

## Source integrity — SOURCE and GitHub metadata

The outer workspace is an older independent checkout, `codex/velora-2-s1-2-claude-usage`, HEAD `ec28205`, with pre-existing untracked `.codex/` and `target-int/`. It is left untouched.

The actual S2.3 repository is `work/grand`, initially clean on `feature/velora-2-s2-3-native-tv-experience`, HEAD `740f5964df4e2dc843f436b0e5e7a61af9cafc13`. Its parents include implementation `cc24affd970b3f4fb478f58f1dceb218708f7753` and integrated base `a7c53b3034fe00b6fa0c76ff6d4fe5f332c0c5ea` (both `merge-base --is-ancestor` checks passed). The checkout is shallow, but these required commits and ancestry are present. Remote `ls-remote` and fetch confirmed S2.3 at exactly `740f596`. PR #62 remains open, Draft, unmerged; its metadata matches the same source. `git show --stat 740f596` contains nine documentation/evidence files only. It does not change runtime behavior.

Created S2.4 branch `feature/velora-2-s2-4-true-tv-experience` from that verified HEAD. No reset, clean, force push, merge, installer execution or installed-file replacement was performed.

Installed executable baseline SHA-256 (read-only file hashing): `d702baf99b9e640c70d96ea0ed01306dac63482356826dfccdd7958ae1eee51f`. Computer Use enumeration found the installed VELORA window running. Candidate validation must close it normally before starting the separate debug EXE because data and single-instance identity are shared.

## YouTube failure — known evidence versus unknown cause

**COMPUTER USE, inherited S2.3 evidence:** the clean cc24aff debug candidate returned `no eligible controls within query budget` for Down on a managed YouTube window. Native keyboard NextSection dispatch was accepted, with no independently established focus effect. Explicit pointer movement and player pause/fullscreen had narrower observations. Full couch navigation was not accepted.

**SOURCE:** `spatial_navigation.rs` uses the Control View walker, a 256-node / 32-level / 40 ms discovery limit, a 250 ms action budget and a 500 ms thread-local candidate cache. Discovery is depth first from the window root. A candidate must be enabled, on screen, non-password, keyboard-focusable and fully contained by scope bounds. Therefore browser chrome, deep document wrappers, slow cross-process calls, partly clipped controls or actionable non-focusable elements can consume/exclude the budget. These are possible mechanisms, not a proven cause for the historical YouTube page.

**SOURCE:** UIA focus ancestry is checked against the exact managed root; selected elements are revalidated for bounds, ancestry, foreground, session and generation before use. These protections must remain. Current cache refresh is tied to target/scope and TTL; moved selected rectangles fail closed.

**SOURCE defect:** spatial errors propagate as strings. The simulator converts a worker error to a default action result with duration zero and null candidate metrics. Thus S2.3's failure receipt cannot distinguish unavailable provider, empty exposure, rejected candidates or exhausted budget. Zero is not a measured failure latency. The old receipt cannot establish browser rendering, DPI, overlay, modal or advertisement as the cause.

**SOURCE:** Automatic mode chooses the conservative keyboard profile, and explicit spatial failure tells the user to choose pointer. No reliable automatic, sticky fallback is evidenced by the S2.3 failure. Do not interpret absent fallback as a successful controller workflow.

## Prioritized defects and work

| Priority | Defect / gap | Required evidence |
| --- | --- | --- |
| P1 | Failure receipts lose UIA cause categories and measured time | Native failure tests plus new live receipt |
| P1 | Bounded discovery can miss page controls; historic cause unresolved | Rejection/visit/budget/focus counters and live reproduction |
| P1 | Desktop catalog arrows are not reliable spatial focus | Real service observations and explicit, visible fallback |
| P1 | 4K/DPI/secondary-display geometry not accepted in S2.3 | Current Windows API snapshot plus candidate runtime |
| P1 | No complete simulator couch workflows accepted | Per-action effects, interventions and honest status |
| P2 | Simulator supports only a short fixed sequence and coarse pointer pulses | Bounded recording/replay/timing/analog tests |
| P2 | Display diagnostics omit useful geometry/scale/provider attribution | Additive contract and unknown-value handling |
| P2 | Native pointer responsiveness/precision at 4K unmeasured | Scaled geometry tests and observed hit testing |
| P2 | Protected catalogs and real DS4 remain open | Legitimate existing sessions; physical testing deferred |

## Display, audio and performance boundary

**COMPUTER USE, S2.4 audit of preserved S2.3 binary:** launched the exact `outputs/s2-3-cc24aff/nexus-aurea.exe` with `process:` path selection, observed diagnostics version 0.11.0-rc.1, full cc24aff SHA, debug Windows target, zero controllers, Home and Control Center. Confirmed F11 expands to the Panasonic desktop and diagnostics remains usable; this is baseline evidence, not S2.4 acceptance. A launch using an unprefixed filename initially resolved to the installed executable; process-path inspection caught that before any test was attributed to the baseline. It was closed normally and the exact process path was used afterward. The installed file was not changed.

The saved TV display identity is currently unavailable, so S2.3 starts in a recoverable window and reports that condition. F11 changes the current window without writing TV preferences. No display-selection preference was overwritten during the baseline audit.

**WINDOWS API:** new read-only native probe identifies one active primary Panasonic-TV desktop, physical 3840×2160 at (0,0), HDMI, NVIDIA RTX 3070 Laptop, DisplayConfig refresh 60000 mHz, advanced color disabled. Panasonic HDMI is the default output, 100%, unmuted. Windows enumerates 62 audio endpoints; existing bounded list reports only 32 and explicitly reports truncation. Earlier CIM reports two active EDID entries; that is a distinct API observation and is not proof of two active desktop paths at the later native snapshot.

`GetScaleFactorForMonitor` returns the resource bucket 140; independently verified PMv2 baseline window reports `GetDpiForWindow=144`, i.e. actual effective window scaling 150%. These values must remain distinct. See `evidence/s2-4-display-audio-native.json` and `evidence/s2-4-window-dpi-native.json`.

Current hardware/API inventory is in `velora-2-s2-4-display-audit.md`. No refresh/HDR/scaling fact is inferred from the Panasonic model. No global display/audio setting changes are authorized. Read-only CIM initially failed under the restricted token; a narrow escalated read succeeded. Fullscreen, HDMI reconnect, multi-monitor cursor hit testing and 100% versus actual DPI are separate runtime acceptance items.

S2.3's reported 961 frontend / 443 Rust test counts and CI success are inherited evidence, not new S2.4 test results. Physical DS4 and iPhone LAN remain untested. Benchmark results must identify source, executable, scope, sample duration and limitations.
