//! VELORA iPhone Remote 2.0 — MODULE C reliability PRIMITIVES (PROTOTYPE).
//!
//! This module is a set of PURE, self-contained reliability primitives plus
//! their unit tests. It is NOT wired into `remote_access.rs` / the HTTPS server
//! and does NOT change the existing protocol or security code. It deliberately
//! uses ONLY `std` (no new crates, no `serde`, no Windows/tauri APIs) so the
//! `#[cfg(test)]` tests compile and run on macOS as well as Windows.
//!
//! Integration (queue / ack / idempotency / reconnect into the PWA and the
//! axum server) is a PLAN only — see docs/iphone-remote-reliability-plan.md.
//!
//! This module registers no Tauri commands and no invoke handlers.
//! `sequence_is_fresh` below is a MIRROR of the real server predicate; the real
//! one in `remote_access.rs` is left untouched.

use std::collections::VecDeque;

#[derive(Clone, Debug)]
pub struct IdempotencyEntry {
    pub command_id: String,
    pub device_id: String,
    pub sequence: u64,
    pub executed: bool,
}

/// Deterministic FNV-1a 64-bit id over `device_id` + `sequence`.
/// No cryptography, no new dependencies — a correlation id, NOT a signature.
pub fn command_id(device_id: &str, sequence: u64) -> String {
    let input = format!("{}\u{1f}{}", device_id, sequence);
    let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a 64-bit offset basis
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3); // FNV-1a 64-bit prime
    }
    format!("remote-{hash:016x}")
}

pub struct IdempotencyStore {
    entries: Vec<IdempotencyEntry>,
    capacity: usize,
}

impl IdempotencyStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Vec::new(),
            capacity,
        }
    }

    pub fn lookup(&self, device_id: &str, sequence: u64) -> Option<&IdempotencyEntry> {
        self.entries
            .iter()
            .find(|entry| entry.device_id == device_id && entry.sequence == sequence)
    }

    /// Record a command. If `(device_id, sequence)` was already seen, return a
    /// CLONE of the cached entry (the SAME `command_id` — never a second,
    /// distinct id). `executed` is monotonic: a later `true` promotes a cached
    /// `false`. Bounded FIFO eviction drops the oldest entry once over capacity.
    pub fn record(
        &mut self,
        device_id: &str,
        sequence: u64,
        executed: bool,
    ) -> IdempotencyEntry {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|e| e.device_id == device_id && e.sequence == sequence)
        {
            if executed && !entry.executed {
                entry.executed = true;
            }
            return entry.clone();
        }
        let entry = IdempotencyEntry {
            command_id: command_id(device_id, sequence),
            device_id: device_id.to_string(),
            sequence,
            executed,
        };
        self.entries.push(entry.clone());
        // capacity == 0 is treated as unbounded for prototype convenience.
        while self.capacity > 0 && self.entries.len() > self.capacity {
            self.entries.remove(0);
        }
        entry
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// MIRROR of the server's freshness predicate. The real one is unchanged.
pub fn sequence_is_fresh(last: u64, next: u64) -> bool {
    next > last
}

pub struct ReconnectPolicy {
    pub base_ms: u64,
    pub max_ms: u64,
    pub max_attempts: u32,
}

impl ReconnectPolicy {
    pub fn new(base_ms: u64, max_ms: u64, max_attempts: u32) -> Self {
        Self {
            base_ms,
            max_ms,
            max_attempts,
        }
    }

    pub fn should_retry(&self, attempt: u32) -> bool {
        attempt < self.max_attempts
    }

    /// Exponential backoff with DETERMINISTIC jitter derived from `attempt`
    /// (no RNG). Jitter is a fraction of the current backoff, so the returned
    /// delay is monotonically non-decreasing until it is capped at `max_ms`.
    /// Returns 0 once `attempt >= max_attempts`.
    pub fn next_delay_ms(&self, attempt: u32) -> u64 {
        if !self.should_retry(attempt) {
            return 0;
        }
        let shift = attempt.min(30);
        let backoff = self.base_ms.saturating_mul(1u64 << shift);
        let jitter = if backoff == 0 {
            0
        } else {
            let seed = u64::from(attempt)
                .wrapping_mul(0x9e3779b97f4a7c15)
                .wrapping_add(0xbf58476d1ce4e5b9);
            seed % backoff
        };
        backoff.saturating_add(jitter).min(self.max_ms)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteSessionState {
    Disconnected,
    Pairing,
    Paired,
    Reconnecting,
    Offline,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteEvent {
    Connected,
    Paired,
    Disconnected,
    WifiLost,
    WifiRestored,
    Timeout,
    ReplayRejected,
    Fatal,
}

/// Pure session state machine. Wi-Fi loss always suspends command capability;
/// only a verified `Connected` / `Paired` signal from `Pairing`/`Reconnecting`
/// reaches `Paired`. Commands are NEVER auto-replayed on reconnect.
pub fn transition(state: &RemoteSessionState, event: RemoteEvent) -> RemoteSessionState {
    use RemoteEvent as E;
    use RemoteSessionState as S;
    match event {
        E::Fatal | E::ReplayRejected => S::Error,
        E::WifiLost => S::Offline,
        E::WifiRestored => S::Reconnecting,
        E::Disconnected => S::Disconnected,
        E::Connected => match state {
            S::Disconnected => S::Pairing,
            S::Pairing | S::Reconnecting | S::Paired => S::Paired,
            S::Offline | S::Error => S::Reconnecting,
        },
        // `Paired` models a verified signed-hello (see safePairingReset in TS).
        E::Paired => S::Paired,
        E::Timeout => match state {
            S::Reconnecting => S::Reconnecting,
            S::Pairing => S::Disconnected,
            other => *other,
        },
    }
}

pub fn allows_commands(state: &RemoteSessionState) -> bool {
    *state == RemoteSessionState::Paired
}

/// Classify a sequence relative to `last`: "replay" (would be rejected), "ok"
/// (expected next value), "gap" (fresh but sequences were skipped). `None` is
/// reserved for an indeterminate future case; the current monotonic rules
/// always produce `Some`.
pub fn classify_sequence_error(observed: u64, last: u64) -> Option<&'static str> {
    if observed <= last {
        Some("replay")
    } else if observed == last.saturating_add(1) {
        Some("ok")
    } else {
        Some("gap")
    }
}

const MAX_COMMAND_RECEIPTS: usize = 256;

/// A successful command execution receipt. It contains only the command name
/// and correlation data — never a signature, token or request body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandReceipt {
    pub command_id: String,
    pub device_id: String,
    pub sequence: u64,
    pub command: String,
}

/// Bounded, in-memory receipt log used by the HTTPS server. It is deliberately
/// not persisted: after a restart the monotonic `last_sequence` still rejects
/// every old request, so a missing receipt can only cause a replay rejection,
/// never a second side effect.
pub struct CommandReceiptLog {
    entries: VecDeque<CommandReceipt>,
    capacity: usize,
}

impl CommandReceiptLog {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            capacity,
        }
    }

    pub fn lookup(&self, device_id: &str, sequence: u64) -> Option<&CommandReceipt> {
        self.entries
            .iter()
            .find(|entry| entry.device_id == device_id && entry.sequence == sequence)
    }

    /// Records a successful execution. A repeated (device, sequence) never
    /// overwrites the original command; the caller compares it explicitly.
    pub fn record(&mut self, device_id: &str, sequence: u64, command: &str) -> CommandReceipt {
        if let Some(existing) = self
            .entries
            .iter()
            .find(|entry| entry.device_id == device_id && entry.sequence == sequence)
        {
            return existing.clone();
        }
        let receipt = CommandReceipt {
            command_id: command_id(device_id, sequence),
            device_id: device_id.to_string(),
            sequence,
            command: command.to_string(),
        };
        self.entries.push_back(receipt.clone());
        let limit = if self.capacity == 0 {
            MAX_COMMAND_RECEIPTS
        } else {
            self.capacity
        };
        while self.entries.len() > limit {
            self.entries.pop_front();
        }
        receipt
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Default for CommandReceiptLog {
    fn default() -> Self {
        Self::new(MAX_COMMAND_RECEIPTS)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayDecision {
    /// Fresh sequence: the caller may execute the command once.
    Execute,
    /// Exact duplicate of an already executed command: acknowledge without a
    /// second side effect.
    AcknowledgeReplay,
    /// Older sequence, or the same sequence for a different command: reject.
    RejectReplay,
}

/// The single decision function used by the HTTPS server. It never turns a
/// different command into an idempotent success.
pub fn classify_replay(
    last_sequence: u64,
    receipt: Option<&CommandReceipt>,
    observed_sequence: u64,
    observed_command: &str,
) -> ReplayDecision {
    if observed_sequence > last_sequence {
        return ReplayDecision::Execute;
    }
    match receipt {
        Some(receipt)
            if receipt.sequence == observed_sequence && receipt.command == observed_command =>
        {
            ReplayDecision::AcknowledgeReplay
        }
        _ => ReplayDecision::RejectReplay,
    }
}

const MAX_PENDING_ACKS: usize = 128;

pub struct AckCorrelator {
    pending: Vec<(String, u64)>,
}

impl AckCorrelator {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Register a pending command. Returns false for a duplicate id or when the
    /// bounded correlator is full.
    pub fn register(&mut self, command_id: &str, now_ms: u64) -> bool {
        if self.pending.iter().any(|(id, _)| id == command_id) {
            return false;
        }
        if self.pending.len() >= MAX_PENDING_ACKS {
            return false;
        }
        self.pending.push((command_id.to_string(), now_ms));
        true
    }

    pub fn complete(&mut self, command_id: &str) -> bool {
        match self.pending.iter().position(|(id, _)| id == command_id) {
            Some(index) => {
                self.pending.remove(index);
                true
            }
            None => false,
        }
    }

    pub fn is_pending(&self, command_id: &str) -> bool {
        self.pending.iter().any(|(id, _)| id == command_id)
    }

    /// True only while still pending and the elapsed time reached the timeout.
    pub fn timed_out(&self, command_id: &str, now_ms: u64, timeout_ms: u64) -> bool {
        match self.pending.iter().find(|(id, _)| id == command_id) {
            Some((_, registered_ms)) => now_ms.saturating_sub(*registered_ms) >= timeout_ms,
            None => false,
        }
    }
}

impl Default for AckCorrelator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotent_replay_returns_cached_command_id_without_a_second_id() {
        let mut store = IdempotencyStore::new(8);
        let first = store.record("device-a", 7, true);
        assert!(first.executed);
        assert_eq!(first.device_id, "device-a");
        assert_eq!(first.sequence, 7);
        let replay = store.record("device-a", 7, true);
        assert_eq!(
            replay.command_id, first.command_id,
            "no second distinct command_id"
        );
        assert!(replay.executed, "replay reports the cached executed result");
        assert_eq!(store.len(), 1, "duplicate must NOT create a second entry");
        assert_eq!(
            store.lookup("device-a", 7).map(|e| e.command_id.as_str()),
            Some(first.command_id.as_str())
        );
    }

    #[test]
    fn idempotent_record_promotes_executed_monotonically() {
        let mut store = IdempotencyStore::new(4);
        let first = store.record("d", 1, false);
        assert!(!first.executed);
        let replay = store.record("d", 1, true);
        assert_eq!(replay.command_id, first.command_id);
        assert!(replay.executed, "later true promotes cached false");
        let again = store.record("d", 1, false);
        assert!(again.executed, "executed is never demoted");
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn different_sequence_gets_a_new_id() {
        let mut store = IdempotencyStore::new(8);
        let a = store.record("device-a", 7, true);
        let b = store.record("device-a", 8, true);
        assert_ne!(a.command_id, b.command_id);
        assert_eq!(store.len(), 2);
        assert!(store.lookup("device-a", 8).is_some());
        assert!(store.lookup("device-a", 9).is_none());
    }

    #[test]
    fn command_id_is_deterministic() {
        assert_eq!(command_id("dev", 1), command_id("dev", 1));
        assert_ne!(command_id("dev", 1), command_id("dev", 2));
        assert_ne!(command_id("dev", 1), command_id("other", 1));
    }

    #[test]
    fn bounded_eviction_drops_oldest() {
        let mut store = IdempotencyStore::new(2);
        store.record("device-a", 1, true);
        store.record("device-a", 2, true);
        store.record("device-a", 3, true);
        assert_eq!(store.len(), 2);
        assert!(store.lookup("device-a", 1).is_none(), "oldest dropped");
        assert!(store.lookup("device-a", 2).is_some());
        assert!(store.lookup("device-a", 3).is_some());
        assert!(!store.is_empty());
    }

    #[test]
    fn sequence_is_fresh_rejects_equal_and_lower() {
        assert!(sequence_is_fresh(2, 3));
        assert!(!sequence_is_fresh(3, 3));
        assert!(!sequence_is_fresh(4, 3));
        assert!(!sequence_is_fresh(0, 0));
    }

    #[test]
    fn backoff_is_monotonic_capped_and_zero_after_max() {
        let policy = ReconnectPolicy::new(400, 10_000, 6);
        let mut previous = 0u64;
        for attempt in 0..6 {
            let delay = policy.next_delay_ms(attempt);
            assert!(delay <= policy.max_ms, "capped at max_ms");
            assert!(delay >= previous, "monotonically non-decreasing");
            previous = delay;
        }
        assert_eq!(policy.next_delay_ms(6), 0);
        assert_eq!(policy.next_delay_ms(99), 0);
        assert!(policy.should_retry(0));
        assert!(policy.should_retry(5));
        assert!(!policy.should_retry(6));
        assert_eq!(policy.next_delay_ms(3), policy.next_delay_ms(3));
    }

    #[test]
    fn session_wifi_loss_offline_reconnecting_paired() {
        let paired = RemoteSessionState::Paired;
        let offline = transition(&paired, RemoteEvent::WifiLost);
        assert_eq!(offline, RemoteSessionState::Offline);
        assert!(!allows_commands(&offline));
        let reconnecting = transition(&offline, RemoteEvent::WifiRestored);
        assert_eq!(reconnecting, RemoteSessionState::Reconnecting);
        assert!(!allows_commands(&reconnecting));
        let paired_again = transition(&reconnecting, RemoteEvent::Connected);
        assert_eq!(paired_again, RemoteSessionState::Paired);
        assert!(allows_commands(&paired_again));
    }

    #[test]
    fn only_paired_allows_commands() {
        let states = [
            RemoteSessionState::Disconnected,
            RemoteSessionState::Pairing,
            RemoteSessionState::Paired,
            RemoteSessionState::Reconnecting,
            RemoteSessionState::Offline,
            RemoteSessionState::Error,
        ];
        for state in &states {
            assert_eq!(
                allows_commands(state),
                *state == RemoteSessionState::Paired
            );
        }
        assert_eq!(
            transition(&RemoteSessionState::Paired, RemoteEvent::Fatal),
            RemoteSessionState::Error
        );
        assert_eq!(
            transition(&RemoteSessionState::Paired, RemoteEvent::ReplayRejected),
            RemoteSessionState::Error
        );
    }

    #[test]
    fn replay_classification() {
        assert_eq!(classify_sequence_error(3, 5), Some("replay"));
        assert_eq!(classify_sequence_error(5, 5), Some("replay"));
        assert_eq!(classify_sequence_error(6, 5), Some("ok"));
        assert_eq!(classify_sequence_error(9, 5), Some("gap"));
    }

    #[test]
    fn command_receipt_log_is_bounded_and_never_overwrites_the_first_command() {
        let mut log = CommandReceiptLog::new(2);
        let first = log.record("device-a", 1, "home");
        assert_eq!(first.command, "home");
        let duplicate = log.record("device-a", 1, "volume-up");
        assert_eq!(duplicate, first, "same (device, sequence) keeps the original");
        assert_eq!(log.len(), 1);
        log.record("device-a", 2, "select");
        log.record("device-a", 3, "back");
        assert_eq!(log.len(), 2);
        assert!(log.lookup("device-a", 1).is_none(), "oldest evicted");
        assert!(log.lookup("device-a", 3).is_some());
    }

    #[test]
    fn replay_decision_acknowledges_only_the_exact_already_executed_command() {
        let mut log = CommandReceiptLog::default();
        let receipt = log.record("device-a", 7, "home");
        assert_eq!(
            classify_replay(7, Some(&receipt), 8, "home"),
            ReplayDecision::Execute,
            "fresh sequence executes exactly once"
        );
        assert_eq!(
            classify_replay(7, Some(&receipt), 7, "home"),
            ReplayDecision::AcknowledgeReplay
        );
        assert_eq!(
            classify_replay(7, Some(&receipt), 7, "volume-up"),
            ReplayDecision::RejectReplay,
            "a different command reusing a sequence is never a success"
        );
        assert_eq!(
            classify_replay(7, None, 7, "home"),
            ReplayDecision::RejectReplay,
            "no receipt means a consumed sequence cannot be re-executed"
        );
        assert_eq!(
            classify_replay(7, Some(&receipt), 6, "home"),
            ReplayDecision::RejectReplay
        );
    }

    #[test]
    fn receipt_command_id_is_deterministic_and_device_scoped() {
        let mut log = CommandReceiptLog::default();
        let first = log.record("device-a", 4, "home");
        let mut other = CommandReceiptLog::default();
        let second = other.record("device-b", 4, "home");
        assert_eq!(first.command_id, command_id("device-a", 4));
        assert_ne!(first.command_id, second.command_id);
        assert!(!first.command_id.contains("token"));
    }

    #[test]
    fn ack_register_complete_and_timeout() {
        let mut ack = AckCorrelator::new();
        assert!(ack.register("cmd-1", 1_000));
        assert!(ack.is_pending("cmd-1"));
        assert!(!ack.register("cmd-1", 1_100), "duplicate rejected");
        assert!(!ack.timed_out("cmd-1", 1_400, 1_000));
        assert!(ack.timed_out("cmd-1", 2_000, 1_000));
        assert!(ack.complete("cmd-1"));
        assert!(!ack.is_pending("cmd-1"));
        assert!(
            !ack.timed_out("cmd-1", 9_999, 1_000),
            "completed -> not timed out"
        );
        assert!(!ack.complete("cmd-1"));
    }

    #[test]
    fn ack_correlator_is_bounded() {
        let mut ack = AckCorrelator::new();
        for index in 0..MAX_PENDING_ACKS {
            assert!(ack.register(&format!("cmd-{index}"), index as u64));
        }
        assert!(!ack.register("overflow", 0), "bounded: rejects extra id");
    }
}
