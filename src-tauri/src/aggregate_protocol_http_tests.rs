//! Real loopback HTTP tests for the complete aggregate routing/translation path.
//! Every socket uses an OS-assigned local port. Credentials are inert fixtures;
//! no user homes, saved accounts, configs, or external endpoints are accessed.
use super::*;
use crate::aggregate_protocol::Protocol;
use std::net::Shutdown;
use std::sync::mpsc;

#[derive(Debug)]
struct CapturedRequest {
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}
struct MockUpstream {
    url: String,
    captured: mpsc::Receiver<CapturedRequest>,
    worker: std::thread::JoinHandle<()>,
}
fn read_mock_request(stream: &mut TcpStream) -> CapturedRequest {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let end = loop {
        let n = stream.read(&mut buffer).unwrap();
        assert!(n > 0, "upstream request closed before headers");
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        assert!(bytes.len() < 128 * 1024);
    };
    let header = std::str::from_utf8(&bytes[..end]).unwrap();
    let mut lines = header.split("\r\n");
    let first = lines.next().unwrap();
    assert!(first.starts_with("POST "));
    let path = first.split_whitespace().nth(1).unwrap().to_owned();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect::<HashMap<_, _>>();
    let length = headers
        .get("content-length")
        .unwrap()
        .parse::<usize>()
        .unwrap();
    assert!(length < 1024 * 1024);
    while bytes.len() - end < length {
        let n = stream.read(&mut buffer).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&buffer[..n]);
    }
    CapturedRequest {
        path,
        headers,
        body: serde_json::from_slice(&bytes[end..end + length]).unwrap(),
    }
}
fn mock(status: u16, content_type: &str, body: String, truncate: bool) -> MockUpstream {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let (tx, captured) = mpsc::channel();
    let content_type = content_type.to_owned();
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut socket = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "router never contacted loopback upstream"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("accept: {e}"),
            }
        };
        // Windows may inherit nonblocking mode from the listener.
        socket.set_nonblocking(false).unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        tx.send(read_mock_request(&mut socket)).unwrap();
        let head=format!("HTTP/1.1 {status} Mock\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()+if truncate{77}else{0});
        socket.write_all(head.as_bytes()).unwrap();
        for chunk in body.as_bytes().chunks(7) {
            if socket.write_all(chunk).is_err() {
                break;
            }
        }
        let _ = socket.flush();
        let _ = socket.shutdown(Shutdown::Both);
    });
    MockUpstream {
        url: format!("http://127.0.0.1:{port}/v1"),
        captured,
        worker,
    }
}
fn fixture_route(protocol: Protocol, url: &str) -> AggregateProviderRoute {
    AggregateProviderRoute {
        source: Default::default(),
        provider_id: if protocol == Protocol::AnthropicMessages {
            "anthropic".into()
        } else {
            "openai".into()
        },
        provider_name: "Loopback fixture".into(),
        upstream_platform: if protocol == Protocol::AnthropicMessages {
            "anthropic".into()
        } else {
            "openai".into()
        },
        group_id: "fixture".into(),
        group_name: "Fixture".into(),
        group_rate_text: String::new(),
        public_model: "gaoge/fixture/group/test".into(),
        upstream_model: if protocol == Protocol::AnthropicMessages {
            "claude-opus-4-8".into()
        } else {
            "gpt-5.6-sol".into()
        },
        base_url: url.into(),
        api_key: "fixture-upstream-key".into(),
        protocol,
        model_config: json!({"fast":"supported"}),
    }
}
fn fixture_payload(route: &AggregateProviderRoute, stream: bool) -> Value {
    json!({"model":route.public_model,"stream":stream,"instructions":"Fixture instruction.","input":[{"role":"user","content":"Run pwd."}],"tools":[{"type":"namespace","name":"functions","tools":[{"type":"function","name":"run","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]}]})
}
fn invoke(
    route: AggregateProviderRoute,
    path: &str,
    payload: Value,
) -> (Result<(), String>, Vec<u8>) {
    let state = AggregateLoginState {
        enabled: true,
        router_port: 1,
        router_token: "fixture-local-router-token".into(),
        default_model: route.public_model.clone(),
        default_model_origin: "user".into(),
        speed_mode: "standard".into(),
        official_account_key: String::new(),
        routes: vec![route],
        recovery_models: Vec::new(),
        updated_at: 0,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let (mut writer, _) = listener.accept().unwrap();
    writer
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        client.read_to_end(&mut out).unwrap();
        out
    });
    let headers = HashMap::from([
        (
            "authorization".into(),
            "Bearer fixture-local-router-token".into(),
        ),
        ("x-api-key".into(), "fixture-local-router-token".into()),
        (
            "chatgpt-account-id".into(),
            "fixture-official-account".into(),
        ),
        ("anthropic-beta".into(), "fixture-unrelated-beta".into()),
        ("x-request-id".into(), "fixture-request-id".into()),
    ]);
    let result = crate::tests::with_temp_user_home("aggregate-http", |_| {
        forward_aggregate_response_request(
            &mut writer,
            path,
            &headers,
            &serde_json::to_vec(&payload).unwrap(),
            &state,
        )
    });
    if let Err(error) = &result {
        // Same failure contract as the outer HTTP handler.
        write_aggregate_json_response(&mut writer, 502, &json!({"error":{"message":error}}));
    }
    let _ = writer.shutdown(Shutdown::Write);
    drop(writer);
    (result, reader.join().unwrap())
}
fn split_reply(bytes: &[u8]) -> (&str, &[u8]) {
    let i = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("HTTP headers");
    (std::str::from_utf8(&bytes[..i]).unwrap(), &bytes[i + 4..])
}
fn sse(data: Value) -> String {
    format!("data: {data}\n\n")
}
fn response_events(bytes: &[u8]) -> Vec<Value> {
    let (_, body) = split_reply(bytes);
    std::str::from_utf8(body)
        .unwrap()
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(|v| serde_json::from_str(v).unwrap())
        .collect()
}
fn finish_mock(mock: MockUpstream) -> CapturedRequest {
    let request = mock.captured.recv_timeout(Duration::from_secs(5)).unwrap();
    mock.worker.join().unwrap();
    request
}

#[test]
fn aggregate_protocol_http_responses_keeps_native_wire_bytes() {
    let wire="event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_native\",\"output\":[],\"status\":\"completed\"}}\n\n";
    let upstream = mock(200, "text/event-stream", wire.into(), false);
    let route = fixture_route(Protocol::Responses, &upstream.url);
    let payload = fixture_payload(&route, true);
    let (result, reply) = invoke(route, "/v1/responses", payload);
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(split_reply(&reply).1, wire.as_bytes());
    let captured = finish_mock(upstream);
    assert_eq!(captured.path, "/v1/responses");
    assert_eq!(captured.body["model"], "gpt-5.6-sol");
    assert_eq!(
        captured.headers["authorization"],
        "Bearer fixture-upstream-key"
    );
    assert!(captured.body.get("messages").is_none());
}
#[test]
fn aggregate_protocol_http_chat_maps_route_auth_priority_and_namespace_stream() {
    let wire = sse(
        json!({"id":"chat_fixture","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tool_fixture","type":"function","function":{"name":"functions__run","arguments":"{\"command\":"}}]}}]}),
    ) + &sse(
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}),
    ) + &sse(json!({"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}))
        + "data: [DONE]\n\n";
    let upstream = mock(200, "text/event-stream; charset=utf-8", wire, false);
    let route = fixture_route(Protocol::ChatCompletions, &upstream.url);
    let mut payload = fixture_payload(&route, true);
    payload["service_tier"] = json!("fast");
    let (result, reply) = invoke(route, "/v1/responses", payload);
    assert!(result.is_ok(), "{result:?}");
    let captured = finish_mock(upstream);
    assert_eq!(captured.path, "/v1/chat/completions");
    assert_eq!(captured.body["model"], "gpt-5.6-sol");
    assert_eq!(captured.body["service_tier"], "priority");
    assert_eq!(
        captured.body["tools"][0]["function"]["name"],
        "functions__run"
    );
    assert_eq!(
        captured.headers["authorization"],
        "Bearer fixture-upstream-key"
    );
    assert!(!captured.headers.contains_key("x-api-key"));
    assert!(!captured.headers.contains_key("chatgpt-account-id"));
    assert!(!captured.headers.contains_key("anthropic-beta"));
    assert_eq!(captured.headers["x-request-id"], "fixture-request-id");
    let events = response_events(&reply);
    let final_response = &events.last().unwrap()["response"];
    assert_eq!(final_response["status"], "completed");
    assert_eq!(final_response["output"][0]["namespace"], "functions");
    assert_eq!(final_response["output"][0]["name"], "run");
    assert_eq!(final_response["output"][0]["call_id"], "tool_fixture");
    assert_eq!(final_response["usage"]["total_tokens"], 13);
}
#[test]
fn aggregate_protocol_http_anthropic_headers_and_multiturn_tools_are_native() {
    let body=json!({"id":"msg_fixture","type":"message","role":"assistant","content":[{"type":"text","text":"The folder is /project."}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}).to_string();
    let upstream = mock(200, "application/json", body, false);
    let route = fixture_route(Protocol::AnthropicMessages, &upstream.url);
    let mut payload = fixture_payload(&route, false);
    payload["input"].as_array_mut().unwrap().extend([json!({"type":"function_call","namespace":"functions","name":"run","call_id":"call_round_1","arguments":"{\"command\":\"pwd\"}"}),json!({"type":"function_call_output","call_id":"call_round_1","output":"/project"})]);
    let (result, reply) = invoke(route, "/responses", payload);
    assert!(result.is_ok(), "{result:?}");
    let captured = finish_mock(upstream);
    assert_eq!(captured.path, "/v1/messages");
    assert_eq!(captured.headers["x-api-key"], "fixture-upstream-key");
    assert_eq!(captured.headers["anthropic-version"], "2023-06-01");
    assert!(!captured.headers.contains_key("authorization"));
    assert!(!captured.headers.contains_key("chatgpt-account-id"));
    assert!(!format!("{captured:?}").contains("fixture-local-router-token"));
    assert_eq!(
        captured.body["messages"][1]["content"][0]["type"],
        "tool_use"
    );
    assert_eq!(
        captured.body["messages"][1]["content"][0]["id"],
        "call_round_1"
    );
    assert_eq!(
        captured.body["messages"][2]["content"][0]["tool_use_id"],
        "call_round_1"
    );
    let reply: Value = serde_json::from_slice(split_reply(&reply).1).unwrap();
    assert_eq!(reply["object"], "response");
    assert_eq!(
        reply["output"][0]["content"][0]["text"],
        "The folder is /project."
    );
    assert_eq!(reply["usage"]["total_tokens"], 15);
}
#[test]
fn aggregate_protocol_http_json_fallback_becomes_complete_sse() {
    let body=json!({"id":"chat_json","choices":[{"message":{"content":"JSON despite stream flag"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}).to_string();
    let upstream = mock(200, "application/json", body, false);
    let route = fixture_route(Protocol::ChatCompletions, &upstream.url);
    let payload = fixture_payload(&route, true);
    let (result, reply) = invoke(route, "/responses", payload);
    assert!(result.is_ok(), "{result:?}");
    finish_mock(upstream);
    assert!(split_reply(&reply)
        .0
        .to_ascii_lowercase()
        .contains("content-type: text/event-stream"));
    let events = response_events(&reply);
    assert_eq!(events[0]["type"], "response.created");
    assert!(events
        .iter()
        .any(|e| e["type"] == "response.output_text.delta"));
    assert_eq!(events.last().unwrap()["type"], "response.completed");
    assert_eq!(
        events.last().unwrap()["response"]["usage"]["total_tokens"],
        5
    );
}
#[test]
fn aggregate_protocol_http_errors_preserve_status_and_never_append_second_head() {
    let body =
        json!({"error":{"message":"fixture rejected","type":"authentication_error"}}).to_string();
    let upstream = mock(401, "application/json", body.clone(), false);
    let route = fixture_route(Protocol::ChatCompletions, &upstream.url);
    let payload = fixture_payload(&route, true);
    let (result, reply) = invoke(route, "/responses", payload);
    assert!(result.is_ok());
    finish_mock(upstream);
    assert!(split_reply(&reply).0.starts_with("HTTP/1.1 401"));
    assert_eq!(split_reply(&reply).1, body.as_bytes());
    assert_eq!(
        String::from_utf8_lossy(&reply).matches("HTTP/1.1").count(),
        1
    );
    for (truncate, tail, expected) in [
        (false, "", "response.incomplete"),
        (true, "", "response.failed"),
        (false, "data: {invalid}\n\n", "response.failed"),
    ] {
        let wire =
            sse(json!({"choices":[{"delta":{"content":"partial"},"finish_reason":null}]})) + tail;
        let upstream = mock(200, "text/event-stream", wire, truncate);
        let route = fixture_route(Protocol::ChatCompletions, &upstream.url);
        let payload = fixture_payload(&route, true);
        let (result, reply) = invoke(route, "/responses", payload);
        assert!(
            result.is_ok(),
            "SSE failure must be consumed after headers: {result:?}"
        );
        finish_mock(upstream);
        assert_eq!(
            String::from_utf8_lossy(&reply).matches("HTTP/1.1").count(),
            1
        );
        let events = response_events(&reply);
        assert_eq!(events.last().unwrap()["type"], expected);
        assert!(!events.iter().any(|e| e["type"] == "response.completed"));
    }
}
#[test]
fn aggregate_protocol_http_compact_rejection_never_contacts_upstream() {
    for protocol in [Protocol::ChatCompletions, Protocol::AnthropicMessages] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let route = fixture_route(
            protocol,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let payload = fixture_payload(&route, false);
        let (result, reply) = invoke(route, "/v1/responses/compact", payload);
        assert!(result.unwrap_err().contains("compact"));
        assert!(split_reply(&reply).0.starts_with("HTTP/1.1 502"));
        assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
    }
}
#[test]
fn aggregate_protocol_http_chat_developer_and_tool_images_remain_ordered() {
    let body=json!({"choices":[{"message":{"content":"I can see both outputs"},"finish_reason":"stop"}]}).to_string();
    let upstream = mock(200, "application/json", body, false);
    let route = fixture_route(Protocol::ChatCompletions, &upstream.url);
    let mut payload = fixture_payload(&route, false);
    payload["input"] = json!([{"role":"developer","content":"Fixture developer rule"},{"role":"user","content":"Inspect images"},{"type":"function_call","namespace":"functions","name":"run","call_id":"tool_a","arguments":"{}"},{"type":"function_call","namespace":"functions","name":"run","call_id":"tool_b","arguments":"{}"},{"type":"function_call_output","call_id":"tool_a","output":[{"type":"input_text","text":"First tool"},{"type":"input_image","image_url":"https://images.invalid/a.png"}]},{"type":"function_call_output","call_id":"tool_b","output":"Second tool"}]);
    let (result, _) = invoke(route, "/responses", payload);
    assert!(result.is_ok(), "{result:?}");
    let captured = finish_mock(upstream);
    let messages = captured.body["messages"].as_array().unwrap();
    assert!(!messages.iter().any(|m| m["role"] == "developer"));
    let tool_rows = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m["role"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(tool_rows.len(), 2);
    assert_eq!(tool_rows[1].0, tool_rows[0].0 + 1);
    let picture = &messages[tool_rows[1].0 + 1];
    assert_eq!(picture["role"], "user");
    assert_eq!(
        picture["content"][1]["image_url"]["url"],
        "https://images.invalid/a.png"
    );
    assert_eq!(tool_rows[0].1["content"][0]["text"], "First tool");
}
#[test]
fn aggregate_protocol_http_unknown_anthropic_tool_becomes_failure_not_panic() {
    let body = format!(
        "event: message_start\ndata: {}\n\nevent: content_block_start\ndata: {}\n\n",
        json!({"message":{"id":"msg_unknown","usage":{}}}),
        json!({"index":0,"content_block":{"type":"tool_use","id":"unknown_call","name":"not_declared","input":{}}})
    );
    let upstream = mock(200, "text/event-stream", body, false);
    let route = fixture_route(Protocol::AnthropicMessages, &upstream.url);
    let payload = fixture_payload(&route, true);
    let (result, reply) = invoke(route, "/responses", payload);
    assert!(
        result.is_ok(),
        "conversion error must be contained: {result:?}"
    );
    finish_mock(upstream);
    assert_eq!(
        String::from_utf8_lossy(&reply).matches("HTTP/1.1").count(),
        1
    );
    assert_eq!(
        response_events(&reply).last().unwrap()["type"],
        "response.failed"
    );
}
#[test]
fn aggregate_protocol_http_chat_keeps_custom_prefix_and_api_version() {
    let body = json!({"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}).to_string();
    let upstream = mock(200, "application/json", body, false);
    let base = upstream.url.trim_end_matches("/v1").to_owned() + "/v2/coding?api-version=fixture";
    let route = fixture_route(Protocol::ChatCompletions, &base);
    let payload = fixture_payload(&route, false);
    let (result, _) = invoke(route, "/responses?local=must-not-forward", payload);
    assert!(result.is_ok(), "{result:?}");
    let captured = finish_mock(upstream);
    assert_eq!(
        captured.path,
        "/v2/coding/chat/completions?api-version=fixture"
    );
}
