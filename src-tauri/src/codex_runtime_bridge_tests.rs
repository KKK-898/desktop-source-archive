use super::*;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

type Step = (&'static str, Vec<Value>, Value);

fn context(id: u64, unique: &str, frame: &str, default: bool) -> Value {
    json!({"method":"Runtime.executionContextCreated", "params":{"context":{
        "id":id,"uniqueId":unique,"auxData":{"frameId":frame,"isDefault":default}
    }}})
}
fn health(ready: bool, owner: Option<&str>) -> Value {
    json!({"result":{"type":"object","value":{"ready":ready,"owner":owner}}})
}
fn startup() -> Vec<Step> {
    vec![
        ("Page.enable", vec![], json!({})),
        (
            "Page.getFrameTree",
            vec![],
            json!({"frameTree":{"frame":{"id":"main"}}}),
        ),
        (
            "Runtime.enable",
            vec![
                context(1, "main-one", "main", true),
                context(2, "iframe", "child", true),
                context(3, "isolated-world", "main", false),
            ],
            json!({}),
        ),
    ]
}
fn mock(steps: Vec<Step>) -> (String, Arc<Mutex<Vec<Value>>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("ws://{}/bridge-test", listener.local_addr().unwrap());
    let received = Arc::new(Mutex::new(Vec::new()));
    let log = received.clone();
    let worker = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = tungstenite::accept(stream).unwrap();
        for (method, events, result) in steps {
            let message = match socket.read().unwrap() {
                Message::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
                _ => panic!("expected a CDP command"),
            };
            assert_eq!(message["method"], method);
            log.lock().unwrap().push(message.clone());
            for event in events {
                socket.send(Message::Text(event.to_string())).unwrap();
            }
            socket
                .send(Message::Text(
                    json!({"id":message["id"],"result":result}).to_string(),
                ))
                .unwrap();
        }
    });
    (url, received, worker)
}

#[test]
fn runtime_bridge_rejects_evaluation_exceptions_without_source_details() {
    let (url, _, worker) = mock(vec![(
        "Runtime.evaluate",
        vec![],
        json!({
            "exceptionDetails":{"text":"secret-binding-token", "exception":{"description":"secret-source"}}
        }),
    )]);
    let mut cdp = Cdp::connect(&url).unwrap();
    let error = cdp
        .command("Runtime.evaluate", json!({"expression":"fixture"}), &|| {
            true
        })
        .unwrap_err();
    assert!(error.contains("脚本执行失败"));
    assert!(!error.contains("secret"));
    worker.join().unwrap();
}

#[test]
fn runtime_bridge_missing_wrappers_are_installed_and_verified_in_main_world() {
    let mut steps = startup();
    steps.extend([
        (
            "Runtime.evaluate",
            vec![],
            health(false, Some("same-instance")),
        ),
        ("Runtime.removeBinding", vec![], json!({})),
        ("Runtime.addBinding", vec![], json!({})),
        (
            "Runtime.evaluate",
            vec![],
            health(true, Some("same-instance")),
        ),
        (
            "Runtime.evaluate",
            vec![],
            health(true, Some("same-instance")),
        ),
    ]);
    let (url, received, worker) = mock(steps);
    let mut cdp = Cdp::connect(&url).unwrap();
    cdp.initialize(&|| true).unwrap();
    assert!(cdp
        .ensure_installed("fixture-token", "same-instance", &|| true)
        .unwrap());
    worker.join().unwrap();
    assert_eq!(cdp.installed.as_ref().unwrap().id, 1);
    let received = received.lock().unwrap();
    assert_eq!(received[5]["params"]["executionContextId"], 1);
    for request in received
        .iter()
        .filter(|item| item["method"] == "Runtime.evaluate")
    {
        assert_eq!(request["params"]["uniqueContextId"], "main-one");
        assert!(request["params"].get("contextId").is_none());
    }
}

#[test]
fn runtime_bridge_healthy_instance_is_probed_without_reinstalling() {
    let mut steps = startup();
    steps.extend([
        (
            "Runtime.evaluate",
            vec![],
            health(true, Some("same-instance")),
        ),
        (
            "Runtime.evaluate",
            vec![],
            health(true, Some("same-instance")),
        ),
    ]);
    let (url, received, worker) = mock(steps);
    let mut cdp = Cdp::connect(&url).unwrap();
    cdp.initialize(&|| true).unwrap();
    assert!(cdp
        .ensure_installed("fixture-token", "same-instance", &|| true)
        .unwrap());
    let original = cdp.installed.clone();
    assert!(cdp
        .ensure_installed("fixture-token", "same-instance", &|| true)
        .unwrap());
    assert_eq!(original, cdp.installed);
    worker.join().unwrap();
    assert!(!received.lock().unwrap().iter().any(|request| matches!(
        request["method"].as_str(),
        Some("Runtime.addBinding" | "Runtime.removeBinding")
    )));
}

#[test]
fn runtime_bridge_command_wait_preserves_events_without_reusing_old_numeric_context() {
    let mut steps = startup();
    let old_binding = json!({"method":"Runtime.bindingCalled","params":{
        "name":"fixture","payload":"old","executionContextId":1
    }});
    steps.extend([
        (
            "Runtime.evaluate",
            vec![],
            health(true, Some("same-instance")),
        ),
        (
            "Runtime.evaluate",
            vec![
                old_binding,
                json!({"method":"Runtime.executionContextsCleared","params":{}}),
                context(1, "main-two", "main", true),
                context(6, "second-child", "child", true),
            ],
            health(true, Some("same-instance")),
        ),
        (
            "Runtime.evaluate",
            vec![],
            health(true, Some("same-instance")),
        ),
    ]);
    let (url, _, worker) = mock(steps);
    let mut cdp = Cdp::connect(&url).unwrap();
    cdp.initialize(&|| true).unwrap();
    assert!(cdp
        .ensure_installed("fixture-token", "same-instance", &|| true)
        .unwrap());
    let old_context = cdp.installed.clone().unwrap();
    assert!(!cdp
        .ensure_installed("fixture-token", "same-instance", &|| true)
        .unwrap());
    assert!(cdp.needs_context_install());
    assert!(cdp
        .ensure_installed("fixture-token", "same-instance", &|| true)
        .unwrap());
    assert_eq!(cdp.installed.as_ref().unwrap().unique_id, "main-two");
    let (binding, captured) = cdp.next_binding().unwrap().unwrap();
    assert_eq!(binding["params"]["payload"], "old");
    assert_eq!(captured, old_context);
    assert!(!cdp.is_current_context(&captured));
    // This must not produce another CDP command.
    cdp.send_reply(&captured, "obsolete".into(), &|| true)
        .unwrap();
    worker.join().unwrap();
}

#[test]
fn runtime_bridge_post_install_verification_is_required() {
    let mut steps = startup();
    steps.extend([
        ("Runtime.evaluate", vec![], health(false, None)),
        ("Runtime.removeBinding", vec![], json!({})),
        ("Runtime.addBinding", vec![], json!({})),
        (
            "Runtime.evaluate",
            vec![],
            health(true, Some("same-instance")),
        ),
        (
            "Runtime.evaluate",
            vec![],
            health(false, Some("same-instance")),
        ),
    ]);
    let (url, _, worker) = mock(steps);
    let mut cdp = Cdp::connect(&url).unwrap();
    cdp.initialize(&|| true).unwrap();
    assert!(cdp
        .ensure_installed("fixture-token", "same-instance", &|| true)
        .is_err());
    assert!(cdp.installed.is_none());
    worker.join().unwrap();
}

#[test]
fn runtime_bridge_inactive_generation_cannot_issue_commands() {
    let (url, received, worker) = mock(vec![]);
    let mut cdp = Cdp::connect(&url).unwrap();
    assert!(cdp
        .command("Runtime.addBinding", json!({}), &|| false)
        .is_err());
    assert!(received.lock().unwrap().is_empty());
    worker.join().unwrap();
}

#[test]
fn runtime_bridge_missing_unique_id_uses_scoped_numeric_context() {
    let value = Cdp::evaluation_params(
        &Context {
            id: 7,
            unique_id: String::new(),
            epoch: 2,
        },
        "fixture".into(),
    );
    assert_eq!(value["contextId"], 7);
    assert!(value.get("uniqueContextId").is_none());
}

#[test]
fn session_delete_bridge_isolated_browser_recovers_same_target() {
    let Ok(websocket_url) = std::env::var("GAOGE_TEST_BALANCE_CDP_WEBSOCKET") else {
        return;
    };
    use super::super::{
        cdp_evaluate_script, ensure_codex_session_delete_bridge, query_cdp_targets,
        stop_codex_session_delete_bridge,
    };
    let socket = url::Url::parse(&websocket_url).unwrap();
    assert_eq!(socket.scheme(), "ws");
    assert!(matches!(
        socket.host_str(),
        Some("localhost" | "127.0.0.1" | "::1")
    ));
    assert!(socket.path().starts_with("/devtools/page/"));
    let targets = query_cdp_targets(socket.port().unwrap()).unwrap();
    let page = targets
        .iter()
        .find(|target| target.web_socket_debugger_url.as_deref() == Some(&websocket_url))
        .expect("supplied endpoint must identify the owned isolated page");
    let page_url = url::Url::parse(&page.url).unwrap();
    assert_eq!(page.target_type, "page");
    assert_eq!(page_url.scheme(), "http");
    assert!(matches!(
        page_url.host_str(),
        Some("127.0.0.1" | "localhost" | "::1")
    ));
    assert_eq!(page_url.path(), "/gaoge-balance-bridge-isolated");
    struct StopBridge;
    impl Drop for StopBridge {
        fn drop(&mut self) {
            stop_codex_session_delete_bridge();
        }
    }
    let _cleanup = StopBridge;
    let evaluate = |script: &str| cdp_evaluate_script(&websocket_url, script).unwrap();
    assert_eq!(
        evaluate(
            r#"(() => {
      window.fixtureReadyEvents = 0;
      window.addEventListener('gaoge:runtime-bridge-ready', () => {
        window.fixtureReadyEvents++;
        window.fixtureReadyResponse = window.__gaogeSessionDeleteBridge('/status', {});
      });
      return location.pathname;
    })()"#
        ),
        "/gaoge-balance-bridge-isolated"
    );
    ensure_codex_session_delete_bridge(&websocket_url).unwrap();
    let status = evaluate(
        r#"(async () => ({
      ok:(await window.__gaogeSessionDeleteBridge('/status', {})).ok === true,
      readyEventCall:(await window.fixtureReadyResponse).ok === true,
      events:window.fixtureReadyEvents
    }))()"#,
    );
    assert_eq!(status["ok"], true);
    assert_eq!(status["readyEventCall"], true);
    assert_eq!(status["events"], 1);

    evaluate(
        r#"(() => {
      window.fixtureBridge = window.__gaogeSessionDeleteBridge;
      window.fixtureCallbacks = window.__gaogeSessionDeleteCallbacks;
      window.fixturePendingResolved = 0;
      window.fixturePendingTimer = setTimeout(() => {}, 60000);
      window.fixtureCallbacks.set('fixture-pending', {
        timer:window.fixturePendingTimer, resolve:() => { window.fixturePendingResolved++; }
      });
      return true;
    })()"#,
    );
    ensure_codex_session_delete_bridge(&websocket_url).unwrap();
    assert_eq!(
        evaluate(
            r#"(() => ({
      bridge:window.fixtureBridge === window.__gaogeSessionDeleteBridge,
      map:window.fixtureCallbacks === window.__gaogeSessionDeleteCallbacks,
      pending:window.fixtureCallbacks.has('fixture-pending'),
      resolved:window.fixturePendingResolved, events:window.fixtureReadyEvents
    }))()"#
        ),
        json!({"bridge":true,"map":true,"pending":true,"resolved":0,"events":1})
    );

    evaluate(
        r#"(() => {
      delete window.__gaogeSessionDeleteBridge;
      delete window.__gaogeSessionDeleteResolve;
      delete window.__gaogeSessionDeleteBridgeReady;
      return true;
    })()"#,
    );
    ensure_codex_session_delete_bridge(&websocket_url).unwrap();
    let restored = evaluate(
        r#"(async () => ({
      ok:(await window.__gaogeSessionDeleteBridge('/status', {})).ok === true,
      replaced:window.fixtureBridge !== window.__gaogeSessionDeleteBridge,
      pendingResolved:window.fixturePendingResolved, events:window.fixtureReadyEvents
    }))()"#,
    );
    assert_eq!(
        restored,
        json!({"ok":true,"replaced":true,"pendingResolved":1,"events":2})
    );
    evaluate("delete window.gaogeSessionDeleteBridgeV1; true");
    ensure_codex_session_delete_bridge(&websocket_url).unwrap();
    assert_eq!(
        evaluate(
            "window.__gaogeSessionDeleteBridge('/status', {}).then(result => result.ok === true)"
        ),
        true
    );

    // The same page target survives a real reload; the bridge restores itself
    // from default-main-world lifecycle events without a new ensure call.
    evaluate("setTimeout(() => location.reload(), 20); true");
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut restored_after_reload = false;
    while Instant::now() < deadline {
        let result = cdp_evaluate_script(
            &websocket_url,
            r#"(async () => {
          if (window.fixtureBridge || typeof window.__gaogeSessionDeleteBridge !== 'function') return false;
          return (await window.__gaogeSessionDeleteBridge('/status', {})).ok === true;
        })()"#,
        );
        if result.as_ref().ok().and_then(Value::as_bool) == Some(true) {
            restored_after_reload = true;
            break;
        }
        thread::sleep(Duration::from_millis(40));
    }
    assert!(
        restored_after_reload,
        "the bridge must recover after a same-target reload"
    );
    ensure_codex_session_delete_bridge(&websocket_url).unwrap();
    assert_eq!(
        evaluate(
            "window.__gaogeSessionDeleteBridge('/status', {}).then(result => result.ok === true)"
        ),
        true
    );
}

#[test]
fn runtime_bridge_retries_each_install_stage_when_context_replacement_is_observed() {
    for stage in 0..5 {
        let mut steps = startup();
        let methods = [
            "Runtime.evaluate",
            "Runtime.removeBinding",
            "Runtime.addBinding",
            "Runtime.evaluate",
            "Runtime.evaluate",
        ];
        let results = [
            health(false, None),
            json!({}),
            json!({}),
            health(true, Some("same-instance")),
            health(true, Some("same-instance")),
        ];
        for index in 0..=stage {
            if index == stage {
                steps.push((methods[index], vec![
                    json!({"method":"Runtime.executionContextDestroyed","params":{"executionContextId":1}}),
                    context(1,"replacement-main","main",true),
                ], json!({"exceptionDetails":{"text":"old context was destroyed"}})));
            } else {
                steps.push((methods[index], vec![], results[index].clone()));
            }
        }
        steps.push((
            "Runtime.evaluate",
            vec![],
            health(true, Some("same-instance")),
        ));
        let (url, _, worker) = mock(steps);
        let mut cdp = Cdp::connect(&url).unwrap();
        cdp.initialize(&|| true).unwrap();
        assert!(
            !cdp.ensure_installed("fixture-token", "same-instance", &|| true)
                .unwrap(),
            "stage {stage}"
        );
        assert!(cdp.installed.is_none());
        cdp.wait_until_installed("fixture-token", "same-instance", &|| true)
            .unwrap();
        assert_eq!(
            cdp.installed.as_ref().unwrap().unique_id,
            "replacement-main"
        );
        worker.join().unwrap();
    }
}

#[test]
fn runtime_bridge_stable_context_exception_is_never_reported_ready() {
    let mut steps = startup();
    steps.push((
        "Runtime.evaluate",
        vec![],
        json!({"exceptionDetails":{"text":"fixture secret"}}),
    ));
    let (url, _, worker) = mock(steps);
    let mut cdp = Cdp::connect(&url).unwrap();
    cdp.initialize(&|| true).unwrap();
    let error = cdp
        .ensure_installed("fixture-token", "same-instance", &|| true)
        .unwrap_err();
    assert!(error.contains("脚本执行失败"));
    assert!(!error.contains("secret"));
    assert!(cdp.installed.is_none());
    worker.join().unwrap();
}

#[test]
fn runtime_bridge_generation_retired_during_command_cannot_report_ready() {
    use std::cell::Cell;
    let (url, _, worker) = mock(vec![(
        "Runtime.evaluate",
        vec![],
        health(true, Some("old-instance")),
    )]);
    let mut cdp = Cdp::connect(&url).unwrap();
    let checks = Cell::new(0);
    let active = || {
        let value = checks.get() + 1;
        checks.set(value);
        value < 3
    };
    assert!(cdp
        .command("Runtime.evaluate", json!({"expression":"fixture"}), &active)
        .is_err());
    assert!(cdp.installed.is_none());
    worker.join().unwrap();
}
