//! Inspect a bounded stream prefix. Any accepted/unknown event permanently
//! closes the recovery window; later errors are forwarded without replay.
use serde_json::Value;
use std::io::{self, Read};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::time::Duration;

pub(super) const PREFIX_LIMIT: usize = 64 * 1024;
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Rejection {
    ToolPair,
    SearchType,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Verdict {
    Pending,
    Forward,
    Rejected(Rejection),
}

pub(super) fn recoverable_input(payload: &Value) -> bool {
    !["previous_response_id", "conversation"]
        .iter()
        .any(|key| payload.get(key).is_some_and(|value| !value.is_null()))
        && payload
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    matches!(
                        item.get("type").and_then(Value::as_str),
                        Some(
                            "function_call"
                                | "function_call_output"
                                | "custom_tool_call"
                                | "custom_tool_call_output"
                                | "web_search_call"
                        )
                    )
                })
            })
}

fn validation_class(value: &Value) -> bool {
    validation_metadata(value)
        && value
            .get("type")
            .filter(|v| !v.is_null())
            .map_or(true, |v| {
                matches!(
                    v.as_str(),
                    Some(
                        "" | "error" | "invalid_request_error" | "invalid_request" | "bad_request"
                    )
                )
            })
}

fn validation_metadata(value: &Value) -> bool {
    ["code"].iter().all(|key| {
        value.get(key).filter(|v| !v.is_null()).map_or(true, |v| {
            matches!(
                v.as_str(),
                Some("" | "error" | "invalid_request_error" | "invalid_request" | "bad_request")
            )
        })
    }) && ["status", "status_code"].iter().all(|key| {
        value
            .get(key)
            .filter(|v| !v.is_null())
            .map_or(true, |v| matches!(v.as_u64(), Some(400 | 422)))
    })
}

fn validation_error(error: &Value) -> Option<Rejection> {
    if !validation_class(error) {
        return None;
    }
    let body = serde_json::to_vec(error).ok()?;
    if super::codex_response_compat::is_tool_pair_rejection(&body) {
        Some(Rejection::ToolPair)
    } else if super::codex_response_compat::is_search_type_rejection(&body) {
        Some(Rejection::SearchType)
    } else {
        None
    }
}

fn classify_event(event: Option<&str>, data: &str) -> Verdict {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Verdict::Forward;
    };
    let kind = value.get("type").and_then(Value::as_str);
    if let (Some(event), Some(kind)) = (event, kind) {
        if event != kind {
            return Verdict::Forward;
        }
    }
    let event_kind = kind.or(event).or_else(|| {
        value
            .get("error")
            .filter(|error| error.is_object())
            .map(|_| "error")
    });
    let rejection = match event_kind {
        Some("error") => {
            if !validation_class(&value)
                || ["response", "output", "item", "delta"]
                    .iter()
                    .any(|key| value.get(key).is_some())
            {
                return Verdict::Forward;
            }
            validation_error(value.get("error").unwrap_or(&value))
        }
        Some("response.failed") => {
            let Some(response) = value.get("response") else {
                return Verdict::Forward;
            };
            // Missing output is not proof of empty output. A nonempty result
            // or generated tokens may already represent a tool execution.
            if !validation_metadata(&value)
                || response.get("background").and_then(Value::as_bool) == Some(true)
                || response.get("status").and_then(Value::as_str) != Some("failed")
                || !response
                    .get("output")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
                || response
                    .pointer("/usage/output_tokens")
                    .is_some_and(|v| !v.is_null() && v.as_u64() != Some(0))
            {
                return Verdict::Forward;
            }
            response.get("error").and_then(validation_error)
        }
        _ => None,
    };
    rejection.map(Verdict::Rejected).unwrap_or(Verdict::Forward)
}

pub(super) struct PrefixProbe {
    line: Vec<u8>,
    data: String,
    event: Option<String>,
    bytes: usize,
    first_line: bool,
    after_cr: bool,
    verdict: Verdict,
}

impl PrefixProbe {
    pub(super) fn new() -> Self {
        Self {
            line: Vec::new(),
            data: String::new(),
            event: None,
            bytes: 0,
            first_line: true,
            after_cr: false,
            verdict: Verdict::Pending,
        }
    }

    fn finish_line(&mut self) {
        let bytes = std::mem::take(&mut self.line);
        let bytes = if self.first_line {
            bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes)
        } else {
            &bytes
        };
        self.first_line = false;
        let Ok(line) = std::str::from_utf8(bytes) else {
            self.verdict = Verdict::Forward;
            return;
        };
        if line.is_empty() {
            if !self.data.is_empty() {
                self.verdict = classify_event(
                    self.event.as_deref(),
                    self.data.trim_end_matches(char::from(10)),
                );
            } else if self.event.is_some() {
                self.verdict = Verdict::Forward;
            }
            return;
        }
        if line.starts_with(':') {
            return;
        } // Only comments are known inert.
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" if self.event.is_none() => self.event = Some(value.into()),
            "data" => {
                self.data.push_str(value);
                self.data.push(char::from(10));
            }
            _ => self.verdict = Verdict::Forward,
        }
    }

    pub(super) fn feed(&mut self, bytes: &[u8]) -> Verdict {
        for &byte in bytes {
            if self.verdict != Verdict::Pending {
                break;
            }
            self.bytes += 1;
            if self.bytes > PREFIX_LIMIT {
                self.verdict = Verdict::Forward;
                break;
            }
            if self.after_cr {
                self.after_cr = false;
                if byte == 10 {
                    continue;
                }
            }
            if matches!(byte, 13 | 10) {
                self.finish_line();
                self.after_cr = byte == 13;
            } else {
                self.line.push(byte);
            }
        }
        self.verdict
    }
}

/// One outstanding read, one bounded chunk. The acknowledgement channel stops
/// reading past a rejection. Timeout retains the SAME response: never replay a
/// slow or uncertain request. Dropping this reader closes the demand channel.
pub(super) struct BodyReader {
    demand: SyncSender<()>,
    chunks: Receiver<io::Result<Vec<u8>>>,
    pending: bool,
}

pub(super) enum ReadError {
    Timeout,
    Io(io::Error),
}

impl BodyReader {
    pub(super) fn new(mut reader: impl Read + Send + 'static) -> io::Result<Self> {
        let (demand, commands) = mpsc::sync_channel(1);
        let (sender, chunks) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("response-prefix-reader".into())
            .spawn(move || {
                while commands.recv().is_ok() {
                    let mut bytes = vec![0; 8192];
                    let result = loop {
                        match reader.read(&mut bytes) {
                            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                            result => break result,
                        }
                    }
                    .map(|count| {
                        bytes.truncate(count);
                        bytes
                    });
                    let terminal = result.as_ref().map_or(true, Vec::is_empty);
                    if sender.send(result).is_err() || terminal {
                        break;
                    }
                }
            })?;
        Ok(Self {
            demand,
            chunks,
            pending: false,
        })
    }

    pub(super) fn next(&mut self, timeout: Option<Duration>) -> Result<Vec<u8>, ReadError> {
        let disconnected = || {
            ReadError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "response reader disconnected",
            ))
        };
        if !self.pending {
            self.demand.send(()).map_err(|_| disconnected())?;
            self.pending = true;
        }
        let chunk = if let Some(timeout) = timeout {
            match self.chunks.recv_timeout(timeout) {
                Ok(chunk) => chunk,
                Err(RecvTimeoutError::Timeout) => return Err(ReadError::Timeout),
                Err(RecvTimeoutError::Disconnected) => return Err(disconnected()),
            }
        } else {
            self.chunks.recv().map_err(|_| disconnected())?
        };
        self.pending = false;
        chunk.map_err(ReadError::Io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const MESSAGE: &str = "stream disconnected before completion: No tool output found for custom tool call ctc_synthetic.";

    fn frame(value: Value) -> String {
        format!("data: {value}\n\n")
    }

    #[test]
    fn recognizes_split_custom_error_and_empty_failed_response() {
        for data in [
            json!({"type":"error","message":MESSAGE}),
            json!({"error":{"type":"invalid_request_error","message":MESSAGE}}),
            json!({"type":"error","error":{"type":"invalid_request_error","message":MESSAGE}}),
            json!({"type":"response.failed","response":{"status":"failed","output":[],"error":{"message":MESSAGE}}}),
        ] {
            for ending in ["\n", "\r\n", "\r"] {
                let text = format!(
                    "{}: keepalive\n\n{}",
                    char::from_u32(0xfeff).unwrap(),
                    frame(data.clone())
                )
                .replace(char::from(10), ending);
                for split in 0..=text.len() {
                    let mut probe = PrefixProbe::new();
                    probe.feed(&text.as_bytes()[..split]);
                    assert_eq!(
                        probe.feed(&text.as_bytes()[split..]),
                        Verdict::Rejected(Rejection::ToolPair)
                    );
                }
            }
        }
    }

    #[test]
    fn accepted_unknown_or_contradictory_events_never_authorize_replay() {
        let error = frame(json!({"type":"error","message":MESSAGE}));
        for value in [
            json!({"type":"response.created"}),
            json!({"type":"response.in_progress"}),
            json!({"type":"response.output_text.delta","delta":MESSAGE}),
            json!({"type":"response.output_item.added","item":{"type":"custom_tool_call"}}),
            json!({"type":"error","message":MESSAGE,"code":"rate_limit_exceeded"}),
            json!({"type":"error","status":500,"error":{"message":MESSAGE}}),
            json!({"type":"error","message":"network timeout"}),
            json!({"type":"response.failed","status_code":429,"response":{"status":"failed","output":[],"error":{"message":MESSAGE}}}),
            json!({"type":"response.failed","response":{"background":true,"status":"failed","output":[],"error":{"message":MESSAGE}}}),
            json!({"type":"response.failed","response":{"status":"failed","error":{"message":MESSAGE}}}),
            json!({"type":"response.failed","response":{"status":"failed","output":[{}],"error":{"message":MESSAGE}}}),
            json!({"type":"response.failed","response":{"status":"failed","output":[],"usage":{"output_tokens":1},"error":{"message":MESSAGE}}}),
        ] {
            let mut probe = PrefixProbe::new();
            assert_eq!(probe.feed(frame(value).as_bytes()), Verdict::Forward);
            assert_eq!(probe.feed(error.as_bytes()), Verdict::Forward);
        }
        for text in [
            "data: [DONE]\n\n".into(),
            "data: invalid json\n\n".into(),
            format!("event: response.output_text.delta\n{error}"),
            format!("id: uncertain\n{error}"),
            format!("data: {}", "x".repeat(PREFIX_LIMIT)),
        ] {
            assert_eq!(PrefixProbe::new().feed(text.as_bytes()), Verdict::Forward);
        }
    }

    #[test]
    fn timeout_retains_the_same_pending_read_without_duplication() {
        struct SlowReader;
        impl Read for SlowReader {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                std::thread::sleep(Duration::from_millis(40));
                out[..2].copy_from_slice(b"ok");
                Ok(2)
            }
        }
        let mut reader = BodyReader::new(SlowReader).unwrap();
        assert!(matches!(
            reader.next(Some(Duration::ZERO)),
            Err(ReadError::Timeout)
        ));
        assert_eq!(reader.next(None).ok().unwrap(), b"ok");
    }

    #[test]
    fn hidden_or_absent_tool_history_does_not_open_probe_window() {
        let input = json!([{"type":"custom_tool_call","call_id":"ctc_test"}]);
        assert!(recoverable_input(&json!({"input":input})));
        assert!(!recoverable_input(
            &json!({"input":input,"previous_response_id":"server-history"})
        ));
        assert!(!recoverable_input(
            &json!({"input":input,"conversation":"server-history"})
        ));
        assert!(!recoverable_input(&json!({"input":"hello"})));
    }
}
