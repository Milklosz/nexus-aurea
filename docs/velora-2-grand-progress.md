# Grand Living Room engineering progress

Engineering program, not stable or hardware accepted. Audit source: S2.0 `05f7235bb4680df03f9147bad055bb542cd6524e`, PR #58 preserved.

## S2.1 integration checkpoint

Implemented: versioned ID-only Smart Home collections and guarded launch integration; existing native LaunchRegistry projected into managed sessions; exact-owned resume and confirmed Cinema close; Sessions tab and Home Resume entry; native default audio read/set/mute with stale endpoint guard; local desktop exit/restart; safe remote diagnostics summary and expanded export redaction; remote admin denial takes precedence over any allow ancestor. Original controller supervisor, input sink, Credential Manager, adapters, weather and Home APIs are reused.

Tests observed before final S2.2 integration: focused UI integration 43/43; available native Rust 381 PASS, 2 ignored, 39 explicitly filtered Windows credential/vault tests. Provenance and Claude adapter 37/37 PASS. Full initial Rust attempt recorded 380 PASS, 32 FAIL, 2 ignored (31 Credential Manager sandbox access failures and one overlong sandbox temporary linker path). A shorter external temporary directory fixes the latter; filtered credential tests are NOT passed. Initial in-progress Vitest captured code while it was being changed; final clean-source runs supersede it.

Computer Use initialized the documented @oai/sky API but list_apps failed with `failed to launch codex app-server: program not found`. No successful live Windows, streaming, controller, HDMI or iPhone action is claimed. Installed 0.9.2 metadata was read; installation untouched.

S2.2 Gaming/TV source is implemented separately and awaits integrated registration, checks and candidate packaging. Final results, build identities and gates will be recorded in the release gate and Computer Use matrix. CI state must be queried for the exact delivered commit.
