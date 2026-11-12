//! Native Fast uses the original Codex controls and the pinned upstream gate adapters.
//! Prepare the module graph in the current document, then install it before the
//! next document is parsed. Only the executed compiled marker verifies readiness.
use super::*;

const SCRIPT: &str = concat!(
    "if (!window.__codexPlusNativeFastRspack) {\n",
    include_str!("third_party/codex-plus-plus/native-fast-rspack.js"),
    "\n}\n",
    "if (!window.__codexPlusNativeFastUnlock) {\n",
    include_str!("third_party/codex-plus-plus/native-fast-unlock.js"),
    "\nwindow.__GAOGE_OWNS_NATIVE_FAST_HELPER__ = true;\n}\n",
    include_str!("codex_native_fast_runtime.js")
);
const MAX_PREPARED_BYTES: usize = 48 * 1024 * 1024;
const CONTEXT_UNAVAILABLE: &str = "Fast renderer context unavailable";
static GENERATION: AtomicU64 = AtomicU64::new(1);
static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));
static LAUNCH_PERMIT: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));
struct Session {
    key: String,
    scope_key: String,
    generation: u64,
    value: Value,
    updated: Instant,
    running: bool,
}

pub(super) fn note_launch() {
    if let Ok(mut permit) = LAUNCH_PERMIT.lock() {
        *permit = Some(Instant::now());
    }
}
fn take_launch_permit() -> bool {
    LAUNCH_PERMIT
        .lock()
        .ok()
        .and_then(|mut permit| permit.take())
        .is_some_and(|started| started.elapsed() < Duration::from_secs(60))
}
pub(super) fn reset() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut session) = SESSION.lock() {
        *session = None;
    }
    if let Ok(mut permit) = LAUNCH_PERMIT.lock() {
        *permit = None;
    }
}
pub(super) fn state() -> Value {
    let fuel = codex_fuel_runtime_state();
    let local_api = codex_api_coding_mode_enabled();
    let enabled = json_bool(&fuel, "enabled")
        && local_api
        && matches!(json_str(&fuel, "mode").as_str(), "relay" | "aggregate");
    let mut digest = Sha256::new();
    digest.update(
        format!(
            "{}:{}:{}:{}",
            current_codex_runtime_revision(),
            enabled,
            json_str(&fuel, "mode"),
            json_str(&fuel, "baseUrl")
        )
        .as_bytes(),
    );
    json!({"enabled":enabled,"localApiConfigured":enabled,"scopeKey":format!("{:x}",digest.finalize())})
}
fn pending(reason: &str, enabled: bool) -> Value {
    json!({"enabled":enabled,"ready":false,"verified":false,"reason":reason,
        "needsRestart":enabled && reason == "awaiting-restart","version":1})
}
fn publish(generation: u64, value: Value) {
    if let Ok(mut session) = SESSION.lock() {
        if let Some(session) = session.as_mut().filter(|s| s.generation == generation) {
            session.value = value;
            session.updated = Instant::now();
        }
    }
}
fn observed_status(session: &Session, expected: &Value) -> Value {
    if session.scope_key != json_str(expected, "scopeKey")
        || session.generation != GENERATION.load(Ordering::SeqCst)
    {
        return pending("awaiting-page", true);
    }
    if session.updated.elapsed() > Duration::from_secs(15) {
        return pending("connection-unavailable", true);
    }
    session.value.clone()
}
pub(super) fn status() -> Value {
    let expected = state();
    if !json_bool(&expected, "enabled") {
        return pending("disabled", false);
    }
    SESSION
        .lock()
        .ok()
        .and_then(|session| {
            session
                .as_ref()
                .map(|session| observed_status(session, &expected))
        })
        .unwrap_or_else(|| pending("awaiting-page", true))
}

pub(super) fn ensure(websocket_url: &str) {
    let expected = state();
    if !json_bool(&expected, "enabled") {
        if SESSION.lock().ok().is_some_and(|s| s.is_some()) {
            reset();
        }
        return;
    }
    let scope_key = json_str(&expected, "scopeKey");
    let key = format!("{websocket_url}:{scope_key}");
    let generation;
    {
        let Ok(mut session) = SESSION.lock() else {
            return;
        };
        if session.as_ref().is_some_and(|s| {
            s.key == key && (s.running || s.updated.elapsed() < Duration::from_secs(60))
        }) {
            return;
        }
        generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        *session = Some(Session {
            key,
            scope_key,
            generation,
            value: pending("preparing-modules", true),
            updated: Instant::now(),
            running: true,
        });
    }
    let target = websocket_url.to_string();
    let spawned = thread::Builder::new()
        .name("codex-native-fast".into())
        .spawn(move || {
            let result = run(&target, &expected, generation);
            if result.is_err() && GENERATION.load(Ordering::SeqCst) == generation {
                publish(generation, pending("native-fast-unavailable", true));
                log::warn!("原生 Fast 适配尚未完成，稍后重试；原生标准模式保持可用。");
            }
            if let Ok(mut session) = SESSION.lock() {
                if let Some(session) = session.as_mut().filter(|s| s.generation == generation) {
                    session.running = false;
                }
            }
        });
    if spawned.is_err() {
        publish(generation, pending("connection-unavailable", true));
        if let Ok(mut session) = SESSION.lock() {
            if let Some(session) = session.as_mut().filter(|s| s.generation == generation) {
                session.running = false;
            }
        }
    }
}

type Socket = tungstenite::WebSocket<TcpStream>;
fn connect(target: &str) -> Result<Socket, String> {
    let parsed = url::Url::parse(target).map_err(|_| "Invalid Fast CDP target")?;
    let host = parsed.host_str().ok_or("Missing Fast CDP host")?;
    if parsed.scheme() != "ws"
        || !matches!(host, "127.0.0.1" | "::1" | "localhost")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Fast CDP requires loopback".into());
    }
    let port = parsed
        .port_or_known_default()
        .ok_or("Missing Fast CDP port")?;
    let mut stream = None;
    for address in (host, port)
        .to_socket_addrs()
        .map_err(|_| "Invalid Fast CDP address")?
    {
        if let Ok(connected) = TcpStream::connect_timeout(&address, Duration::from_secs(3)) {
            stream = Some(connected);
            break;
        }
    }
    let stream = stream.ok_or("Fast CDP connection unavailable")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|_| "Fast CDP read timeout")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "Fast CDP write timeout")?;
    websocket_client(target, stream)
        .map(|(socket, _)| socket)
        .map_err(|_| "Fast CDP handshake failed".into())
}
fn command(
    socket: &mut Socket,
    next_id: &mut u64,
    method: &str,
    params: Value,
    generation: u64,
) -> Result<Value, String> {
    if GENERATION.load(Ordering::SeqCst) != generation {
        return Err("Fast CDP cancelled".into());
    }
    // A registration already sent must yield its identifier even if this worker
    // is cancelled, so the outer cleanup can remove the registered bootstrap.
    let cancellation = (method != "Page.addScriptToEvaluateOnNewDocument").then_some(generation);
    finish_command(
        socket,
        next_id,
        method,
        params,
        cancellation,
        Duration::from_secs(45),
    )
}
fn finish_command(
    socket: &mut Socket,
    next_id: &mut u64,
    method: &str,
    params: Value,
    generation: Option<u64>,
    timeout: Duration,
) -> Result<Value, String> {
    *next_id += 1;
    let id = *next_id;
    socket
        .send(WebSocketMessage::Text(
            json!({"id":id,"method":method,"params":params}).to_string(),
        ))
        .map_err(|_| "Fast CDP disconnected")?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline
        && generation.map_or(true, |generation| {
            GENERATION.load(Ordering::SeqCst) == generation
        })
    {
        let message = match socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return Err("Fast CDP disconnected".into()),
        };
        match message {
            WebSocketMessage::Ping(payload) => {
                let _ = socket.send(WebSocketMessage::Pong(payload));
            }
            WebSocketMessage::Close(_) => return Err("Fast CDP disconnected".into()),
            WebSocketMessage::Text(text) => {
                let value: Value =
                    serde_json::from_str(&text).map_err(|_| "Invalid Fast CDP response")?;
                if value["id"].as_u64() != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    let description = json_str(error, "message").to_ascii_lowercase();
                    if method == "Runtime.evaluate"
                        && (description.contains("execution context")
                            || description.contains("cannot find context")
                            || description.contains("navigated"))
                    {
                        return Err(CONTEXT_UNAVAILABLE.into());
                    }
                    return Err("Fast CDP command failed".into());
                }
                return Ok(value["result"].clone());
            }
            _ => {}
        }
    }
    Err("Fast CDP command expired".into())
}
fn evaluate(
    socket: &mut Socket,
    next_id: &mut u64,
    expression: String,
    generation: u64,
) -> Result<Value, String> {
    let result = command(
        socket,
        next_id,
        "Runtime.evaluate",
        json!({"expression":expression,
        "awaitPromise":true,"returnByValue":true,"allowUnsafeEvalBlockedByCSP":true}),
        generation,
    )?;
    if result.get("exceptionDetails").is_some() {
        return Err("Fast renderer evaluation failed".into());
    }
    Ok(result["result"]["value"].clone())
}
fn valid_prepared(value: &Value) -> bool {
    if !json_bool(value, "ok")
        || value["version"].as_u64() != Some(1)
        || value["diagnostics"]["rewriters"]["fast"].as_str() != Some("patched")
    {
        return false;
    }
    let Some(modules) = value["modules"].as_array() else {
        return false;
    };
    if modules.is_empty() || modules.len() > 8 {
        return false;
    }
    let mut total = 0usize;
    let mut urls = HashSet::new();
    let mut entry = false;
    for module in modules {
        let (Some(raw_url), Some(source)) =
            (module["url"].as_str(), module["patchedSource"].as_str())
        else {
            return false;
        };
        let Ok(url) = url::Url::parse(raw_url) else {
            return false;
        };
        let Some(basename) = url.path().strip_prefix("/assets/") else {
            return false;
        };
        if url.scheme() != "app"
            || url.host_str() != Some("-")
            || url.port().is_some()
            || !basename.ends_with(".js")
            || !basename
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !urls.insert(raw_url)
            || source.is_empty()
            || source.len() > 26 * 1024 * 1024
        {
            return false;
        }
        total = total.saturating_add(source.len());
        entry |= source.contains("window.__codexPlusNativeFastCompiled=\"v1\";");
    }
    total <= MAX_PREPARED_BYTES && entry
}
fn run(target: &str, expected: &Value, generation: u64) -> Result<(), String> {
    run_with_state(target, expected, generation, state)
}
fn run_with_state<F: Fn() -> Value>(
    target: &str,
    expected: &Value,
    generation: u64,
    read_state: F,
) -> Result<(), String> {
    let mut socket = connect(target)?;
    let mut next_id = 0;
    let mut script_id: Option<String> = None;
    let owner =
        serde_json::to_string(&format!("{}:{generation}", PROCESS_INSTANCE_ID.as_str())).unwrap();
    let is_current = || {
        GENERATION.load(Ordering::SeqCst) == generation
            && read_state()["scopeKey"] == expected["scopeKey"]
    };
    let result = (|| {
        command(
            &mut socket,
            &mut next_id,
            "Page.enable",
            json!({}),
            generation,
        )?;
        let prepared = evaluate(&mut socket, &mut next_id,
            format!("{SCRIPT}\nwindow.__GAOGE_NATIVE_FAST_OWNER__={owner};\ninstallCodexNativeFastRuntime({expected}).prepare()"), generation)?;
        if !is_current() {
            return Ok(());
        }
        let mut navigation_started: Option<Instant> = None;
        if !json_bool(&prepared, "alreadyCompiled") {
            if !valid_prepared(&prepared) {
                publish(generation, pending("unsupported-modules", true));
                return Ok(());
            }
            let source = format!("if(window===window.top && location.protocol==='app:' && location.host==='-'){{\n{SCRIPT}\nwindow.__GAOGE_NATIVE_FAST_OWNER__={owner};\ninstallCodexNativeFastRuntime({expected}).installPrepared({prepared});\n}}");
            let registration = command(
                &mut socket,
                &mut next_id,
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source":source}),
                generation,
            )?;
            script_id = registration["identifier"].as_str().map(str::to_string);
            if script_id.is_none() {
                return Err("Fast new-document registration failed".into());
            }
            if !is_current() {
                return Ok(());
            }
            let reload = take_launch_permit();
            publish(
                generation,
                pending(
                    if reload {
                        "awaiting-page"
                    } else {
                        "awaiting-restart"
                    },
                    true,
                ),
            );
            if reload {
                navigation_started = Some(Instant::now());
                command(
                    &mut socket,
                    &mut next_id,
                    "Page.reload",
                    json!({"ignoreCache":true}),
                    generation,
                )?;
                invalidate_codex_runtime_injection_state();
            }
        }
        let mut missing_context_since = None;
        while is_current() {
            let current = read_state();
            match evaluate(&mut socket, &mut next_id,
                format!("typeof installCodexNativeFastRuntime==='function'?installCodexNativeFastRuntime({current}).status():null"), generation) {
                Ok(value) if value.is_object() => {
                    missing_context_since = None;
                    // Reload can acknowledge before the old document disappears.
                    // Its prepared status must not ask the user for a second restart.
                    if let Some(started) = navigation_started.filter(|_|
                        json_bool(&value, "needsRestart") && json_str(&value, "phase") != "unsupported") {
                        if started.elapsed() >= Duration::from_secs(15) { return Err(CONTEXT_UNAVAILABLE.into()); }
                        publish(generation, pending("awaiting-page", true));
                    } else {
                        if json_bool(&value, "compiled") { navigation_started = None; }
                        publish(generation, value);
                    }
                },
                Ok(_) => {
                    let started = missing_context_since.get_or_insert_with(Instant::now);
                    if started.elapsed() >= Duration::from_secs(15) { return Err(CONTEXT_UNAVAILABLE.into()); }
                    publish(generation, pending("awaiting-page", true));
                },
                Err(error) if error == CONTEXT_UNAVAILABLE => {
                    let started = missing_context_since.get_or_insert_with(Instant::now);
                    if started.elapsed() >= Duration::from_secs(15) { return Err(error); }
                    publish(generation, pending("awaiting-page", true));
                },
                Err(_) if !is_current() => break,
                Err(error) => return Err(error),
            }
            thread::sleep(Duration::from_secs(2));
        }
        Ok(())
    })();
    if let Some(identifier) = script_id {
        let _ = finish_command(
            &mut socket,
            &mut next_id,
            "Page.removeScriptToEvaluateOnNewDocument",
            json!({"identifier":identifier}),
            None,
            Duration::from_secs(5),
        );
    }
    let cleanup = format!("if(window.__GAOGE_NATIVE_FAST_OWNER__==={owner}){{window.__gaogeCodexNativeFastRuntime?.dispose?.();delete window.__GAOGE_NATIVE_FAST_OWNER__;}}");
    let _ = finish_command(
        &mut socket,
        &mut next_id,
        "Runtime.evaluate",
        json!({"expression":cleanup}),
        None,
        Duration::from_secs(5),
    );
    let _ = socket.close(None);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    fn modules() -> Value {
        json!({"ok":true,"version":1,"diagnostics":{"rewriters":{"fast":"patched"}},
            "modules":[{"url":"app://-/assets/index-test.js","patchedSource":"window.__codexPlusNativeFastCompiled=\"v1\";"}]})
    }
    #[test]
    fn native_fast_requires_complete_local_module_graph() {
        assert!(valid_prepared(&modules()));
        for url in [
            "https://example.com/assets/index-test.js",
            "file:///assets/index-test.js",
            "app://other/assets/index-test.js",
            "app://-/assets/index-test.js?token=x",
            "app://-/assets/nested/index.js",
            "app://-:123/assets/index.js",
            "app://-/assets/%61.js",
        ] {
            let mut value = modules();
            value["modules"][0]["url"] = json!(url);
            assert!(!valid_prepared(&value), "{url}");
        }
        let mut value = modules();
        value["modules"][0]["patchedSource"] = json!("partial();");
        assert!(!valid_prepared(&value));
        let mut value = modules();
        value["diagnostics"]["rewriters"]["fast"] = json!("incomplete-gates");
        assert!(!valid_prepared(&value));
    }
    #[test]
    fn native_fast_pending_is_never_verified() {
        for reason in [
            "awaiting-restart",
            "preparing-modules",
            "unsupported-modules",
            "connection-unavailable",
        ] {
            let value = pending(reason, true);
            assert_eq!(value["ready"], false);
            assert_eq!(value["verified"], false);
            assert_eq!(value["needsRestart"], reason == "awaiting-restart");
        }
    }
    #[test]
    fn native_fast_observations_require_current_scope_and_fresh_connection() {
        let _lock = TEST_LOCK.lock().unwrap();
        let generation = GENERATION.load(Ordering::SeqCst);
        let expected = json!({"scopeKey":"current"});
        let mut session = Session {
            key: String::new(),
            scope_key: "current".into(),
            generation,
            value: json!({"ready":true,"verified":true}),
            updated: Instant::now(),
            running: true,
        };
        assert_eq!(observed_status(&session, &expected)["verified"], true);
        assert_eq!(
            observed_status(&session, &json!({"scopeKey":"different"}))["verified"],
            false
        );
        session.updated = Instant::now() - Duration::from_secs(16);
        assert_eq!(observed_status(&session, &expected)["verified"], false);
        session.updated = Instant::now();
        session.generation = generation + 1;
        assert_eq!(observed_status(&session, &expected)["verified"], false);
    }
    fn mock_lifecycle(fresh_launch: bool, cancel_registration: bool) -> (Vec<String>, Value) {
        let _lock = TEST_LOCK.lock().unwrap();
        reset();
        let generation = GENERATION.load(Ordering::SeqCst);
        let expected = json!({"enabled":true,"localApiConfigured":true,"scopeKey":"mock-current"});
        *SESSION.lock().unwrap() = Some(Session {
            key: "mock".into(),
            scope_key: "mock-current".into(),
            generation,
            value: pending("preparing-modules", true),
            updated: Instant::now(),
            running: true,
        });
        if fresh_launch {
            note_launch();
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target = format!("ws://{}/devtools/page/mock", listener.local_addr().unwrap());
        let finished = Arc::new(AtomicBool::new(false));
        let server_finished = finished.clone();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            let mut methods = Vec::new();
            let mut polls = 0;
            while let Ok(WebSocketMessage::Text(text)) = socket.read() {
                let request: Value = serde_json::from_str(&text).unwrap();
                let method = json_str(&request, "method");
                methods.push(method.clone());
                let expression = json_str(&request["params"], "expression");
                let result = match method.as_str() {
                    "Page.enable" => {
                        socket
                            .send(WebSocketMessage::Text(
                                json!({"method":"Page.domContentEventFired","params":{}})
                                    .to_string(),
                            ))
                            .unwrap();
                        json!({})
                    }
                    "Runtime.evaluate" if expression.ends_with(".prepare()") => {
                        assert!(expression.contains("window.__GAOGE_NATIVE_FAST_OWNER__="));
                        json!({"result":{"value":modules()}})
                    }
                    "Page.addScriptToEvaluateOnNewDocument" => {
                        let source = json_str(&request["params"], "source");
                        assert!(source.contains("window===window.top"));
                        assert!(source.contains(".installPrepared("));
                        if cancel_registration {
                            GENERATION.fetch_add(1, Ordering::SeqCst);
                        }
                        json!({"identifier":"mock-bootstrap"})
                    }
                    "Page.reload" => {
                        assert!(fresh_launch && !cancel_registration);
                        json!({})
                    }
                    "Runtime.evaluate" if expression.ends_with(".status():null") => {
                        polls += 1;
                        if fresh_launch && polls == 1 {
                            socket
                                .send(WebSocketMessage::Text(
                                    json!({"id":request["id"],
                                "result":{"result":{"value":pending("awaiting-restart", true)}}})
                                    .to_string(),
                                ))
                                .unwrap();
                            continue;
                        }
                        if fresh_launch && polls == 3 {
                            socket
                                .send(WebSocketMessage::Text(
                                    json!({"id":request["id"],
                                "error":{"message":"Execution context was destroyed."}})
                                    .to_string(),
                                ))
                                .unwrap();
                            continue;
                        }
                        if fresh_launch && polls == 2 {
                            let previous = SESSION.lock().unwrap().as_ref().unwrap().value.clone();
                            assert_eq!(previous["reason"], "awaiting-page");
                            assert_eq!(previous["needsRestart"], false);
                            socket
                                .send(WebSocketMessage::Text(
                                    json!({"id":request["id"],
                                "result":{"result":{"value":null}}})
                                    .to_string(),
                                ))
                                .unwrap();
                            continue;
                        }
                        server_finished.store(true, Ordering::SeqCst);
                        json!({"result":{"value":if fresh_launch {
                            json!({"enabled":true,"ready":true,"verified":true,"reason":"compiled"})
                        } else { pending("awaiting-restart", true) }}})
                    }
                    "Page.removeScriptToEvaluateOnNewDocument" => {
                        assert_eq!(request["params"]["identifier"], "mock-bootstrap");
                        json!({})
                    }
                    "Runtime.evaluate" => {
                        assert!(expression.contains("__GAOGE_NATIVE_FAST_OWNER__==="));
                        assert!(expression.contains(".dispose?.()"));
                        socket
                            .send(WebSocketMessage::Text(
                                json!({"id":request["id"],"result":{}}).to_string(),
                            ))
                            .unwrap();
                        break;
                    }
                    other => panic!("Unexpected CDP command {other}"),
                };
                socket
                    .send(WebSocketMessage::Text(
                        json!({"id":request["id"],"result":result}).to_string(),
                    ))
                    .unwrap();
            }
            methods
        });
        let result = run_with_state(&target, &expected, generation, || {
            if finished.load(Ordering::SeqCst) {
                json!({"scopeKey":"mock-replaced"})
            } else {
                expected.clone()
            }
        });
        let methods = server.join().unwrap();
        let value = SESSION.lock().unwrap().as_ref().unwrap().value.clone();
        reset();
        result.unwrap();
        (methods, value)
    }
    #[test]
    fn native_fast_cdp_bootstraps_before_reload_and_survives_context_replacement() {
        let (methods, value) = mock_lifecycle(true, false);
        assert_eq!(
            methods,
            vec![
                "Page.enable",
                "Runtime.evaluate",
                "Page.addScriptToEvaluateOnNewDocument",
                "Page.reload",
                "Runtime.evaluate",
                "Runtime.evaluate",
                "Runtime.evaluate",
                "Runtime.evaluate",
                "Page.removeScriptToEvaluateOnNewDocument",
                "Runtime.evaluate"
            ]
        );
        assert_eq!(value["verified"], true);
    }
    #[test]
    fn native_fast_cdp_existing_window_waits_for_navigation() {
        let (methods, value) = mock_lifecycle(false, false);
        assert!(!methods.iter().any(|method| method == "Page.reload"));
        assert!(methods
            .iter()
            .any(|method| method == "Page.removeScriptToEvaluateOnNewDocument"));
        assert_eq!(value["verified"], false);
        assert_eq!(value["needsRestart"], true);
    }
    #[test]
    fn native_fast_cdp_cancelled_registration_is_removed_without_reloading() {
        let (methods, _) = mock_lifecycle(true, true);
        assert_eq!(
            methods,
            vec![
                "Page.enable",
                "Runtime.evaluate",
                "Page.addScriptToEvaluateOnNewDocument",
                "Page.removeScriptToEvaluateOnNewDocument",
                "Runtime.evaluate"
            ]
        );
    }
}
