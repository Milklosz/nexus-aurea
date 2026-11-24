# Synthetic Steam library fixtures (S3.8 Gaming Hub 4.0)

All files in this directory are **synthetic, hand-written test fixtures**. They are
not copied from any real machine, library, or Steam installation. App IDs, names,
paths and sizes are invented. Nothing here is read by production code at runtime;
Rust `cfg(test)` unit tests load them with `include_str!`/`fs::read_to_string`
(via `CARGO_MANIFEST_DIR`) and assemble them into throwaway temp directories.

- `libraryfolders-modern.vdf` — modern multi-library format with `{{ROOT}}` /
  `{{LIB2}}` placeholders, plus a disconnected ("ghost") library entry.
- `libraryfolders-legacy.vdf` — legacy `"<index>" "<path>"` format, duplicate
  entry, same placeholders.
- `appmanifest-*.acf` — valid manifests (440, 220, 500 with CRLF + padded name),
  an installed duplicate of appid 440, and malformed variants: not-installed,
  traversal `installdir`, zero appid, missing `installdir`, blank name, bad appid.

Safety: fixtures only ever validate **read-only** VDF parsing and scanning.
They never reference real game saves, DRM, registries, or Steam writes.
