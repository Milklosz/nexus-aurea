# VELORA S0b — Build provenance

## Scope and baseline

This change is based on the audited candidate `36312486cebb5b523c24cf0754f4a317ad87f042`. At that SHA, `src-tauri/build.rs` ran `git rev-parse --short=12 HEAD` and watched only `../.git/HEAD`. A new commit on the same branch could leave a cached build identified by an old short SHA, and a worktree's `.git` is a file rather than the directory this watcher assumed. The candidate document also cited a different short-lived SHA than the verified PR head, demonstrating that its source record had drifted.

## Implementation

- `src-tauri/src/build_support.rs` reads the full 40/64-character checkout SHA, branch/detached state, dirty state, and active Git metadata paths. It resolves worktree Git metadata through Git itself and returns unknown values when no repository is available.
- `build.rs` watches the current branch ref, `HEAD`, index, packed refs, tracked source files, and relevant source directories. A CI supplied checkout SHA must be full length and match Git `HEAD`; stale or malformed values fail the build. Local builds without Git still compile and report unknown provenance unless a full CI SHA was supplied.
- The app's typed diagnostics now include full build/checkout SHA, branch, ref, dirty state, event, PR head/base SHA, target triple, profile, and rustc version. Values pass through the existing diagnostics sanitizer.
- Windows CI records full source SHA, checkout SHA, PR head and synthetic merge SHA separately, branch/ref, event, clean/dirty state, app version, target, build/run data, and Node/pnpm/Rust/Tauri/MSVC/Windows SDK versions.
- The Windows build step extracts the generated NSIS installer to a unique temporary folder and hashes the setup file, the release EXE, and the actual packaged EXE as three separate outputs. It does not assume that Tauri/NSIS leaves the EXE bytes unchanged; the manifest binds each hash and size to its own file and the verifier checks each record independently. It writes and re-verifies `velora-build-provenance.json` beside the installer, uploads both files, and prints each hash in the workflow summary. GitHub's artifact ZIP digest remains a separate value.
- CI whitespace checking now compares the PR base to the synthetic merge checkout, or the pushed commit range, instead of checking only the empty post-checkout working tree.
- Manifest format is specified in `docs/schemas/velora-build-provenance.schema.json`. Repeated setup builds are expected to produce separate hashes; no byte reproducibility claim is made.

## Verification status

| Check | Result | Evidence |
|---|---|---|
| Provenance Node tests | PASS | `node --test scripts/build-provenance-node-check.mjs`: five tests for consecutive same-branch commits, detached HEAD, worktree, no-Git behavior, PR source vs synthetic merge, independently hashed built/packaged EXEs, tampering, and stale SHA rejection. The file name avoids Vitest's default test discovery; it is invoked explicitly by the package script. |
| Rust Git metadata and Cargo cache tests | PASS | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib build_support::tests`: seven tests covering full SHA validation, dirty state, detached HEAD, worktree, missing Git, and a real cached Cargo rebuild after a same-branch empty commit without cleaning `target`. |
| Full Rust library suite | PASS | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`: 271 passed, 0 failed. Existing unrelated compiler warnings remain. |
| Full React/Vitest and TypeScript build | NOT RUN locally / PASS in CI | The checkout has no `node_modules`; `pnpm` could not register the workspace because this sandbox denies creation of a pnpm-store symlink (`EPERM`). Direct Node tests ran without installing dependencies. Full JS/Vitest and TypeScript checks passed in [PR run #43472898200](https://github.com/Milklosz/nexus-aurea/actions/runs/43472898200). |
| Windows NSIS provenance manifest | NOT RUN locally / PASS in CI | [PR run #43472898200](https://github.com/Milklosz/nexus-aurea/actions/runs/43472898200) extracted the installer, wrote and re-verified hashes for the setup, build EXE and packaged payload EXE, then uploaded the installer and manifest. |
| S0b PR CI, React/Vitest, TypeScript build, Windows MSVC build and NSIS provenance manifest | PASS | [PR run #43472898200](https://github.com/Milklosz/nexus-aurea/actions/runs/43472898200) on implementation commit `07185b16534dd51b7de1f614eb9395c8e8cb3b10`; Windows and macOS jobs passed. The Windows job extracted the NSIS payload, verified the manifest against the installer/build EXE/packaged EXE, and uploaded the installer plus manifest artifact. |

The manifest is emitted only when a full Git checkout is available and the output files can be hashed and compared. Local builds without Git remain usable but expose `unknown` rather than a fabricated commit. For pull requests, the build binary identifies the actual synthetic merge checkout while the manifest separately records the PR head SHA and base SHA.

## Limitations and risks

- The local JavaScript app tests and TypeScript build need a dependency-equipped runner; the new built-in Node provenance tests passed independently.
- Windows CI passed extraction and verified there was exactly one `nexus-aurea.exe` in the NSIS installer. Future builds still fail closed if extraction or any manifest-to-file check is unavailable.
- The SHA-256 values identify the exact produced files. They do not imply that a later installer rebuild has identical bytes, nor do they constitute a digital signature.
- The Actions artifact ZIP digest identifies GitHub's uploaded archive and is not the setup.exe digest.
- No release is created, no installation is performed, and no running MSI application is changed.
