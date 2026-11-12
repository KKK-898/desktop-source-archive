//! Signature-preserving Ultra adaptation and current-page verification.
//! A running process or a prepared catalog is never evidence of a working menu.
use super::*;

pub(super) const SCRIPT: &str = concat!(
    include_str!("codex_ultra_picker.js"), "\n", include_str!("codex_ultra_runtime.js")
);

struct Observation {
    scope_key: String,
    revision: u64,
    observed_at: Instant,
    value: Value,
}

static OBSERVATION: Lazy<Mutex<Option<Observation>>> = Lazy::new(|| Mutex::new(None));
static GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct Connection {
    target_key: Option<String>,
    state: ConnectionState,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum ConnectionState {
    #[default]
    Unknown,
    Connected,
    Disconnected,
}

impl ConnectionState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Connected => "connected",
            Self::Disconnected => "disconnected",
        }
    }
}

static CONNECTION: Lazy<Mutex<Connection>> = Lazy::new(|| Mutex::new(Connection::default()));

fn invalidate_observation() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut observation) = OBSERVATION.lock() { *observation = None; }
}

/// A new process/page must not reuse a previous target's ready observation.
/// Retain only a digest: debugger URLs and page locations are never diagnostics.
pub(super) fn observe_target(websocket_url: &str, page_url: &str) -> bool {
    let mut digest = Sha256::new();
    digest.update(websocket_url.as_bytes());
    digest.update([0]);
    digest.update(page_url.as_bytes());
    let target_key = format!("{:x}", digest.finalize());
    let Ok(mut connection) = CONNECTION.lock() else { return false; };
    let changed = connection.target_key.as_deref() != Some(target_key.as_str())
        || connection.state == ConnectionState::Disconnected;
    if changed { invalidate_observation(); }
    connection.target_key = Some(target_key);
    connection.state = ConnectionState::Connected;
    changed
}

/// Repeated failed polls do not endlessly change the scope or restart the app.
pub(super) fn disconnected() {
    if let Ok(mut connection) = CONNECTION.lock() {
        if connection.state != ConnectionState::Disconnected { invalidate_observation(); }
        connection.target_key = None;
        connection.state = ConnectionState::Disconnected;
    }
}

/// The current page no longer exposes its verified observer (e.g. reload).
/// Increment only if there was evidence to invalidate, preserving bounded retry.
pub(super) fn source_unavailable(revision: u64) {
    if revision != current_codex_runtime_revision() { return; }
    if let Ok(mut observation) = OBSERVATION.lock() {
        if observation.take().is_some() { GENERATION.fetch_add(1, Ordering::SeqCst); }
    }
}

pub(super) fn version() -> u64 {
    SCRIPT.lines().find_map(|line| {
        line.trim().strip_prefix("var CODEX_ULTRA_RUNTIME_VERSION = ")?
            .strip_suffix(';')?.trim().parse().ok()
    }).unwrap_or(0)
}

fn disabled_state(requested: bool, reason: &str) -> Value {
    json!({"requested": requested, "enabled": false, "reason": reason,
        "provider": "", "modelCatalogPath": "", "scopeKey": ""})
}

fn managed_route_requested(config: &str, router: &RouterState) -> bool {
    router.mode == "relay"
        && configured_provider(config) == CODEX_DIRECT_PROVIDER_ID
        && configured_root_value(config, "profile").is_none()
        && model_provider_value(config, CODEX_DIRECT_PROVIDER_ID, "name")
            .is_some_and(|name| name.eq_ignore_ascii_case(CODEX_ROUTER_PROVIDER_NAME))
}

// Compatibility catalogs are read-only inputs. The repair writer continues to
// own only Gaoge's original catalog file; it never rewrites another manager's.
fn compatible_catalog_path(config_path: &Path, config: &str) -> Option<PathBuf> {
    if config.parse::<toml_edit::Document>().is_err()
        || fs::symlink_metadata(config_path).ok()?.file_type().is_symlink() { return None; }
    let directory = fs::canonicalize(config_path.parent()?).ok()?;
    let configured = PathBuf::from(configured_root_value(config, "model_catalog_json")?);
    let candidate = if configured.is_absolute() { configured } else { directory.join(configured) };
    let metadata = fs::symlink_metadata(&candidate).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8 * 1024 * 1024 {
        return None;
    }
    let canonical = fs::canonicalize(&candidate).ok()?;
    canonical.starts_with(&directory).then_some(candidate)
}

fn catalog_reasoning_efforts(catalog: &Value, routes: &[AggregateProviderRoute]) -> Map<String, Value> {
    let mut result = Map::new();
    let Some(models) = catalog.get("models").or_else(|| catalog.get("data"))
        .and_then(Value::as_array).or_else(|| catalog.as_array()) else { return result; };
    for model in models.iter().take(10_000) {
        let Some(id) = model.get("slug").or_else(|| model.get("model")).or_else(|| model.get("id"))
            .and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty() && id.len() <= 512)
            else { continue; };
        let mut efforts: Vec<String> = Vec::new();
        for key in ["supported_reasoning_levels", "supportedReasoningEfforts", "supported_reasoning_efforts"] {
            if let Some(levels) = model.get(key).and_then(Value::as_array) {
                for level in levels {
                    let effort = level.as_str().or_else(|| level.get("effort").and_then(Value::as_str))
                        .or_else(|| level.get("reasoningEffort").and_then(Value::as_str));
                    if let Some(effort) = effort.filter(|effort|
                        matches!(*effort, "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")) {
                        if !efforts.iter().any(|value| value == effort) { efforts.push(effort.to_string()); }
                    }
                }
            }
        }
        // Union our reviewed capabilities with explicit third-party metadata.
        // Unknown model names and an arbitrary number of levels are not proof
        // of Ultra support, so the compatibility path does not guess those.
        let model_name = canonical_codex_catalog_entry_model_name(model, id, routes);
        let declared = ["supported_reasoning_levels", "supportedReasoningEfforts", "supported_reasoning_efforts"]
            .iter().any(|key| model.get(*key).is_some_and(Value::is_array));
        let non_reasoning = declared && efforts.iter().all(|effort| effort == "none");
        if !non_reasoning && codex_model_supports_ultra_reasoning(&model_name) {
            for effort in ["max", "ultra"] {
                if !efforts.iter().any(|value| value == effort) { efforts.push(effort.into()); }
            }
        }
        if efforts.iter().any(|value| value == "ultra") { result.insert(id.to_string(), json!(efforts)); }
    }
    result
}

pub(super) fn state() -> Value {
    let config_path = codex_fuel_runtime_config_path();
    let Ok(config) = read_text_if_exists(&config_path) else { return disabled_state(false, "route-inactive"); };
    let Ok(router) = load_router_state() else { return disabled_state(false, "route-inactive"); };
    let aggregate = aggregate_login_state_snapshot();
    let aggregate_running = AGGREGATE_ROUTER_RUNTIME.lock().ok()
        .and_then(|runtime| runtime.as_ref().cloned())
        .is_some_and(|runtime| !runtime.stop.load(Ordering::SeqCst)
            && runtime.port == aggregate.router_port && runtime.token == aggregate.router_token);
    // Authorize the same config snapshot used below, rather than checking one
    // snapshot and then accidentally reading a different route for injection.
    if !json_bool(&codex_fuel_guard::status(&config, &router, &aggregate, aggregate_running), "enabled") {
        return disabled_state(managed_route_requested(&config, &router), "route-inactive");
    }
    let Some(catalog_path) = codex_managed_ultra_catalog_path(&config_path, &config)
        .or_else(|| compatible_catalog_path(&config_path, &config)) else {
        return disabled_state(true, "catalog-unavailable");
    };
    let Ok(catalog_bytes) = fs::read(&catalog_path) else { return disabled_state(true, "catalog-unavailable"); };
    let Ok(catalog) = serde_json::from_slice::<Value>(&catalog_bytes) else {
        return disabled_state(true, "catalog-unavailable");
    };
    let model_reasoning_efforts = catalog_reasoning_efforts(&catalog, &aggregate.routes);
    if model_reasoning_efforts.is_empty() { return disabled_state(true, "model-unsupported"); }
    // Include the actual config and catalog in the identity so a changed route,
    // setting, or capability cannot inherit a previous menu's successful check.
    let mut digest = Sha256::new();
    digest.update(config.as_bytes());
    digest.update([0]);
    digest.update(catalog_path.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(&catalog_bytes);
    digest.update(GENERATION.load(Ordering::SeqCst).to_le_bytes());
    json!({
        "requested": true,
        "enabled": true,
        "provider": configured_provider(&config),
        "modelCatalogPath": catalog_path.to_string_lossy(),
        "managedCatalogPaths": [catalog_path.to_string_lossy()],
        "modelReasoningEfforts": model_reasoning_efforts,
        "platform": std::env::consts::OS,
        "scopeKey": format!("{:x}", digest.finalize()),
    })
}

pub(super) fn reset() {
    // A delayed response from the previous process must not validate a newly
    // restarted process even when its config and global revision are identical.
    if let Ok(mut connection) = CONNECTION.lock() { *connection = Connection::default(); }
    invalidate_observation();
}

fn same_scope(value: &Value, expected: &Value) -> bool {
    json_bool(value, "enabled") == json_bool(expected, "enabled")
        && value["scopeKey"].as_str() == expected["scopeKey"].as_str()
}

/// Keep a healthy pending observer alive through cold-start model loading.
/// This deliberately does not claim that Ultra has already been verified.
pub(super) fn healthy(value: &Value, expected: &Value) -> bool {
    if !json_bool(expected, "enabled") {
        return !json_bool(value, "enabled");
    }
    same_scope(value, expected)
        && version() > 0
        && value["version"].as_u64() == Some(version())
        && json_bool(value, "healthy")
        && !json_bool(value, "needsReinstall")
        && (json_str(value, "error").is_empty() || json_str(value, "reason") == "asset-timeout")
}

fn public_error(reason: &str) -> &'static str {
    // Never forward renderer error text, paths, account data, or arbitrary HTML.
    match reason {
        "unsupported-query" => "当前 Codex 版本的 Ultra 界面尚未适配。",
        "verification-failed" => "Ultra 界面检查未通过，正在重试。",
        "connection-unavailable" => "暂时无法连接 Codex 界面，Ultra 检查尚未完成。",
        "observation-expired" => "Ultra 验证已过期，等待当前 Codex 界面重新确认。",
        "asset-timeout" => "Ultra 界面资源加载超时，正在自动重试。",
        "catalog-unavailable" => "Ultra 模型目录不可用，请重新执行 API 登录以修复配置。",
        "route-inactive" => "当前 API 路由未就绪，Ultra 适配尚未启用，请检查登录配置。",
        _ => "",
    }
}

fn public_status(value: &Value, expected: &Value) -> Value {
    if !json_bool(expected, "enabled") {
        let requested = json_bool(expected, "requested");
        let reason = match expected["reason"].as_str().unwrap_or("") {
            r @ ("route-inactive" | "catalog-unavailable" | "model-unsupported") => r,
            _ => "disabled",
        };
        let error = if requested { public_error(reason) } else { "" };
        return json!({"requested": requested, "enabled": false, "ready": false,
            "verified": false, "reason": reason, "error": error,
            "warnings": if error.is_empty() { Vec::<&str>::new() } else { vec![error] }});
    }
    let current = same_scope(value, expected) && value["version"].as_u64() == Some(version());
    let verified = current && healthy(value, expected)
        && json_bool(value, "ready") && json_bool(value, "verified")
        && json_str(value, "reason") == "ready";
    let reason = if verified { "ready" } else if !current { "awaiting-page" } else {
        match value["reason"].as_str().unwrap_or("") {
            r @ ("awaiting-page" | "awaiting-model-query" | "unsupported-query"
                | "verification-failed" | "connection-unavailable" | "setting-disabled"
                | "model-unsupported" | "visible-model-unsupported" | "route-inactive"
                | "awaiting-visible-picker" | "asset-timeout" | "catalog-unavailable"
                | "observation-expired") => r,
            _ if !json_str(value, "error").is_empty() => "verification-failed",
            _ => "awaiting-model-query",
        }
    };
    let error = public_error(reason);
    json!({"requested": true, "enabled": true, "ready": verified,
        "verified": verified, "reason": reason, "error": error,
        "warnings": if error.is_empty() { Vec::<&str>::new() } else { vec![error] }})
}

pub(super) fn record(value: &Value, revision: u64) {
    let generation = GENERATION.load(Ordering::SeqCst);
    let expected = state();
    if !value.is_object() || value["scopeKey"].as_str().is_none() {
        source_unavailable(revision);
        return;
    }
    if revision != current_codex_runtime_revision() || !same_scope(value, &expected) {
        return;
    }
    if let Ok(mut observation) = OBSERVATION.lock() {
        // A disconnect can race a response already received from the old page.
        if generation != GENERATION.load(Ordering::SeqCst)
            || revision != current_codex_runtime_revision() { return; }
        *observation = Some(Observation {
            scope_key: json_str(&expected, "scopeKey"), revision,
            observed_at: Instant::now(), value: value.clone(),
        });
    }
}

fn status_snapshot(
    observation: Option<&Observation>, expected: &Value, revision: u64,
    connection: ConnectionState, now: Instant,
) -> Value {
    let current = observation.filter(|observation| {
        observation.revision == revision
            && observation.scope_key == json_str(expected, "scopeKey")
    });
    let age = current.map(|observation| now.saturating_duration_since(observation.observed_at));
    let fresh = json_bool(expected, "enabled")
        && connection != ConnectionState::Disconnected
        && age.is_some_and(|age| age < Duration::from_millis(CODEX_RUNTIME_HEALTHCHECK_MS.saturating_mul(3)));
    let unavailable_reason = if connection == ConnectionState::Disconnected {
        Some("connection-unavailable")
    } else if current.is_some() && !fresh {
        Some("observation-expired")
    } else { None };
    let value = if fresh {
        current.map(|observation| observation.value.clone()).unwrap_or(Value::Null)
    } else if let Some(reason) = unavailable_reason {
        json!({"enabled": true, "scopeKey": expected["scopeKey"], "version": version(),
            "ready": false, "verified": false, "healthy": false, "reason": reason})
    } else { Value::Null };
    let mut result = public_status(&value, expected);
    result["runtimeVersion"] = json!(version());
    result["observationFresh"] = json!(fresh);
    result["observationAgeMs"] = age.map(|age| json!(age.as_millis().min(u64::MAX as u128) as u64)).unwrap_or(Value::Null);
    result["connectionState"] = json!(connection.as_str());
    result
}

pub(super) fn status() -> Value {
    let expected = state();
    let connection = CONNECTION.lock().ok().map(|connection| connection.state)
        .unwrap_or(ConnectionState::Unknown);
    let observation = OBSERVATION.lock().ok();
    status_snapshot(observation.as_deref().and_then(Option::as_ref), &expected,
        current_codex_runtime_revision(), connection, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected() -> Value { json!({"enabled": true, "scopeKey": "route-one"}) }
    fn ready() -> Value {
        json!({"enabled": true, "scopeKey": "route-one", "version": version(),
            "ready": true, "verified": true, "healthy": true,
            "needsReinstall": false, "reason": "ready", "error": ""})
    }

    #[test]
    fn ultra_status_requires_current_scope_version_and_actual_verification() {
        assert!(version() > 0);
        assert_eq!(public_status(&ready(), &expected())["verified"], true);
        for (field, value) in [("scopeKey", json!("old-route")), ("version", json!(version()+1)),
            ("verified", json!(false)), ("ready", json!(false)), ("healthy", json!(false)),
            ("needsReinstall", json!(true)), ("error", json!("untrusted renderer error"))] {
            let mut sample = ready(); sample[field] = value;
            assert_eq!(public_status(&sample, &expected())["verified"], false, "{field}");
        }
    }

    #[test]
    fn ultra_pending_observer_is_healthy_without_reporting_success() {
        let mut sample = ready();
        sample["ready"] = json!(false); sample["verified"] = json!(false);
        sample["reason"] = json!("awaiting-model-query");
        assert!(healthy(&sample, &expected()));
        let status = public_status(&sample, &expected());
        assert_eq!(status["verified"], false);
        assert_eq!(status["reason"], "awaiting-model-query");
    }

    #[test]
    fn ultra_status_does_not_forward_renderer_errors_or_stale_success() {
        let mut sample = ready();
        sample["error"] = json!("secret renderer payload");
        sample["reason"] = json!("unsupported-query");
        assert!(!public_status(&sample, &expected()).to_string().contains("secret"));
        assert_eq!(public_status(&Value::Null, &expected())["reason"], "awaiting-page");
        assert_eq!(public_status(&ready(), &json!({"enabled":false}))["requested"], false);
        assert!(!healthy(&ready(), &json!({"enabled":false})));
    }

    #[test]
    fn ultra_disabled_status_distinguishes_configuration_and_model_reasons() {
        for reason in ["route-inactive", "catalog-unavailable", "model-unsupported"] {
            let status = public_status(&ready(), &disabled_state(true, reason));
            assert_eq!(status["requested"], true);
            assert_eq!(status["enabled"], false);
            assert_eq!(status["verified"], false);
            assert_eq!(status["reason"], reason);
            assert_eq!(status["error"], public_error(reason));
        }
        let official = public_status(&ready(), &disabled_state(false, "route-inactive"));
        assert_eq!(official["requested"], false);
        assert_eq!(official["error"], "");
        assert_eq!(official["warnings"], json!([]));
    }

    #[test]
    fn ultra_requested_state_does_not_treat_other_providers_as_managed() {
        let mut router = default_router_state();
        router.mode = "relay".to_string();
        let config = build_codex_direct_config(
            "fixture-key", "https://relay.example.invalid/v1", "gpt-6.1-sol",
        );
        assert!(managed_route_requested(&config, &router));
        for config in [
            config.replace("model_provider = \"custom\"", "model_provider = \"openai\""),
            config.replace("name = \"Gaoge\"", "name = \"Personal\""),
            format!("profile = \"personal\"\n{config}"),
            String::new(),
        ] {
            assert!(!managed_route_requested(&config, &router));
        }
        router.mode = "official".to_string();
        assert!(!managed_route_requested(&config, &router));
    }

    #[test]
    fn ultra_visible_picker_and_asset_timeout_are_not_verified_success() {
        for reason in ["awaiting-visible-picker", "visible-model-unsupported", "asset-timeout"] {
            let mut sample = ready();
            sample["reason"] = json!(reason);
            if reason == "asset-timeout" {
                sample["error"] = json!("sensitive path from a resource timeout");
            }
            let status = public_status(&sample, &expected());
            assert!(healthy(&sample, &expected()));
            assert_eq!(status["verified"], false);
            assert_eq!(status["ready"], false);
            assert_eq!(status["reason"], reason);
            assert!(!status.to_string().contains("sensitive"));
        }
    }

    #[test]
    fn ultra_observation_expiry_and_disconnection_never_reuse_ready() {
        let now = Instant::now();
        let observation = Observation { scope_key: "route-one".to_string(), revision: 7,
            observed_at: now, value: ready() };
        let fresh = status_snapshot(Some(&observation), &expected(), 7, ConnectionState::Connected, now);
        assert_eq!(fresh["verified"], true);
        assert_eq!(fresh["observationFresh"], true);
        assert_eq!(fresh["observationAgeMs"], 0);
        assert_eq!(fresh["runtimeVersion"], version());
        let deadline = now + Duration::from_millis(CODEX_RUNTIME_HEALTHCHECK_MS * 3);
        let expired = status_snapshot(Some(&observation), &expected(), 7, ConnectionState::Connected, deadline);
        assert_eq!(expired["verified"], false);
        assert_eq!(expired["ready"], false);
        assert_eq!(expired["observationFresh"], false);
        assert_eq!(expired["reason"], "observation-expired");
        let disconnected = status_snapshot(Some(&observation), &expected(), 7, ConnectionState::Disconnected, now);
        assert_eq!(disconnected["verified"], false);
        assert_eq!(disconnected["reason"], "connection-unavailable");
        assert_eq!(disconnected["connectionState"], "disconnected");
        assert_eq!(disconnected["observationFresh"], false);
    }

    #[test]
    fn ultra_diagnostics_do_not_forward_stale_scope_or_renderer_payloads() {
        let now = Instant::now();
        let mut payload = ready();
        payload["error"] = json!("secret/path?token=private");
        payload["sourceUrl"] = json!("file:///private/catalog.json");
        payload["reason"] = json!("unsupported-query");
        let observation = Observation { scope_key: "route-one".to_string(), revision: 7,
            observed_at: now, value: payload };
        let status = status_snapshot(Some(&observation), &expected(), 7, ConnectionState::Connected, now);
        assert_eq!(status["reason"], "unsupported-query");
        assert!(!status.to_string().contains("private"));
        assert!(!status.to_string().contains("secret"));
        for (expected, revision) in [(expected(), 8), (json!({"enabled":true,"scopeKey":"new-route"}), 7)] {
            let stale = status_snapshot(Some(&observation), &expected, revision, ConnectionState::Connected, now);
            assert_eq!(stale["reason"], "awaiting-page");
            assert_eq!(stale["observationFresh"], false);
            assert_eq!(stale["observationAgeMs"], Value::Null);
        }
    }

    #[test]
    fn ultra_catalog_unions_gaoge_and_codex_plus_metadata_without_guessing_unknown_models() {
        let catalog = json!({"models":[
            {"slug":"gpt-6.1-sol","supported_reasoning_levels":[{"effort":"high"},{"effort":"max"}]},
            {"model":"group/vendor-explicit","supportedReasoningEfforts":[{"reasoningEffort":"high"},{"reasoningEffort":"ultra"}]},
            {"slug":"unknown-four-level-model","supported_reasoning_levels":["low","medium","high","max"]},
            {"slug":"gpt-5.5","supported_reasoning_levels":["low","medium","high","xhigh"]}
        ]});
        let map = catalog_reasoning_efforts(&catalog, &[]);
        assert!(map["gpt-6.1-sol"].as_array().unwrap().contains(&json!("ultra")));
        assert_eq!(map["group/vendor-explicit"], json!(["high","ultra"]));
        assert!(!map.contains_key("unknown-four-level-model"));
        assert!(!map.contains_key("gpt-5.5"));
        let data = json!({"data":[{"id":"third-party-model","supported_reasoning_efforts":["high","ultra"]}]});
        assert_eq!(catalog_reasoning_efforts(&data, &[])["third-party-model"], json!(["high","ultra"]));
    }

    #[test]
    fn ultra_catalog_aggregate_route_identity_and_nonreasoning_caps_remain_exact() {
        let catalog = json!({"models":[
            {"slug":"gaoge/openai/1/gpt-6-astra","supported_reasoning_levels":[{"effort":"high"},{"effort":"max"}]},
            {"slug":"gaoge/custom/openai/1/gpt-6-astra","gaoge_aggregate_source":"custom",
             "gaoge_aggregate_provider_id":"openai","gaoge_aggregate_group_id":"1",
             "gaoge_aggregate_public_model":"gaoge/custom/openai/1/gpt-6-astra",
             "gaoge_aggregate_upstream_model":"gpt-6-astra","supported_reasoning_levels":[{"effort":"max"}]},
            {"slug":"gaoge/custom/openai/2/gpt-6-astra","supported_reasoning_levels":[{"effort":"max"}]},
            {"slug":"gaoge/openai/empty/gpt-6-astra","supported_reasoning_levels":[]},
            {"slug":"gaoge/openai/none/gpt-6-astra","supported_reasoning_levels":[{"effort":"none"}]},
            {"slug":"gaoge/deepseek/1/deepseek-v4-pro","supported_reasoning_levels":[{"effort":"high"},{"effort":"max"}]},
            {"slug":"gaoge/kimi/1/kimi-k3","supported_reasoning_levels":[{"effort":"high"},{"effort":"max"}]}
        ]});
        let map = catalog_reasoning_efforts(&catalog, &[]);
        assert_eq!(map.len(), 2);
        assert!(map["gaoge/openai/1/gpt-6-astra"].as_array().unwrap().contains(&json!("ultra")));
        assert!(map["gaoge/custom/openai/1/gpt-6-astra"].as_array().unwrap().contains(&json!("ultra")));
        assert!(!map.contains_key("gpt-6-astra"));
    }

    #[test]
    fn ultra_compatibility_catalog_is_read_only_and_stays_within_active_codex_home() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("config.toml");
        fs::write(&config_path, "").unwrap();
        let catalog_dir = directory.path().join("codex-plus");
        fs::create_dir(&catalog_dir).unwrap();
        let catalog_path = catalog_dir.join("model-catalog.json");
        let original = r#"{"models":[{"model":"vendor-model","supportedReasoningEfforts":["ultra"]}]}"#;
        fs::write(&catalog_path, original).unwrap();
        let config = "model_catalog_json = \"codex-plus/model-catalog.json\"\n";
        assert_eq!(compatible_catalog_path(&config_path, config).and_then(|path| fs::canonicalize(path).ok()),
            Some(fs::canonicalize(&catalog_path).unwrap()));
        assert_eq!(fs::read_to_string(&catalog_path).unwrap(), original);
        let outside = tempfile::NamedTempFile::new().unwrap();
        let config = format!("model_catalog_json = {}\n", json!(outside.path().to_string_lossy()));
        assert!(compatible_catalog_path(&config_path, &config).is_none());
    }

}
