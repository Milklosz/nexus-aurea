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
