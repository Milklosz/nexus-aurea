# S2.2 Gaming Hub

## Implemented

GamingHub continues to use existing App Manager Steam library discovery and the existing guarded `launch_managed_game` route. New collection tabs show installed games, favorites and recently requested launches. Favorites and recent Steam app IDs persist in versioned local storage; names, paths, account details and browsing history are not stored. Ordered collections are resolved against the current installed library so a removed game never becomes a launchable stale item. The existing standalone Playnite library panel, exporter, supported manifest contract and guarded Playnite launcher are preserved.

Only valid nonzero canonical unsigned 32-bit Steam IDs are accepted. Lists are bounded to 64 saved IDs and 4,096 ingested entries. Malformed or future-version storage falls back safely. Storage errors leave the current collection usable and produce a visible warning. A recent entry means VELORA accepted a launch request; it does not claim gameplay, play duration or foreground activation. No artwork is invented or downloaded from external services. Existing local metadata/artwork support in the Playnite panel is unchanged.

## Verification

The dedicated collections tests cover schema/version rejection, corrupt and oversized input, duplicate removal, list bounds, canonical IDs, persistence, missing installed games, order and storage denial. The existing 19 GamingHub tests pass with the new controls. Steam/Playnite native launch and gameplay are NOT TESTED in this environment. Computer Use is BLOCKED by the missing app-server helper. Steam Input settings are unchanged. Physical controller acceptance is deferred.

## Limits

Game collections in this increment apply to the manifest-confirmed Steam list; Playnite keeps its existing separate library and local metadata route. No unified cross-provider game favorites or play-time ingestion is claimed. The launch receipt proves a request, not that a third-party game reached its menu. Resume of launcher sessions stays under the shared native Session Manager ownership checks.
