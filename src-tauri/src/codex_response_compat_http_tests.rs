mod response_compat_http_regressions {
    use super::*;

    struct MockReply {
        status: u16,
        body: String,
        content_type: &'static str,
        chunk_size: usize,
        delay_ms: u64,
        declared_extra: usize,
    }

    impl MockReply {
        fn json(status: u16, body: String) -> Self {
            Self {
                status,
                body,
                content_type: "application/json",
                chunk_size: usize::MAX,
                delay_ms: 0,
                declared_extra: 0,
            }
        }
        fn sse(body: String) -> Self {
            Self {
                content_type: "text/event-stream; charset=utf-8",
                ..Self::json(200, body)
            }
        }
    }

    fn forward_fixture(replies: Vec<(u16, String)>) -> (String, Vec<Value>) {
        forward_fixture_with_input(
            replies,
            json!([{"type":"web_search_call","id":"ws_test",
            "status":"completed","action":{"type":"search","query":"synthetic preserved query"}},
            {"type":"message","role":"user","content":"continue"}]),
        )
    }

    fn forward_fixture_with_input(
        replies: Vec<(u16, String)>,
        input: Value,
    ) -> (String, Vec<Value>) {
        let (response, requests, result) = forward_fixture_with_replies(
            replies
                .into_iter()
                .map(|(status, body)| MockReply::json(status, body))
                .collect(),
            json!({"input":input}),
        );
        result.unwrap();
        (response, requests)
    }

    fn forward_fixture_with_replies(
        replies: Vec<MockReply>,
        mut payload: Value,
    ) -> (String, Vec<Value>, Result<(), String>) {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        upstream.set_nonblocking(true).unwrap();
        let mock = thread::spawn(move || {
            let mut requests = Vec::new();
            let expected_requests = replies.len();
            for (reply_index, reply) in replies.into_iter().enumerate() {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match upstream.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!(
                            "expected local upstream request {}/{} after {} received: {e}",
                            reply_index + 1, expected_requests, requests.len()
                        ),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let (_, _, headers, request) = read_aggregate_http_request(&mut socket).unwrap();
                assert_eq!(
                    headers.get("authorization").unwrap(),
                    "Bearer synthetic-only"
                );
                requests.push(serde_json::from_slice::<Value>(&request).unwrap());
                let crlf = String::from_utf8(vec![13, 10]).unwrap();
                let response = format!("HTTP/1.1 {} Mock{crlf}Content-Type: {}{crlf}X-Mock-Result: preserved{crlf}Content-Length: {}{crlf}Connection: close{crlf}{crlf}", reply.status, reply.content_type, reply.body.len() + reply.declared_extra);
                socket.write_all(response.as_bytes()).unwrap();
                thread::sleep(Duration::from_millis(reply.delay_ms));
                for chunk in reply.body.as_bytes().chunks(reply.chunk_size) {
                    socket.write_all(chunk).unwrap();
                    socket.flush().unwrap();
                }
            }
            requests
        });
        let client_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut output = TcpStream::connect(client_listener.local_addr().unwrap()).unwrap();
        output
            .set_read_timeout(Some(Duration::from_secs(8)))
            .unwrap();
        let (mut router, _) = client_listener.accept().unwrap();
        let worker = thread::spawn(move || {
            let route = AggregateProviderRoute {
                source: Default::default(),
                protocol: Default::default(),
                // This synthetic endpoint accepts priority; recovery tests must
                // not depend on native user caches or infer Fast from a model ID.
                model_config: json!({"fast":"supported"}),
                provider_id: "openai".into(),
                provider_name: "Synthetic".into(),
                upstream_platform: "openai".into(),
                group_id: "test".into(),
                group_name: "Synthetic".into(),
                group_rate_text: String::new(),
                public_model: "gaoge/openai/test/gpt-5.4".into(),
                upstream_model: "gpt-5.4".into(),
                base_url: format!("http://{upstream_addr}/v1"),
                api_key: "synthetic-only".into(),
            };
            let mut state = default_aggregate_login_state();
            state.enabled = true;
            state.default_model = route.public_model.clone();
            state.routes = vec![route];
            payload["model"] = json!(state.default_model);
            let body = serde_json::to_vec(&payload).unwrap();
            forward_aggregate_response_request(
                &mut router,
                "/v1/responses",
                &HashMap::new(),
                &body,
                &state,
            )
        });
        let mut response = String::new();
        output.read_to_string(&mut response).unwrap();
        let result = worker.join().unwrap();
        let requests = mock.join().unwrap_or_else(|_| {
            panic!("mock upstream did not finish; forwarding result: {result:?}")
        });
        (response, requests, result)
    }

    fn rejection() -> String {
        json!({"error":{"message":"Responses input item type 'web_search_call' is not supported."}})
            .to_string()
    }

    fn tool_rejection() -> String {
        json!({"error":{"message":"A tool call is missing its matching output. Resend the complete tool-call and tool-output context."}}).to_string()
    }

    fn tool_input() -> Value {
        json!([{"type":"message","role":"user","content":"original project goal"},
            {"type":"function_call","call_id":"missing","name":"state_change","arguments":"{original:17}"},
            {"type":"function_call","call_id":"real","name":"read_file","arguments":"{}"},
            {"type":"function_call_output","call_id":"real","output":"exact real result"},
            {"type":"message","role":"user","content":"continue same conversation"}])
    }

    fn custom_input() -> Value {
        json!([
            {"type":"message","role":"user","content":"original project goal"},
            {"type":"custom_tool_call","call_id":"ctc_missing","name":"apply_patch","input":"original patch"},
            {"type":"custom_tool_call","call_id":"ctc_saved","name":"read","input":"original input"},
            {"type":"custom_tool_call_output","call_id":"ctc_saved","output":"exact original result"},
            {"type":"message","role":"assistant","content":"previous answer"},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"continue same conversation"},
                {"type":"input_image","image_url":"data:image/png;base64,synthetic"}]}
        ])
    }

    fn screenshot_error() -> Value {
        json!({"type":"invalid_request_error","message":"stream disconnected before completion: No tool output found for custom tool call ctc_missing."})
    }

    fn sse_event(value: Value) -> String {
        format!(
            "event: {}\ndata: {value}\n\n",
            value["type"].as_str().unwrap()
        )
    }

    fn sse_pair_error() -> String {
        sse_event(json!({"type":"error","error":screenshot_error()}))
    }

    #[test]
    fn exact_screenshot_http_errors_recover_custom_history_with_attachments() {
        for status in [400, 422] {
            let (response, requests) = forward_fixture_with_input(
                vec![
                    (status, json!({"error":screenshot_error()}).to_string()),
                    (200, "continued".into()),
                ],
                custom_input(),
            );
            assert!(response.ends_with("continued"));
            assert_eq!(requests.len(), 2);
            for index in [0, 4, 5] {
                assert_eq!(requests[0]["input"][index], requests[1]["input"][index]);
            }
            let context = requests[1]["input"].to_string();
            for text in [
                "UNKNOWN",
                "original patch",
                "exact original result",
                "previous answer",
            ] {
                assert!(context.contains(text));
            }
        }
    }

    #[test]
    fn initial_sse_validation_errors_recover_once_before_forwarding() {
        for status in [200, 400, 422] {
            for error in [
                sse_pair_error(),
                sse_event(json!({"type":"response.failed","response":{
                "status":"failed","output":[],"error":screenshot_error()}})),
            ] {
                let accepted =
                    sse_event(json!({"type":"response.created","response":{"id":"new"}}));
                let reply = MockReply {
                    status,
                    chunk_size: 7,
                    ..MockReply::sse(format!(": keepalive\n\n{error}"))
                };
                let payload = json!({"input":custom_input(),"tools":[{"type":"custom","name":"apply_patch"}],"stream":true,"service_tier":"priority"});
                let (response, requests, result) = forward_fixture_with_replies(
                    vec![reply, MockReply::sse(accepted.clone())],
                    payload.clone(),
                );
                result.unwrap();
                assert!(response.starts_with("HTTP/1.1 200"));
                assert!(response.ends_with(&accepted));
                assert!(!response.contains("ctc_missing"));
                assert_eq!(response.matches("HTTP/1.1").count(), 1);
                assert_eq!(requests.len(), 2);
                for key in ["tools", "stream", "service_tier"] {
                    // Aggregate policy may normalize speed before forwarding;
                    // recovery must preserve that effective original request.
                    assert_eq!(requests[1][key], requests[0][key]);
                }
                for index in [0, 4, 5] {
                    assert_eq!(requests[1]["input"][index], payload["input"][index]);
                }
            }
        }
    }

    #[test]
    fn sse_errors_after_any_accepted_event_are_forwarded_without_replay() {
        for value in [
            json!({"type":"response.created"}),
            json!({"type":"response.in_progress"}),
            json!({"type":"response.output_text.delta","delta":"already answered"}),
            json!({"type":"response.output_item.added","item":{"type":"custom_tool_call"}}),
        ] {
            let body = sse_event(value) + &sse_pair_error();
            let (response, requests, result) = forward_fixture_with_replies(
                vec![MockReply::sse(body.clone())],
                json!({"input":custom_input()}),
            );
            result.unwrap();
            assert!(response.ends_with(&body));
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["input"], custom_input());
        }
    }

    #[test]
    fn sse_retry_failure_is_returned_without_another_recovery() {
        for second in [
            MockReply::sse(sse_pair_error()),
            MockReply::json(429, "quota exceeded".into()),
            MockReply::json(400, json!({"error":screenshot_error()}).to_string()),
        ] {
            let expected = second.body.clone();
            let (response, requests, result) = forward_fixture_with_replies(
                vec![MockReply::sse(sse_pair_error()), second],
                json!({"input":custom_input()}),
            );
            result.unwrap();
            assert!(response.ends_with(&expected));
            assert_eq!(response.matches("HTTP/1.1").count(), 1);
            assert_eq!(requests.len(), 2);
        }
    }

    #[test]
    fn slow_oversized_incomplete_or_uncertain_streams_never_retry() {
        let mut slow = MockReply::sse(sse_pair_error());
        slow.delay_ms = (codex_response_stream::PROBE_TIMEOUT.as_millis() + 200) as u64;
        for reply in [
            slow,
            MockReply::sse(format!(
                ":{}\n\n{}",
                "x".repeat(codex_response_stream::PREFIX_LIMIT),
                sse_pair_error()
            )),
            MockReply::sse(sse_pair_error().trim_end().into()),
            MockReply::sse(sse_event(
                json!({"type":"error","error":{"code":"server_error","message":screenshot_error()["message"]}}),
            )),
            MockReply {
                status: 429,
                ..MockReply::sse(sse_pair_error())
            },
        ] {
            let expected = reply.body.clone();
            let (response, requests, result) =
                forward_fixture_with_replies(vec![reply], json!({"input":custom_input()}));
            result.unwrap();
            assert!(response.ends_with(&expected));
            assert_eq!(requests.len(), 1);
        }
    }

    #[test]
    fn truncated_stream_preserves_received_bytes_and_does_not_replay() {
        let body = sse_event(json!({"type":"response.output_text.delta","delta":"partial answer"}));
        let (response, requests, result) = forward_fixture_with_replies(
            vec![MockReply {
                declared_extra: 100,
                ..MockReply::sse(body.clone())
            }],
            json!({"input":custom_input()}),
        );
        assert!(result.is_err());
        assert!(response.ends_with(&body));
        assert_eq!(response.matches("HTTP/1.1").count(), 1);
        assert_eq!(requests.len(), 1);
    }

    #[test]
    fn sse_hidden_history_and_no_repairable_records_are_preserved() {
        for payload in [
            json!({"input":custom_input(),"previous_response_id":"hidden"}),
            json!({"input":custom_input(),"conversation":"hidden"}),
            json!({"input":[{"type":"message","role":"user","content":"continue"}]}),
        ] {
            let (response, requests, result) = forward_fixture_with_replies(
                vec![MockReply::sse(sse_pair_error())],
                payload.clone(),
            );
            result.unwrap();
            assert!(response.ends_with(&sse_pair_error()));
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["input"], payload["input"]);
        }
    }

    #[test]
    #[ignore = "requires the isolated native tool verifier's marked synthetic fixture"]
    fn native_tool_recovery_proxy() {
        let home = PathBuf::from(
            std::env::var_os("GAOGE_SYNTHETIC_HISTORY_HOME").expect("synthetic fixture required"),
        )
        .canonicalize()
        .unwrap();
        let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/conversation-verification")
            .canonicalize()
            .unwrap();
        assert!(home.starts_with(&allowed));
        assert_eq!(home.file_name().unwrap(), ".codex");
        assert_eq!(
            fs::read_to_string(home.join("gaoge-synthetic-history-fixture")).unwrap(),
            "synthetic-only"
        );
        let upstream: std::net::SocketAddr = std::env::var("GAOGE_SYNTHETIC_UPSTREAM")
            .expect("local mock required")
            .parse()
            .unwrap();
        assert_eq!(
            upstream.ip(),
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        );
        assert_ne!(upstream.port(), 0);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let route = AggregateProviderRoute {
            source: Default::default(),
            protocol: Default::default(),
            model_config: Value::Null,
            provider_id: "openai".into(),
            provider_name: "Synthetic".into(),
            upstream_platform: "openai".into(),
            group_id: "test".into(),
            group_name: "Synthetic".into(),
            group_rate_text: String::new(),
            public_model: "gaoge-conversation-verification".into(),
            upstream_model: "gaoge-conversation-verification".into(),
            base_url: format!("http://{upstream}/v1"),
            api_key: "synthetic-only".into(),
        };
        let mut state = default_aggregate_login_state();
        state.enabled = true;
        state.default_model = route.public_model.clone();
        state.routes = vec![route];
        fs::write(
            home.join("gaoge-test-proxy.json"),
            json!({"port":listener.local_addr().unwrap().port()}).to_string(),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut forwarded = 0;
        loop {
            assert!(
                Instant::now() < deadline,
                "synthetic proxy did not shut down"
            );
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => panic!("synthetic listener failed: {error}"),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(8)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(8)))
                .unwrap();
            let (method, path, headers, body) = read_aggregate_http_request(&mut stream).unwrap();
            assert_eq!(
                headers.get("authorization").map(String::as_str),
                Some("Bearer synthetic-only")
            );
            assert_eq!(method, "POST");
            if path == "/__shutdown" {
                write_aggregate_json_response(&mut stream, 200, &json!({"forwarded":forwarded}));
                assert!(forwarded >= 5, "native test did not exercise the proxy");
                break;
            }
            assert_eq!(path, "/v1/responses");
            forward_aggregate_response_request(&mut stream, &path, &headers, &body, &state)
                .unwrap();
            forwarded += 1;
        }
    }

    #[test]
    fn tool_pair_rejection_recovers_same_request_context_exactly_once() {
        for status in [400, 422] {
            let (response, requests) = forward_fixture_with_input(
                vec![(status, tool_rejection()), (200, "continued".into())],
                tool_input(),
            );
            assert!(response.ends_with("continued"));
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0]["input"], tool_input());
            assert_eq!(requests[1]["input"][0], requests[0]["input"][0]);
            assert_eq!(requests[1]["input"][4], requests[0]["input"][4]);
            let text = requests[1]["input"].to_string();
            assert!(text.contains("UNKNOWN"));
            assert!(text.contains("exact real result"));
            assert!(text.contains("original:17"));
        }
        let (response, requests) = forward_fixture_with_input(
            vec![(400, tool_rejection()), (400, tool_rejection())],
            tool_input(),
        );
        assert!(response.starts_with("HTTP/1.1 400"));
        assert_eq!(requests.len(), 2);
    }

    #[test]
    fn tool_recovery_does_not_replay_accepted_unauthorized_or_uncertain_requests() {
        for status in [200, 401, 403, 429, 500, 503] {
            let (response, requests) =
                forward_fixture_with_input(vec![(status, tool_rejection())], tool_input());
            assert!(response.starts_with(&format!("HTTP/1.1 {status}")));
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["input"], tool_input());
        }
    }

    #[test]
    fn search_validation_rejection_retries_once_without_losing_context() {
        for status in [400, 422] {
            let (response, requests) =
                forward_fixture(vec![(status, rejection()), (200, "accepted".into())]);
            assert!(response.starts_with("HTTP/1.1 200"));
            assert!(response.ends_with("accepted"));
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0]["input"][0]["type"], "web_search_call");
            assert_eq!(requests[1]["input"][0]["type"], "message");
            assert!(requests[1]["input"][0]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("synthetic preserved query"));
            assert_eq!(requests[0]["input"][1], requests[1]["input"][1]);
        }
    }

    #[test]
    fn native_search_and_unrelated_errors_are_forwarded_without_retry() {
        for (status, body) in [
            (200, "native success".into()),
            (401, rejection()),
            (429, rejection()),
            (500, rejection()),
            (400, "unrelated validation error".into()),
            (422, "x".repeat(70_000)),
        ] {
            let (response, requests) = forward_fixture(vec![(status, body.clone())]);
            assert!(response.starts_with(&format!("HTTP/1.1 {status}")));
            assert!(response.contains("x-mock-result: preserved"));
            assert!(response.ends_with(&body));
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["input"][0]["type"], "web_search_call");
        }
    }

    #[test]
    fn repeated_search_rejection_never_creates_an_infinite_retry_loop() {
        let (response, requests) = forward_fixture(vec![(400, rejection()), (400, rejection())]);
        assert!(response.starts_with("HTTP/1.1 400"));
        assert!(response.ends_with(&rejection()));
        assert_eq!(requests.len(), 2);
    }
}
