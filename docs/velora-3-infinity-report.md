# VELORA 3 Infinity engineering report

The Infinity development branch stacks on First Frame Recovery at `95da492d34f64ba37643dfb42386d80ce8050341`. It retains the `0.12.0-rc.1` application version. Candidate-specific CI, artifact hashes and the final verdict are recorded on [Draft PR #77](https://github.com/Milklosz/nexus-aurea/pull/77). Use the PR head for the candidate SHA and check that the Windows portable manifest names the same commit. The baseline and resumable milestones are in the [checkpoint](velora-3-infinity-checkpoint.md).

## Workstreams and integration

| Workstream | Owner and code surface | Integrated result and remaining gate |
| --- | --- | --- |
| S3.20 Startup | Startup specialist, `portable.rs`, `single_instance.rs`, `startup_diagnostics.rs`, startup in `lib.rs` | Portable exclusion precedes child data writes. Mutex, profile and WebView2 failures have separate stages or exit codes. Startup logs are capped at 4 KiB per file. Test exact builds on the target display. |
| S3.21 Controller | Controller specialist, native and browser hooks and controller engine | Re-arm on focus or native epoch changes, ignore stale held state and recover after a short chord. Deterministic tests cover these branches. Physical DS4, Bluetooth reconnect and Steam Input remain open. |
| S3.22 Streaming | Session specialist, `openStreamingService.ts`, `veloraSessionManager.ts` | One pending native launch or adoption per service. Missing launch IDs no longer strand the client state, and a failed adoption preserves known state. Provider playback and switching remain open. |
| S3.23 Gaming Hub | Integration lead, `GamingHub.tsx`, `gamingCollections.ts` | Stable read-only catalog, Steam alias deduplication, search through the existing VELORA keyboard, running indicators backed by native observations, and listener cleanup. Live Steam and Playnite detection and return remain open. |
| S3.24 Home | Integration lead, `LivingRoomHome.tsx`, `HomeSections.tsx`, `FocusInfo.tsx`, Living Room CSS | Shared flow removes absolute-position collisions. Rapid focus reversal preserves the subtitle, and the error retry is directionally reachable. Physical display and long-running focus remain open. |
| S3.25 Control Center | Startup specialist, `ControlCenter.tsx` | Footer application switch opens Sessions and focuses that tab on repeated use in the same modal. Existing permissions apply. Hands-on panel recovery remains open. |
| S3.26 iPhone Remote | Security specialist, `remote_access.rs` | Hello rate accounting follows authentication, with fresh vault verification retained. Stop invalidates pending Start, and older server completion cannot clear newer state. Real TLS pairing and delivery remain open. |
| S3.27 Windows lifecycle | Startup specialist, portable startup and native guard | Distinct installed and portable mutex identities. Tests cover guard classification and early profile/runtime failure. HDMI, resume and restart remain open. |
| S3.28 Performance | Integration lead, portable smoke and Gaming Hub observation | One game-process read in flight, poll stops after a terminal observation. CI records elapsed time to observed window, React readiness and orderly shutdown. No comparative performance claim. |
| S3.29 Security | Security specialist and integration lead, remote and portable boundaries | Defensive review and regression tests for quota, lifecycle and trust-file isolation. Remaining conditions are listed below. |
| S3.30 Failure injection | Startup, controller and security specialists | Deterministic tests for duplicate launch, blocked profile, dropped controller input, delayed streaming receipt and cancelled LAN server startup. The full hardware and long-running scenario set remains open. |
| S3.31 IPC | Integration lead, `ipc-contract-node-check.mjs` | 81 paired Rust and TypeScript command names plus 13 matching documented table rows. No contract weakening or command changes. Existing guard primarily checks descriptors and names. |
| S3.32 CI and portable release | Integration lead, `portable-windows.yml`, CI wiring guard | Exact source checkout, visible startup, React, orderly exit and negative startup-path gates with sanitized traces. SHA-256 manifests cover package contents and published output. |
| S3.33 Couch accessibility | Integration lead and Control Center specialist | Directional recovery action, stable Sessions focus and searchable games with the existing on-screen keyboard. Physical couch-only acceptance remains open. |
| S3.34 Integration | Integration lead and independent reviewer | Changes stacked as reviewable commits. Independent startup/CI diff review confirmed PowerShell syntax and flagged missing negative-path trace uploads, which are now included. |
| S3.35 Candidate | Integration lead | Draft PR and exact-commit validation. The development artifact requires separate MSI and couch acceptance. |

## Main defects repaired

- The Home subtitle ended 224 reference pixels above the screen bottom. The recents row's bottom edge was anchored 196 reference pixels above the bottom, so a row at least 56 pixels tall crossed into the subtitle. The shared flow sizes the gaps from actual content and wraps tiles to keep focusable controls on screen. `livingRoomParts.test.tsx` also verifies a cancelled title transition cannot leave the current title invisible.
- Same-device native reconnect and fast focus cycles now reset the controller engine and bumper state. A dropped Options heartbeat is treated as lost input, so it cannot create a release action. Controller tests synthesize reports and time transitions.
- Pending native streaming selection survives independent state snapshots. Duplicate selection during adoption sends only one native request. A receipt without `launchId` permits another request through the native duplicate guard.
- Gaming Hub folds numeric and canonical Steam IDs into a single installed row and preserves old collection entries. The process indicator requires a tracked native running observation. The existing managed game and validated URI launch paths are still used.
- The mounted Control Center now uses its own tab selection when switching to Sessions. A regression changes tabs and invokes the footer action twice without remounting.

## Security and residual risks

| Severity | Finding and conditions | Fix, test and residual |
| --- | --- | --- |
| Medium | An enabled LAN server admitted unverified hello callers to the bounded rate map before authenticating. | Account only after validating a known cached device signature, discard revoked buckets and verify again against the locked fresh store. Windows tests verify the store and legitimate budget remain intact. Traffic can still consume transport resources. |
| Medium | A local Start followed by Stop while TLS was loading could let a server publish after Stop. Older completion could clear a newer handle. | Reserve start ownership, allow only the current attempt to publish and bind completion to the owning handle. Deterministic lifecycle regression covers cancellation and stale completion. A command already executing may finish, and the old socket may remain occupied briefly during close. |
| Medium | An approved portable trust export or cleanup could encounter redirected local profile paths. | Pin and inspect the portable root and trust child, refuse redirected and nonregular targets, and publish via atomic replacement. Test failure paths with fabricated directories and hard links. Cleanup continues revocation after a file error. Ancestor path control and OS privilege remain part of the local trust boundary. |
| Low | The startup mutex previously failed open when Windows could not create it. | Portable startup now returns 22. The installed build keeps its prior fallback. Classification tests and the duplicate CI smoke cover the normal guard paths. |
| Low | A Windows policy could be keyed by an explicit process AppUserModelID, which the existing check omitted. | Query the explicit ID and check it alongside executable name and stem using read-only Windows registry calls. The wildcard is excluded for `UserDataFolder` in the [WebView2 API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.4258.31). Target Windows policy variants have not been injected on the MSI. |
| Low | Paired-device keys persist until revocation, and the existing pairing ceremony relies on a short code and rate limits. | Existing TLS, signed commands, replay handling and explicit revocation remain in place. Expiry and rotation need a compatible protocol rollout and iPhone testing. |
| Low | Portable redirection of `LOCALAPPDATA` can hide per-user Playnite paths. | Preserve isolation. A future read-only discovery path must be separate from mutable app data, and validated against a real installation. |
| Low | Each trace file is bounded. Retained older traces can accumulate over many launches. | Preserve evidence for now. Future retention should be limited to files owned by the candidate, with a verified policy and tests. |

The review also checked Tauri capability scope, explicit URL and process identity validation, authenticated commands, durable replay handling, redacted evidence, installer publish conditions and exact-source artifact provenance. The LAN carryover uses the existing CA and credential store. The Home weather lookup is optional and can attempt a network request on startup. Full advisory scanning and certificate trust on a physical iPhone remain open. No privileged LAN operations, production installation or stable release were requested by this candidate.

## Reproducible verification

Run from the isolated checkout. Use a normal writable system temp directory outside a Git working tree for the Rust fixtures and Windows Credential Manager access for the synthetic vault tests.

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd test
pnpm.cmd build
node scripts/home-layout-browser-check.mjs
node --test scripts/build-provenance-node-check.mjs scripts/claude-usage-node-check.mjs scripts/genesis-ci-node-check.mjs scripts/ipc-contract-node-check.mjs scripts/portable-isolation-node-check.mjs scripts/portable-manifest-node-check.mjs scripts/sha256-manifest-node-check.mjs
cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib --features portable-validation
git diff --check
```

The integrated frontend passed 1,395 tests across 146 files, the Node checks passed 73 tests and the Windows Rust portable-feature suite passed 561 tests with 3 helper tests ignored. The normal sandbox denied synthetic Credential Manager access, so the Rust suite passed in the approved environment. The production build passed with Vite's existing large-chunk advisory. Headless Edge passed 12/12 layout fixtures covering empty, populated and long-copy error states at 1920×1080, 3840×2160, 2560×1440 and 780×650 CSS pixels. The same probe with `--css-ref 95da492d34f64ba37643dfb42386d80ce8050341` reproduced the overlap in all 12 baseline fixtures.

The portable workflow records timings from process launch and observes readiness at 250 ms polling resolution. A cold-start comparison, memory and CPU profiles, and per-service latency measurements still need comparable runs on the same hardware.

## Acceptance matrix

Results reflect the evidence type named in each row. The final exact-head artifact and CI verdict live on the draft PR.

| Gate | Status | Evidence |
| --- | --- | --- |
| Startup | PARTIAL | Unit and portable CI gates. Historical intermittent failure remains unexplained. |
| First visible window | PARTIAL | Exact-head portable CI provides Windows runner filter and trace evidence. MSI acceptance is separate. |
| React readiness | PARTIAL | Windows runner frontend signal and startup trace. |
| Portable isolation | PARTIAL | Unit tests, direct-launch portable CI and manifest evidence. The CI guard detects new installed directories. |
| Fullscreen | NOT TESTED | This candidate's portable CI uses windowed mode. |
| 4K UI layout | PARTIAL | Edge passed 3840×2160 and 2560×1440 CSS viewport fixtures. Physical scaling and overscan are open. |
| Home text overlap | PASS | Edge geometry reproduced the baseline collision and checked the repaired layout. Physical confirmation remains open. |
| DS4 navigation | PARTIAL | Deterministic input tests. Physical DS4 remains open. |
| PS+Options Home | PARTIAL | Input state-machine tests. Physical chord remains open. |
| Input deduplication | PARTIAL | Cross-provider, short-chord and release simulation. |
| Controller reconnect | PARTIAL | Same-device reconnect and heartbeat fixtures. |
| Streaming launch | PARTIAL | Simulated native receipts and compatibility. |
| Streaming switching | PARTIAL | Lifecycle and delayed-receipt tests. No protected playback validation. |
| Home recovery | PARTIAL | Focus, repeat and route regressions. External app recovery remains open. |
| Gaming Hub | PARTIAL | Synthetic catalog, search, runtime observation and error tests. |
| Steam | PARTIAL | Validated ID fixtures and simulated launch. Live installation and Steam Input remain open. |
| Playnite | PARTIAL | Manifest tests and CI extension build. Live integration remains open. |
| Control Center | PASS | Frontend tests verify repeated Sessions selection and focus. |
| iPhone Remote | PARTIAL | Windows-native vault/lifecycle and frontend policy tests. Real LAN pairing remains open. |
| Windows focus recovery | PARTIAL | Hook and native unit test evidence. Physical foreground handoff remains open. |
| Restart | NOT TESTED | No candidate-specific MSI restart evidence. |
| Shutdown | PARTIAL | Windows CI orderly-close and trace gate. |
| Startup diagnostics | PASS | Bounded trace, typed Windows errors and portable workflow regression gates. |
| IPC contracts | PASS | 81 paired command entries and 13 documented rows. |
| Security review | PARTIAL | Independent review and implemented fixes. Residuals are listed above. |
| Performance | PARTIAL | Runner startup and shutdown observations. Comparable hardware measurements remain open. |
| Portable artifact provenance | PARTIAL | Manifest tests and CI exact-head verification documented on the draft PR. |
| CI | PARTIAL | Use exact-head run links and outcomes on the draft PR. |
| Physical Panasonic validation | NOT TESTED | No hardware evidence for Infinity. |
| Overall couch-only usability | NOT TESTED | Needs the full hands-on sequence. |

## Hardware handoff and next sprint

1. On Draft PR #77, identify the portable run for the exact commit. Download the artifact, compare its archive SHA-256 with the GitHub artifact digest, and run `node scripts/portable-manifest.mjs verify --manifest <manifest> --package <package> --stage <extracted-folder>`. Record `SHA256SUMS.txt`, the job URL and any failure evidence.
2. On the MSI, record the installed executable hash and active Windows display identity, resolution, refresh rate and scale. Extract into a fresh writable folder. Run `Run-VELORA-Portable.cmd --windowed`, then repeat with its default fullscreen mode. At each launch verify Home, Search, Home return and clean close. Capture isolated `startup-*.log` files and recheck the installed executable hash.
3. With the Panasonic and physical DualShock 4, exercise D-pad, analog, X, Circle, Options and PS+Options, followed by reconnect, held buttons, provider switching, app launch failure and Home recovery. Record the controller transport, Steam Input mode and results for each step.
4. Verify authorized streaming on the real target, manually managing personal sign-in. Verify Steam, Playnite and game exit with existing user libraries. On the iPhone, approve only the intended trust profile, verify pairing, interrupt the LAN connection during a command and confirm how ambiguous delivery and revocation are shown.
5. For the next sprint, prioritize Windows display and controller acceptance, portable Playnite discovery, LAN credential expiry and a measured startup comparison. Use the checkpoint to resume without changing the upstream recovery stack.
