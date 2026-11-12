//! Private, line-delimited stdio owner for the mobile gateway.
//! Status reads do not launch the manager or start a connection.
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const RESPONSE_LIMIT: usize = 1024 * 1024;
const SECRET_FILE: &str = "relay-registration.secure.json";

#[derive(Clone, Default)]
pub struct MobileConnectionRuntime {
    inner: Arc<Mutex<Option<Supervisor>>>,
    exiting: Arc<AtomicBool>,
    component_updating: Arc<AtomicBool>,
}

pub struct ComponentUpdateGuard(Arc<AtomicBool>);
impl Drop for ComponentUpdateGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct Supervisor {
    child: Child,
    input: Option<mpsc::Sender<Vec<u8>>>,
    responses: mpsc::Receiver<Result<Value, ()>>,
    sequence: u64,
    last_status: Value,
    saved_secrets: Value,
    pending_secrets: Option<Value>,
    transport_failed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    username: String,
    password: Option<String>,
    relay_url: Option<String>,
    enrollment_token: Option<String>,
    account_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeRequest {
    device_id: String,
}

fn data_dir() -> PathBuf {
    super::roaming_app_dir().join("mobile-connection")
}

fn empty_status(available: bool, error: Option<&str>) -> Value {
    json!({
        "relayConfigured": false, "runtimeAvailable": available,
        "state": if error.is_some() { "error" } else { "stopped" },
        "username": "", "hasPassword": false, "relayUrl": "",
        "hasEnrollmentToken": false, "publicUrl": null, "pairing": null,
        "devices": [], "error": error
    })
}

// Explicitly allow only the public contract. Private fields from the manager
// must never become visible to the WebView or an accidental debug serializer.
fn public_status(raw: &Value) -> Value {
    let state = raw.get("state").and_then(Value::as_str).unwrap_or("error");
    let state = match state {
        "stopped" | "starting" | "running" | "reconnecting" | "error" => state,
        _ => "error",
    };
    let mut result = empty_status(true, None);
    result["state"] = json!(state);
    for key in [
        "relayConfigured",
        "runtimeAvailable",
        "hasPassword",
        "hasEnrollmentToken",
    ] {
        if let Some(value) = raw.get(key).and_then(Value::as_bool) {
            result[key] = json!(value);
        }
    }
    for key in ["username", "relayUrl"] {
        if let Some(value) = raw.get(key).and_then(Value::as_str) {
            result[key] = json!(value);
        }
    }
    for key in ["publicUrl", "error"] {
        if let Some(value) = raw.get(key).and_then(Value::as_str) {
            result[key] = json!(value);
        }
    }
    if let Some(pairing) = raw.get("pairing") {
        if let (Some(url), Some(expires_at)) = (
            pairing.get("url").and_then(Value::as_str),
            pairing.get("expiresAt").and_then(Value::as_u64),
        ) {
            result["pairing"] = json!({"url": url, "expiresAt": expires_at});
        }
    }
    if let Some(devices) = raw.get("devices").and_then(Value::as_array) {
        result["devices"] = Value::Array(
            devices
                .iter()
                .filter_map(|item| {
                    Some(json!({
                        "id": item.get("id")?.as_str()?,
                        "name": item.get("name").and_then(Value::as_str).unwrap_or("手机"),
                        "lastSeen": item.get("lastSeen").and_then(Value::as_u64).unwrap_or(0),
                    }))
                })
                .collect(),
        );
    }
    result
}

fn load_secrets(directory: &Path) -> Result<Value, String> {
    let contents = match fs::read_to_string(directory.join(SECRET_FILE)) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(_) => return Err("无法读取手机连接的设备凭据".into()),
    };
    let stored: Value =
        serde_json::from_str(&contents).map_err(|_| "手机连接的设备凭据已损坏，请重新配置连接")?;
    let ciphertext = stored
        .get("encrypted")
        .and_then(Value::as_str)
        .ok_or("手机连接的设备凭据格式不正确")?;
    let plaintext = super::decrypt_secret(ciphertext)
        .map_err(|_| "系统无法解密手机连接的设备凭据，请重新配置连接")?
        .ok_or("当前系统不支持安全保存手机连接的设备凭据")?;
    let raw: Value =
        serde_json::from_str(&plaintext).map_err(|_| "手机连接的设备凭据格式不正确")?;
    registration_secrets(&raw)
}

fn save_secrets(directory: &Path, secrets: &Value) -> Result<(), String> {
    if !secrets.is_null() && !secrets.is_object() {
        return Err("手机连接管理程序返回了无效的设备凭据".into());
    }
    let path = directory.join(SECRET_FILE);
    if secrets.is_null() {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法清除手机连接的设备凭据".into()),
        };
    }
    let plaintext = serde_json::to_string(secrets).map_err(|_| "无法保存设备凭据")?;
    let encrypted = super::encrypt_secret(&plaintext)
        .map_err(|_| "系统无法安全保存手机连接的设备凭据")?
        .ok_or("当前系统不支持安全保存手机连接的设备凭据")?;
    super::write_json_pretty_atomic(&path, &json!({"version": 1, "encrypted": encrypted}))
        .map_err(|_| "无法保存手机连接的设备凭据".into())
}

fn registration_secrets(raw: &Value) -> Result<Value, String> {
    if raw.is_null() {
        return Ok(Value::Null);
    }
    if !raw.is_object() {
        return Err("手机连接管理程序返回了无效的设备凭据".into());
    }
    let mut registration = json!({});
    for key in ["deviceToken", "deviceId", "deviceName", "url"] {
        if let Some(value) = raw.get(key).and_then(Value::as_str) {
            registration[key] = json!(value);
        }
    }
    Ok(registration)
}

fn packaged_runtime(app: &AppHandle) -> Option<PathBuf> {
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let executable = if cfg!(windows) {
        "gaoge-mobile-gateway.exe"
    } else {
        "gaoge-mobile-gateway"
    };
    let resource_dir = app.path().resource_dir().ok()?;
    let mut roots = vec![
        resource_dir.join("resources/mobile-bridge"),
        resource_dir.join("_up_/resources/mobile-bridge"),
        resource_dir.join("mobile-bridge"),
    ];
    if cfg!(debug_assertions) {
        roots.insert(
            0,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/mobile-bridge"),
        );
    }
    roots
        .into_iter()
        .map(|root| root.join(&platform).join(executable))
        .find(|path| path.is_file())
}

fn runtime_command(app: &AppHandle) -> Result<Command, String> {
    if let Some(binary) = super::mobile_component::installed_executable()? {
        let mut command = super::hidden_command(&binary);
        if let Some(parent) = binary.parent() {
            command.current_dir(parent);
        }
        return Ok(command);
    }
    if !cfg!(debug_assertions) {
        return Err("请先下载手机连接组件".into());
    }
    let mut development_fallback = None;
    // A selected development interpreter takes priority. Otherwise the bundled
    // runtime makes a debug application usable without a system Python setup.
    if cfg!(debug_assertions) {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mobile-bridge");
        let script = source.join("gaoge_mobile.py");
        if script.is_file() {
            let configured_python = std::env::var_os("GAOGE_MOBILE_PYTHON")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    let venv = source.join(if cfg!(windows) {
                        ".venv/Scripts/python.exe"
                    } else {
                        ".venv/bin/python"
                    });
                    venv.is_file().then_some(venv)
                });
            let source_selected = configured_python.is_some();
            let python = configured_python
                .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "python" } else { "python3" }));
            let mut command = super::hidden_command(python);
            command.arg("-u").arg(script).current_dir(source);
            if source_selected {
                return Ok(command);
            }
            development_fallback = Some(command);
        }
    }
    if let Some(binary) = packaged_runtime(app) {
        let mut command = super::hidden_command(&binary);
        if let Some(parent) = binary.parent() {
            command.current_dir(parent);
        }
        return Ok(command);
    }
    development_fallback.ok_or_else(|| "请先下载手机连接组件".into())
}

fn runtime_source(app: &AppHandle) -> &'static str {
    match super::mobile_component::installed_executable() {
        Ok(Some(_)) => "component",
        Ok(None) if cfg!(debug_assertions) && runtime_command(app).is_ok() => "development",
        _ => "missing",
    }
}

fn offline_settings_status(available: bool, settings: Option<&Value>) -> Value {
    let mut status = empty_status(available, None);
    status["relayUrl"] = json!(ACCOUNT_RELAY_URL);
    if let Some(value) = settings {
        status["username"] = json!(value
            .pointer("/auth/username")
            .and_then(Value::as_str)
            .unwrap_or(""));
        status["hasPassword"] = json!(value
            .pointer("/auth/hash")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()));
        if let Some(relay_url) = value.get("relayUrl").and_then(Value::as_str) {
            status["relayUrl"] = json!(relay_url);
        }
    }
    status
}

fn offline_status(app: &AppHandle) -> Value {
    let available = runtime_command(app).is_ok();
    let directory = data_dir();
    let settings = directory.join("mobile-settings.json");
    let saved = fs::metadata(&settings)
        .is_ok_and(|value| value.len() <= RESPONSE_LIMIT as u64)
        .then(|| fs::read(&settings).ok())
        .flatten()
        .and_then(|contents| serde_json::from_slice::<Value>(&contents).ok());
    let mut status = offline_settings_status(available, saved.as_ref());
    if let Ok(secrets) = load_secrets(&directory) {
        let registered = secrets
            .get("deviceToken")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty());
        status["relayConfigured"] = json!(registered);
        status["hasEnrollmentToken"] = json!(registered);
    }
    status["runtimeSource"] = json!(runtime_source(app));
    status
}

const ACCOUNT_RELAY_URL: &str = "https://api.gaogeaii.com/mobile";

fn validate_account_relay(relay_url: Option<&str>) -> Result<(), String> {
    let raw = relay_url.unwrap_or_default().trim();
    let authority = raw
        .split_once("://")
        .map(|(_, value)| {
            value
                .split(['/', '?', '#', '\\'])
                .next()
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let parsed = url::Url::parse(raw).ok();
    let trusted = parsed.as_ref().is_some_and(|url| {
        !authority.contains('@')
            && !raw.chars().any(char::is_control)
            && url.scheme() == "https"
            && url.host_str() == Some("api.gaogeaii.com")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && matches!(url.path(), "/mobile" | "/mobile/")
    });
    if trusted {
        Ok(())
    } else {
        Err("软件账号只能用于官方手机连接服务；自定义服务器请使用设备注册码".into())
    }
}

impl Supervisor {
    fn spawn(app: &AppHandle, exiting: &AtomicBool) -> Result<Self, String> {
        let directory = data_dir();
        let secrets = load_secrets(&directory)?;
        let mut command = runtime_command(app)?;
        fs::create_dir_all(&directory).map_err(|_| "无法创建手机连接的本地配置目录")?;
        // Only the nonsensitive data directory is passed as an argument.
        command
            .arg("supervise")
            .arg("--data-dir")
            .arg(&directory)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONUTF8", "1");
        let mut supervisor = Self::launch(command, secrets.clone())?;
        supervisor.request("init", json!({"relayConfig": secrets}), exiting)?;
        Ok(supervisor)
    }

    fn launch(mut command: Command, secrets: Value) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动手机连接组件，请检查安装是否完整")?;
        let mut input = child.stdin.take().ok_or("无法打开手机连接组件的控制通道")?;
        let output = child.stdout.take().ok_or("无法读取手机连接组件的状态")?;
        let (request_sender, request_receiver) = mpsc::channel::<Vec<u8>>();
        // A hung child must not block the UI worker inside a pipe write and
        // defeat its deadline or application exit. The reader deadline also
        // covers writes; dropping this sender closes stdin after queued work.
        std::thread::Builder::new()
            .name("gaoge-mobile-requests".into())
            .spawn(move || {
                while let Ok(bytes) = request_receiver.recv() {
                    if input.write_all(&bytes).and_then(|_| input.flush()).is_err() {
                        break;
                    }
                }
            })
            .map_err(|_| {
                let _ = child.kill();
                "无法创建手机连接控制任务"
            })?;
        let (sender, responses) = mpsc::channel();
        std::thread::Builder::new()
            .name("gaoge-mobile-responses".into())
            .spawn(move || {
                let mut reader = BufReader::new(output);
                loop {
                    let mut line = Vec::new();
                    match (&mut reader)
                        .take((RESPONSE_LIMIT + 1) as u64)
                        .read_until(b'\n', &mut line)
                    {
                        Ok(0) => break,
                        Ok(_) if line.len() <= RESPONSE_LIMIT => {
                            let response = serde_json::from_slice::<Value>(&line).map_err(|_| ());
                            if sender.send(response).is_err() {
                                break;
                            }
                        }
                        _ => {
                            let _ = sender.send(Err(()));
                            break;
                        }
                    }
                }
            })
            .map_err(|_| {
                let _ = child.kill();
                "无法创建手机连接状态监听任务"
            })?;
        Ok(Self {
            child,
            input: Some(request_sender),
            responses,
            sequence: 0,
            last_status: empty_status(true, None),
            saved_secrets: secrets,
            pending_secrets: None,
            transport_failed: false,
        })
    }

    fn flush_pending_with<F>(&mut self, persist: F) -> Result<(), String>
    where
        F: FnOnce(&Value) -> Result<(), String>,
    {
        if let Some(secrets) = self.pending_secrets.as_ref() {
            // Losing a one-time registration because secure storage is
            // temporarily unavailable would force another server registration.
            // Keep both the child and token until this write can be retried.
            self.transport_failed = false;
            persist(secrets)?;
            self.saved_secrets = self.pending_secrets.take().expect("pending registration");
        }
        Ok(())
    }

    fn flush_pending(&mut self) -> Result<(), String> {
        self.flush_pending_with(|secrets| save_secrets(&data_dir(), secrets))
    }

    fn request(
        &mut self,
        action: &str,
        request: Value,
        exiting: &AtomicBool,
    ) -> Result<Value, String> {
        self.transport_failed = false;
        if exiting.load(Ordering::Acquire) {
            return Err("软件正在退出，手机连接已停止".into());
        }
        let mut persistence_error = None;
        if let Err(error) = self.flush_pending() {
            if action != "stop" {
                return Err(error);
            }
            persistence_error = Some(error);
        }
        self.transport_failed = true;
        if self
            .child
            .try_wait()
            .map_err(|_| "无法检查手机连接组件状态")?
            .is_some()
        {
            return Err("手机连接组件已退出，请重新开启连接".into());
        }
        self.sequence += 1;
        let id = self.sequence;
        let input = self.input.as_ref().ok_or("手机连接控制通道已关闭")?;
        let mut bytes =
            serde_json::to_vec(&json!({"id": id, "action": action, "request": request}))
                .map_err(|_| "无法发送手机连接请求")?;
        bytes.push(b'\n');
        input.send(bytes).map_err(|_| "无法发送手机连接请求")?;
        let timeout = match action {
            "start" | "save" => 60,
            "init" => 15,
            _ => 30,
        };
        let deadline = Instant::now() + Duration::from_secs(timeout);
        loop {
            if exiting.load(Ordering::Acquire) {
                return Err("软件正在退出，手机连接已停止".into());
            }
            if Instant::now() >= deadline {
                return Err("手机连接响应超时，请检查网络后重试".into());
            }
            let reply = match self.responses.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(value)) => value,
                Ok(Err(())) => return Err("手机连接组件返回了无效的状态".into()),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("手机连接组件已断开，请重新开启连接".into())
                }
            };
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                return Err("手机连接组件的响应顺序异常，请重新开启连接".into());
            }
            if reply.get("ok").and_then(Value::as_bool) != Some(true) {
                // A rejected form or an unavailable relay is a business error,
                // not a reason to tear down a healthy, already running gateway.
                self.transport_failed = false;
                return Err(reply
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("手机连接操作失败，请重试")
                    .to_owned());
            }
            let result = reply
                .get("result")
                .filter(|result| result.is_object())
                .ok_or("手机连接组件缺少状态信息")?;
            if let Some(raw_secrets) = result.get("_secrets") {
                let secrets = registration_secrets(raw_secrets)?;
                if secrets != self.saved_secrets {
                    self.pending_secrets = Some(secrets);
                    if let Err(error) = self.flush_pending() {
                        if action != "stop" {
                            return Err(error);
                        }
                        persistence_error = Some(error);
                    }
                }
            }
            self.last_status = public_status(result);
            if let Some(error) = persistence_error {
                self.last_status["error"] = json!(error);
            }
            self.transport_failed = false;
            return Ok(self.last_status.clone());
        }
    }

    fn shutdown(&mut self) {
        // EOF is the manager's ownership contract. It also shuts down its child
        // gateway if the desktop terminates unexpectedly and closes the pipe.
        drop(self.input.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                _ if Instant::now() >= deadline => break,
                _ => std::thread::sleep(Duration::from_millis(25)),
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl MobileConnectionRuntime {
    pub fn begin_component_update(&self) -> Result<ComponentUpdateGuard, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "手机连接状态不可用，请重启软件")?;
        if self.exiting.load(Ordering::Acquire) {
            return Err("软件正在退出".into());
        }
        if self.component_updating.load(Ordering::Acquire) {
            return Err("手机组件正在更新，请稍候".into());
        }
        if let Some(child) = guard.as_mut() {
            if child
                .child
                .try_wait()
                .map_err(|_| "无法确认手机连接是否已停止")?
                .is_none()
            {
                let status = child
                    .request("status", json!({}), &self.exiting)
                    .map_err(|_| "请先停止手机连接，再更新组件")?;
                if matches!(
                    status.get("state").and_then(Value::as_str),
                    Some("running" | "starting" | "reconnecting")
                ) {
                    return Err("请先停止手机连接，再更新组件".into());
                }
            }
        }
        self.component_updating.store(true, Ordering::Release);
        guard.take();
        Ok(ComponentUpdateGuard(self.component_updating.clone()))
    }

    fn request(&self, app: AppHandle, action: &str, request: Value) -> Result<Value, String> {
        if self.exiting.load(Ordering::Acquire) {
            return Err("软件正在退出，手机连接已停止".into());
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "手机连接状态不可用，请重启软件")?;
        if self.component_updating.load(Ordering::Acquire) {
            return if action == "status" {
                Ok(offline_status(&app))
            } else {
                Err("手机组件正在更新，请稍候".into())
            };
        }
        if guard.is_none() && matches!(action, "status" | "stop") {
            return Ok(offline_status(&app));
        }
        if guard.is_none() {
            match Supervisor::spawn(&app, &self.exiting) {
                Ok(supervisor) => *guard = Some(supervisor),
                Err(error) if action == "status" => {
                    return Ok(empty_status(runtime_command(&app).is_ok(), Some(&error)));
                }
                Err(error) => return Err(error),
            }
        }
        let outcome =
            guard
                .as_mut()
                .expect("supervisor initialized")
                .request(action, request, &self.exiting);
        if let Err(error) = &outcome {
            let mut last_status = guard
                .as_ref()
                .map(|child| child.last_status.clone())
                .unwrap_or_else(|| empty_status(true, None));
            // Reap a failed manager, making a retry safe. Never auto-start the
            // connection after a failure or while polling this settings page.
            if guard.as_ref().is_some_and(|child| child.transport_failed) {
                guard.take();
            }
            if action == "status" {
                last_status["state"] = json!("error");
                last_status["error"] = json!(error);
                last_status["publicUrl"] = Value::Null;
                last_status["pairing"] = Value::Null;
                last_status["devices"] = json!([]);
                return Ok(last_status);
            }
        }
        outcome
    }

    pub fn shutdown(&self) {
        self.exiting.store(true, Ordering::Release);
        if let Ok(mut guard) = self.inner.lock() {
            guard.take();
        }
    }
}

async fn dispatch(
    app: AppHandle,
    runtime: MobileConnectionRuntime,
    action: &'static str,
    request: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = runtime_source(&app);
        let mut result = runtime.request(app, action, request)?;
        result["runtimeSource"] = json!(source);
        Ok(result)
    })
    .await
    .map_err(|_| "手机连接任务未能完成")?
}

#[tauri::command]
pub async fn mobile_connection_status(
    app: AppHandle,
    runtime: State<'_, MobileConnectionRuntime>,
) -> Result<Value, String> {
    dispatch(app, runtime.inner().clone(), "status", json!({})).await
}

#[tauri::command]
pub async fn mobile_connection_save(
    app: AppHandle,
    runtime: State<'_, MobileConnectionRuntime>,
    request: SaveRequest,
) -> Result<Value, String> {
    let username = request.username.trim();
    if username.is_empty() || username.chars().count() > 200 {
        return Err("请输入 1 到 200 个字符的用户名".into());
    }
    if request.password.as_ref().is_some_and(|value| {
        !value.is_empty() && (value.chars().count() < 12 || value.len() > 1000)
    }) {
        return Err("密码至少需要 12 个字符，且不能超过 1000 字节".into());
    }
    if request
        .relay_url
        .as_ref()
        .is_some_and(|value| value.len() > 2048)
        || request
            .enrollment_token
            .as_ref()
            .is_some_and(|value| value.len() > 4096)
    {
        return Err("手机连接的服务器配置过长".into());
    }
    if request
        .account_token
        .as_ref()
        .is_some_and(|value| value.len() > 16384 || value.chars().any(char::is_control))
    {
        return Err("账号登录凭据格式不正确，请重新登录软件".into());
    }
    let account_token = request
        .account_token
        .filter(|value| !value.trim().is_empty());
    if account_token.is_some() {
        validate_account_relay(request.relay_url.as_deref())?;
    }
    let mut payload = json!({"username": username});
    if let Some(password) = request.password.filter(|value| !value.is_empty()) {
        payload["password"] = json!(password);
    }
    if let Some(relay_url) = request.relay_url {
        payload["relayUrl"] = json!(if account_token.is_some() {
            ACCOUNT_RELAY_URL.to_owned()
        } else {
            relay_url
        });
    }
    if let Some(enrollment_token) = request.enrollment_token {
        payload["enrollmentToken"] = json!(enrollment_token);
    }
    if let Some(account_token) = account_token {
        payload["accountToken"] = json!(account_token);
    }
    dispatch(app, runtime.inner().clone(), "save", payload).await
}

#[tauri::command]
pub async fn mobile_connection_start(
    app: AppHandle,
    runtime: State<'_, MobileConnectionRuntime>,
) -> Result<Value, String> {
    dispatch(app, runtime.inner().clone(), "start", json!({})).await
}

#[tauri::command]
pub async fn mobile_connection_stop(
    app: AppHandle,
    runtime: State<'_, MobileConnectionRuntime>,
) -> Result<Value, String> {
    dispatch(app, runtime.inner().clone(), "stop", json!({})).await
}

#[tauri::command]
pub async fn mobile_connection_pair(
    app: AppHandle,
    runtime: State<'_, MobileConnectionRuntime>,
) -> Result<Value, String> {
    dispatch(app, runtime.inner().clone(), "pair", json!({})).await
}

#[tauri::command]
pub async fn mobile_connection_revoke_device(
    app: AppHandle,
    runtime: State<'_, MobileConnectionRuntime>,
    request: RevokeRequest,
) -> Result<Value, String> {
    if request.device_id.is_empty() || request.device_id.len() > 200 {
        return Err("手机设备标识不正确".into());
    }
    dispatch(
        app,
        runtime.inner().clone(),
        "revoke_device",
        json!({"deviceId": request.device_id}),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_use_defaults_to_official_relay_and_preserves_saved_custom_relay() {
        let first = offline_settings_status(false, None);
        assert_eq!(first["relayUrl"], ACCOUNT_RELAY_URL);
        assert_eq!(first["state"], "stopped");
        assert_eq!(first["runtimeAvailable"], false);
        assert_eq!(first["hasEnrollmentToken"], false);
        let saved = json!({"relayUrl": "https://custom.example/mobile", "auth": {"username": "saved-user", "hash": "test-hash"}});
        let existing = offline_settings_status(true, Some(&saved));
        assert_eq!(existing["relayUrl"], "https://custom.example/mobile");
        assert_eq!(existing["username"], "saved-user");
        assert_eq!(existing["hasPassword"], true);
    }

    #[test]
    fn component_update_guard_serializes_updates_and_releases_on_drop() {
        let runtime = MobileConnectionRuntime::default();
        let guard = runtime.begin_component_update().unwrap();
        assert!(runtime.component_updating.load(Ordering::Acquire));
        assert!(runtime.begin_component_update().is_err());
        drop(guard);
        assert!(!runtime.component_updating.load(Ordering::Acquire));
        assert!(runtime.begin_component_update().is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn running_connection_refuses_component_update_without_killing_manager() {
        let script = r#"
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $req = $line | ConvertFrom-Json
  [Console]::Out.WriteLine('{"id":' + $req.id + ',"ok":true,"result":{"state":"running"}}')
}
"#;
        let mut command = crate::hidden_command("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ]);
        let runtime = MobileConnectionRuntime::default();
        *runtime.inner.lock().unwrap() = Some(Supervisor::launch(command, Value::Null).unwrap());
        assert!(runtime.begin_component_update().is_err());
        assert!(!runtime.component_updating.load(Ordering::Acquire));
        assert!(runtime
            .inner
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_none());
        runtime.shutdown();
    }

    #[test]
    fn public_status_never_exposes_manager_secrets() {
        let raw = json!({
            "state": "running", "username": "owner", "runtimeAvailable": true,
            "_secrets": {"deviceToken": "private"}, "password": "private",
            "devices": [{"id": "phone", "name": "Phone", "lastSeen": 123, "token": "private"}],
            "pairing": {"url": "https://phone.test/#pair=short-lived", "expiresAt": 456, "private": "private"}
        });
        let result = public_status(&raw);
        assert_eq!(result["username"], "owner");
        assert_eq!(result["devices"][0]["id"], "phone");
        assert_eq!(result["pairing"]["expiresAt"], 456);
        assert!(!result.to_string().contains("private"));
    }

    #[test]
    fn unknown_manager_state_cannot_claim_connected() {
        assert_eq!(public_status(&json!({"state": "ready"}))["state"], "error");
        assert_eq!(
            empty_status(false, Some("missing"))["runtimeAvailable"],
            false
        );
    }

    #[test]
    fn account_login_token_is_restricted_to_our_exact_https_relay() {
        for value in [
            "https://api.gaogeaii.com/mobile",
            "https://api.gaogeaii.com/mobile/",
            "https://API.GAOGEAII.COM:443/mobile",
        ] {
            assert!(validate_account_relay(Some(value)).is_ok(), "{value}");
        }
        for value in [
            "http://api.gaogeaii.com/mobile",
            "https://api.gaogeaii.com.evil.test/mobile",
            "https://evil.test/mobile",
            "https://api.gaogeaii.com:8443/mobile",
            "https://api.gaogeaii.com/other",
            "https://api.gaogeaii.com/mobile/extra",
            "https://api.gaogeaii.com/mobile?redirect=evil",
            "https://api.gaogeaii.com/mobile#fragment",
            "https://user@api.gaogeaii.com/mobile",
            "https://@api.gaogeaii.com/mobile",
            "https://user:secret@api.gaogeaii.com/mobile",
            "https://api.gaogeaii.com/%6dobile",
            "https://api.gaogeaii.com./mobile",
            "https://api.gaogea\nii.com/mobile",
        ] {
            assert!(validate_account_relay(Some(value)).is_err(), "{value}");
        }
        assert!(validate_account_relay(None).is_err());
    }

    #[test]
    fn account_password_and_enrollment_tokens_are_never_persisted_as_registration() {
        let registration = registration_secrets(&json!({
            "deviceToken": "device", "deviceId": "id", "deviceName": "computer",
            "url": ACCOUNT_RELAY_URL, "accountToken": "private-account",
            "password": "private-password", "enrollmentToken": "private-invite", "enabled": true
        }))
        .unwrap();
        assert_eq!(registration.as_object().unwrap().len(), 4);
        assert_eq!(registration["deviceToken"], "device");
        assert!(!registration.to_string().contains("private"));
        assert!(registration_secrets(&Value::Null).unwrap().is_null());
    }

    #[cfg(windows)]
    #[test]
    fn stdio_business_rejection_keeps_manager_alive_and_eof_stops_it() {
        let script = r#"
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $req = $line | ConvertFrom-Json
  if ($req.action -eq 'reject') {
    [Console]::Out.WriteLine('{"id":' + $req.id + ',"ok":false,"error":"rejected"}')
  } else {
    [Console]::Out.WriteLine('{"id":' + $req.id + ',"ok":true,"result":{"state":"stopped"}}')
  }
}
"#;
        let mut command = crate::hidden_command("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ]);
        let mut supervisor = Supervisor::launch(command, Value::Null).unwrap();
        let exiting = AtomicBool::new(false);
        assert!(supervisor.request("reject", json!({}), &exiting).is_err());
        assert!(!supervisor.transport_failed);
        let registration = json!({"deviceToken": "issued-once", "deviceId": "device"});
        supervisor.pending_secrets = Some(registration.clone());
        supervisor.transport_failed = true;
        let sequence_before_retry = supervisor.sequence;
        let storage_error =
            supervisor.flush_pending_with(|_| Err("secure store unavailable".into()));
        assert!(storage_error.is_err());
        assert!(
            !supervisor.transport_failed,
            "storage error must not reap the healthy manager"
        );
        assert_eq!(supervisor.pending_secrets, Some(registration.clone()));
        assert!(supervisor.saved_secrets.is_null());
        assert!(supervisor.child.try_wait().unwrap().is_none());
        supervisor
            .flush_pending_with(|value| {
                assert_eq!(value, &registration);
                Ok(())
            })
            .unwrap();
        assert!(supervisor.pending_secrets.is_none());
        assert_eq!(supervisor.saved_secrets, registration);
        assert_eq!(
            supervisor.sequence, sequence_before_retry,
            "retry must not issue another registration request"
        );
        assert_eq!(
            supervisor.request("status", json!({}), &exiting).unwrap()["state"],
            "stopped"
        );
        supervisor.shutdown();
        assert!(supervisor.child.try_wait().unwrap().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn application_exit_can_cancel_a_child_that_does_not_read_stdin() {
        let mut command = crate::hidden_command("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 10",
        ]);
        let mut supervisor = Supervisor::launch(command, Value::Null).unwrap();
        let exiting = Arc::new(AtomicBool::new(false));
        let signal = exiting.clone();
        let signal_thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            signal.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let result = supervisor.request(
            "status",
            json!({"payload": "x".repeat(128 * 1024)}),
            &exiting,
        );
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "pipe write blocked exit cancellation"
        );
        signal_thread.join().unwrap();
        supervisor.shutdown();
        assert!(supervisor.child.try_wait().unwrap().is_some());
    }
}
