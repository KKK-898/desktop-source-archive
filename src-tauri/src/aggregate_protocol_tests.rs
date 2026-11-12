use super::*;
fn request() -> Value {
    json!({"model":"test-model","stream":true,"instructions":"Be accurate.","input":[{"role":"user","content":[{"type":"input_text","text":"你好"}]}],"tools":[{"type":"function","name":"run","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]})
}
fn data(value: Value) -> String {
    format!("data: {value}\r\n\r\n")
}
fn event(kind: &str, value: Value) -> String {
    format!("event: {kind}\ndata: {value}\n\n")
}
fn events(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn final_response(bytes: &[u8]) -> Value {
    events(bytes)
        .into_iter()
        .rev()
        .find_map(|e| e.get("response").cloned())
        .unwrap()
}
fn feed(protocol: Protocol, request: &Value, wire: &str, chunk: usize) -> (StreamAdapter, Vec<u8>) {
    let mut a = StreamAdapter::new(protocol, request).unwrap();
    let mut out = Vec::new();
    for c in wire.as_bytes().chunks(chunk) {
        out.extend(a.push(c).unwrap());
    }
    out.extend(a.finish().unwrap());
    (a, out)
}
#[test]
fn protocol_aliases_defaults_endpoints_and_compact_rejection() {
    assert_eq!(Protocol::default(), Protocol::Responses);
    for name in ["chatCompletions", "chat_completions", "chat-completions"] {
        assert_eq!(Protocol::parse(name).unwrap(), Protocol::ChatCompletions);
    }
    assert_eq!(
        serde_json::from_value::<Protocol>(json!("anthropic_messages")).unwrap(),
        Protocol::AnthropicMessages
    );
    assert_eq!(
        endpoint(
            Protocol::ChatCompletions,
            "https://provider.invalid/custom/v1/responses",
            "/v1/responses"
        )
        .unwrap(),
        "https://provider.invalid/custom/v1/chat/completions"
    );
    assert_eq!(
        endpoint(
            Protocol::AnthropicMessages,
            "https://provider.invalid/anthropic",
            "/responses"
        )
        .unwrap(),
        "https://provider.invalid/anthropic/v1/messages"
    );
    assert!(endpoint(
        Protocol::ChatCompletions,
        "https://provider.invalid",
        "/responses/compact"
    )
    .is_err());
}
#[test]
fn responses_is_exact_passthrough() {
    let v = json!({"model":"x","unrecognized_future_field":[1]});
    assert_eq!(prepare_request(Protocol::Responses, &v).unwrap(), v);
    assert_eq!(convert_response(Protocol::Responses, &v, &v).unwrap(), v);
    let mut s = StreamAdapter::new(Protocol::Responses, &v).unwrap();
    assert_eq!(s.push(b"\xffdata: x").unwrap(), b"\xffdata: x");
    assert!(s.finish().unwrap().is_empty());
}
#[test]
fn request_preserves_messages_tools_images_and_tier() {
    let mut r = request();
    r["service_tier"] = json!("priority");
    r["reasoning"] = json!({"effort":"high"});
    r["input"][0]["content"].as_array_mut().unwrap().push(
        json!({"type":"input_image","image_url":"data:image/png;base64,aGk=","detail":"high"}),
    );
    let v = prepare_request(Protocol::ChatCompletions, &r).unwrap();
    assert_eq!(v["messages"][0]["role"], "system");
    assert_eq!(v["messages"][1]["content"][0]["text"], "你好");
    assert_eq!(
        v["messages"][1]["content"][1]["image_url"]["detail"],
        "high"
    );
    assert_eq!(v["tools"][0]["function"]["name"], "run");
    assert_eq!(v["service_tier"], "priority");
    assert_eq!(v["stream_options"]["include_usage"], true);
    assert_eq!(v["reasoning_effort"], "high");
    assert!(prepare_request(Protocol::AnthropicMessages, &r)
        .unwrap_err()
        .contains("priority"));
}
#[test]
fn multi_turn_tool_ids_and_results_are_preserved() {
    let mut r = request();
    r["input"].as_array_mut().unwrap().extend([json!({"type":"function_call","name":"run","call_id":"call_original","arguments":"{\"command\":\"pwd\"}"}),json!({"type":"function_call_output","call_id":"call_original","output":"D:/workspace"}),json!({"role":"user","content":"continue"})]);
    for p in [Protocol::ChatCompletions, Protocol::AnthropicMessages] {
        let v = prepare_request(p, &r).unwrap();
        let s = v.to_string();
        assert!(s.contains("call_original"));
        assert!(s.contains("D:/workspace"));
        assert!(s.contains("continue"));
    }
    let v = prepare_request(Protocol::AnthropicMessages, &r).unwrap();
    assert_eq!(v["messages"][1]["content"][0]["input"]["command"], "pwd");
    assert_eq!(
        v["messages"][2]["content"][0]["tool_use_id"],
        "call_original"
    );
}
#[test]
fn unsupported_content_and_orphan_tools_fail_instead_of_dropping() {
    let mut r = request();
    r["input"] = json!([{"type":"function_call_output","call_id":"missing","output":"important"}]);
    assert!(prepare_request(Protocol::ChatCompletions, &r).is_err());
    r = request();
    r["input"][0]["content"] = json!([{"type":"input_audio","data":"..."}]);
    assert!(prepare_request(Protocol::ChatCompletions, &r).is_err());
    r = request();
    r["previous_response_id"] = json!("resp_old");
    assert!(prepare_request(Protocol::ChatCompletions, &r).is_err());
    r = request();
    r["tools"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"web_search"}));
    assert!(prepare_request(Protocol::ChatCompletions, &r).is_err());
}
#[test]
fn chat_stream_handles_each_byte_unicode_tool_fragments_and_usage() {
    let chunks = [
        json!({"id":"chat1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}),
        json!({"id":"chat1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"run","arguments":"{\"com"}}]},"finish_reason":null}]}),
        json!({"id":"chat1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}),
        json!({"id":"chat1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":4}}}),
    ];
    let wire = chunks.into_iter().map(data).collect::<String>() + "data: [DONE]\r\n\r\n";
    for size in [1, 2, 7, 1024] {
        let (_, out) = feed(Protocol::ChatCompletions, &request(), &wire, size);
        let r = final_response(&out);
        assert_eq!(r["status"], "completed");
        assert_eq!(r["output"][0]["content"][0]["text"], "你好");
        assert_eq!(r["output"][1]["call_id"], "call_a");
        assert_eq!(r["output"][1]["arguments"], "{\"command\":\"pwd\"}");
        assert_eq!(r["usage"]["total_tokens"], 20);
        assert_eq!(r["usage"]["input_tokens_details"]["cached_tokens"], 4);
        let es = events(&out);
        for (i, e) in es.iter().enumerate() {
            assert_eq!(e["sequence_number"], i as u64);
        }
    }
}
#[test]
fn parallel_tools_and_namespaces_survive_round_trip() {
    let mut r = request();
    r["tools"] = json!([{"type":"namespace","name":"functions","tools":[{"type":"function","name":"run","parameters":{"type":"object"}}]}]);
    assert_eq!(
        prepare_request(Protocol::ChatCompletions, &r).unwrap()["tools"][0]["function"]["name"],
        "functions__run"
    );
    let upstream = json!({"id":"x","choices":[{"message":{"tool_calls":[{"id":"a","type":"function","function":{"name":"functions__run","arguments":"{}"}},{"id":"b","type":"function","function":{"name":"functions__run","arguments":"{}"}}]},"finish_reason":"tool_calls"}]});
    let out = convert_response(Protocol::ChatCompletions, &upstream, &r).unwrap();
    assert_eq!(out["output"].as_array().unwrap().len(), 2);
    assert_eq!(out["output"][0]["namespace"], "functions");
    assert_eq!(out["output"][0]["name"], "run");
    assert_eq!(out["output"][1]["call_id"], "b");
}
#[test]
fn custom_tool_input_and_grammar_are_preserved() {
    let mut r = request();
    r["tools"] = json!([{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"start: PATCH"}}]);
    let prepared = prepare_request(Protocol::ChatCompletions, &r).unwrap();
    assert!(prepared["tools"][0]["function"]["description"]
        .as_str()
        .unwrap()
        .contains("start: PATCH"));
    let raw = "*** Begin Patch\n*** End Patch";
    let v = json!({"choices":[{"message":{"tool_calls":[{"id":"p","type":"function","function":{"name":"apply_patch","arguments":json!({"input":raw}).to_string()}}]},"finish_reason":"tool_calls"}]});
    let out = convert_response(Protocol::ChatCompletions, &v, &r).unwrap();
    assert_eq!(out["output"][0]["type"], "custom_tool_call");
    assert_eq!(out["output"][0]["input"], raw);
    r["input"].as_array_mut().unwrap().extend([
        out["output"][0].clone(),
        json!({"type":"custom_tool_call_output","call_id":"p","output":"done"}),
    ]);
    assert_eq!(
        prepare_request(Protocol::AnthropicMessages, &r).unwrap()["messages"][1]["content"][0]
            ["input"]["input"],
        raw
    );
}
fn anthropic_wire() -> String {
    [
 event("message_start",json!({"message":{"id":"msg1","usage":{"input_tokens":10,"cache_read_input_tokens":30,"cache_creation_input_tokens":5,"output_tokens":0}}})),
 event("content_block_start",json!({"index":0,"content_block":{"type":"thinking","thinking":""}})),
 event("content_block_delta",json!({"index":0,"delta":{"type":"thinking_delta","thinking":"Thought"}})),
 event("content_block_delta",json!({"index":0,"delta":{"type":"signature_delta","signature":"signed-value"}})),
 event("content_block_stop",json!({"index":0})),
 event("content_block_start",json!({"index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"run","input":{}}})),
 event("content_block_delta",json!({"index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}})),
 event("content_block_delta",json!({"index":1,"delta":{"type":"input_json_delta","partial_json":"\"pwd\"}"}})),
 event("content_block_stop",json!({"index":1})),
 event("message_delta",json!({"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}})),
 event("message_stop",json!({}))].concat()
}
#[test]
fn anthropic_stream_preserves_signed_thinking_tool_ids_cache_usage_and_replay() {
    for size in [1, 3, 27, 4096] {
        let (_, out) = feed(
            Protocol::AnthropicMessages,
            &request(),
            &anthropic_wire(),
            size,
        );
        let response = final_response(&out);
        assert_eq!(response["status"], "completed");
        assert_eq!(response["usage"]["input_tokens"], 45);
        assert_eq!(response["usage"]["total_tokens"], 52);
        assert_eq!(response["output"][1]["call_id"], "tool_1");
        let mut r = request();
        r["input"]
            .as_array_mut()
            .unwrap()
            .extend(response["output"].as_array().unwrap().clone());
        r["input"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"function_call_output","call_id":"tool_1","output":"/root"}));
        let p = prepare_request(Protocol::AnthropicMessages, &r).unwrap();
        assert_eq!(p["messages"][1]["content"][0]["signature"], "signed-value");
        assert_eq!(p["messages"][1]["content"][1]["id"], "tool_1");
    }
}
#[test]
fn native_thought_signatures_on_chat_tools_are_replayed() {
    let r = request();
    let upstream = json!({"choices":[{"message":{"reasoning_content":"reason","tool_calls":[{"id":"s1","type":"function","function":{"name":"run","arguments":"{}"},"extra_content":{"google":{"thought_signature":"sig"}}}]},"finish_reason":"tool_calls"}]});
    let output = convert_response(Protocol::ChatCompletions, &upstream, &r).unwrap();
    let mut r = r;
    r["input"]
        .as_array_mut()
        .unwrap()
        .extend(output["output"].as_array().unwrap().clone());
    r["input"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"function_call_output","call_id":"s1","output":"ok"}));
    let prepared = prepare_request(Protocol::ChatCompletions, &r).unwrap();
    assert_eq!(prepared["messages"][2]["reasoning_content"], "reason");
    assert_eq!(
        prepared["messages"][2]["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
        "sig"
    );
}
#[test]
fn incomplete_stream_and_token_limit_are_not_completed() {
    let first = data(json!({"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}));
    let (_, bytes) = feed(Protocol::ChatCompletions, &request(), &first, 3);
    assert_eq!(final_response(&bytes)["status"], "incomplete");
    let limited =
        data(json!({"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}))
            + "data: [DONE]\n\n";
    let (_, bytes) = feed(Protocol::ChatCompletions, &request(), &limited, 7);
    assert_eq!(
        final_response(&bytes)["incomplete_details"]["reason"],
        "max_output_tokens"
    );
    let wire = anthropic_wire().replace(&event("message_stop", json!({})), "");
    let (_, bytes) = feed(Protocol::AnthropicMessages, &request(), &wire, 13);
    assert_eq!(final_response(&bytes)["status"], "incomplete");
}
#[test]
fn malformed_stream_and_provider_error_never_report_success() {
    let mut a = StreamAdapter::new(Protocol::ChatCompletions, &request()).unwrap();
    assert!(a.push(b"data: {broken}\n\n").is_err());
    let out = a.abort("invalid upstream stream");
    assert_eq!(final_response(&out)["status"], "failed");
    let (_, out) = feed(
        Protocol::AnthropicMessages,
        &request(),
        &event(
            "error",
            json!({"error":{"type":"overloaded_error","message":"busy"}}),
        ),
        1,
    );
    assert_eq!(final_response(&out)["status"], "failed");
    assert_eq!(final_response(&out)["error"]["message"], "busy");
}
#[test]
fn missing_tool_arguments_or_missing_block_stop_is_rejected() {
    let bad = json!({"choices":[{"message":{"tool_calls":[{"id":"t","function":{"name":"run","arguments":"{"}}]},"finish_reason":"tool_calls"}]});
    assert!(convert_response(Protocol::ChatCompletions, &bad, &request()).is_err());
    let mut a = StreamAdapter::new(Protocol::AnthropicMessages, &request()).unwrap();
    let wire = anthropic_wire().replace(&event("content_block_stop", json!({"index":1})), "");
    assert!(a.push(wire.as_bytes()).is_err());
}
#[test]
fn anthropic_nonstream_images_adaptive_thinking_and_tool_result_blocks() {
    let mut r = request();
    r["model"] = json!("claude-opus-4-8");
    r["max_output_tokens"] = json!(18000);
    r["reasoning"] = json!({"effort":"high"});
    r["input"][0]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"input_image","image_url":"https://example.invalid/img.png"}));
    let p = prepare_request(Protocol::AnthropicMessages, &r).unwrap();
    assert_eq!(p["thinking"]["type"], "adaptive");
    assert_eq!(p["max_tokens"], 18000);
    assert_eq!(p["messages"][0]["content"][1]["source"]["type"], "url");
    let output=convert_response(Protocol::AnthropicMessages,&json!({"id":"a","content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":2}}),&r).unwrap();
    assert_eq!(output["output"][0]["content"][0]["text"], "answer");
    assert_eq!(output["usage"]["total_tokens"], 7);
}
#[test]
fn bounds_and_unknown_stream_events_fail_closed() {
    let mut a = StreamAdapter::new(Protocol::ChatCompletions, &request()).unwrap();
    assert!(a.push(&vec![b'x'; MAX_EVENT + 1]).is_err());
    let mut a = StreamAdapter::new(Protocol::AnthropicMessages, &request()).unwrap();
    assert!(a
        .push(
            event(
                "future_semantic_event",
                json!({"type":"future_semantic_event"})
            )
            .as_bytes()
        )
        .is_err());
}
#[test]
fn fragmented_tool_names_and_ids_are_not_announced_prematurely() {
    let chunks = [
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"r","arguments":""}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"one","function":{"name":"un","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}),
    ];
    let wire = chunks.into_iter().map(data).collect::<String>() + "data: [DONE]\n\n";
    let (_, out) = feed(Protocol::ChatCompletions, &request(), &wire, 1);
    let r = final_response(&out);
    assert_eq!(r["status"], "completed");
    assert_eq!(r["output"][0]["call_id"], "call_one");
    assert_eq!(r["output"][0]["name"], "run");
    assert_eq!(
        events(&out)
            .iter()
            .filter(|e| e["type"] == "response.output_item.added")
            .count(),
        1
    );
}
#[test]
fn json_response_can_be_emitted_as_full_responses_sse() {
    let upstream = json!({"choices":[{"message":{"content":"complete","tool_calls":[{"id":"t","type":"function","function":{"name":"run","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4}});
    let bytes = convert_response_sse(Protocol::ChatCompletions, &upstream, &request()).unwrap();
    let names = events(&bytes)
        .iter()
        .map(|e| e["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(names.contains(&"response.created".into()));
    assert!(names.contains(&"response.output_text.delta".into()));
    assert!(names.contains(&"response.function_call_arguments.done".into()));
    assert_eq!(names.last().unwrap(), "response.completed");
    assert_eq!(final_response(&bytes)["usage"]["total_tokens"], 7);
}
#[test]
fn foreign_encrypted_history_is_ignored_but_plain_messages_are_not() {
    let mut r = request();
    r["input"].as_array_mut().unwrap().insert(
        0,
        json!({"type":"reasoning","encrypted_content":"provider-private-data"}),
    );
    let p = prepare_request(Protocol::ChatCompletions, &r).unwrap();
    assert_eq!(p["messages"][1]["content"][0]["text"], "你好");
    assert!(!p.to_string().contains("provider-private-data"));
}
#[test]
fn unsigned_thinking_and_unknown_endpoints_are_rejected() {
    let response = json!({"id":"s","content":[{"type":"thinking","thinking":"unsigned"}],"stop_reason":"end_turn","usage":{}});
    assert!(convert_response(Protocol::AnthropicMessages, &response, &request()).is_err());
    assert!(endpoint(
        Protocol::Responses,
        "https://provider.invalid",
        "/totally-unrelated"
    )
    .is_err());
}

#[test]
fn aggregate_highest_reasoning_effort_survives_each_protocol() {
    for (protocol, model, effort) in [
        (Protocol::Responses, "gpt-6-astra", "ultra"),
        (Protocol::Responses, "gpt-6.1-sol", "ultra"),
        (Protocol::ChatCompletions, "deepseek-v4-pro", "max"),
        (Protocol::ChatCompletions, "kimi-k3", "max"),
        (Protocol::ChatCompletions, "glm-5.3", "max"),
        (Protocol::AnthropicMessages, "claude-opus-4-8", "max"),
    ] {
        let mut r = request();
        r["model"] = json!(model);
        r["reasoning"] = json!({"effort":effort});
        let prepared = prepare_request(protocol, &r).unwrap();
        match protocol {
            Protocol::Responses => assert_eq!(prepared["reasoning"]["effort"], effort),
            Protocol::ChatCompletions => assert_eq!(prepared["reasoning_effort"], effort),
            Protocol::AnthropicMessages => {
                assert_eq!(prepared["thinking"]["type"], "adaptive");
                assert_eq!(prepared["output_config"]["effort"], effort);
                assert_eq!(prepared["max_tokens"], 8192, "adaptive default is unchanged");
            }
        }
        assert_eq!(prepared["model"], model);
    }
}

#[test]
fn anthropic_manual_thinking_default_preserves_requested_budget() {
    for (effort, budget, max_tokens) in [
        ("low", 1024, 8192), ("medium", 4096, 8192),
        ("high", 8192, 16384), ("xhigh", 16384, 32768),
        ("max", 32768, 65536), ("ultra", 32768, 65536),
    ] {
        let mut r = request();
        r["model"] = json!("claude-sonnet-4-5");
        r["reasoning"] = json!({"effort":effort});
        let prepared = prepare_request(Protocol::AnthropicMessages, &r).unwrap();
        assert_eq!(prepared["thinking"], json!({"type":"enabled","budget_tokens":budget}), "{effort}");
        assert_eq!(prepared["max_tokens"], max_tokens, "{effort}");
    }
    for effort in ["none", "minimal"] {
        let mut r = request();
        r["model"] = json!("claude-sonnet-4-5");
        r["reasoning"] = json!({"effort":effort});
        let prepared = prepare_request(Protocol::AnthropicMessages, &r).unwrap();
        assert!(prepared.get("thinking").is_none());
        assert_eq!(prepared["max_tokens"], 8192);
    }
}

#[test]
fn anthropic_manual_thinking_respects_every_explicit_output_limit() {
    for field in ["max_output_tokens", "max_completion_tokens", "max_tokens"] {
        let mut r = request();
        r["model"] = json!("claude-sonnet-4-5");
        r["reasoning"] = json!({"effort":"max"});
        r[field] = json!(8192);
        let prepared = prepare_request(Protocol::AnthropicMessages, &r).unwrap();
        assert_eq!(prepared["max_tokens"], 8192, "{field}");
        assert_eq!(prepared["thinking"]["budget_tokens"], 4096, "{field}");
        r[field] = json!(65536);
        let prepared = prepare_request(Protocol::AnthropicMessages, &r).unwrap();
        assert_eq!(prepared["max_tokens"], 65536, "{field}");
        assert_eq!(prepared["thinking"]["budget_tokens"], 32768, "{field}");
        r[field] = json!(1024);
        assert!(prepare_request(Protocol::AnthropicMessages, &r).unwrap_err()
            .contains("thinking token budget below 1024"), "{field}");
    }
}
