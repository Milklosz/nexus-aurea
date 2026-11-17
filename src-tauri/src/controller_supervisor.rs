//! Pure per-device supervisor for the optional DualShock 4 fallback Home chord.
//!
//! The candidate is deliberately conservative: hold L1 + R1 + Options for a
//! configurable interval (at least 1.5 seconds). It is disabled by default and
//! its physical mapping has not been validated on hardware. This module only
//! consumes already-parsed DS4 button state; it never reads or writes HID itself.

use crate::ds4::{Ds4Button, Ds4Buttons, SILENCE_RELEASE_MS};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const ALLOWED_HOLD_MS: [u64; 3] = [1_500, 2_000, 3_000];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ControllerFallbackGesture {
    #[default]
    Disabled,
    L1R1Options,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerFallbackConfig {
    pub(crate) enabled: bool,
    pub(crate) gesture: ControllerFallbackGesture,
    pub(crate) hold_ms: u64,
}

impl Default for ControllerFallbackConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            gesture: ControllerFallbackGesture::Disabled,
            hold_ms: 2_000,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControllerFallbackOutcome {
    #[default]
    Disabled,
    AwaitingNeutral,
    Armed,
    PartialChord,
    Holding,
    HomeGateClosed,
    SessionGateClosed,
    Triggered,
    Released,
    DeviceSilent,
    ConfigurationChanged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerFallbackStatus {
    pub(crate) enabled: bool,
    pub(crate) gesture: ControllerFallbackGesture,
    pub(crate) hold_ms: u64,
    pub(crate) physical_mapping_validated: bool,
    pub(crate) validation_note: String,
    /// Enabling the alternate gesture suppresses PS + Options for this session,
    /// so one physical report sequence cannot dispatch two Home requests.
    pub(crate) primary_chord_suppressed: bool,
    /// True when at least one connected DS4 has completed neutral rearm.
    pub(crate) armed: bool,
    pub(crate) armed_devices: usize,
    pub(crate) connected_devices: usize,
    pub(crate) streaming_suppressed_devices: usize,
    pub(crate) holding_since_ms: Option<u64>,
    pub(crate) last_triggered_at_ms: Option<u64>,
    /// Effective session setting from `set_controller_home_enabled` / Control Service.
    pub(crate) home_gate_open: bool,
    /// The orchestrator is in a non-Home session that can be returned from.
    pub(crate) session_gate_open: bool,
    pub(crate) last_outcome: ControllerFallbackOutcome,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ControllerFallbackDecision {
    pub triggered: bool,
    /// A report gap expired one or more devices; queued stream input must be
    /// invalidated before this report is routed to the bridge.
    pub streaming_reset: bool,
}

#[derive(Clone, Debug, Default)]
struct DeviceState {
    armed: bool,
    holding_since_ms: Option<u64>,
    last_report_at_ms: u64,
    has_report: bool,
    suppress_until_neutral: bool,
}

/// Deterministic Home fallback state machine. Device labels are opaque hashes
/// produced by `gamepad_home::device_label`, never raw HID paths.
#[derive(Clone, Debug, Default)]
pub(crate) struct ControllerSupervisor {
    config: ControllerFallbackConfig,
    devices: HashMap<String, DeviceState>,
    last_triggered_at_ms: Option<u64>,
    home_gate_open: bool,
    session_gate_open: bool,
    last_outcome: ControllerFallbackOutcome,
}

impl ControllerSupervisor {
    pub(crate) fn config(&self) -> ControllerFallbackConfig {
        self.config
    }

    pub(crate) fn configure(
        &mut self,
        config: ControllerFallbackConfig,
    ) -> Result<ControllerFallbackStatus, String> {
        if !ALLOWED_HOLD_MS.contains(&config.hold_ms) {
            return Err("Czas przytrzymania musi wynosić 1500, 2000 lub 3000 ms.".into());
        }
        if config.enabled != (config.gesture != ControllerFallbackGesture::Disabled) {
            return Err("Wybierz wyłączone albo włączony gest L1 + R1 + Options.".into());
        }
        if self.config != config {
            self.config = config;
            self.devices.clear();
            self.last_outcome = if self.is_enabled() {
                ControllerFallbackOutcome::ConfigurationChanged
            } else {
                ControllerFallbackOutcome::Disabled
            };
        }
        Ok(self.status())
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.config.enabled && self.config.gesture == ControllerFallbackGesture::L1R1Options
    }

    /// Returns whether the primary PS + Options chord must be suppressed.
    pub(crate) fn suppress_primary_chord(&self) -> bool {
        self.is_enabled()
    }

    /// A session transition invalidates a partially held chord. Releasing every
    /// candidate button and pressing again is required before the Home request.
    pub(crate) fn set_session_gate(&mut self, open: bool) {
        if self.session_gate_open == open {
            return;
        }
        self.session_gate_open = open;
        for state in self.devices.values_mut() {
            state.armed = false;
            state.holding_since_ms = None;
            state.suppress_until_neutral = true;
        }
        self.last_outcome = if open {
            ControllerFallbackOutcome::AwaitingNeutral
        } else {
            ControllerFallbackOutcome::SessionGateClosed
        };
    }

    /// The explicit session Home setting remains the top-level permission for
    /// every Home gesture, including the fallback. Changing it requires a fresh
    /// neutral sample so a held chord cannot activate when the gate opens.
    pub(crate) fn set_home_gate(&mut self, open: bool) {
        if self.home_gate_open == open {
            return;
        }
        self.home_gate_open = open;
        for state in self.devices.values_mut() {
            state.armed = false;
            state.holding_since_ms = None;
            state.suppress_until_neutral = true;
        }
        self.last_outcome = if open {
            ControllerFallbackOutcome::AwaitingNeutral
        } else {
            ControllerFallbackOutcome::HomeGateClosed
        };
    }

    /// An authoritative session change invalidates a chord that is still held,
    /// even when the gate value itself did not change (for example one game
    /// session handing off to another). Every pad must release and press again.
    pub(crate) fn on_session_changed(&mut self) {
        for state in self.devices.values_mut() {
            state.armed = false;
            state.holding_since_ms = None;
            state.suppress_until_neutral = true;
        }
        self.last_outcome = ControllerFallbackOutcome::AwaitingNeutral;
    }

    /// Observes a valid parsed report. Every device has its own timer and latch;
    /// two pads can never combine partial chords or release each other's latch.
    pub(crate) fn observe_report(
        &mut self,
        device: &str,
        buttons: Ds4Buttons,
        at_ms: u64,
    ) -> ControllerFallbackDecision {
        let streaming_reset = self.expire_silent(at_ms);
        if !self.is_enabled() {
            self.last_outcome = ControllerFallbackOutcome::Disabled;
            return ControllerFallbackDecision {
                triggered: false,
                streaming_reset,
            };
        }

        let l1 = buttons.is_pressed(Ds4Button::L1);
        let r1 = buttons.is_pressed(Ds4Button::R1);
        let options = buttons.is_pressed(Ds4Button::Options);
        let all_neutral = !(l1 || r1 || options);
        let all_pressed = l1 && r1 && options;

        // A fixed cap bounds memory even if malformed device lifetimes bypass
        // the normal removal/prune path.
        if !self.devices.contains_key(device) && self.devices.len() >= 4 {
            if let Some(oldest) = self
                .devices
                .iter()
                .min_by_key(|(_, state)| state.last_report_at_ms)
                .map(|(label, _)| label.clone())
            {
                self.devices.remove(&oldest);
            }
        }
        let state = self.devices.entry(device.to_owned()).or_default();
        state.last_report_at_ms = at_ms;
        state.has_report = true;

        if all_neutral {
            let released = state.holding_since_ms.take().is_some() || state.suppress_until_neutral;
            state.armed = true;
            state.suppress_until_neutral = false;
            self.last_outcome = if released {
                ControllerFallbackOutcome::Released
            } else {
                ControllerFallbackOutcome::Armed
            };
            return ControllerFallbackDecision {
                triggered: false,
                streaming_reset,
            };
        }

        state.suppress_until_neutral = true;
        if !self.home_gate_open {
            state.armed = false;
            state.holding_since_ms = None;
            self.last_outcome = ControllerFallbackOutcome::HomeGateClosed;
            return ControllerFallbackDecision {
                triggered: false,
                streaming_reset,
            };
        }
        if !state.armed {
            state.holding_since_ms = None;
            self.last_outcome = ControllerFallbackOutcome::AwaitingNeutral;
            return ControllerFallbackDecision {
                triggered: false,
                streaming_reset,
            };
        }

        if !all_pressed {
            state.holding_since_ms = None;
            self.last_outcome = ControllerFallbackOutcome::PartialChord;
            return ControllerFallbackDecision {
                triggered: false,
                streaming_reset,
            };
        }

        let holding_since = *state.holding_since_ms.get_or_insert(at_ms);
        if !self.session_gate_open {
            state.holding_since_ms = None;
            self.last_outcome = ControllerFallbackOutcome::SessionGateClosed;
            return ControllerFallbackDecision {
                triggered: false,
                streaming_reset,
            };
        }
        if at_ms.saturating_sub(holding_since) < self.config.hold_ms {
            self.last_outcome = ControllerFallbackOutcome::Holding;
            return ControllerFallbackDecision {
                triggered: false,
                streaming_reset,
            };
        }

        state.armed = false;
        state.holding_since_ms = None;
        self.last_triggered_at_ms = Some(at_ms);
        self.last_outcome = ControllerFallbackOutcome::Triggered;
        ControllerFallbackDecision {
            triggered: true,
            streaming_reset,
        }
    }

    pub(crate) fn remove_device(&mut self, device: &str) {
        self.devices.remove(device);
    }

    pub(crate) fn tick(&mut self, at_ms: u64) -> bool {
        self.expire_silent(at_ms)
    }

    /// Reconnects and silent links must release and rearm; an old held state is
    /// never allowed to accumulate hold time across a report gap.
    fn expire_silent(&mut self, at_ms: u64) -> bool {
        let mut expired = false;
        for state in self.devices.values_mut() {
            if state.has_report
                && at_ms.saturating_sub(state.last_report_at_ms) > SILENCE_RELEASE_MS
            {
                state.has_report = false;
                state.armed = false;
                state.holding_since_ms = None;
                state.suppress_until_neutral = true;
                expired = true;
            }
        }
        if expired {
            self.last_outcome = ControllerFallbackOutcome::DeviceSilent;
        }
        expired
    }

    pub(crate) fn status(&self) -> ControllerFallbackStatus {
        let enabled = self.is_enabled();
        let armed_devices = self.devices.values().filter(|state| state.armed).count();
        ControllerFallbackStatus {
            enabled,
            gesture: if enabled {
                self.config.gesture
            } else {
                ControllerFallbackGesture::Disabled
            },
            hold_ms: self.config.hold_ms,
            physical_mapping_validated: false,
            validation_note: "L1 + R1 + Options jest kandydatem i nie zostało zweryfikowane na fizycznym kontrolerze DS4.".into(),
            primary_chord_suppressed: enabled,
            armed: enabled && armed_devices > 0,
            armed_devices,
            connected_devices: self.devices.len(),
            streaming_suppressed_devices: self
                .devices
                .values()
                .filter(|state| state.suppress_until_neutral)
                .count(),
            holding_since_ms: self
                .devices
                .values()
                .filter_map(|state| state.holding_since_ms)
                .min(),
            last_triggered_at_ms: self.last_triggered_at_ms,
            home_gate_open: self.home_gate_open,
            session_gate_open: self.session_gate_open,
            last_outcome: self.last_outcome,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_configuration_matches_the_control_center_wire_contract() {
        let config: ControllerFallbackConfig = serde_json::from_value(serde_json::json!({
            "enabled": true, "gesture": "l1R1Options", "holdMs": 2000
        }))
        .unwrap();
        let mut supervisor = ControllerSupervisor::default();
        let status = serde_json::to_value(supervisor.configure(config).unwrap()).unwrap();
        assert_eq!(status["gesture"], "l1R1Options");
        assert_eq!(status["holdMs"], 2000);
        assert_eq!(status["physicalMappingValidated"], false);
        assert_eq!(status["primaryChordSuppressed"], true);
        assert!(!ControllerSupervisor::default().config().enabled);
    }

    fn enabled(hold_ms: u64) -> ControllerSupervisor {
        let mut supervisor = ControllerSupervisor::default();
        supervisor
            .configure(ControllerFallbackConfig {
                enabled: true,
                gesture: ControllerFallbackGesture::L1R1Options,
                hold_ms,
            })
            .unwrap();
        supervisor.set_home_gate(true);
        supervisor.set_session_gate(true);
        supervisor
    }

    fn buttons(l1: bool, r1: bool, options: bool) -> Ds4Buttons {
        let mut buttons = Ds4Buttons::default();
        buttons.set(Ds4Button::L1, l1);
        buttons.set(Ds4Button::R1, r1);
        buttons.set(Ds4Button::Options, options);
        buttons
    }

    #[test]
    fn disabled_by_default_and_mapping_is_reported_unvalidated() {
        let supervisor = ControllerSupervisor::default();
        let status = supervisor.status();
        assert!(!status.enabled);
        assert!(!status.primary_chord_suppressed);
        assert!(!status.physical_mapping_validated);
        assert!(status.validation_note.contains("nie zostało zweryfikowane"));
    }

    #[test]
    fn hold_is_deterministic_per_device_and_fires_once_after_threshold() {
        let mut supervisor = enabled(1_500);
        // Configuration and reconnect require a neutral sample first.
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(false, false, false), 10)
                .triggered
        );
        let first = supervisor.observe_report("pad-a", buttons(true, true, true), 20);
        assert!(!first.triggered);
        assert!(supervisor.status().primary_chord_suppressed);
        assert_eq!(supervisor.status().holding_since_ms, Some(20));
        supervisor.observe_report("pad-a", buttons(true, true, true), 700);
        supervisor.observe_report("pad-a", buttons(true, true, true), 1_400);
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 1_519)
                .triggered
        );
        let triggered = supervisor.observe_report("pad-a", buttons(true, true, true), 1_520);
        assert!(triggered.triggered);
        assert_eq!(supervisor.status().last_triggered_at_ms, Some(1_520));
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 4_000)
                .triggered
        );
        assert_eq!(
            supervisor.status().last_outcome,
            ControllerFallbackOutcome::AwaitingNeutral
        );
        // Release and neutral rearm permit one new deliberate hold.
        supervisor.observe_report("pad-a", buttons(false, false, false), 4_010);
        supervisor.observe_report("pad-a", buttons(false, false, false), 4_500);
        supervisor.observe_report("pad-a", buttons(true, true, true), 5_000);
        supervisor.observe_report("pad-a", buttons(true, true, true), 5_600);
        supervisor.observe_report("pad-a", buttons(true, true, true), 6_200);
        assert!(
            supervisor
                .observe_report("pad-a", buttons(true, true, true), 6_500)
                .triggered
        );
    }

    #[test]
    fn buttons_from_separate_devices_never_form_a_chord() {
        let mut supervisor = enabled(1_500);
        supervisor.observe_report("pad-a", buttons(false, false, false), 10);
        supervisor.observe_report("pad-b", buttons(false, false, false), 10);
        supervisor.observe_report("pad-a", buttons(true, false, false), 20);
        supervisor.observe_report("pad-b", buttons(false, true, true), 20);
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, false, false), 2_000)
                .triggered
        );
        assert!(
            !supervisor
                .observe_report("pad-b", buttons(false, true, true), 2_000)
                .triggered
        );
    }

    #[test]
    fn release_rearms_and_configuration_or_device_silence_requires_neutral() {
        let mut supervisor = enabled(1_500);
        supervisor.observe_report("pad-a", buttons(false, false, false), 1);
        supervisor.observe_report("pad-a", buttons(true, true, true), 2);
        supervisor.observe_report("pad-a", buttons(true, true, true), 700);
        supervisor.observe_report("pad-a", buttons(true, true, true), 1_400);
        assert!(
            supervisor
                .observe_report("pad-a", buttons(true, true, true), 1_502)
                .triggered
        );
        supervisor.observe_report("pad-a", buttons(true, true, true), 1_600);
        assert_eq!(supervisor.status().streaming_suppressed_devices, 1);
        supervisor.observe_report("pad-a", buttons(false, false, false), 1_601);
        assert_eq!(supervisor.status().streaming_suppressed_devices, 0);
        supervisor.observe_report("pad-a", buttons(true, true, true), 1_700);
        // More than 750 ms without a fresh report invalidates this hold.
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 2_451)
                .triggered
        );
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 3_000)
                .triggered
        );
        // Silence expires the old hold; the first held report after the gap is not armed.
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 4_000)
                .triggered
        );
        assert_eq!(
            supervisor.status().last_outcome,
            ControllerFallbackOutcome::AwaitingNeutral
        );
        supervisor.observe_report("pad-a", buttons(false, false, false), 4_010);
        supervisor.observe_report("pad-a", buttons(false, false, false), 4_500);
        supervisor.observe_report("pad-a", buttons(true, true, true), 5_000);
        supervisor.observe_report("pad-a", buttons(true, true, true), 5_600);
        supervisor.observe_report("pad-a", buttons(true, true, true), 6_200);
        assert!(
            supervisor
                .observe_report("pad-a", buttons(true, true, true), 6_500)
                .triggered
        );
    }

    #[test]
    fn closed_home_session_gate_cannot_accumulate_a_hold() {
        let mut supervisor = enabled(1_500);
        supervisor.set_session_gate(false);
        supervisor.observe_report("pad-a", buttons(false, false, false), 10);
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 20)
                .triggered
        );
        assert_eq!(
            supervisor.status().last_outcome,
            ControllerFallbackOutcome::SessionGateClosed
        );
        supervisor.set_session_gate(true);
        // An in-progress hold is invalidated across the session transition.
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 2_000)
                .triggered
        );
        assert_eq!(
            supervisor.status().last_outcome,
            ControllerFallbackOutcome::AwaitingNeutral
        );
        supervisor.observe_report("pad-a", buttons(false, false, false), 2_010);
        supervisor.observe_report("pad-a", buttons(true, true, true), 2_020);
        supervisor.observe_report("pad-a", buttons(true, true, true), 2_600);
        supervisor.observe_report("pad-a", buttons(true, true, true), 3_100);
        assert!(
            supervisor
                .observe_report("pad-a", buttons(true, true, true), 3_520)
                .triggered
        );
    }

    #[test]
    fn disabled_session_home_gate_blocks_configured_fallback() {
        let mut supervisor = enabled(1_500);
        supervisor.set_home_gate(false);
        supervisor.observe_report("pad-a", buttons(false, false, false), 10);
        let first = supervisor.observe_report("pad-a", buttons(true, true, true), 20);
        assert!(!first.triggered);
        assert_eq!(supervisor.status().streaming_suppressed_devices, 1);
        assert_eq!(
            supervisor.status().last_outcome,
            ControllerFallbackOutcome::HomeGateClosed
        );
        supervisor.set_home_gate(true);
        // Gate reopening while still held must not complete the old hold.
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 2_000)
                .triggered
        );
        supervisor.observe_report("pad-a", buttons(false, false, false), 2_010);
        supervisor.observe_report("pad-a", buttons(true, true, true), 2_020);
        supervisor.observe_report("pad-a", buttons(true, true, true), 2_600);
        supervisor.observe_report("pad-a", buttons(true, true, true), 3_100);
        assert!(
            supervisor
                .observe_report("pad-a", buttons(true, true, true), 3_520)
                .triggered
        );
    }

    #[test]
    fn reopening_session_or_home_gate_while_chord_held_requires_neutral_rearm() {
        let mut supervisor = enabled(1_500);
        supervisor.observe_report("pad-a", buttons(false, false, false), 1);
        supervisor.observe_report("pad-a", buttons(true, true, true), 20);
        supervisor.observe_report("pad-a", buttons(true, true, true), 700);
        supervisor.observe_report("pad-a", buttons(true, true, true), 1_400);
        assert!(supervisor.observe_report("pad-a", buttons(true, true, true), 1_520).triggered);

        // A session transition closes and reopens the gate while the physical
        // chord is still held. The old hold must not complete.
        supervisor.set_session_gate(false);
        supervisor.set_session_gate(true);
        for at in [1_600, 2_300, 3_000, 3_700] {
            assert!(
                !supervisor
                    .observe_report("pad-a", buttons(true, true, true), at)
                    .triggered,
                "held chord retriggered after session gate reopened at {at}"
            );
        }
        assert_eq!(
            supervisor.status().last_outcome,
            ControllerFallbackOutcome::AwaitingNeutral
        );

        // Release + neutral rearm permits one new deliberate hold.
        supervisor.observe_report("pad-a", buttons(false, false, false), 3_800);
        supervisor.observe_report("pad-a", buttons(true, true, true), 3_900);
        supervisor.observe_report("pad-a", buttons(true, true, true), 4_600);
        supervisor.observe_report("pad-a", buttons(true, true, true), 5_300);
        assert!(supervisor.observe_report("pad-a", buttons(true, true, true), 5_400).triggered);

        // The explicit Home gate follows the same rule.
        supervisor.observe_report("pad-a", buttons(false, false, false), 5_500);
        supervisor.observe_report("pad-a", buttons(true, true, true), 5_600);
        supervisor.set_home_gate(false);
        supervisor.set_home_gate(true);
        for at in [5_700, 6_400, 7_100, 7_800] {
            assert!(
                !supervisor
                    .observe_report("pad-a", buttons(true, true, true), at)
                    .triggered,
                "held chord retriggered after home gate reopened at {at}"
            );
        }
        assert_eq!(
            supervisor.status().last_outcome,
            ControllerFallbackOutcome::AwaitingNeutral
        );
        supervisor.observe_report("pad-a", buttons(false, false, false), 7_900);
        supervisor.observe_report("pad-a", buttons(true, true, true), 8_000);
        supervisor.observe_report("pad-a", buttons(true, true, true), 8_700);
        supervisor.observe_report("pad-a", buttons(true, true, true), 9_400);
        assert!(supervisor.observe_report("pad-a", buttons(true, true, true), 9_500).triggered);
    }

    #[test]
    fn authoritative_session_change_requires_neutral_rearm_even_without_a_gate_flip() {
        let mut supervisor = enabled(1_500);
        supervisor.observe_report("pad-a", buttons(false, false, false), 1);
        supervisor.observe_report("pad-a", buttons(true, true, true), 20);
        supervisor.observe_report("pad-a", buttons(true, true, true), 700);
        supervisor.observe_report("pad-a", buttons(true, true, true), 1_400);
        assert!(supervisor.observe_report("pad-a", buttons(true, true, true), 1_520).triggered);

        // One external session handing off to another keeps the gate open, but
        // the authoritative session revision changed: the chord is disarmed.
        supervisor.on_session_changed();
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 1_600)
                .triggered
        );
        assert_eq!(
            supervisor.status().last_outcome,
            ControllerFallbackOutcome::AwaitingNeutral
        );
        supervisor.observe_report("pad-a", buttons(false, false, false), 1_700);
        supervisor.observe_report("pad-a", buttons(true, true, true), 1_800);
        supervisor.observe_report("pad-a", buttons(true, true, true), 2_500);
        supervisor.observe_report("pad-a", buttons(true, true, true), 3_000);
        assert!(supervisor.observe_report("pad-a", buttons(true, true, true), 3_320).triggered);
    }

    #[test]
    fn disable_and_invalid_configuration_are_safe() {
        let mut supervisor = enabled(1_500);
        let invalid_hold = ControllerFallbackConfig {
            hold_ms: 249,
            ..supervisor.config()
        };
        assert!(supervisor.configure(invalid_hold).is_err());
        let invalid_gesture = ControllerFallbackConfig {
            enabled: false,
            gesture: ControllerFallbackGesture::L1R1Options,
            hold_ms: 1_500,
        };
        assert!(supervisor.configure(invalid_gesture).is_err());
        let status = supervisor
            .configure(ControllerFallbackConfig::default())
            .unwrap();
        assert!(!status.enabled && !status.primary_chord_suppressed);
        assert!(
            !supervisor
                .observe_report("pad-a", buttons(true, true, true), 10_000)
                .triggered
        );
    }
}
