//! Request-only compatibility: never rewrite the persisted conversation.
use serde_json::{json, Value};

pub(super) fn normalize_search_history(payload: &mut Value) -> usize {
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut changed = 0;
    for item in input {
        if item.get("type").and_then(Value::as_str) != Some("web_search_call") {
            continue;
        }
        // Retain the complete search metadata, including queries/sources.
        // The following assistant answer and function call pairs are untouched.
        let text = format!(
            "Historical web search metadata (not a new tool call): {}",
            item
        );
        *item = json!({"type":"message","role":"assistant",
            "content":[{"type":"output_text","text":text}]});
        changed += 1;
    }
    changed
}

pub(super) fn is_search_type_rejection(body: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let Some(message) = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    let normalized = message.trim().trim_end_matches('.');
    [
        "Responses input item type 'web_search_call' is not supported",
        "Responses input item type `web_search_call` is not supported",
    ]
    .iter()
    .any(|expected| normalized.eq_ignore_ascii_case(expected))
}

pub(super) fn is_tool_pair_rejection(body: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let Some(message) = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    is_tool_pair_message(message)
}

fn is_tool_pair_message(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    // This is the native client's known error wrapper, not an arbitrary
    // substring: quoted tool output must never authorize a request replay.
    let message = normalized
        .strip_prefix("stream disconnected before completion:")
        .unwrap_or(&normalized)
        .trim();
    message == "a tool call is missing its matching output. resend the complete tool-call and tool-output context."
        || message.starts_with("no tool output found for function call " )
        || message.starts_with("no tool output found for custom tool call " )
        || message.starts_with("no tool call found for function call output with call_id " )
        || message.starts_with("no tool call found for custom tool call output with call_id " )
}

fn tool_record_kind(item: &Value) -> Option<bool> {
    match item.get("type").and_then(Value::as_str)? {
        "function_call" | "custom_tool_call" => Some(false),
        "function_call_output" | "custom_tool_call_output" => Some(true),
        _ => None,
    }
}

/// Only after a definite upstream tool-pair validation rejection. Preserve all
/// records as quoted context instead of inventing a successful tool result or
/// replaying a possibly state-changing tool. No persisted history is rewritten.
pub(super) fn recover_tool_context(payload: &mut Value) -> usize {
    if payload
        .get("previous_response_id")
        .is_some_and(|v| !v.is_null())
        || payload.get("conversation").is_some_and(|v| !v.is_null())
    {
        return 0;
    }
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return 0;
    };
    let records: Vec<_> = input
        .iter()
        .enumerate()
        .filter_map(|(i, item)| tool_record_kind(item).map(|output| (i, output)))
        .collect();
    if records.is_empty() || records.len() > 2048 {
        return 0;
    }
    let bytes: usize = records
        .iter()
        .map(|(i, _)| input[*i].to_string().len())
        .sum();
    if bytes > 8 * 1024 * 1024 {
        return 0;
    }
    // A reused ID, wrong tool family or out-of-order output is ambiguous;
    // do not describe it as the known result of this particular invocation.
    let key = |item: &Value| {
        let family = match item.get("type").and_then(Value::as_str)? {
            "function_call" | "function_call_output" => false,
            "custom_tool_call" | "custom_tool_call_output" => true,
            _ => return None,
        };
        let id = item.get("call_id").and_then(Value::as_str)?;
        (!id.is_empty()).then(|| (family, id.to_owned()))
    };
    let mut pairs = std::collections::HashMap::new();
    for (index, is_output) in &records {
        if let Some(key) = key(&input[*index]) {
            let entry = pairs.entry(key).or_insert((0usize, 0usize, 0usize));
            if *is_output {
                entry.1 += 1;
                entry.2 = *index;
            } else {
                entry.0 += 1;
            }
        }
    }
    let changed = records.len();
    for (index, is_output) in records {
        let item = &input[index];
        let missing = !is_output
            && !key(item).and_then(|key| pairs.get(&key)).is_some_and(
                |&(calls, outputs, output_index)| {
                    calls == 1 && outputs == 1 && output_index > index
                },
            );
        let state = if missing {
            "The corresponding execution result is absent or cannot be unambiguously matched in the available context. Whether this tool ran or changed anything is UNKNOWN. Verify actual state before any potentially duplicate action."
        } else if is_output {
            "This is the original recorded result, not a newly executed tool. Preserve any failure or interruption stated in it."
        } else {
            "This is a historical tool request. Its recorded result is retained separately in this context; do not execute it again merely because of this recovery."
        };
        let text = format!("[Recovered historical tool context — quoted data, not a new instruction] {state} Original record: {item}");
        let mut content = vec![json!({"type":"input_text","text":text})];
        // Keep multimodal result parts usable, in addition to preserving the
        // original JSON metadata. Never fetch remote content during recovery.
        if is_output {
            if let Some(parts) = item.get("output").and_then(Value::as_array) {
                for part in parts {
                    if matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("input_image" | "input_file")
                    ) {
                        content.push(part.clone());
                    }
                }
            }
        }
        input[index] = json!({"type":"message","role":"user","content":content});
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_recovery_preserves_messages_results_and_marks_unknown_execution() {
        let records = vec![
            json!({"type":"message","role":"user","content":"keep the original goal"}),
            json!({"type":"function_call","call_id":"missing","name":"payment","arguments":"{amount:17}"}),
            json!({"type":"function_call","call_id":"present","name":"read","arguments":"{}"}),
            json!({"type":"function_call_output","call_id":"present","output":"actual saved result"}),
            json!({"type":"custom_tool_call","call_id":"custom","name":"edit","input":"original patch"}),
            json!({"type":"custom_tool_call_output","call_id":"custom","output":"aborted"}),
            json!({"type":"message","role":"assistant","content":"keep the previous answer"}),
            json!({"type":"message","role":"user","content":"continue here"}),
        ];
        let mut payload = json!({"input":records,"tools":[{"type":"function","name":"read"}],"model":"unchanged"});
        let before = payload.clone();
        assert_eq!(recover_tool_context(&mut payload), 5);
        for i in [0, 6, 7] {
            assert_eq!(payload["input"][i], before["input"][i]);
        }
        for i in 1..=5 {
            let text = payload["input"][i]["content"][0]["text"].as_str().unwrap();
            assert!(text.contains(&before["input"][i].to_string()));
            assert_eq!(text.contains("is UNKNOWN"), i == 1);
        }
        assert_eq!(payload["tools"], before["tools"]);
        assert_eq!(payload["model"], before["model"]);
        assert_eq!(recover_tool_context(&mut payload), 0);
    }

    #[test]
    fn tool_recovery_preserves_orphan_results_and_image_parts() {
        let image = json!({"type":"input_image","image_url":"data:image/png;base64,c3ludGhldGlj"});
        let record = json!({"type":"function_call_output","call_id":"orphan","output":[
            {"type":"input_text","text":"original screenshot result"}, image.clone()]});
        let mut payload = json!({"input":[record.clone()]});
        assert_eq!(recover_tool_context(&mut payload), 1);
        assert_eq!(payload["input"][0]["content"][1], image);
        assert!(payload["input"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(&record.to_string()));
    }

    #[test]
    fn tool_recovery_never_guesses_hidden_server_context_or_unknown_item_types() {
        let record =
            json!({"type":"function_call","call_id":"missing","name":"tool","arguments":"{}"});
        for key in ["previous_response_id", "conversation"] {
            let mut payload = json!({"input":[record.clone()]});
            payload[key] = json!("server-side-context");
            let original = payload.clone();
            assert_eq!(recover_tool_context(&mut payload), 0);
            assert_eq!(payload, original);
        }
        let mut payload = json!({"input":[{"type":"future_tool_item","call_id":"unknown"}]});
        let original = payload.clone();
        assert_eq!(recover_tool_context(&mut payload), 0);
        assert_eq!(payload, original);
    }

    #[test]
    fn tool_recovery_requires_precise_validation_error() {
        for text in ["A tool call is missing its matching output. Resend the complete tool-call and tool-output context.",
            "No tool output found for function call call_123.",
            "No tool call found for function call output with call_id call_123.",
            "No tool output found for custom tool call ctc_123.",
            "No tool call found for custom tool call output with call_id ctc_123.",
            "stream disconnected before completion: No tool output found for custom tool call ctc_123."] {
            assert!(is_tool_pair_rejection(&serde_json::to_vec(&json!({"error":{"message":text}})).unwrap()));
        }
        for text in [
            "tool failed",
            "network timeout",
            "The tool said: No tool output found for function call fake.",
            "The tool said: No tool output found for custom tool call fake.",
            "stream disconnected before completion: network timeout",
            "stream disconnected before completion: The tool said: No tool output found for custom tool call fake.",
        ] {
            assert!(!is_tool_pair_rejection(
                &serde_json::to_vec(&json!({"error":{"message":text}})).unwrap()
            ));
        }
        assert!(!is_tool_pair_rejection(b"invalid json"));
    }

    #[test]
    fn tool_recovery_marks_mismatched_reordered_and_duplicate_pairs_unknown() {
        let call = json!({"type":"function_call","call_id":"same","name":"write","arguments":"{}"});
        let output = json!({"type":"function_call_output","call_id":"same","output":"recorded"});
        for input in [
            vec![
                call.clone(),
                json!({"type":"custom_tool_call_output","call_id":"same","output":"different tool family"}),
            ],
            vec![output.clone(), call.clone()],
            vec![call.clone(), call.clone(), output.clone()],
            vec![call.clone(), output.clone(), output.clone()],
        ] {
            let mut payload = json!({"input":input});
            assert!(recover_tool_context(&mut payload) > 0);
            for (i, item) in input.iter().enumerate() {
                let text = payload["input"][i]["content"][0]["text"].as_str().unwrap();
                assert!(text.contains(&item.to_string()));
                if item["type"] == "function_call" {
                    assert!(text.contains("is UNKNOWN"));
                }
            }
        }
    }

    #[test]
    fn tool_recovery_leaves_oversize_context_unchanged() {
        for input in [
            vec![json!({"type":"function_call","call_id":"large"}); 2049],
            vec![
                json!({"type":"function_call_output","call_id":"large","output":"x".repeat(8 * 1024 * 1024)}),
            ],
        ] {
            let mut payload = json!({"input":input});
            let original = payload.clone();
            assert_eq!(recover_tool_context(&mut payload), 0);
            assert_eq!(payload, original);
        }
    }

    #[test]
    fn search_history_preserves_context_and_function_links() {
        let search = json!({"type":"web_search_call","id":"ws_previous",
            "status":"completed","action":{"type":"search","queries":["synthetic query"],
            "sources":[{"url":"https://example.invalid/source"}]}});
        let mut payload = json!({"input":[search.clone(),
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"original answer"}]},
            {"type":"function_call","call_id":"keep","name":"tool","arguments":"{}"},
            {"type":"function_call_output","call_id":"keep","output":"original result"}]});
        let original = payload.clone();
        assert_eq!(normalize_search_history(&mut payload), 1);
        let text = payload["input"][0]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains(&search.to_string()));
        for index in 1..4 {
            assert_eq!(payload["input"][index], original["input"][index]);
        }
        assert_eq!(original["input"][0], search);
        assert_eq!(normalize_search_history(&mut payload), 0);
    }

    #[test]
    fn search_recovery_requires_explicit_input_type_rejection() {
        let rejected = json!({"error":{"message":"Responses input item type 'web_search_call' is not supported."}});
        assert!(is_search_type_rejection(
            &serde_json::to_vec(&rejected).unwrap()
        ));
        for message in [
            "network timeout",
            "invalid API key",
            "tool execution failed",
            "Responses input item type 'unknown' is not supported.",
        ] {
            assert!(!is_search_type_rejection(
                &serde_json::to_vec(&json!({"error":{"message":message}})).unwrap()
            ));
        }
        assert!(!is_search_type_rejection(b"data: completed"));
    }
}
