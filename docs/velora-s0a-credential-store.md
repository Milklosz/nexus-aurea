# VELORA S0a — iPhone Remote credential store

## Scope and baseline

This change is based on the audited candidate `36312486cebb5b523c24cf0754f4a317ad87f042` and is limited to iPhone Remote secret persistence. The S0 remediation of findings F01 and F02 of the independent audit of 13 November 2026 is described in the sections "Multi-process safety" and "Recovery of damaged or partial state".

At the baseline, the Windows `keyring` dependency used its default feature set; `cargo tree -e features -i keyring` did not include `windows-native`. Remote state was kept in one `encrypted-state-v1` entry, including the CA, device tokens, and sequence values. The previous 2,400-byte check counted UTF-8 bytes, while the Windows backend stores password data as UTF-16 bytes. Those conditions could select a non-persistent backend and could reject or exceed the actual Windows credential limit for different values.

## Implementation

- Windows explicitly enables `keyring`'s `windows-native` backend. There is no mock backend in the Windows production dependency graph.
- The CA certificate and private key have separate entries. A bounded device index stores IDs, names, `lastSequence` and a monotonic `revision`; each device token has its own entry. The index is limited to eight devices and validated on load.
- Every credential is checked against a 2,400-byte UTF-16 payload ceiling, leaving room below Windows' 2,560-byte credential blob maximum. The index, certificate, and key also use this check at write time.
- Pairing writes the token before publishing it in the index. If the index write fails, the token is removed where possible and pairing returns an error. Revocation updates the index first, so the device is revoked even if deleting its token fails; cleanup failures are returned to the caller.
- Command sequence numbers are persisted before dispatch (see "Multi-process safety" for how this holds across processes). A failed sequence write rejects the command. An equal sequence without a receipt, for example after a restart or in another process, answers 409 and is never executed again.
- Missing, partial or damaged CA material is never silently replaced. The service stays unavailable until the user runs the local recovery described below. A fresh trust profile is generated only through the explicit profile preparation flow, and only when both CA entries are absent. Legacy `encrypted-state-v1` data is not migrated or deleted.
- Native integration tests use a unique `com.nexus.aurea.remote.tests...` service and synthetic values. Cleanup is limited to entries created by that test instance.

## Multi-process safety (audit F01, HIGH)

The audit reproduced a persisted sequence going from 11 back to 10: two VELORA processes of the same Windows user shared the Credential Manager entries, each kept a cache, and `save_device_index` wrote the whole index back from whichever cache was older. The in-process `command_gate` and `vault` mutexes could not order that. The `Local\` single-instance mutex is per Windows session and, on mutex-creation failure, deliberately lets the app start, so it is not relied on for storage safety.

Model: **a cross-process transaction around every read-modify-write**, implemented in `src-tauri/src/remote_state_lock.rs` and `remote_access.rs`.

- A byte-range lock (`LockFileEx`) on a file under `%LOCALAPPDATA%\VELORA\locks\` is the cross-process mutex. It is per user profile (so two sessions of one user exclude each other), released by the operating system when a process dies (a crash cannot leave the store locked), and not squattable by another user. It is declared with hand-written Win32 bindings; `Cargo.lock` is unchanged.
- Every operation that changes state or decides on it (command authentication and sequence reservation, reservation release, pairing, revoke, revoke-all, CA creation, recovery) takes the lock, **re-reads the stored state while holding it**, validates, writes, publishes the result to the cache, and releases the lock. The in-memory vault is only a cache for display and for a cheap pre-check that rejects unknown devices and bad signatures from the LAN before the lock is taken (pairing happens only in the serving process). A stale cache is never written back.
- The device index carries a `revision` that rises with every commit. A process that sees the stored revision go below what it last verified, or the same revision with different content, treats the store as rolled back and refuses to operate (`rolled-back` state, recovery required) instead of trusting it. This detects a backup being restored while VELORA runs; it cannot detect a restore made while no VELORA process was running (see limitations).
- Lowering a stored sequence is possible in exactly one place: releasing a reservation whose side effect never happened. It is compare-and-swap against the freshly read value; if another process moved the sequence, or the store or lock cannot be used, nothing is lowered and the sequence stays consumed.
- Fail-closed: if the lock location cannot be determined, the lock cannot be created, it stays busy (2.5 s for commands), or Credential Manager fails, the operation is refused with 503 (or an error to the UI) and nothing is written.
- The unauthenticated LAN `/api/status` endpoint is served from memory only, so a network client cannot cause credential-store I/O or lock contention.

## Recovery of damaged or partial state (audit F02, MEDIUM)

Fail-closed is kept, and a local way out now exists that does not depend on a successful normal load.

- The status reports the state of the store separately from "no paired devices": `ok`, `unavailable`, `locked`, `damaged`, `rolled-back`, `recovery-pending`. Only `damaged`, `rolled-back` and `recovery-pending` mark `recoveryRequired`; an unreadable (`unavailable`) or busy (`locked`) store offers no destructive action.
- `load_vault` now validates the CA: real PEM, a CA certificate that is currently valid, a parsable private key, and a key that matches the certificate's public key. Missing, one-sided, non-PEM, mismatched, truncated and expired material is classified as damaged.
- Recovery is two Tauri commands, `inspect_remote_recovery` and `run_remote_recovery`, called only from the local app UI (Control Center, iPhone Remote, "Odzyskiwanie zaufania…"). Neither has an HTTPS route; a test fixes the exact list of LAN routes. Inspection issues a one-time, expiring confirmation code; running requires it and consumes it. The user also has to pick a mode and tick an acknowledgement.
- Modes: **revoke all devices** (keeps the CA, so the iPhone profile stays valid) and **reset trust** (also deletes the CA certificate and key; a new CA exists only when the user later prepares a trust profile, which must be installed and fully trusted on the iPhone again). Damaged CA material allows only reset trust.
- The transaction stops the server, holds the cross-process lock, and writes a journal first (mode and known device IDs). While the journal exists the store stays closed. It then replaces the index with an empty one with a higher revision (every device is revoked before any secret is touched), deletes the device tokens (and for reset trust the CA key, then the certificate), and removes the journal only when every deletion succeeded. Every step is idempotent: an interrupted recovery is finished by running it again, and no half-reset state is ever usable.
- Only VELORA's own `com.nexus.aurea.remote` entries are touched. Nothing is rotated, regenerated or deleted automatically, and production credentials are never read by the tests.

## Verification status

Evidence for the remediation comes from a local Windows run of the native test suite (real Credential Manager under unique synthetic service names), a mutation check, and the GitHub CI results recorded in the PR description. Hardware status is unchanged.

| Check | Result | Evidence |
|---|---|---|
| Dependency feature inspection | PASS | `cargo tree --offline --locked --manifest-path src-tauri/Cargo.toml -e features -i keyring` shows `keyring feature "windows-native"`. |
| Rust library tests (Windows, local) | PASS | 301 tests, repeated runs, no leaked test credentials. |
| Anti-replay: an older cache cannot lower 11 to 10 | PASS | In-process (two caches) and with two real OS processes. With the stale-cache revoke temporarily restored, both tests fail with `left: 10, right: 11`, reproducing the audited defect. |
| Parallel writers | PASS | Three child processes plus the test process submit overlapping sequences 1–30: no sequence accepted twice, stored sequence and revision never decrease, final value 30. |
| Replay after restart | PASS | A new process answers 409 for the used sequence and 401 for older ones. |
| Credential Manager errors | PASS | Read errors, write errors, a write that reaches the store and then reports an error, delete errors, unavailable and busy locks: all refuse and none executes twice. |
| Interrupted writes | PASS | Real child processes ended after the Nth write for command, revoke and recovery; the OS releases the lock; state never goes backwards; recovery completes. Failure injected at every mutation of a recovery run. |
| Recovery scenarios | PASS | Missing certificate or key, non-PEM, mismatched, truncated CA; missing or undecodable token, unreadable index, unsupported version, duplicate IDs, CA missing with devices; each ends with a working new set and the old device rejected. |
| Native Credential Manager write-error injection | NOT RUN | Failures are injected at the storage adapter boundary and by ending real processes between writes; a forced native `CredWrite` failure is not available. |
| macOS build | CI | Windows-only code is `cfg(windows)`; checked by the macOS CI job. |
| Two interactive Windows sessions of one user | NOT RUN | The lock is per user profile by construction and is tested across real processes, not across interactive sessions. |
| MSI, iPhone/Safari, physical pairing, TLS chain after restart | NOT RUN | Requires the separate hardware acceptance stage. No hardware PASS is claimed. |

## Remaining limitations

- Restoring an older backup of the credential store while **no** VELORA process is running cannot be detected: the new process has no earlier revision to compare with. The revision check covers rollback while a process runs.
- Receipts stay in memory per process. After a restart, or when a different process receives the retry, an already executed command is answered 409, not acknowledged: at most one execution, possibly a lost command, not exactly-once.
- Credential Manager entries are written by the `keyring` backend with enterprise persistence and are visible to other processes of the same user. They are a system protection for the user, not isolation from malware running as that user. Roaming behavior was not verified on the MSI.
- Device tokens whose index record is unreadable and whose ID no process remembers cannot be enumerated (the `keyring` API has no enumeration). Recovery removes every ID it knows from the index, the journal and the process cache; remaining orphan tokens cannot authorize because authorization requires an index record.
- The root CA installed on an iPhone is not constrained to the LAN by its description; the earlier hardening note on trust scope still applies.
- No MSI installation, running application, release, or production credential was touched by this change.
