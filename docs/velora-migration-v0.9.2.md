# VELORA v0.9.2 data and installer migration

## Identity retained for compatibility

- Product, window and installer name: **VELORA by Milklosh Studio**.
- Tauri identifier remains `pl.nexus.aurea`, matching the current stable profile at `%LOCALAPPDATA%\pl.nexus.aurea`.
- The existing per-user install folder `%LOCALAPPDATA%\NEXUS AUREA` is reused when its `nexus-aurea.exe` is present. A fresh installation uses the VELORA product folder.
- Windows Credential Manager service name and the iPhone Remote protocol identifiers remain unchanged so previously stored remote credentials are not orphaned by the visual rebrand.
- The legacy Test profile at `%LOCALAPPDATA%\NEXUS-AUREA-Test` is preserved separately and is never copied over the stable WebView profile.

## Data handling

No application profile is renamed, merged, or deleted by the installer. The VELORA stable build continues using the existing stable data directory in place. Test data remains separate. A pre-install backup is still required before replacing the program files.

## Rollback

1. Close VELORA.
2. Restore the saved 0.4.0 program files, uninstall registry entry and shortcuts to their original locations.
3. Leave the active stable user-data profile in place for the first rollback launch, so data created during the pilot remains available.
4. If the old app cannot use that profile, close it and first copy the current profile to a dated recovery folder. Then restore the pre-install profile from the verified backup and compare it with the manifest before launching.

The installer hook only redirects an existing stable installation to its current program path and retires the old stable Add/Remove Programs entry and shortcut after the new files are installed. It does not touch either user-data profile.
