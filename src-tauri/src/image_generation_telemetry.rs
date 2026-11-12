//! Content-free image timings. Stage values accumulate work across parallel images;
//! `total` is wall-clock time and must not be computed by summing stage values.
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum Stage {
    Credentials,
    Arguments,
    Preparation,
    HttpRequest,
    ResponseBody,
    ResponseParse,
    ImageDecode,
    ImageDownload,
    ImageSave,
    ResourceRegistration,
    ImageView,
}

impl Stage {
    fn key(self) -> &'static str {
        match self {
            Self::Credentials => "credentials",
            Self::Arguments => "arguments",
            Self::Preparation => "preparation",
            Self::HttpRequest => "httpRequest",
            Self::ResponseBody => "responseBody",
            Self::ResponseParse => "responseParse",
            Self::ImageDecode => "imageDecode",
            Self::ImageDownload => "imageDownload",
            Self::ImageSave => "imageSave",
            Self::ResourceRegistration => "resourceRegistration",
            Self::ImageView => "imageView",
        }
    }
}

#[derive(Clone)]
pub(crate) struct ImageTimings {
    request_id: u64,
    started: Instant,
    stages: Arc<Mutex<BTreeMap<Stage, u64>>>,
}

impl ImageTimings {
    pub(crate) fn new() -> Self {
        Self {
            request_id: NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed),
            started: Instant::now(),
            stages: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub(crate) fn stage(&self, stage: Stage) -> StageTimer {
        StageTimer {
            timings: self.clone(),
            stage,
            started: Instant::now(),
            succeeded: false,
        }
    }

    fn record(&self, stage: Stage, elapsed_ms: u64, succeeded: bool) {
        if let Ok(mut stages) = self.stages.lock() {
            let value = stages.entry(stage).or_default();
            *value = value.saturating_add(elapsed_ms);
        }
        self.trace(
            stage.key(),
            elapsed_ms,
            if succeeded {
                "ok"
            } else {
                "failed_or_cancelled"
            },
        );
    }

    // Only generated identifiers, fixed stage/status labels and numbers are logged.
    // In particular, never log prompts, URLs, paths, credentials or response bodies.
    fn trace(&self, stage: &str, elapsed_ms: u64, status: &str) {
        let _ = writeln!(
            std::io::stderr().lock(),
            "[gaoge-image] timing request_id={} stage={} status={} elapsed_ms={}",
            self.request_id,
            stage,
            status,
            elapsed_ms
        );
    }

    pub(crate) fn snapshot(&self) -> Value {
        let mut values = Map::new();
        if let Ok(stages) = self.stages.lock() {
            for (stage, elapsed_ms) in stages.iter() {
                values.insert(stage.key().to_string(), Value::from(*elapsed_ms));
            }
        }
        values.insert("total".to_string(), Value::from(self.elapsed_ms()));
        Value::Object(values)
    }

    pub(crate) fn finish(&self, succeeded: bool) {
        self.trace(
            "total",
            self.elapsed_ms(),
            if succeeded { "ok" } else { "failed" },
        );
    }

    fn elapsed_ms(&self) -> u64 {
        millis(self.started)
    }
}

fn millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

pub(crate) struct StageTimer {
    timings: ImageTimings,
    stage: Stage,
    started: Instant,
    succeeded: bool,
}

impl StageTimer {
    pub(crate) fn finish(mut self, succeeded: bool) {
        self.succeeded = succeeded;
    }
}

impl Drop for StageTimer {
    fn drop(&mut self) {
        self.timings
            .record(self.stage, millis(self.started), self.succeeded);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_values_are_numeric_and_parallel_work_accumulates() {
        let timings = ImageTimings::new();
        let other_image = timings.clone();
        timings.record(Stage::HttpRequest, 12, true);
        other_image.record(Stage::HttpRequest, 7, true);
        timings.record(Stage::ResponseBody, 3, true);
        let values = timings.snapshot();
        assert_eq!(values["httpRequest"], 19);
        assert_eq!(values["responseBody"], 3);
        assert!(values.as_object().unwrap().values().all(Value::is_u64));
        assert!(values["total"].is_u64());
    }

    #[test]
    fn early_error_still_records_the_active_stage() {
        let timings = ImageTimings::new();
        let attempt = || -> Result<(), ()> {
            let _timer = timings.stage(Stage::ResponseParse);
            Err(())?;
            Ok(())
        };
        assert!(attempt().is_err());
        assert!(timings.snapshot()["responseParse"].is_u64());
    }

    #[test]
    fn independent_requests_do_not_share_stage_values() {
        let first = ImageTimings::new();
        let second = ImageTimings::new();
        first.record(Stage::ImageSave, 5, true);
        assert!(second.snapshot().get("imageSave").is_none());
        assert_ne!(first.request_id, second.request_id);
    }
}
