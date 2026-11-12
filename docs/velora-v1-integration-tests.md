# VELORA 1.0 — Integration Test Coverage

This maps every mandatory sprint scenario to an actual executable test. Tests
that simulate Windows/launch behavior are labelled **mock**; they do not prove
hardware behavior. Physical checks belong to
[`velora-v1-msi-acceptance.md`](velora-v1-msi-acceptance.md).

| # | Scenario | Executable coverage | Type |
|---|---|---|---|
| 1 | Home → Edge → Home | `session_orchestrator::tests::cinema_session_is_owned_by_one_launch_context_and_returns_home_on_exit`; `launch_registry::tests::cinema_root_window_counts_even_for_a_descendant_only_watch`; `edge_cinema::tests::edge_watch_owns_cinema_and_detects_window_close` | mock/native logic |
| 2 | Home → Steam → Game → Home | `session_orchestrator::tests::game_launch_and_exit_do_not_regress_the_session_revision`; `launch_registry::tests::distinguishes_process_window_active_and_exit_phases`; `baseline_windows_prevent_an_existing_steam_window_from_counting_as_a_game` | mock/native logic |
| 3 | Home → Playnite → Desktop handoff → Home | `launch_registry::tests::playnite_fullscreen_to_desktop_handoff_is_not_a_session_end`; `session_orchestrator::tests::game_playnite_and_cinema_can_hand_off_without_an_intermediate_home` | mock/native logic |
| 4 | Restart VELORA during an active session | `session_store::tests::round_trips_session_state_without_secrets`; `session_orchestrator::tests::unexpected_exit_recovery_returns_home_and_preserves_correlation`; `clean_restart_from_an_external_session_reports_it_without_claiming_it` | state file/logic |
| 5 | Crash Edge during Cinema | `launch_registry::tests::cinema_window_close_ends_a_lingering_browser_process_after_grace`; `cinema_window_reappearing_during_grace_keeps_the_session` | mock |
| 6 | Sleep/wake during a game | `launch_registry::tests::resume_resets_the_exit_grace_without_ending_a_session`; `session_monitor::tests::a_multi_second_gap_reports_a_resume` | logic |
| 7 | DualSense disconnect | `gamepad_home::tests::disconnect_and_reconnect_resets_the_chord_state`; `removal_is_idempotent`; `reconnect_counter_increments_on_arrival_and_removal_history`; `tracked_devices_stay_bounded` | mock |
| 8 | `SetForegroundWindow` denial | `window_broker::tests::foreground_denial_is_classified_truthfully`; `automatic_restore_never_takes_focus_from_unrelated_apps`; `a_race_to_an_unrelated_window_is_caught_by_the_second_policy_check` | logic |
| 9 | PID reuse | `launch_registry::tests::a_recycled_root_pid_ends_the_old_session_after_grace`; `process_table::tests::process_identity_requires_both_pid_and_creation_time` | logic |
| 10 | HWND reuse | `launch_registry::tests::a_window_from_a_reused_process_instance_is_ignored` (also asserts a stale foreground HWND is not accepted) | logic |
| 11 | iPhone Remote duplicate command | `remote_reliability::tests::replay_decision_acknowledges_only_the_exact_already_executed_command`; `command_receipt_log_is_bounded_and_never_overwrites_the_first_command`; `remoteSecurityInvariants.test.ts` | logic + source guard |
| 12 | iPhone Remote timeout | `remoteSecurityInvariants.test.ts` asserts `requestTimeoutMs = 8000`, `AbortController`, `fetchWithTimeout` and no auto-retry | source guard |
| 13 | Replay request | `remote_reliability::tests::replay_decision_acknowledges_only_the_exact_already_executed_command`; `remote_access::tests::commands_are_authenticated_and_replay_protected` | logic |
| 14 | Invalid Playnite manifest | `playnite_manifest::tests::malformed_json_is_rejected`, `duplicate_game_ids_are_rejected`, `launch_uri_injection_is_rejected`, `launch_resolution_requires_an_installed_known_game_with_the_canonical_uri` | parser |
| 15 | Missing Edge | `edge_cinema::tests::missing_edge_is_reported_without_inventing_native_state` (non-Windows build); Windows missing-Edge path is **REQUIRES MSI** | partial |
| 16 | Missing Playnite | `playnite_library::tests::command_never_invents_games`; `detected_snapshot_carries_no_metadata` | logic |
| 17 | Stale autostart entry | `autostart::tests::detect_issues_reports_stale_executable_after_update`, `recovery_message_is_clean_and_never_leaks_raw_paths`, `no_hklm_winlogon_shell_or_cmd_appears_anywhere` | logic |
| 18 | Concurrent Home commands | `session_orchestrator::tests::concurrent_home_requests_reuse_only_the_same_home_revision_within_the_window` | logic |
| 19 | Older event after a newer revision | `session_orchestrator::tests::stale_revision_guard_rejects_the_transition_without_mutation`; `repeated_command_id_is_idempotent_and_returns_the_original_snapshot`; `command_id_reuse_for_a_different_target_is_rejected` | logic |
| 20 | Diagnostics without secrets | `diagnostics::tests::report_contract_never_contains_secret_material_or_raw_window_titles`; `session_store::tests::round_trips_session_state_without_secrets`; `remoteSecurityInvariants.test.ts` secret lists | logic + source guard |

## Commands

```bash
pnpm test
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo check --locked --manifest-path src-tauri/Cargo.toml
git diff --check
```

Windows CI additionally runs MSVC `cargo check`, Rust tests, React tests/build,
the NSIS x64 build and SHA-256 calculation.

## Honest limits

- No test starts a real Edge, Steam, Playnite, Steam Input or DualSense.
- No test proves DRM/HDCP, 4K, HDR, HDMI audio routing or Panasonic behavior.
- The Playnite C# exporter is not compiled anywhere; its Rust parser tests are
  not evidence that the extension runs.
- `BLOCKED` and `PARTIAL` items above are intentional and must stay visible in
  the final report.
