# VELORA S0b — Build provenance

## Scope and baseline

This change is based on the audited candidate `36312486cebb5b523c24cf0754f4a317ad87f042`. At that SHA, `src-tauri/build.rs` ran `git rev-parse --short=12 HEAD` and watched only `../.git/HEAD`. A new commit on the same branch could leave a cached build identified by an old short SHA, and a worktree's `.git` is a file rather than the directory this watcher assumed. The candidate document also cited a different short-lived SHA than the verified PR head, demonstrating that its source record had drifted.

## Implementation

- `src-tauri/src/build_support.rs` reads the full 40/64-character checkout SHA, branch/detached state, dirty state, and active Git metadata paths. It resolves worktree Git metadata through Git itself and returns unknown values when no repository is available.
- `build.rs` watches the current branch ref, `HEAD`, index, packed refs, tracked source files, and relevant source directories. A CI supplied checkout SHA must be full length and match Git `HEAD`; stale or malformed values fail the build. Local builds without Git still compile and report unknown provenance unless a full CI SHA was supplied.
- The app's typed diagnostics now include full build/checkout SHA, branch, ref, dirty state, event, PR head/base SHA, target triple, profile, and rustc version. Values pass through the existing diagnostics sanitizer.
- Windows CI records full source SHA, checkout SHA, PR head and synthetic merge SHA separately, branch/ref, event, clean/dirty state, app version, target, build/run data, and Node/pnpm/Rust/Tauri/MSVC/Windows SDK versions.
- The Windows build step extracts the generated NSIS installer to a unique temporary folder, hashes the setup file and release EXE, and requires the packaged EXE hash and size to match the release EXE. It writes and re-verifies `velora-build-provenance.json` beside the installer, uploads both files, and prints the same hashes in the workflow summary. GitHub's artifact ZIP digest remains a separate value.
- CI whitespace checking now compares the PR base to the synthetic merge checkout, or the pushed commit range, instead of checking only the empty post-checkout working tree.
- Manifest format is specified in `docs/schemas/velora-build-provenance.schema.json`. Repeated setup builds are expected to produce separate hashes; no byte reproducibility claim is made.

## Verification status

| Check | Result | Evidence |
|---|---|---|
| Provenance Node tests | PASS | `node --test scripts/build-provenance.test.mjs`: five tests for consecutive same-branch commits, detached HEAD, worktree, no-Git behavior, PR source vs synthetic merge, artifact hash verification, tampering, and stale SHA rejection. |
| Rust Git metadata and Cargo cache tests | PASS | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib build_support::tests`: seven tests covering full SHA validation, dirty state, detached HEAD, worktree, missing Git, and a real cached Cargo rebuild after a same-branch empty commit without cleaning `target`. |
| Full Rust library suite | PASS | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`: 271 passed, 0 failed. Existing unrelated compiler warnings remain. |
| Full React/Vitest and TypeScript build | NOT RUN locally | The checkout has no `node_modules`; `pnpm` could not register the workspace because this sandbox denies creation of a pnpm-store symlink (`EPERM`). Direct Node tests ran without installing dependencies. CI on the S0b PR head must provide the full result. |
| Windows NSIS provenance manifest | NOT RUN locally | Requires the Windows CI build. The CI step now extracts, hashes, compares, writes, and re-verifies the actual setup and payload outputs. |
| S0b PR CI, React/Vitest, TypeScript build, Windows MSVC build and NSIS provenance manifest | Pending | Must run on the pushed S0b PR head; neither baseline CI nor S0a CI is evidence for this commit. |

The manifest is emitted only when a full Git checkout is available and the output files can be hashed and compared. Local builds without Git remain usable but expose `unknown` rather than a fabricated commit. For pull requests, the build binary identifies the actual synthetic merge checkout while the manifest separately records the PR head SHA and base SHA.

## Limitations and risks

- The local JavaScript app tests and TypeScript build need a dependency-equipped runner; the new built-in Node provenance tests passed independently.
- Windows CI must confirm that the runner's 7-Zip can extract the NSIS installer and that the installer contains exactly one `nexus-aurea.exe`. The step fails closed if extraction or comparison is unavailable.
- The SHA-256 values identify the exact produced files. They do not imply that a later installer rebuild has identical bytes, nor do they constitute a digital signature.
- The Actions artifact ZIP digest identifies GitHub's uploaded archive and is not the setup.exe digest.
- No release is created, no installation is performed, and no running MSI application is changed.
