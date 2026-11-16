# Grand Living Room engineering progress

Engineering program, not stable or hardware accepted. Audit source: S2.0 `05f7235bb4680df03f9147bad055bb542cd6524e`, PR #58 preserved.

## S2.1 integration checkpoint

Implemented: versioned ID-only Smart Home collections and guarded launch integration; existing native LaunchRegistry projected into managed sessions; exact-owned resume and confirmed Cinema close; Sessions tab and Home Resume entry; native default audio read/set/mute with stale endpoint guard; local desktop exit/restart; safe remote diagnostics summary and expanded export redaction; remote admin denial takes precedence over any allow ancestor. Original controller supervisor, input sink, Credential Manager, adapters, weather and Home APIs are reused.

Tests observed before final S2.2 integration: focused UI integration 43/43; available native Rust 381 PASS, 2 ignored, 39 explicitly filtered Windows credential/vault tests. Provenance and Claude adapter 37/37 PASS. Full initial Rust attempt recorded 380 PASS, 32 FAIL, 2 ignored (31 Credential Manager sandbox access failures and one overlong sandbox temporary linker path). A shorter external temporary directory fixes the latter; filtered credential tests are NOT passed. Initial in-progress Vitest captured code while it was being changed; final clean-source runs supersede it.

Computer Use initialized the documented @oai/sky API but list_apps failed with `failed to launch codex app-server: program not found`. No successful live Windows, streaming, controller, HDMI or iPhone action is claimed. Installed 0.9.2 metadata was read; installation untouched.

## S2.2 integrated candidate

Version `0.10.0-rc.1` adds Steam installed/favorites/recent collections, preserves the existing supported Playnite library/extension, and wires native TV selection into Control Center, startup and the existing display-change observer. Monitor identity resolves against actual native enumeration. Only VELORA window placement/fullscreen changes; no global topology or default-audio mutation. `--windowed` overrides saved TV mode. Future collection/preferences versions are preserved. Explicit autostart remains disabled unless selected by the user. Clean exit/restart and existing crash recovery are reused; no watchdog is installed.

Observed integrated local checks: Vitest **924 PASS /104 files**, Rust available suite **384 PASS /0 FAIL /2 ignored /39 explicitly filtered**, TypeScript and production frontend PASS. Node provenance/Claude adapter **37 PASS**. Clippy PASS with inherited warnings; whole-crate rustfmt still has inherited drift while touched modules are checked independently. One native TV persistence return-type integration error was fixed before these passing Rust results. Full initial frontend failures from changed tab/cache expectations and preview audio were corrected, not hidden by exclusion.

S2.1 Draft PR: https://github.com/Milklosz/nexus-aurea/pull/59; latest source `89886f079fe4bbcb0e47b9940fc6fab52046bd5d`. S2.2 is stacked on this exact source. CI and installer evidence must identify the final candidate SHA. Actual live UI, streaming, runtime latency/CPU/memory and physical device acceptance remain unverified; no fabricated performance measurements.

## Follow-up candidate 0.10.0-rc.2

The existing rc.1 work and its reports were inspected and preserved. Follow-up branch: `codex/velora-grand-living-room-validation`, based on integrated `f232ea698adf3e15003a167f032543a61f26324e`, without rewriting #58–60. Actual delegated work in this follow-up: Luna Windows validation, session implementation, remote implementation and a separate audio/TV/session source review by the remote specialist.

Implemented follow-up: true observed activation timestamps in LaunchRegistry; sanitized launch adapter family; explicit application-level notRunning states without fake session IDs; same-phase foreground/window update notifications without stable-tick spam; Smart Home recents ignore those focus-only events. Core Audio notifications invalidate stale frontend snapshots, coalesce bursts and reread the default endpoint. TV shows exact native refresh/transport/friendly-name metadata, reports unknown ambiguous targets, and rejects invalid/future preferences before window mutation. Remote adds one-action swipe/tap navigation and nonqueuing same-origin Web Locks with a fresh persisted sequence read; HTTPS/HMAC/native commands remain unchanged. This touchpad navigates focus; it is not an unrestricted OS cursor.

Observed final-code local checks: **933 Vitest PASS /105 files; full Windows Rust 428 PASS /0 FAIL /2 ignored /0 filtered; TypeScript/production frontend PASS; provenance/Claude adapter 37 PASS**. The complete native suite ran with test-only synthetic vault services outside the sandbox restrictions; this supersedes the earlier filtered local scope without relabeling earlier failures. One earlier follow-up attempt failed before tests because its short linker temporary directory had not yet been created; it was created and the complete suite rerun successfully. Clippy/format/artifact and exact-head CI evidence are recorded at the delivery checkpoint.

Computer Use now successfully enumerates Windows apps and has launched the exact rc.1 debug candidate. Its live results are recorded separately from rc.2 code/build checks. The initial helper failure is historical, not the current environment status. No controller/iPhone/Panasonic hardware acceptance follows from these keyboard/mouse tests.

Verified rc.1 CI run `43896908102`: Windows, macOS and Playnite success; release publication skipped. Downloaded rc.1 installer ZIP matches GitHub digest `6c9b7ff56b2b72a908deb44a19fcbbd47f8c931a7c520acce49e46fdfb5e9ee5`. Its NSIS EXE is 4,512,821 bytes, SHA-256 `7544fbc8f846c51a528b47064b0a528e12c31123e7d3155a5dbe72af61b3a666`, source `f232ea6`, synthetic merge `af71e5d`. Local manifest consistency passes; this does not independently attest CI origin or provide a digital signature. The installer was not executed. rc.2 must receive its own artifact; rc.1 is not presented as containing follow-up fixes.

## Live/independent QA corrections

rc.1 live testing found normal restart exited without replacement. Installed Tauri source confirms restart can spawn before old-process teardown, while the old single-instance mutex handle was retained; synchronous UI-thread `restart` also skips the Exit callback. The fix uses `request_restart` and releases only VELORA's own guard at the end of orderly Exit, after shutdown requests. An isolated test-only mutex verifies duplicate exclusion until exit, primary claim after release and idempotent cleanup. Broken-event-loop fallback remains unproved; no watchdog/retry loop was added.

Netflix's owned close was observed terminating. Other browser windows accepted WM_CLOSE but remained present; their reason is not proven. The Sessions UI now distinguishes an accepted request from confirmed exit: existing events plus one read after 6.5 seconds either confirm native terminal/absent state or show an explicit unconfirmed-close warning with a scoped window-check action. It never kills a process or repeats WM_CLOSE automatically.

Independent remote review reproduced a stale401/new-pair storage race. Atomic IndexedDB conditional mutations now cover sequence reservation, matching-generation rejection/tombstones, status cleanup and confirmed pairing replacement, including browsers without Web Locks. Pair failures do not delete keys. The independent reviewer reran 65 real-script tests; the full focused remote set passes 69. Cache revision is command-8. Obsolete concurrent successful server pairings can require local revocation; client storage preserves the winning confirmed record.

Final implementation checks after these corrections: **946 Vitest PASS /105 files; full Windows Rust 429 PASS /0 FAIL /2 ignored /0 filtered; TypeScript PASS**. Intermediate source `32782c0` passed Windows/macOS/Playnite CI run `43949305641` and produced a clean debug artifact. That run predates the QA corrections; the final child commit requires its own CI/build evidence. rc.1's failing restart row is retained, not rewritten as a pass.
