# VELORA 2.0 — S2.5–S2.8 security review (engineering candidate)

Review type: **bounded source review plus automated tests**. This is not a penetration test,
a hardware acceptance, a certificate-trust validation, DRM analysis or a claim about live
Windows/iPhone behavior. Evidence labels: **SOURCE**, **AUTOMATED**, **HARDWARE NOT TESTED**.

The threat model and review obligations inherited from the Grand Living Room candidate remain
the baseline (`docs/velora-2-grand-security-review.md`, GSEC-01…GSEC-04). This document reviews
the S2.5–S2.8 additions against that baseline and records residual risk.

## 1. Remote pairing (S2.6)

### 1.1 Protections retained (SOURCE)

- HTTPS is bound to a selected private IPv4 on a fixed port. Native middleware performs exact
  Host validation plus exact Origin validation for non-GET `/api/` requests, sets `no-store`,
  `no-referrer`, `nosniff`, frame denial and a restrictive CSP, and caps request bodies at 4096
  bytes. No unauthenticated control endpoint is introduced.
- Pairing is local-initiated, 6 digits, 60-second TTL, consumed on success, with an attempt
  budget of 5 and a paired-device cap of 8. A paired device stores a non-exportable WebCrypto
  HMAC key; no token or key is persisted in the QR artifact, a log or a diagnostics export.
- Commands are a fixed allowlist authenticated with HMAC over
  `NEXUS-AUREA-REMOTE-V1\n{deviceId}\n{sequence}\n{command}`. The server authenticates under a
  cross-process lock, requires a strictly increasing sequence, reserves the sequence durably
  before the side effect and rolls the reservation back on failure. A repeated completed command
  can be acknowledged without a second execution; changed or ambiguous replays are denied.
- Revocation of an individual device and of all devices persists under the same lock. Recovery
  is local-only; a 401 invalidates the in-memory credential before storage cleanup and leaves
  the page fail-closed.

### 1.2 QR bootstrap — review decision (SOURCE + design constraint)

A QR code may carry only a short-lived, single-use pairing bootstrap (one-time code, host and
expiry). It is transported as a URL **fragment**, so the code is not sent to the server, written
to access logs or persisted in browser history. The PWA prefills it into the existing manual code
field and keeps manual entry fully functional. The code loses validity at the 60-second expiry
and on first successful use.

Rejected alternatives: embedding a device token, a CA/certificate, a long-lived code, or a query
parameter in the QR (would create a persistent or logged secret); relaxing Host/Origin checks to
make scanning easier; adding an unauthenticated `/api/pair` variant. If simplifying certificate
setup would require weakening TLS or trust verification, that change is deferred and documented
rather than applied.

### 1.3 Signed paired-state verification (SOURCE + design decision)

Verification of existing paired-device state **reuses the device's existing HMAC key** (a
signed status/hello acknowledgment carrying a server epoch, paired count and fresh nonce) instead
of introducing a new key-distribution scheme. This avoids a new trust bootstrap, cannot be forged
by an unpaired client, and keeps `/api/status` non-sensitive (booleans/counts only). The client
must re-verify after a Wi-Fi interruption and must not replay queued commands on reconnect.

**Residual risk:** connection status alone proves HTTPS reachability, not that a stored key is
still authorized; only an accepted signed command proves that. Real iPhone certificate trust,
Safari behavior and LAN/TLS conditions remain **HARDWARE NOT TESTED**.

## 2. Session ownership and controller authority (S2.5-B/C)

### 2.1 Ownership cannot become permissive (SOURCE)

- Navigation outcomes carry a typed failure kind. Ownership, authorization, scope and target
  failures are non-fallback by construction (`fallback_eligible() == false`); only bounded,
  recoverable spatial/provider failures may engage sticky pointer fallback.
- Fallback is additionally gated by re-checking authorization, session target currency and
  generation/epoch validity at the moment of activation. A remote-origin action is excluded from
  automatic fallback. A failed spatial Confirm is never replayed as a pointer Click.
- The supervisor and Home runtime preserve epoch/neutral rearm: a session or gate change forces
  neutral re-arm, stale raw-input envelopes are dropped, and queue overflow bumps an epoch. The
  session machine rejects stale revisions, expired commands, duplicate command IDs and
  superseded Home completions.

### 2.2 Diagnostics remount (SOURCE + review obligation)

Simulator/session continuity state must be bound to a session/revision token. A diagnostics panel
remount after a different session transition must not resume old queued actions or treat an older
Home completion as reusable; native generation rejection is a second line of defence, not the
only one. This is covered by the S2.5-C work and its repeated-transition tests.

**Residual risk:** Windows foreground lock / UIPI and real DualShock 4 routing are
**HARDWARE NOT TESTED**. The typed-failure refactor must not reintroduce `contains(...)`-based
classification, which previously collapsed authorization failures into generic provider errors.

## 3. Display geometry (S2.5-D)

Geometry is read-only. The display signature is now an explicit ordered serialization of the
fields that require window recovery; observational labels (adapter name, EDID ids, connection
type) no longer invalidate geometry. Physical-to-logical conversion returns `None` unless DPI
provenance is confirmed — an assumed 96 DPI is never reported as fact, and the measured 140%
API bucket versus 150% effective window DPI remain distinct. Negative desktop origins are
handled explicitly.

**Residual risk:** physical 4K pointer accuracy, HDMI reconnect and the exact Panasonic panel
identity are **HARDWARE NOT TESTED**. No display or audio system setting is changed.

## 4. Diagnostics sanitization (S2.8, AUTOMATED)

`diagnostics.rs::sanitize_text` now redacts, in addition to the prior credential/URL/path rules:
one-time pairing/bootstrap codes (`pair=`, `pairing`, `bootstrap`, `otp=`, `pin=`, `qr=`), device
identifiers, HMAC/signature/nonce material, MAC-48 addresses, Windows SIDs and account-like
emails. The browser-only preview mirrors these rules so a free-form message cannot surface a
secret in the System Intelligence panel. Rust and Vitest regressions cover each class and a
bounded-export invariant.

**Residual risk (inherited):** the sanitizer is pattern-based and explicitly **not a universal
secret detector**. The typed report remains the primary boundary; new modules must emit fixed,
non-sensitive diagnostics rather than piping arbitrary page text or authentication payloads into
public reports.

## 5. Release engineering (S2.8, SOURCE + CI)

CI preserves the reviewed installer provenance chain: exact-source SHA, internal consistency plus
CI-origin check, payload relation policy (built vs packaged EXE differs only by the reviewed
bundle-type marker), exactly one packaged application executable plus pinned plugins, a release
asset preview before publication, and a whitespace gate. The `publish-release` job runs only on
version tags and re-verifies the installer and manifest. No stable release, install or Windows
configuration change is part of this program.

## 6. Conclusion

**SOURCE REVIEW PASS for this engineering candidate**, conditional on completing the integration
review of the S2.5-A/B, S2.5-C, S2.6 and S2.7 branch merges and recording their exact automated
results. No critical/high issue was identified in the reviewed new source. The following remain
separate, unmet gates and are explicitly **not** claimed: real iPhone LAN/TLS trust, Windows
foreground/UIPI behavior, physical DualShock 4 operation, Panasonic 4K pointer accuracy, DRM and
streaming-service compatibility, installer upgrade/rollback execution.

_Integration evidence (commit SHAs, test counts, CI results) is appended in the final engineering
report and the progress checkpoint; it is intentionally not pre-filled here._
