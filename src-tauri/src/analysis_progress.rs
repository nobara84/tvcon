//! Credential-free, throttled source-analysis telemetry.
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
pub struct AnalysisProgress {
    pub phase: &'static str,
    pub processed_bytes: u64,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub analyzed_entries: u64,
    pub category_count: usize,
    pub percentage: Option<f64>,
}

pub type ProgressCallback = Box<dyn Fn(AnalysisProgress) + Send + Sync>;

pub struct Reporter {
    callback: Option<ProgressCallback>,
    last_emit: Option<Instant>,
}
impl Reporter {
    pub fn new(callback: Option<ProgressCallback>) -> Self {
        Self {
            callback,
            last_emit: None,
        }
    }
    pub fn update(
        &mut self,
        phase: &'static str,
        processed_bytes: u64,
        received_bytes: u64,
        total_bytes: Option<u64>,
        analyzed_entries: u64,
        category_count: usize,
        force: bool,
    ) {
        let Some(callback) = &self.callback else {
            return;
        };
        if !force
            && self
                .last_emit
                .is_some_and(|last| last.elapsed() < Duration::from_millis(250))
        {
            return;
        }
        let bytes = if phase == "DOWNLOADING" {
            received_bytes
        } else {
            processed_bytes
        };
        let percentage = total_bytes.map(|total| {
            if total == 0 {
                if phase == "COMPLETE" { 100.0 } else { 0.0 }
            } else {
                (bytes as f64 / total as f64 * 100.0).min(100.0)
            }
        });
        callback(AnalysisProgress {
            phase,
            processed_bytes,
            received_bytes,
            total_bytes,
            analyzed_entries,
            category_count,
            percentage,
        });
        self.last_emit = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    #[test]
    fn throttles_updates_but_always_emits_completion() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let mut reporter = Reporter::new(Some(Box::new(move |event| {
            sink.lock().unwrap().push(event)
        })));
        reporter.update("ANALYZING", 0, 0, Some(100), 0, 0, true);
        for bytes in 1..100 {
            reporter.update("ANALYZING", bytes, bytes, Some(100), bytes, 1, false);
        }
        reporter.update("COMPLETE", 100, 100, Some(100), 100, 1, true);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].percentage, Some(100.0));
    }
    #[test]
    fn unknown_size_is_indeterminate_and_download_percentage_uses_received_bytes() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let mut reporter = Reporter::new(Some(Box::new(move |event| {
            sink.lock().unwrap().push(event)
        })));
        reporter.update("DOWNLOADING", 40, 50, None, 3, 2, true);
        reporter.update("DOWNLOADING", 40, 50, Some(100), 3, 2, true);
        let events = events.lock().unwrap();
        assert_eq!(events[0].percentage, None);
        assert_eq!(events[1].percentage, Some(50.0));
        let json = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 7);
    }
}
