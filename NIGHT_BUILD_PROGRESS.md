# VELORA Night Build Progress

Updated: 2026-11-11

## Current status

- Draft PR: [#13](https://github.com/Milklosz/nexus-aurea/pull/13), targeting feat/aurea-v0.9.1-secure-iphone-remote. It remains Draft and unmerged; no release has been published.
- Stage 46 adds an on-demand read-only Gaming Hub diagnostic for Playnite, GOG Galaxy, Cyberpunk 2077 files in common GOG locations, GOG process state, and available space on fixed volumes. Checks are limited to known paths; they do not read account ownership, sign in, install, launch, or recursively scan disks.
- Stage 46 results: 26 React test files, 153 tests passed; TypeScript/Vite production build passed; Windows and macOS Rust/Tauri CI passed. The Windows NSIS installer was built as a test artifact and was not run or installed.
- MSI hardware status remains unverified. No physical controller, GOG account, or Cyberpunk launch test has been performed.
- Playnite Fullscreen handoff uses the documented --startfullscreen argument. The Gaming Hub gives the official Playnite download page when Playnite is not found.
- VELORA reads and launches only Steam games verified through local installation manifests. Playnite is the integration path for GOG, Epic, EA App, Ubisoft Connect, Battle.net, and Xbox/PC Game Pass; login, client, and game requirements depend on each integration.
- Cyberpunk 2077 can be launched through Playnite after the GOG library is connected and the game is installed and ready. VELORA does not determine account ownership or trigger a download.

## Current Windows artifacts

- Latest PR-validation artifact: [Actions run 43100659083](https://github.com/Milklosz/nexus-aurea/actions/runs/43100659083), artifact 13892175434. GitHub built it from temporary PR merge revision 7c54700281b19f68cbcbdd648efa3b1ab9e0efcf, using branch head 2f4674b8de6325b628d84e0c618874060e6ece59. Installer SHA-256: 36c82268f030b8e19793d63ab0087d567cbd8bc1e4788400f9438191583f51cf. ZIP digest: sha256:919d8fdd61c0ba8dc68f06da21c2a9b3548db21c96e7e06198f23dc43d4b4b67.
- Branch-head artifact: [Actions run 43100647291](https://github.com/Milklosz/nexus-aurea/actions/runs/43100647291), artifact 13890444719, built from exact branch commit 2f4674b8de6325b628d84e0c618874060e6ece59. Installer SHA-256: 5e3eb0f4db057eb7fd80e739a0673db962c2dfb5c33e8ce418817af83d0d1637. ZIP digest: sha256:a7b79c614140afa793b7a5204647e128bad64c3138024aeea43475444576b5a8.
- Windows CI records the installer SHA-256 and checked-out commit in the Actions summary. Both Stage 46 push and PR runs passed on Windows and macOS; release jobs were skipped.

## Implementation history

- Stage 46 diagnostic commit: local 92b6a8e35fac82be7c8ddb741519fe7ca5368ac2; published 289d25cf51554edde817ab18fc2c9682d6cee7d2.
- Stage 46 CI checksum commit: local 5c0af358f4087cc53763ce9fa2530c510b683cd4; published 2f4674b8de6325b628d84e0c618874060e6ece59.
- Stage 45 Playnite implementation: local c8c663ae8c3bfbad1fc2ded0ccaa84546660172e; published 24772b6d9609eae643a7a8ded44a4e203e08d98c. Cinema styling local commit: c081af4.
- Stage 44 implementation: local ae5407b358b48b472794b7d748ca17537e1575e0; published 06df0985ee56f81d22466e7269a8ddad82a0d24d. Stage 44 progress checkpoint: local 8b06a458114a0a72d45379effa375ae71ec642f7; published f67a568cc16552d6742c43853e02615e6aa9aa20.
- Stage 43 implementation: local 93b4df4514541eae9fe8c408c794e7a1543c90c3; published c2f512ae9eef4e9a23630d11659bd19753008e36.
- Stage 42 implementation: local 30adaca9d57b38defc1516db1652dd4ee59e2e26; published 213d4d287b6e9df1dba158ebe473506d6a321b90.
- Stage 41 implementation: local e88fbe0f5b86d6d51eb9fb92386e43e68ac9a118; published 137be5c68d6f5ee4d8d5aa2db5296716774ff2f7.
- Stage 40 implementation: local 62181463ba53fb0ec1a747316fa5c47bcae67283; published dcbbe9ac1fea1b6b591646f66eea5b561c9f3e0a.
- Stage 39 implementation: local acb32fafd7b9fb7cc79d96ad8aea865edb6b7a2f; published e839f37c736f3fb5798911bd5da212cf8e77e34c.
- Stage 36 implementation: local 8d4cf0a89a58e18894a099f2828696fe98b9ca2b; published 9cf4d4d9bf662a27558b071a8b68400917f364da.
- Stage 35 progress checkpoint: local c9dd9be49be86d514e5d9cb0fb536d520a84a8f4; published d56a7ee6778849c65b706af7afa9afb91af723ee.
- Stage 36 progress checkpoint: local ed92f8d0f227e24b08639fa95200a433c3aeb465; published 2fc1bb7150697e3bc773912bf285712c8cdf4044.
- Stage 37 progress checkpoint: local 8fe4493ec4cff2b03beef61bbfd1786bc369bd0c; published e818274c3656cfac14edce63ae725ebe27fb0b15.
- Stage 38 progress checkpoint: local 9671d25e62e3eab5745e71615f16a241eee2a100; published c344baa2f8d99e39f270a21d040b960430144c68.
- Stage 39 progress checkpoint: local 51518334249dd27f622072b83305d1b2d41d6131; published c730b400911260ec5ceaec986a023454f2b8895e.
- Earlier implementation commits: local b42757ad27530e2a5937ba46ac4faddbdbeecd6e published e0337167448b6c0ac70d31d3c5873e141a8dd0f8; local 3d9c78533126fa679a2f3828b35d3e27b77c94bd published 91ddcbf4804c7cd5a7454a5976e4b91a7dc7f5a7; local e4f4efe3466de7c3cc12bc86a0196afd5c61e08a published 91646dc0f9ec30fb05c0871167855a7c572ede5e.
- Stage 24: local 3ca7b50b565bda5197d45aefb9f1f1230a9b5db3; published a1f8de1176117bfe2da24c0a661c665b02109e50.
- Stage 23: local fdadd1e1e26effcd9cbfaff570f4f3d90eb89e62; published c345a500339e4096e16427b9f0280b69781d4dff.
- Stage 21: local b3cd86440621d33d2251eac8d508d3872c0ec066; published 611acc37d31db2a8c47c279db782fcadc962133f.
- Stage 20: local 0f196da0076e9d89d9a39b1a9ab56d9200eb905f; published a2bd3208ec114b94a4bbed8d212bb8f5bf4d92f3.
- Earlier local commit references: Stage 19 de31db486e07a1f9ba56216dd20481d5dd2b0ebe; Stage 18 4f876cc19540e802dbb8c40cd85cdb7d8602563f; Stage 17 329fcfc499a0a952baa115072798f3564d307b12; Stage 16 adf81a6893538385330365233986d30bb4748a0a; Stage 15 2445c8dfd7ea8c84128ef75b27383f9808658f26; Stage 14 689ab0dff82ea0cc6712da4999e55121f67e8812; Stage 13 119db2a7138f4c6cad2912ce8e3ed0944532366a; Stage 08 8390a6555aa573063ff2d92bd0f9c6077082abc2.
- Verified PR base commit: 6dbcc36abeded18b753a134bc8ede10fb37df391.

## Technical work completed

- Preserved Control Center, dock, HBO Max, TV navigation, and Steam Big Picture functionality.
- Added per-service duplicate-launch protection with accessible busy feedback, safer website-opening guidance, and clear Windows app-launch errors.
- Gamepad polling pauses while VELORA is unfocused or input is suspended, and resets held/repeat state before resuming.
- Control Service diagnostics classify the foreground process as VELORA, Steam, external, or unknown. Steam remains advisory; VELORA does not claim controller ownership. Non-VELORA or unknown foreground states suspend local gamepad polling while Control Service is active.
- iPhone Remote fails closed if IndexedDB cannot read the secure device-key record; pairing and commands stay disabled until status can be read. Control Center hides remote actions when status is unknown and offers a focused retry.
- iPhone Remote refreshes read-only server and pairing status when the PWA becomes visible. Offline transitions invalidate pending status and command responses; commands are not retried automatically.
- iPhone Remote Home closes open panels, unminimizes VELORA, then requests focus. Focus refusal is reported with an Alt+Tab fallback.
- Controller and keyboard navigation in dialogs includes enabled form controls, skips disabled or hidden controls, and preserves native text editing. Backspace remains available for editing text and navigates back elsewhere.
- Focus returns to the selected dock item when Control Center closes. Modal handoffs preserve focus, and visible focus/pressed states are clearer.
- Gaming Hub reports pending and failed Steam, Playnite, and game launches accurately. It preserves the library view and focused retry controls during refresh failures.
- Control Service announces pending action results, exposes busy state, invalidates stale pending reads on emergency stop, and reports listener-registration failures.
- Playnite fullscreen startup, existing-instance mode handoff, exit monitoring, VELORA focus restoration, official download guidance, and GOG/Cyberpunk setup instructions are implemented.
- The on-demand gaming diagnostic checks known install locations and available bytes on fixed volumes. It does not read accounts, install software, launch games, or recursively scan disks.

## Historical artifact source commits

These commit IDs were encoded in the removed local Windows artifact filenames:

- Baseline: 92d942a17173f8af3e244995d9c409df94716897.
- Stage 17: 3be7517542ad6b164d3001cc4a4aa4063ab1bc4b.
- Stage 19: fbbc0e52343fffd9c68369bc6dc3dfe969df187f.
- Stage 22: 5ce71d8295d007940e8144a62cd69e28d4f4518f.
- Stage 34: a0092854aa4ac3fe83f5d08d7a887833fda8b831.
- Stage 35: 9a297d011bcc8c8e5a5b467522f752bfa2654588.
- Stage 36: 55fc68b18e41c4bb8cb6c3a20c417e5240919e04.
- Stage 37: 2cdb52ce704e1990e6ef7dd05722ca9b7dc35965.
- Stage 38: c2b978910cea590fba5fb8f956d28cb08596c5e5.
- Stage 39: 1aa9df9b8f7249c867700aae382fcd1b671858bc.
## Test results

- Stage 32: 137 React tests; Stage 33: 138; Stage 34: 139; Stage 35: 140; Stage 36: 141; Stage 37: 142; Stage 38: 143; Stage 39: 144; Stage 40: 145; Stage 41: 145; Stage 42: 146; Stage 43: 147; Stage 44: 148; Stage 45: 152; Stage 46: 153.
- Stage 36 through Stage 46 TypeScript/Vite production builds passed.
- Stage 46 Rust unit tests, Windows MSVC check, Windows NSIS build, and macOS Rust/Tauri check passed. Stage 46 release jobs were skipped.
- Stage 44 regression coverage proves a late secure iPhone Remote status read cannot overwrite a newer listener event.
- Local Cargo is unavailable; Rust verification is performed by CI.

## GitHub Actions history

- Baseline and Stage 09–19 successful runs: [43026294733](https://github.com/Milklosz/nexus-aurea/actions/runs/43026294733), [43029135952](https://github.com/Milklosz/nexus-aurea/actions/runs/43029135952), [43029773813](https://github.com/Milklosz/nexus-aurea/actions/runs/43029773813), [43030395848](https://github.com/Milklosz/nexus-aurea/actions/runs/43030395848), [43031259001](https://github.com/Milklosz/nexus-aurea/actions/runs/43031259001), [43032589406](https://github.com/Milklosz/nexus-aurea/actions/runs/43032589406), [43033436829](https://github.com/Milklosz/nexus-aurea/actions/runs/43033436829), [43035329173](https://github.com/Milklosz/nexus-aurea/actions/runs/43035329173), [43036042119](https://github.com/Milklosz/nexus-aurea/actions/runs/43036042119), [43036705267](https://github.com/Milklosz/nexus-aurea/actions/runs/43036705267), [43039325451](https://github.com/Milklosz/nexus-aurea/actions/runs/43039325451), [43040038281](https://github.com/Milklosz/nexus-aurea/actions/runs/43040038281).
- Stages 20–24: [43043218481](https://github.com/Milklosz/nexus-aurea/actions/runs/43043218481), [43043740999](https://github.com/Milklosz/nexus-aurea/actions/runs/43043740999), [43045040872](https://github.com/Milklosz/nexus-aurea/actions/runs/43045040872), [43047036322](https://github.com/Milklosz/nexus-aurea/actions/runs/43047036322), [43047629891](https://github.com/Milklosz/nexus-aurea/actions/runs/43047629891), [43048341666](https://github.com/Milklosz/nexus-aurea/actions/runs/43048341666).
- Stages 25–34: [43051579122](https://github.com/Milklosz/nexus-aurea/actions/runs/43051579122), [43051591281](https://github.com/Milklosz/nexus-aurea/actions/runs/43051591281), [43053309991](https://github.com/Milklosz/nexus-aurea/actions/runs/43053309991), [43053322359](https://github.com/Milklosz/nexus-aurea/actions/runs/43053322359), [43053998764](https://github.com/Milklosz/nexus-aurea/actions/runs/43053998764), [43054012947](https://github.com/Milklosz/nexus-aurea/actions/runs/43054012947), [43054826843](https://github.com/Milklosz/nexus-aurea/actions/runs/43054826843), [43054839359](https://github.com/Milklosz/nexus-aurea/actions/runs/43054839359), [43055634481](https://github.com/Milklosz/nexus-aurea/actions/runs/43055634481), [43055651446](https://github.com/Milklosz/nexus-aurea/actions/runs/43055651446), [43057181243](https://github.com/Milklosz/nexus-aurea/actions/runs/43057181243), [43057193890](https://github.com/Milklosz/nexus-aurea/actions/runs/43057193890), [43059538714](https://github.com/Milklosz/nexus-aurea/actions/runs/43059538714), [43059553007](https://github.com/Milklosz/nexus-aurea/actions/runs/43059553007), [43061131133](https://github.com/Milklosz/nexus-aurea/actions/runs/43061131133), [43061141004](https://github.com/Milklosz/nexus-aurea/actions/runs/43061141004), [43063611269](https://github.com/Milklosz/nexus-aurea/actions/runs/43063611269), [43063620136](https://github.com/Milklosz/nexus-aurea/actions/runs/43063620136).
- Stages 35–44: [43066207610](https://github.com/Milklosz/nexus-aurea/actions/runs/43066207610), [43066219552](https://github.com/Milklosz/nexus-aurea/actions/runs/43066219552), [43066446793](https://github.com/Milklosz/nexus-aurea/actions/runs/43066446793), [43069783881](https://github.com/Milklosz/nexus-aurea/actions/runs/43069783881), [43070000362](https://github.com/Milklosz/nexus-aurea/actions/runs/43070000362), [43072191134](https://github.com/Milklosz/nexus-aurea/actions/runs/43072191134), [43073689068](https://github.com/Milklosz/nexus-aurea/actions/runs/43073689068), [43075438533](https://github.com/Milklosz/nexus-aurea/actions/runs/43075438533), [43078222464](https://github.com/Milklosz/nexus-aurea/actions/runs/43078222464), [43080053138](https://github.com/Milklosz/nexus-aurea/actions/runs/43080053138), [43082100781](https://github.com/Milklosz/nexus-aurea/actions/runs/43082100781), [43083595112](https://github.com/Milklosz/nexus-aurea/actions/runs/43083595112), [43085464052](https://github.com/Milklosz/nexus-aurea/actions/runs/43085464052), [43085965713](https://github.com/Milklosz/nexus-aurea/actions/runs/43085965713), [43088196298](https://github.com/Milklosz/nexus-aurea/actions/runs/43088196298).
- Stage 45: [43097826595](https://github.com/Milklosz/nexus-aurea/actions/runs/43097826595), [43097832382](https://github.com/Milklosz/nexus-aurea/actions/runs/43097832382).
- Stage 46 code and checksum reporting: [43099686644](https://github.com/Milklosz/nexus-aurea/actions/runs/43099686644), [43099698964](https://github.com/Milklosz/nexus-aurea/actions/runs/43099698964), [43100647291](https://github.com/Milklosz/nexus-aurea/actions/runs/43100647291), [43100659083](https://github.com/Milklosz/nexus-aurea/actions/runs/43100659083).

## Historical Windows artifact checksums

- Stage 44, run 43085464052, artifact 13887105964. ZIP digest sha256:a18472336db29ac56188c6ff452fc373c4ba8446c966c8c44e612e226de4ed83; installer SHA-256 d03a8e768e3d9e39e862981a08f79e33897af48b8b0a7a7fcc1e30c63b97ee35; Authenticode NotSigned.
- Stage 43, run 43083595112, artifact 13885362786. ZIP digest sha256:54d0bb4ad5018a7733ae123302f09ba53cf7ddf470d1a55ffe533d6c0a8aa30f; installer SHA-256 a685ee90ac0cf21d6f20fd94d379a5ad058a533f2ae0d216bc61a4759025b622; Authenticode NotSigned.
- Stage 42, run 43082100781, artifact 13884697892. ZIP digest sha256:37d87ac50217a0838f3c5f400b1e45d2ea20cb284dfb44ac723e2bceab1837cd; installer SHA-256 57e4737fb5ad026ecea34c423900f57d67e379efd671f682ce2ba6b681899e8a; Authenticode NotSigned.
- Stage 41, run 43080053138, artifact 13883428811. ZIP digest sha256:49f011d570981a53b3a26721d607b46fc8b937d2f7e805cd8b1866a3248790eb; installer SHA-256 e9e63ce0468b2ae04b64a2ef3b0496793ff635b2705ec0a6a7a4a6e5fdf575e6; Authenticode NotSigned.
- Stage 40, run 43078222464, artifact 13883033253. ZIP digest sha256:1b0a7ef6f31e377c42633e52440e5ba60d9f29a67aa7d078b8e2f9ec8fd8966e; installer SHA-256 0ede340bad14eaa95d9af9e43d147ec9176d6f7c9e6bd182729a59b4d66bd1da; Authenticode NotSigned.
- Stage 39, run 43075438533, artifact 13879879196. ZIP digest sha256:847b6923c2f030a971241b90330785297653a39d6fde94a0ecd127d96cf9665d; installer SHA-256 0b087d5edf3b4c653ea3e7876e20b85ba12c4ba407fc9a2bfac722b24a8884ef; Authenticode NotSigned.
- Stage 38, run 43073689068, artifact 13880197018. ZIP digest sha256:f7b24bce3bba1fc656a25b8d6e04b76c5642b9c4b76c0f2a8faf2df11f952684; installer SHA-256 a6269cf0152460f7b471ce2037e7e948cf0776826544e166271f7799154576de; Authenticode NotSigned.
- Stage 37, run 43072191134, artifact 13878987663. ZIP digest sha256:7420e2c568e11490893b13bc2d9dba46d167c44c3867e905025076ee74c45fd9; installer SHA-256 15372bca3ecdfc39e5d033ba16298501f50b00734a38968ea22289c0ec43d786; Authenticode NotSigned.
- Stage 36, run 43069783881, artifact 13878076320. ZIP digest sha256:01e9bc3a7f15db58e71f161c236924dde35666e068353408da347a500e3691cb; installer SHA-256 1d520a17b6fd3403076f0e1e087a44fb8ecca6c6e869bd2993862c8a3def3a54; Authenticode NotSigned.
- Stage 35, run 43066207610, artifact 13874844404. ZIP digest sha256:f8056cb63fa3b85bfce7f9e16e4e2f9deecce3301059618636ce8f175fa419e9; installer SHA-256 13f2430a5800a805e5ba5e7b097ff7de861946ee883696fcfcf780d6049f9d7; Authenticode NotSigned.
- Stage 34, run 43063611269, artifact 13874273614. ZIP digest sha256:ff14d0a7ea0fb3f3dd728199a5c485ecc0491a7a1fd7be6fe488d51fb019e217; installer SHA-256 a3ad2aeba5dc4729d6e403b0577152084800464e4a686a7ec1e3d2cee8ee510d; Authenticode NotSigned.
- Stage 22, run 43045040872. ZIP SHA-256 4c4029a24370116f33d057baec6ff765c3ce599dc657f6b5ef835dd63a1024e8; installer SHA-256 6ca72f8eb0dbdefa94a4bd118510207986821d9c1c3d6779c89f9234690eb166; Authenticode NotSigned.
- Stage 19, run 43040038281. ZIP SHA-256 f3dedafd2cb510cc7886be8598cd8776677cfe6684c56a40ddfba183b170bb13; installer SHA-256 983a2fb40e56761c8be8145dfb8a260cf531301bed95707166324d76cb5629b8; Authenticode NotSigned.
- Stage 17, run 43036705267. ZIP SHA-256 18aa95b26daced7ef3027a533c29bc3c999fcf44566a13397ef4f39974b709fa; installer SHA-256 3c55c84b75b69c30c7285e67dd55a898041681fd1f3dcc7db28b6e05c52b5f8c; Authenticode NotSigned.
- Baseline, run 43026294733. ZIP SHA-256 ff512ee2a362516a3a067d9655597643b62346e106a3837fe9002b9af01a9eb9; installer SHA-256 eab9905c006b3beef847a0e063e8dafd336b0b2a07386ae48181eac917a108ac; Authenticode NotSigned.
- Earlier Stage 34 artifact ZIP digest and installer SHA are preserved above; superseded artifacts were not run or installed.

## Remaining validation

1. Run the Stage 46 diagnostic on the MSI and confirm Playnite, GOG Galaxy, Cyberpunk files, and available disk space against the actual setup.
2. Configure the Playnite GOG integration manually, verify account ownership and installation status, then test a user-initiated Cyberpunk launch.
3. Test PlayStation controller navigation, accept/back input, focus, reconnect behavior, Playnite Fullscreen handoff, and return to VELORA on the MSI.
4. Test Steam, Epic, EA App, and other configured Playnite integrations with their actual launchers and account states.
5. Keep PR #13 Draft until hardware validation and review are complete; do not merge or release as part of this checkpoint.
