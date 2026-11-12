//! Small bounded operation registry for timeout and cancellation diagnostics.
//!
//! Session transitions themselves are short and synchronous. The registry
//! exists for the operations around them (currently returning home, which asks
//! WindowBroker for focus) so the UI and MSI diagnostics can distinguish
//! "cancelled" from "Windows refused focus" and "operation exceeded deadline".

use serde::{Deserialize, Serialize};

pub(crate) const MAX_RETAINED_OPERATIONS: usize = 32;
pub(crate) const RETURN_HOME_TIMEOUT_MS: u64 = 3_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationKind {
    ReturnHome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationStatus {
    Pending,
    Completed,
    Cancelled,
    TimedOut,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOperation {
    pub id: String,
    pub kind: OperationKind,
    pub status: OperationStatus,
    pub started_at_ms: u64,
    pub deadline_at_ms: u64,
    pub finished_at_ms: Option<u64>,
}

#[derive(Default)]
pub(crate) struct OperationRegistry {
    next_id: u64,
    operations: Vec<SessionOperation>,
}

impl OperationRegistry {
    pub(crate) fn begin(
        &mut self,
        kind: OperationKind,
        at_ms: u64,
        timeout_ms: u64,
    ) -> SessionOperation {
        self.next_id = self.next_id.saturating_add(1);
        let operation = SessionOperation {
            id: format!("op-{at_ms}-{}", self.next_id),
            kind,
            status: OperationStatus::Pending,
            started_at_ms: at_ms,
            deadline_at_ms: at_ms.saturating_add(timeout_ms),
            finished_at_ms: None,
        };
        self.operations.push(operation.clone());
        while self.operations.len() > MAX_RETAINED_OPERATIONS {
            if let Some(index) = self
                .operations
                .iter()
                .position(|entry| entry.status != OperationStatus::Pending)
            {
                self.operations.remove(index);
            } else {
                break;
            }
        }
        operation
    }

    pub(crate) fn cancel(&mut self, id: &str, at_ms: u64) -> Option<SessionOperation> {
        let operation = self
            .operations
            .iter_mut()
            .find(|entry| entry.id == id && entry.status == OperationStatus::Pending)?;
        operation.status = OperationStatus::Cancelled;
        operation.finished_at_ms = Some(at_ms);
        Some(operation.clone())
    }

    pub(crate) fn is_cancelled(&self, id: &str) -> bool {
        self.operations
            .iter()
            .any(|entry| entry.id == id && entry.status == OperationStatus::Cancelled)
    }

    pub(crate) fn finish(
        &mut self,
        id: &str,
        at_ms: u64,
        timed_out: bool,
    ) -> Option<SessionOperation> {
        let operation = self
            .operations
            .iter_mut()
            .find(|entry| entry.id == id && entry.status == OperationStatus::Pending)?;
        operation.status = if timed_out {
            OperationStatus::TimedOut
        } else {
            OperationStatus::Completed
        };
        operation.finished_at_ms = Some(at_ms);
        Some(operation.clone())
    }

    pub(crate) fn expire(&mut self, at_ms: u64) -> usize {
        let mut expired = 0;
        for operation in &mut self.operations {
            if operation.status == OperationStatus::Pending && at_ms > operation.deadline_at_ms {
                operation.status = OperationStatus::TimedOut;
                operation.finished_at_ms = Some(at_ms);
                expired += 1;
            }
        }
        expired
    }

    pub(crate) fn snapshot(&self) -> Vec<SessionOperation> {
        self.operations.clone()
    }

    #[cfg(test)]
    pub(crate) fn pending_count(&self) -> usize {
        self.operations
            .iter()
            .filter(|entry| entry.status == OperationStatus::Pending)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::{OperationKind, OperationRegistry, OperationStatus, MAX_RETAINED_OPERATIONS};

    #[test]
    fn begin_cancel_and_finish_are_explicit_and_idempotent() {
        let mut registry = OperationRegistry::default();
        let operation = registry.begin(OperationKind::ReturnHome, 100, 500);
        assert_eq!(operation.status, OperationStatus::Pending);
        assert_eq!(operation.deadline_at_ms, 600);
        assert_eq!(registry.pending_count(), 1);
        let cancelled = registry.cancel(&operation.id, 150).unwrap();
        assert_eq!(cancelled.status, OperationStatus::Cancelled);
        assert!(registry.is_cancelled(&operation.id));
        assert!(registry.cancel(&operation.id, 160).is_none());
        assert!(registry.finish(&operation.id, 170, false).is_none());
        assert_eq!(registry.pending_count(), 0);
    }

    #[test]
    fn finish_marks_timeout_truthfully() {
        let mut registry = OperationRegistry::default();
        let operation = registry.begin(OperationKind::ReturnHome, 0, 100);
        let finished = registry.finish(&operation.id, 150, true).unwrap();
        assert_eq!(finished.status, OperationStatus::TimedOut);
        assert_eq!(finished.finished_at_ms, Some(150));
    }

    #[test]
    fn expire_never_touches_completed_operations() {
        let mut registry = OperationRegistry::default();
        let completed = registry.begin(OperationKind::ReturnHome, 0, 100);
        registry.finish(&completed.id, 50, false);
        let pending = registry.begin(OperationKind::ReturnHome, 10, 100);
        assert_eq!(registry.expire(120), 1);
        let snapshot = registry.snapshot();
        assert!(snapshot
            .iter()
            .any(|entry| entry.id == pending.id && entry.status == OperationStatus::TimedOut));
        assert!(snapshot
            .iter()
            .any(|entry| entry.id == completed.id && entry.status == OperationStatus::Completed));
    }

    #[test]
    fn retained_history_is_bounded() {
        let mut registry = OperationRegistry::default();
        for index in 0..(MAX_RETAINED_OPERATIONS * 3) {
            let operation = registry.begin(OperationKind::ReturnHome, index as u64, 10);
            registry.finish(&operation.id, index as u64 + 1, false);
        }
        assert!(registry.snapshot().len() <= MAX_RETAINED_OPERATIONS);
        assert_eq!(registry.pending_count(), 0);
    }

    #[test]
    fn operation_ids_are_unique_even_with_the_same_timestamp() {
        let mut registry = OperationRegistry::default();
        let first = registry.begin(OperationKind::ReturnHome, 5, 10);
        let second = registry.begin(OperationKind::ReturnHome, 5, 10);
        assert_ne!(first.id, second.id);
    }
}
