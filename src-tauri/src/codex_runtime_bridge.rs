//! CDP transport owned by one bridge generation. Commands preserve runtime
//! events, and bridge health is checked in the current main-world context.
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};
use tungstenite::{client, Message, WebSocket};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Context {
    pub(crate) id: u64,
    unique_id: String,
    epoch: u64,
}

#[derive(Default)]
struct PageContexts {
    main_frame: String,
    contexts: HashMap<u64, (String, Context)>,
    epoch: u64,
}
impl PageContexts {
    fn observe(&mut self, event: &Value) {
        let params = &event["params"];
        match event["method"].as_str().unwrap_or_default() {
            "Page.frameNavigated" if params["frame"]["parentId"].is_null() => {
                if let Some(frame) = params["frame"]["id"].as_str() {
                    self.main_frame = frame.to_owned();
                }
            }
            "Runtime.executionContextsCleared" => {
                self.contexts.clear();
                self.epoch += 1;
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = params["executionContextId"].as_u64() {
                    self.contexts.remove(&id);
                }
            }
            "Runtime.executionContextCreated" => {
                let context = &params["context"];
                if context["auxData"]["isDefault"].as_bool() != Some(true) {
                    return;
                }
                if let (Some(id), Some(frame)) = (
                    context["id"].as_u64(),
                    context["auxData"]["frameId"].as_str(),
                ) {
                    self.epoch += 1;
                    self.contexts.insert(
                        id,
                        (
                            frame.to_owned(),
                            Context {
                                id,
                                unique_id: context["uniqueId"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .to_owned(),
                                epoch: self.epoch,
                            },
                        ),
                    );
                }
            }
            _ => {}
        }
    }
    fn main(&self) -> Option<Context> {
        self.contexts
            .values()
            .filter(|(frame, _)| frame == &self.main_frame)
            .max_by_key(|(_, context)| context.epoch)
            .map(|(_, context)| context.clone())
    }
}

pub(crate) struct Cdp {
    socket: WebSocket<TcpStream>,
    sequence: u64,
    events: VecDeque<(Value, Context)>,
    contexts: PageContexts,
    installed: Option<Context>,
}
impl Cdp {
    pub(crate) fn connect(websocket_url: &str) -> Result<Self, String> {
        let parsed = url::Url::parse(websocket_url).map_err(|_| "本地桥接地址无效。")?;
        let host = parsed.host_str().ok_or("本地桥接缺少主机地址。")?;
        if parsed.scheme() != "ws" || !matches!(host, "127.0.0.1" | "::1" | "localhost") {
            return Err("本地桥接仅允许回环 WebSocket。".into());
        }
        let port = parsed.port_or_known_default().ok_or("本地桥接缺少端口。")?;
        let timeout = Duration::from_secs(super::CODEX_PLUGIN_CDP_WEBSOCKET_TIMEOUT_SECS);
        let stream = (host, port)
            .to_socket_addrs()
            .map_err(|_| "解析本地桥接地址失败。")?
            .find_map(|address| TcpStream::connect_timeout(&address, timeout).ok())
            .ok_or("连接本地桥接失败。")?;
        stream
            .set_read_timeout(Some(timeout))
            .and_then(|_| stream.set_write_timeout(Some(timeout)))
            .map_err(|_| "设置本地桥接超时失败。")?;
        let (socket, _) = client(websocket_url, stream).map_err(|_| "连接本地桥接失败。")?;
        socket
            .get_ref()
            .set_read_timeout(Some(Duration::from_millis(
                super::CODEX_SESSION_DELETE_BRIDGE_POLL_MS,
            )))
            .map_err(|_| "设置本地桥接轮询失败。")?;
        Ok(Self {
            socket,
            sequence: 0,
            events: VecDeque::new(),
            contexts: PageContexts::default(),
            installed: None,
        })
    }
    fn read(&mut self) -> Result<Option<Value>, String> {
        match self.socket.read() {
            Ok(Message::Text(text)) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|_| "本地桥接消息格式无效。".into()),
            Ok(Message::Ping(payload)) => {
                self.socket
                    .send(Message::Pong(payload))
                    .map_err(|_| "本地桥接心跳失败。")?;
                Ok(None)
            }
            Ok(Message::Close(_)) => Err("本地桥接连接已关闭。".into()),
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(_) => Err("读取本地桥接消息失败。".into()),
        }
    }
    fn observe(&mut self, message: Value) -> Result<(), String> {
        self.contexts.observe(&message);
        if message["method"] == "Runtime.bindingCalled" {
            if let Some(context) = self.contexts.main().filter(|context| {
                message["params"]["executionContextId"].as_u64() == Some(context.id)
            }) {
                if self.events.len() >= 512 {
                    return Err("本地桥接事件等待过多。".into());
                }
                self.events.push_back((message, context));
            }
        }
        Ok(())
    }
    pub(crate) fn command(
        &mut self,
        method: &str,
        params: Value,
        active: &impl Fn() -> bool,
    ) -> Result<Value, String> {
        if !active() {
            return Err("本地桥接实例已更新。".into());
        }
        self.sequence += 1;
        let id = self.sequence;
        self.socket
            .send(Message::Text(
                json!({"id":id,"method":method,"params":params}).to_string(),
            ))
            .map_err(|_| "发送本地桥接命令失败。")?;
        let deadline =
            Instant::now() + Duration::from_secs(super::CODEX_PLUGIN_CDP_WEBSOCKET_TIMEOUT_SECS);
        while Instant::now() < deadline && active() {
            let Some(message) = self.read()? else {
                continue;
            };
            if message["id"].as_u64() != Some(id) {
                self.observe(message)?;
                continue;
            }
            // Never include exception source, binding names or tokens in errors.
            if !message["error"].is_null() {
                return Err(format!("本地桥接命令失败（{method}）。"));
            }
            if !message["result"]["exceptionDetails"].is_null() {
                return Err(format!("本地桥接脚本执行失败（{method}）。"));
            }
            if !active() {
                return Err("本地桥接实例已更新。".into());
            }
            return Ok(message["result"].clone());
        }
        Err("等待本地桥接命令结果超时或实例已更新。".into())
    }
    pub(crate) fn initialize(&mut self, active: &impl Fn() -> bool) -> Result<(), String> {
        self.command("Page.enable", json!({}), active)?;
        let tree = self.command("Page.getFrameTree", json!({}), active)?;
        self.contexts.main_frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or("本地桥接未找到主页面。")?
            .to_owned();
        self.command("Runtime.enable", json!({}), active)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.contexts.main().is_none() && active() && Instant::now() < deadline {
            if let Some(message) = self.read()? {
                self.observe(message)?;
            }
        }
        if self.contexts.main().is_none() {
            return Err("本地桥接等待主页面上下文。".into());
        }
        Ok(())
    }
    fn evaluation_params(context: &Context, expression: String) -> Value {
        let mut params = json!({"expression":expression,"returnByValue":true,"allowUnsafeEvalBlockedByCSP":true});
        if context.unique_id.is_empty() {
            params["contextId"] = json!(context.id);
        } else {
            params["uniqueContextId"] = json!(context.unique_id);
        }
        params
    }
    fn context_command(
        &mut self,
        context: &Context,
        method: &str,
        params: Value,
        active: &impl Fn() -> bool,
    ) -> Result<Option<Value>, String> {
        let result = self.command(method, params, active);
        // Chrome may invalidate an evaluation while its lifecycle events are
        // already queued. Retry only when those events prove identity changed;
        // stable-context JavaScript/CDP errors must still fail verification.
        if self.contexts.main().as_ref() != Some(context) {
            self.installed = None;
            return Ok(None);
        }
        result.map(Some)
    }
    pub(crate) fn ensure_installed(
        &mut self,
        token: &str,
        instance: &str,
        active: &impl Fn() -> bool,
    ) -> Result<bool, String> {
        let Some(context) = self.contexts.main() else {
            self.installed = None;
            return Ok(false);
        };
        let probe = super::codex_session_delete_bridge_health_script(instance);
        let Some(health) = self.context_command(
            &context,
            "Runtime.evaluate",
            Self::evaluation_params(&context, probe),
            active,
        )?
        else {
            return Ok(false);
        };
        if health["result"]["value"]["ready"].as_bool() == Some(true) {
            self.installed = Some(context);
            return Ok(true);
        }
        let expected_owner = health["result"]["value"]["owner"].as_str();
        // Re-adding a registered binding does not recreate its deleted JS
        // function. Only an unhealthy installation resets this session's
        // registration; healthy probes never disturb pending callbacks.
        if self
            .context_command(
                &context,
                "Runtime.removeBinding",
                json!({"name":super::CODEX_SESSION_DELETE_BINDING_NAME}),
                active,
            )?
            .is_none()
        {
            return Ok(false);
        }
        if self.context_command(&context, "Runtime.addBinding", json!({"name":super::CODEX_SESSION_DELETE_BINDING_NAME,"executionContextId":context.id}), active)?.is_none() {
            return Ok(false);
        }
        let script =
            super::codex_session_delete_bridge_instance_script(token, instance, expected_owner);
        let Some(installed) = self.context_command(
            &context,
            "Runtime.evaluate",
            Self::evaluation_params(&context, script),
            active,
        )?
        else {
            return Ok(false);
        };
        if installed["result"]["value"]["ready"].as_bool() != Some(true) {
            return Err("本地桥接安装后校验未通过。".into());
        }
        // Check the published functions, map, native binding and owner again;
        // an exception-free evaluate alone does not establish readiness.
        let Some(verified) = self.context_command(
            &context,
            "Runtime.evaluate",
            Self::evaluation_params(
                &context,
                super::codex_session_delete_bridge_health_script(instance),
            ),
            active,
        )?
        else {
            return Ok(false);
        };
        if verified["result"]["value"]["ready"].as_bool() != Some(true) {
            return Err("本地桥接安装后校验未通过。".into());
        }
        self.installed = Some(context);
        Ok(true)
    }

    pub(crate) fn wait_until_installed(
        &mut self,
        token: &str,
        instance: &str,
        active: &impl Fn() -> bool,
    ) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        while active() && Instant::now() < deadline {
            if self.ensure_installed(token, instance, active)? {
                return Ok(());
            }
            self.poll_event()?;
        }
        Err("本地桥接等待主页面就绪超时。".into())
    }
    pub(crate) fn needs_context_install(&self) -> bool {
        self.contexts.main() != self.installed
    }
    pub(crate) fn poll_event(&mut self) -> Result<(), String> {
        if let Some(message) = self.read()? {
            self.observe(message)?;
        }
        Ok(())
    }
    pub(crate) fn next_binding(&mut self) -> Result<Option<(Value, Context)>, String> {
        if let Some(event) = self.events.pop_front() {
            return Ok(Some(event));
        }
        self.poll_event()?;
        Ok(self.events.pop_front())
    }
    pub(crate) fn is_current_context(&self, context: &Context) -> bool {
        self.installed.as_ref() == Some(context) && self.contexts.main().as_ref() == Some(context)
    }

    pub(crate) fn send_reply(
        &mut self,
        context: &Context,
        expression: String,
        active: &impl Fn() -> bool,
    ) -> Result<(), String> {
        if !active() || !self.is_current_context(context) {
            return Ok(());
        }
        self.sequence += 1;
        self.socket.send(Message::Text(json!({"id":self.sequence,"method":"Runtime.evaluate","params":Self::evaluation_params(context, expression)}).to_string()))
            .map_err(|_| "回传本地桥接结果失败。".into())
    }
}

#[cfg(test)]
#[path = "codex_runtime_bridge_tests.rs"]
mod tests;
