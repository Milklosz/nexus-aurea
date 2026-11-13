# VELORA S0a — iPhone Remote credential store

## Scope and baseline

This change is based on the audited candidate `36312486cebb5b523c24cf0754f4a317ad87f042` and is limited to iPhone Remote secret persistence.

At the baseline, the Windows `keyring` dependency used its default feature set; `cargo tree -e features -i keyring` did not include `windows-native`. Remote state was kept in one `encrypted-state-v1` entry, including the CA, device tokens, and sequence values. The previous 2,400-byte check counted UTF-8 bytes, while the Windows backend stores password data as UTF-16 bytes. Those conditions could select a non-persistent backend and could reject or exceed the actual Windows credential limit for different values.

## Implementation

- Windows explicitly enables `keyring`'s `windows-native` backend. There is no mock backend in the Windows production dependency graph.
- The CA certificate and private key have separate entries. A bounded device index stores IDs, names, and `lastSequence`; each device token has its own entry. The index is limited to eight devices and validated on load.
- Every credential is checked against a 2,400-byte UTF-16 payload ceiling, leaving room below Windows' 2,560-byte credential blob maximum. The index, certificate, and key also use this check at write time.
- Pairing writes the token before publishing it in the index. If the index write fails, the token is removed where possible and pairing returns an error. Revocation updates the index first, so the device is revoked even if deleting its token fails; cleanup failures are returned to the caller.
- Command sequence numbers are persisted before dispatch. A failed sequence write rejects the command and restores the in-memory sequence. The existing command gate and receipt behavior remain in place; an equal sequence after restart is rejected without a second effect.
- Missing or partial CA material does not get silently replaced when paired devices remain. The service stays unavailable and requires a controlled new trust profile and re-pairing. Legacy `encrypted-state-v1` data is not migrated or deleted. A fresh trust profile is generated only through the explicit profile preparation flow.
- Native integration tests use a unique `com.nexus.aurea.remote.tests...` service and synthetic values. Cleanup is limited to entries created by that test instance.

## Verification status

The original local Windows sandbox run could not access Credential Manager (`Unavailable`); this is recorded separately from the dedicated GitHub-hosted Windows CI run. The CI result below is for head `934fd664e4b21c2a3f342413aa89b277718e0ff6` (run `43467145834`, PR #49).

| Check | Result | Evidence |
|---|---|---|
| Dependency feature inspection | PASS | `cargo tree --offline --locked --manifest-path src-tauri/Cargo.toml -e features -i keyring` shows `keyring feature "windows-native"`. |
| Dedicated Windows CI Rust suite | PASS | Run `43467145834` on the current PR head completed successfully. Windows-only integration tests use unique synthetic Credential Manager service/account names and cover independent handles/processes, CA/device/sequence persistence through a new handle and child process, replay rejection after restart, revoke/revoke-all, device and payload bounds. |
| Injected write/delete failures | PASS | The test-only fault-injecting store exercises failure of CA, token, index, sequence and cleanup writes; pairing and command handling fail closed and revoke remains effective when token cleanup fails. This validates service behavior when the adapter returns an error. |
| Native Credential Manager write-error injection | NOT RUN | GitHub-hosted CI does not provide a safe, deterministic way to force a valid native write to fail after reaching Windows Credential Manager. Native reads/writes and the safe payload boundary are tested against unique synthetic records; failures are injected at the storage adapter boundary. |
| UTF-16 limit arithmetic and safe boundary | PASS | `credential_limit_counts_windows_utf16_bytes` passed for ASCII and supplementary Unicode characters. |
| Windows CI build checks | PASS | The same run completed JavaScript tests, Rust library tests, React/TypeScript build, Windows MSVC check, and NSIS installer build. No installer was installed or published. |
| iPhone/Safari and physical pairing | NOT RUN | Requires the separate hardware acceptance stage. |

The native CredMan scenarios passed on the dedicated Windows runner; the local sandbox's `Unavailable` result is not presented as a native PASS. The injected error tests use the test-only storage adapter and are not described as native CredMan error injection.

## Recovery and remaining risks

If the former mock backend contained a CA private key, that key cannot be reconstructed from the public profile after a restart. The user must explicitly prepare a new profile, transfer it to the iPhone through a trusted channel, install and fully trust it, and pair devices again. The update does not inspect production credentials, migrate them, or remove them.

An interrupted write may leave an orphan token if Windows refuses cleanup. The device index remains authoritative, so an unindexed token cannot authenticate; a cleanup error is surfaced. If Credential Manager becomes unavailable while the process is running, later writes fail closed. The current in-memory cache does not detect external removal until the next load/restart, so a hardware restart and trust-recovery check remains necessary.

No MSI installation, running application, release, or production credential was touched by this change.
