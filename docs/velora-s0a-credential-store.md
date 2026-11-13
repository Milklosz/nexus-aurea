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

Results below are for the current S0a branch head and must be refreshed after CI runs on the PR head.

| Check | Result | Evidence |
|---|---|---|
| Dependency feature inspection | PASS | `cargo tree --offline --locked --manifest-path src-tauri/Cargo.toml -e features -i keyring` shows `keyring feature "windows-native"`. |
| Rust library test suite | FAIL / native scenarios NOT RUN | 272 tests ran: 267 passed and five new Windows Credential Manager integration tests failed at the first native write/read with `CredentialStoreError::Unavailable` in this execution environment. This does not establish persistence, independent-process, revoke, or native payload-boundary behavior. |
| UTF-16 limit arithmetic and safe boundary | PASS | `credential_limit_counts_windows_utf16_bytes` passed for ASCII and supplementary Unicode characters. |
| Rust formatting and whitespace | PASS | `cargo fmt --manifest-path src-tauri/Cargo.toml`; `git diff --check`. |
| iPhone/Safari and physical pairing | NOT RUN | Requires the separate hardware acceptance stage. |

The native integration failure is an explicit limitation, not a mocked success. The GitHub Actions result on the new PR head is still required before S0a can meet its acceptance criteria.

## Recovery and remaining risks

If the former mock backend contained a CA private key, that key cannot be reconstructed from the public profile after a restart. The user must explicitly prepare a new profile, transfer it to the iPhone through a trusted channel, install and fully trust it, and pair devices again. The update does not inspect production credentials, migrate them, or remove them.

An interrupted write may leave an orphan token if Windows refuses cleanup. The device index remains authoritative, so an unindexed token cannot authenticate; a cleanup error is surfaced. If Credential Manager becomes unavailable while the process is running, later writes fail closed. The current in-memory cache does not detect external removal until the next load/restart, so a hardware restart and trust-recovery check remains necessary.

No MSI installation, running application, release, or production credential was touched by this change.
