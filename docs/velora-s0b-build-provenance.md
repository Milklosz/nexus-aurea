# VELORA S0b — Build provenance

## Scope and baseline

This change is based on the audited candidate `36312486cebb5b523c24cf0754f4a317ad87f042`. At that SHA, `src-tauri/build.rs` ran `git rev-parse --short=12 HEAD` and watched only `../.git/HEAD`. A new commit on the same branch could leave a cached build identified by an old short SHA, and a worktree's `.git` is a file rather than the directory this watcher assumed. The candidate document also cited a different short-lived SHA than the verified PR head, demonstrating that its source record had drifted.

The S0 remediation of audit findings F03–F06 (13 November 2026) is described in "What verification proves" and the sections after it.

## Implementation

- `src-tauri/src/build_support.rs` reads the full 40/64-character checkout SHA, branch/detached state, dirty state, and active Git metadata paths. It resolves worktree Git metadata through Git itself and returns unknown values when no repository is available.
- `build.rs` watches the current branch ref, `HEAD`, index, packed refs, tracked source files, and relevant source directories. A CI supplied checkout SHA must be full length and match Git `HEAD`; stale or malformed values fail the build. Local builds without Git still compile and report unknown provenance unless a full CI SHA was supplied.
- The app's typed diagnostics now include full build/checkout SHA, branch, ref, dirty state, event, PR head/base SHA, target triple, profile, and rustc version. Values pass through the existing diagnostics sanitizer.
- Windows CI extracts the generated NSIS installer to a unique temporary folder (extraction only; the installer is never run) and hashes the setup file, the release EXE, and the packaged EXE as three separate outputs, then writes and verifies `velora-build-provenance.json` (schema version 2, `docs/schemas/velora-build-provenance.schema.json`) beside the installer and uploads both files.
- CI whitespace checking compares the PR base to the synthetic merge checkout, or the pushed commit range, instead of checking only the empty post-checkout working tree.
- Repeated setup builds are expected to produce separate hashes; no byte reproducibility claim is made.

## What verification proves (audit F04)

`scripts/build-provenance.mjs` keeps two levels of assurance apart and says so in its output.

**Internal consistency** (every verification): the manifest passes the full JSON schema (version, target, profile, tool-version formats, strict UTC timestamp, numeric run id, closed set of fields, SHA formats); its fields agree with each other (clean/dirty, PR head/base/synthetic merge, `sourceSha` = PR head and `checkoutSha` = merge for pull requests, merge ref shape, `generatedAt` not in the future, sizes and names); the three files match their recorded size and SHA-256; the packaged EXE is related to the built EXE by the reviewed transformation (below); and the manifest agrees with the checkout it is verified in: `checkoutSha` equals Git `HEAD`, dirty state, the merge's parents are exactly the recorded PR base and head, the app version equals `package.json` and `src-tauri/Cargo.toml`, and the Tauri CLI version equals the version pinned in `pnpm-lock.yaml`.

**CI origin** (only with `--ci`, inside a GitHub Actions job): the manifest is additionally compared with the job's own context: event name, ref, `GITHUB_SHA`, run id and attempt, runner OS, head branch; for pull requests the head SHA, base SHA and number from the event payload; the target and profile from the location of the built EXE (`target/<triple>/<profile>/`); all seven tool versions re-collected on the runner; and the manifest age. All seven tools must be available.

**What it does not prove.** The manifest and its hashes are not a digital signature and not a cryptographic proof of authenticity. Anyone who controls the workflow, the runner or the artifact store can produce a manifest that passes every check; the CI check shows the runner agrees with itself and with GitHub's event data. A signature or a GitHub artifact attestation would be a separate decision and is not claimed. Without `--ci` the output states `CI origin: NOT CONFIRMED`.

## Build EXE and installer payload (audit F03)

The Tauri CLI pinned by the lockfile (2.12.4) patches one bundle-type marker in the built EXE before NSIS packs it and then restores the original file, which is why the built EXE and the packaged EXE have different hashes. The verifier now enforces exactly that relation instead of accepting any two files:

- policy `tauri-cli-2.12.4-nsis-unsigned` in `PAYLOAD_POLICIES`: `__TAURI_BUNDLE_TYPE_VAR_UNK` in the built EXE becomes `__TAURI_BUNDLE_TYPE_VAR_NSS` in the packaged EXE, at the same offset, and every other byte is identical;
- both files must start with `MZ`, have equal size, and contain exactly one bundle-type marker of the expected kind (no extra marker, no other bundle type, no missing or moved marker);
- a Tauri CLI version without a reviewed entry is refused; changing the bundler version or enabling signing requires a reviewed policy change, not a bypass;
- exactly one `nexus-aurea.exe` must exist in the extracted installer (`--extracted-dir`), and the manifest records the policy, transformation and marker offset, which are re-checked on every verification;
- the files are only read: the installer and the EXEs are never executed, and the SHA-256 checks remain.

Evidence for the rule on the audited artifact (read-only, in the audit folder): the packaged EXE with its single NSS marker restored to UNK hashes to `4aee97ae6aef7c2de3f7b54e48384aa1b900cf5b7e99b130ac0f0ff94cb5ddb1`, the audited built-EXE hash, at offset 12,692,696. This is the byte-level explanation of the hash difference; it is not a rebuild from source or an attestation.

## Tool versions (audit F05)

The audited manifest recorded `unavailable` for pnpm, the Tauri CLI, MSVC and the Windows SDK. Causes and fixes:

- pnpm and `pnpm exec tauri` are `.cmd` shims on Windows, which Node cannot start without a shell, so the version probe failed silently. The fixed command lines are now run through the shell, only a zero exit status counts, only stdout counts (the old code could take the first stderr line as a "version"), and the output must match the expected format.
- MSVC and the Windows SDK were read from `VCToolsVersion`/`WindowsSDKVersion`, which a plain CI shell does not set and the build does not read. They now come from the linker the build toolchain really uses: a tiny probe program with a deliberate unresolved symbol is linked with `/VERBOSE:LIB`; the failing link prints the `link.exe` path (toolset version) and the `kernel32.lib` it found (SDK version). No "newest installed" guess.
- With `--ci`, any missing or malformed required version stops manifest creation; without it the manifest still shows `unavailable` explicitly (never hidden). Release verification refuses a manifest with an unavailable tool.

## Release (audit F06)

Nothing is published by this change. The release job now checks out the verification script, selects exactly one `*-setup.exe` and one `velora-build-provenance.json` (any other file fails), verifies that the installer matches the manifest's installer entry and that the manifest belongs to this commit, run, push event and tag, and uploads the installer and the manifest together. CI also runs the same selection and installer/manifest check on every Windows build (`--preview`, which skips only the push/tag check) without any publishing step.

## Verification status

| Check | Result | Evidence |
|---|---|---|
| Provenance Node tests | PASS (local) | `node --test scripts/build-provenance-node-check.mjs`: 22 tests, run on Windows. Payload relation: text file in place of the EXE, modified EXE (code and last byte), non-PE, truncated/appended, zero/two/other-type markers, reversed roles, moved marker, unknown Tauri version, zero/two EXEs in the extraction. Manifest: 45 single-field manipulations (every field class), with and without `--ci`; forged event payload; unavailable tools; release asset selection and verification. |
| Rule applied to the audited real artifact | PASS (local, read-only) | UNK-restored packaged EXE reproduces `4aee97ae…ddb1`; text file and modified EXE rejected; the audited manifest (schema 1, four unavailable tools) fails the new schema, as it should. |
| Tool collection on a real Windows toolchain | PASS (local) | MSVC toolset and SDK parsed from a real failing probe link; pnpm and `pnpm exec tauri` via shell return `11.25.0` / `tauri-cli 2.12.4`. The full seven-tool record on the Windows CI runner is reported in the PR description. |
| Rust Git metadata and Cargo cache tests | unchanged | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib build_support::tests` (no change in this PR's remediation). |
| Windows NSIS provenance manifest with all seven tools | CI | See the PR description for the run on the integration candidate. |
| Release job | NOT RUN | No release is created; the selection and verification code is tested and previewed in CI only. |

## Limitations and risks

- The SHA-256 values identify the exact produced files. They do not imply that a later installer rebuild has identical bytes, and they are not a digital signature.
- `--ci` trusts the GitHub-provided environment and event payload of the running job.
- The payload policy covers the unsigned NSIS bundle of Tauri CLI 2.12.4 only.
- The SDK/MSVC probe links a trivial program with the same toolchain and target; it identifies what the toolchain selects for that link, not an independent inventory of what is installed.
- The Actions artifact ZIP digest identifies GitHub's uploaded archive and is not the setup.exe digest.
- No release is created, no installation is performed, and no running MSI application is changed.
