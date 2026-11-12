# iPhone Remote — independent certificate & trust-risk audit (v0.9.2)

**Status: AUDIT + PLAN ONLY.** No protocol or security code was changed. This is
an independent, factual assessment based on a read-only review of
`src-tauri/src/remote_access.rs`, `public/remote/app.js`, `public/remote/sw.js`,
`public/remote/index.html`, `src/services/remoteAccess.ts`,
`docs/iphone-remote-v0.9.2.md`, `docs/remote-security-v0.9*.md`,
`docs/ipc-contract.md` and `src/contracts/*`. macOS environment; no MSI build
and no physical-iPhone testing was performed here.

## Trust architecture as built (factual)

- **Runtime-generated self-signed CA in Windows Credential Manager.**
  `prepare_trust_profile` creates a `VELORA LAN Remote CA` certificate and its
  private key and persists both via `save_vault` to a `keyring::Entry`
  (service `com.nexus.aurea.remote`, account `encrypted-state-v1`).
- **One plaintext JSON blob.** `Vault` holds `ca_cert_pem`, `ca_key_pem` and
  `devices[]` (each with `token` + `last_sequence`). `save_vault` writes
  `serde_json::to_string(vault)` through `set_password`. The account name
  `encrypted-state-v1` is **misleading**: it is only an account label, not a
  statement about the value. The **CA private key is co-located with every
  device HMAC token** in a single readable string.
- **`.mobileconfig` with `com.apple.security.root` + manual "full trust".**
  The user installs the profile and then, separately, enables full trust under
  iOS *Certificate Trust Settings*. This grants device-wide trust, not a
  per-site or per-origin exception.
- **CA scope.** `IsCa::Ca(BasicConstraints::Constrained(0))` sets `pathLen=0`
  (no subordinate CAs), with `KeyCertSign`/`CrlSign` key usages. There are
  **no name constraints and no EKU restriction on the CA**, so leaf names are
  effectively unconstrained.
- **90-day leaf regenerated per start with an IP-only SAN.** `start()` rebuilds
  the leaf each launch (`not_after = now + 90 days`), with a single
  `SanType::IpAddress(private IPv4)`, CN `VELORA LAN Remote`, `ServerAuth` EKU.
  Bind/origin are tied to one private IPv4 discovered at startup.
- **`caFingerprint` is display-only.** It is the SHA-256 of the CA DER, shown
  in Control Center for **humans**; the PWA never fetches or compares it.
  **There is no programmatic pinning.**
- **No CRL / OCSP / rotation / revocation of the trust anchor.**
  `revoke_device` / `revoke_all` remove device tokens only; the CA and the
  installed profile persist for the CA's 5-year lifetime. `trust_confirmed`
  is an **unverifiable UI checkbox** — `start()` trusts a boolean.
- **Compensating controls (genuinely present).** Exact `Host` + `Origin`
  (`is_allowed_request`), restrictive CSP, `DefaultBodyLimit::max(MAX_REQUEST_BYTES)`
  = 4096 bytes, `credentials: "omit"`, `cache: "no-store"`,
  `referrer-policy: no-referrer`, `x-frame-options: DENY`, HMAC-SHA256 over the
  `NEXUS-AUREA-REMOTE-V1` payload with a monotonic `sequence`, pairing/command
  rate limits, private-IPv4-only bind, and a non-exportable WebCrypto key in
  IndexedDB. These reduce the attack surface but do **not** shrink the
  trust-anchor blast radius.

## Risks — severity, concrete attack, and why a code-only fix is provisional

### R1 — Co-located CA key + all device tokens in one plaintext blob (High)
- **Attack.** Any actor who can read that Credential Manager entry (a local
  process, an OS account with access, a memory/backup/log copy of the blob)
  obtains the CA signing key **and** every device HMAC token at once. With the
  key they can mint TLS certificates for *any* name the device-wide root trusts;
  with the tokens they can forge signed commands. There is no per-secret
  isolation and no separation of duties.
- **Why a code-only fix is provisional.** Encrypting or splitting the blob in
  `save_vault` is a small edit, but (a) the CA key is consumed by
  `prepare_trust_profile` and `start()` from the same `Vault`, and (b) the
  iPhone still trusts the **already-installed** old CA. You cannot rotate the
  trust anchor from app code — it requires a **new profile + user reinstall +
  manual full-trust re-toggle + removal guidance**. A blob-only change leaves
  the old device-wide trust intact and creates false assurance.

### R2 — Device-wide root with unconstrained SANs; `pathLen=0` only (High)
- **Attack.** Because full trust applies to **all TLS on the iPhone** and the CA
  has no name constraints / EKU scoping, any leaf signed by this CA (or by
  anyone who steals its key) is accepted device-wide — for banking, mail, any
  host — not just the LAN IP. `pathLen=0` only forbids intermediate CAs; it does
  not restrict names or usage. A rogue MSI process or a leaked key yields a
  universal intercept capability.
- **Why a code-only fix is provisional.** Adding name constraints / an EKU in
  `rcgen` is a one-file change, but constraints are enforced only for
  **newly issued** certs and **newly installed** roots. The phone's existing
  profile keeps trusting the old unconstrained CA until the user removes and
  reinstalls it — a UX + distribution + infra change.

### R3 — Per-start 90-day leaf with IP-only SAN (Medium)
- **Impact/attack.** The origin Safari trusts is bound to one private IPv4.
  DHCP reassignment, VPN route changes, or clock skew break the SAN / validity
  match, so Safari refuses (and users are tempted to bypass the warning). A LAN
  actor able to influence DHCP can force repeated failures.
- **Why a code-only fix is provisional.** A stable hostname needs a
  name + DNS/mDNS resolution story and a matching Host/Origin allowlist —
  infrastructure. Widening the SAN or regenerating more often in code would
  relax the exact-Host control without a trust bootstrap; that is a workaround,
  not a fix.

### R4 — No programmatic pinning; `caFingerprint` is human-only (High)
- **Attack.** An attacker who gets **any** CA the iPhone already trusts (or who
  steals the VELORA CA key) to issue a leaf for the LAN IP can transparently
  intercept the PWA, harvest the HMAC token and inject commands. Since JS never
  compares the fingerprint, a substituted CA/profile is invisible to the app.
- **Why a code-only fix is provisional.** Real pinning means SPKI / public-key
  pinning delivered **out-of-band** and verified in the PWA against
  `caFingerprint`. That needs a new served file/resource, a Service Worker
  `CACHE_NAME` bump, a new route in the axum router, and a
  `remotePwa.test.ts` update — not a one-line JS edit, and it must not break the
  offline shell or the exact-origin check.

### R5 — No CRL/OCSP/rotation; revoke only clears tokens (Medium–High)
- **Attack.** After revocation the CA and device-wide profile remain trusted;
  there is no rotation or revocation channel, so a stolen CA key stays trusted
  for the full 5-year CA lifetime. Concretely: after a laptop theft, the thief
  keeps a trusted root on the iPhone until the user manually removes it.
- **Why a code-only fix is provisional.** Rotation/revocation requires a new
  trust profile, a revocation affordance in Control Center, and profile-removal
  guidance — UX + infra. Deleting the key in code does not remove iOS trust.

### R6 — Unverifiable `trust_confirmed`; optimistic pairing gap (Medium)
- **Attack.** `start()` trusts a boolean; nothing verifies the iPhone actually
  installed the correct profile. A stale `paired` IndexedDB record is trusted on
  the next load without a fresh signed hello; a user can tick the box without
  installing anything (Safari still fails closed, but the state misleads).
- **Why a code-only fix is provisional.** Fixing it needs a signed-hello
  handshake at the protocol level plus a pairing re-verification step in
  Control Center — protocol + UX, not a checkbox rename.

## Compensating controls (do not remove these)
Exact Host+Origin, CSP, body limit, `credentials: "omit"`, `cache: "no-store"`,
`no-referrer`, HMAC + monotonic sequence, rate limits, private-IPv4 bind,
non-exportable WebCrypto key. They are necessary and are **unchanged** by this
audit; they do not, however, reduce the device-wide trust-anchor blast radius.

## Why a safe fix REQUIRES UX + infrastructure change
A trust anchor on iOS lives in *Settings → General → VPN & Device Management*
and *Certificate Trust Settings*. It is changed only by installing/removing
configuration profiles and toggling full trust — operations no in-app code can
perform. Every code-only fix (encrypt the blob, add name constraints, compare a
fingerprint) leaves an **already-installed, device-wide root** trusted on the
phone. Therefore a genuine fix needs coordinated: new profile generation and
out-of-band distribution, explicit manual user steps, a served pin/rotation
resource, a Service Worker update, and profile-removal guidance. Applying only a
partial code change would be a **provisional workaround** that looks like
"HMAC/replay/cert validation is done" while the core risk remains. We
explicitly do **not** apply one.

## PLAN (NOT implemented)
1. **Scope the CA** with name constraints / EKU, or move to mutual TLS with
   per-device client certificates (removes reliance on a device-wide root).
2. **SPKI / public-key pinning** delivered out-of-band and verified in the PWA
   against `caFingerprint` — needs a new served file, a Service Worker
   `CACHE_NAME` bump, and a `remotePwa.test.ts` update.
3. **CA rotation + a revocation command + profile-removal guidance** in
   Control Center.
4. **Encrypt the vault blob / split the CA key from device tokens** (separate
   keyring entries or OS-protected storage, distinct access paths).
5. **Pairing re-verification with a signed hello** before trusting `paired`
   after any reconnect/restart.

## Tests to add before / with the fix
- `remotePwa.test.ts`: assert the pin resource is fetched and compared to
  `caFingerprint`; bump `CACHE_NAME`; add the required `node:vm` sandbox globals
  for new code paths; keep the offline-shell assertions green.
- New Rust tests in `remote_access.rs` for the name-constrained CA / EKU in
  `prepare_trust_profile`, dual-CA rotation overlap, and the revocation command.
- A contract test that `trust_confirmed` is backed by a verified signed hello.
- The security regression guard `src/__tests__/remoteSecurityInvariants.test.ts`
  must keep passing: HMAC / replay / certificate-validation literals unchanged.
- Windows + physical-iPhone validation is **manual**; macOS CI cannot exercise
  Credential Manager or iOS profile installation, and no MSI build was run.

## Scope statement
**NO provisional workaround applied.** HMAC-SHA256, monotonic-sequence replay
protection, and certificate validation (`RustlsConfig::from_pem`,
`trust_confirmed`, `prepare_trust_profile`) are **unchanged**. Not tested on an
MSI or a physical iPhone (macOS environment only). **No final release
announcement.**
