//! Server-owned model injection policy. Only our ordinary relay catalog is managed.
//! Remote input supplies model identifiers, never paths, TOML, credentials or code.
use super::*;

const MAX_POLICY_BYTES: u64 = 128 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct Policy {
    pub version: u32,
    pub enabled: bool,
    pub models: Vec<String>,
    pub revision: String,
    #[serde(default, rename = "modelCapabilities", skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub model_capabilities: std::collections::BTreeMap<String, ModelCapabilities>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelCapabilities {
    #[serde(default, deserialize_with = "optional_capability", skip_serializing_if = "Option::is_none")]
    pub supports_ultra: Option<bool>,
    #[serde(default, deserialize_with = "optional_capability", skip_serializing_if = "Option::is_none")]
    pub supports_fast: Option<bool>,
}

// Missing is legacy behavior. Explicit null, strings, and numbers are invalid,
// never equivalent to a positive capability or a silently cleared override.
fn optional_capability<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<bool>, D::Error> {
    bool::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug)]
pub(super) struct Resolution {
    pub policy: Policy,
    pub warning: String,
}

fn validate_policy(value: &Value) -> Result<Policy, String> {
    let mut policy: Policy =
        serde_json::from_value(value.clone()).map_err(|_| "模型支持策略格式无效。".to_string())?;
    if policy.version != 1
        || policy.models.len() > 100
        || policy.revision.is_empty()
        || policy.revision.len() > 256
        || !policy.revision.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("模型支持策略版本或内容无效。".to_string());
    }
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for candidate in &policy.models {
        let model = candidate.trim();
        if model.is_empty()
            || model.len() > 200
            || !model.as_bytes()[0].is_ascii_alphanumeric()
            || !model.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'_' | b'-' | b'/' | b':' | b'@')
            })
        {
            return Err("模型支持策略包含无效或非对话模型。".to_string());
        }
        if seen.insert(model.to_string()) {
            models.push(model.to_string());
        }
    }
    if policy.enabled && models.is_empty() {
        return Err("已启用的模型支持策略不能为空。".to_string());
    }
    if policy.model_capabilities.len() > 100
        || policy.model_capabilities.keys().any(|model| !models.contains(model))
    {
        return Err("模型能力声明必须对应当前模型名单。".to_string());
    }
    policy.models = models;
    Ok(policy)
}

// Only generated, owned catalog entries receive these local bookkeeping fields.
// Keep the original capability fields so removing a declaration restores legacy
// behavior rather than treating our previous injection as independent metadata.
const CAPABILITY_FIELDS: &[&str] = &[
    "supported_reasoning_levels", "supportedReasoningEfforts", "supported_reasoning_efforts",
    "default_reasoning_level", "multi_agent_version", "additional_speed_tiers", "service_tiers",
    "additionalSpeedTiers", "serviceTiers",
];

pub(super) fn entry_override(entry: &Map<String, Value>, capability: &str) -> Option<bool> {
    entry.get("gaogeModelCapabilities")?.get(capability)?.as_bool()
}

pub(super) fn restore_entry_capabilities(entry: &mut Map<String, Value>) {
    if let Some(baseline) = entry.remove("gaogeCapabilityBaseline").and_then(|value| value.as_object().cloned()) {
        for key in CAPABILITY_FIELDS {
            match baseline.get(*key) {
                Some(Value::Null) | None => { entry.remove(*key); }
                Some(value) => { entry.insert((*key).into(), value.clone()); }
            }
        }
    }
    entry.remove("gaogeModelCapabilities");
}

pub(super) fn preserve_nonreasoning_declarations(catalog: &mut Value, targets: &[CodexDirTarget]) {
    let mut seen = HashSet::new();
    for path in codex_model_cache_paths(targets) {
        let Ok(Some(cache)) = read_json_if_exists(&path) else { continue; };
        for source in cache["models"].as_array().into_iter().flatten() {
            let Some(id) = source["slug"].as_str() else { continue; };
            if !seen.insert(id.to_string()) { continue; }
            let Some(levels) = source["supported_reasoning_levels"].as_array() else { continue; };
            if !levels.iter().all(|level| codex_reasoning_level_effort(level) == Some("none")) { continue; }
            if let Some(entry) = catalog["models"].as_array_mut().into_iter().flatten()
                .find(|entry| entry["slug"].as_str() == Some(id)) {
                entry["supported_reasoning_levels"] = if levels.is_empty() { json!([]) } else { json!([codex_reasoning_level_entry("none")]) };
                entry["default_reasoning_level"] = json!("none");
            }
        }
    }
}

pub(super) fn apply_catalog_capabilities(catalog: &mut Value, policy: &Policy) {
    for entry in catalog.get_mut("models").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(model) = entry.get("slug").and_then(Value::as_str).map(str::to_owned) else { continue; };
        let Some(object) = entry.as_object_mut() else { continue; };
        restore_entry_capabilities(object);
        if !policy.enabled { continue; }
        let Some(capabilities) = policy.model_capabilities.get(&model) else { continue; };
        if capabilities.supports_ultra.is_none() && capabilities.supports_fast.is_none() { continue; }
        let baseline = CAPABILITY_FIELDS.iter().map(|key| ((*key).to_string(), object.get(*key).cloned().unwrap_or(Value::Null)))
            .collect::<Map<_, _>>();
        object.insert("gaogeCapabilityBaseline".into(), Value::Object(baseline));
        object.insert("gaogeModelCapabilities".into(), serde_json::to_value(capabilities).expect("boolean capabilities serialize"));
        reconcile_codex_reasoning_levels(object, &model);
        reconcile_codex_multi_agent_version(object, &model);
        reconcile_codex_speed_tiers(object, &model);
    }
}

pub(super) fn catalog_ultra_overrides(catalog: &Value) -> Map<String, Value> {
    catalog["models"].as_array().into_iter().flatten().filter_map(|entry| {
        Some((entry["slug"].as_str()?.to_string(), json!(entry_override(entry.as_object()?, "supportsUltra")?)))
    }).collect()
}

pub(super) fn reconcile_selected_capabilities(config: &str, catalog: &Value) -> Result<String, String> {
    let model = configured_root_value(config, "model").unwrap_or_default();
    let Some(entry) = catalog["models"].as_array().into_iter().flatten()
        .find(|entry| entry["slug"].as_str() == Some(model.as_str())) else { return Ok(config.to_string()); };
    let mut document = config.parse::<toml_edit::Document>().map_err(|_| "当前 Codex 配置无效。")?;
    let mut changed = false;
    if let Some(effort) = configured_root_value(config, "model_reasoning_effort") {
        let safe = codex_catalog_reasoning_effort(catalog, &model, Some(&effort));
        if safe != effort {
            document["model_reasoning_effort"] = toml_edit::value(safe);
            changed = true;
        }
    }
    if entry.as_object().and_then(|object| entry_override(object, "supportsFast")) == Some(false)
        && configured_root_value(config, "service_tier").is_some_and(|tier| matches!(tier.as_str(), "fast" | "priority"))
    {
        document["service_tier"] = toml_edit::value("default");
        changed = true;
    }
    Ok(if changed { document.to_string() } else { config.to_string() })
}

pub(super) fn reconcile_previous_selection(config: &str, old_config: &str, catalog: &Value, previous: Option<&Value>) -> Result<String, String> {
    let old_model = configured_root_value(old_config, "model").unwrap_or_default();
    let owned_fast = previous.and_then(|catalog| catalog["models"].as_array()).into_iter().flatten()
        .find(|entry| entry["slug"].as_str() == Some(old_model.as_str()))
        .and_then(Value::as_object).and_then(|entry| entry_override(entry, "supportsFast")) == Some(true);
    let selected = configured_root_value(config, "model").unwrap_or_default();
    let next_supports_fast = catalog["models"].as_array().into_iter().flatten()
        .find(|entry| entry["slug"].as_str() == Some(selected.as_str())).is_some_and(codex_model_entry_declares_speed);
    if owned_fast && !next_supports_fast
        && configured_root_value(config, "service_tier").is_some_and(|tier| matches!(tier.as_str(), "fast" | "priority")) {
        let mut document = config.parse::<toml_edit::Document>().map_err(|_| "当前 Codex 配置无效。")?;
        document["service_tier"] = toml_edit::value("default");
        return Ok(document.to_string());
    }
    Ok(config.to_string())
}

fn parse_payload(payload: &Value) -> Result<Policy, String> {
    if payload.get("success").and_then(Value::as_bool) == Some(false) {
        return Err("模型支持配置读取失败。".to_string());
    }
    let data = payload
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(payload);
    if payload.get("desktopModelSupportError").is_some()
        || data.get("desktopModelSupportError").is_some()
    {
        return Err("服务器暂时无法读取模型支持配置。".to_string());
    }
    let value = data
        .get("desktopModelSupport")
        .ok_or_else(|| "服务器尚未提供模型支持配置，请更新服务端后重试。".to_string())?;
    // Conflicting compatibility envelopes must never silently disable restrictions.
    if data != payload
        && payload
            .get("desktopModelSupport")
            .is_some_and(|outer| outer != value)
    {
        return Err("模型支持配置响应不一致。".to_string());
    }
    validate_policy(value)
}

fn endpoint(base_url: &str) -> Result<String, String> {
    let mut url = url::Url::parse(base_url).map_err(|_| "模型策略服务器地址无效。".to_string())?;
    let loopback_test = cfg!(test)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if (url.scheme() != "https" && !loopback_test)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("模型策略仅接受当前中转服务器的安全地址。".to_string());
    }
    url.set_path("/api/v1/desktop/config");
    Ok(url.to_string())
}

fn cache_path(endpoint: &str) -> PathBuf {
    let key = format!("{:x}", Sha256::digest(endpoint.as_bytes()));
    roaming_app_dir()
        .join("desktop-model-support")
        .join(format!("{key}.json"))
}

fn fetch(endpoint: &str) -> Result<Policy, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建模型配置请求。".to_string())?;
    let response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache, no-store")
        .send()
        .map_err(|_| "模型配置请求失败，请检查当前服务器连接。".to_string())?;
    if !response.status().is_success() {
        return Err("模型配置服务器返回异常状态。".to_string());
    }
    let mut body = Vec::new();
    response
        .take(MAX_POLICY_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| "读取模型配置响应失败。".to_string())?;
    if body.len() as u64 > MAX_POLICY_BYTES {
        return Err("模型配置响应过大。".to_string());
    }
    let payload =
        serde_json::from_slice(&body).map_err(|_| "模型配置响应不是有效 JSON。".to_string())?;
    parse_payload(&payload)
}

fn cached_policy(path: &Path, endpoint: &str) -> Result<Option<Policy>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(path)
        .map_err(|_| "读取模型配置缓存失败。")?
        .len()
        > MAX_POLICY_BYTES
    {
        return Err("模型配置缓存过大。".to_string());
    }
    let value = read_json_if_exists(path)?.ok_or("模型配置缓存缺失。")?;
    if value.get("endpoint").and_then(Value::as_str) != Some(endpoint) {
        return Err("模型配置缓存不属于当前服务器。".to_string());
    }
    validate_policy(value.get("policy").ok_or("模型配置缓存内容缺失。")?).map(Some)
}

fn resolve_with_cache(
    endpoint: &str,
    path: &Path,
    result: Result<Policy, String>,
) -> Result<Resolution, String> {
    match result {
        Ok(policy) => {
            let saved = serde_json::to_string_pretty(&json!({"endpoint":endpoint,"policy":policy}))
                .map_err(|_| "模型配置缓存编码失败。".to_string())?;
            write_text_atomic(path, &saved).map_err(|_| {
                "模型支持配置无法持久保存，已取消本次写入，避免离线时恢复过期限制。".to_string()
            })?;
            Ok(Resolution {
                policy,
                warning: String::new(),
            })
        }
        Err(error) => match cached_policy(path, endpoint)? {
            Some(policy) => Ok(Resolution {
                policy,
                warning: format!(
                    "{error} 已保留当前服务器上次成功的模型支持策略，未回退全量模型。"
                ),
            }),
            None => Err(format!(
                "{error} 尚无已验证缓存，已暂停模型写入，请稍后重试。"
            )),
        },
    }
}

fn usable(mut resolved: Resolution) -> Result<Resolution, String> {
    if resolved.policy.enabled {
        let count = resolved.policy.models.len();
        resolved
            .policy
            .models
            .retain(|model| is_codex_conversation_model(model));
        resolved.policy.model_capabilities.retain(|model, _| resolved.policy.models.contains(model));
        if resolved.policy.models.is_empty() {
            return Err(
                "模型支持清单没有可用于对话的模型，已暂停写入；不会回退全量模型。".to_string(),
            );
        }
        if resolved.policy.models.len() != count {
            resolved.warning = format!(
                "{} 已跳过 {} 个纯生图模型，仅写入可用于对话的模型。",
                resolved.warning,
                count - resolved.policy.models.len()
            )
            .trim()
            .to_string();
        }
    }
    Ok(resolved)
}

fn pair_path(relay: &str) -> PathBuf {
    let key = format!(
        "{:x}",
        Sha256::digest(relay.trim_end_matches('/').as_bytes())
    );
    roaming_app_dir()
        .join("desktop-model-support")
        .join(format!("pair-{key}.json"))
}

fn policy_endpoint(control_base: &str) -> Result<String, String> {
    let mut url = url::Url::parse(control_base).map_err(|_| "模型策略控制服务地址无效。")?;
    endpoint(control_base)?; // Shared scheme/credentials/query validation, not path inference.
    url.set_path(&format!(
        "{}/desktop/config",
        url.path().trim_end_matches('/')
    ));
    Ok(url.to_string())
}

pub(super) fn remember_pair(relay: &str, control_base: &str) -> Result<(), String> {
    endpoint(relay)?;
    let control = policy_endpoint(control_base)?;
    let pair = json!({"relay":relay.trim_end_matches('/'),"control":control});
    write_text_atomic(&pair_path(relay), &pair.to_string())
        .map_err(|_| "模型策略服务配对无法保存，已取消操作。".to_string())
}

fn saved_endpoint(relay: &str) -> Result<String, String> {
    let saved = read_json_if_exists(&pair_path(relay))?
        .ok_or("未登记此中转的模型策略控制地址，请在登录页面重新登录或重启。")?;
    if saved.get("relay").and_then(Value::as_str) != Some(relay.trim_end_matches('/')) {
        return Err("模型策略服务配对不匹配。".to_string());
    }
    let control = saved
        .get("control")
        .and_then(Value::as_str)
        .ok_or("模型策略控制地址缺失。")?;
    endpoint(control)?;
    Ok(control.to_string())
}

pub(super) fn refresh(relay: &str, control_base: Option<&str>) -> Result<Resolution, String> {
    if let Some(control) = control_base.filter(|value| !value.trim().is_empty()) {
        remember_pair(relay, control)?;
    }
    let endpoint = saved_endpoint(relay)?;
    let scope = format!("{}\n{}", endpoint, relay.trim_end_matches('/'));
    resolve_received(&scope, &cache_path(&scope), fetch(&endpoint))
}

fn resolve_received(
    scope: &str,
    path: &Path,
    received: Result<Policy, String>,
) -> Result<Resolution, String> {
    // Validate/filter before persisting: an unusable all-media response cannot
    // displace a working last-known strategy or trigger the disabled fallback.
    let received = match received {
        // A successfully received enabled policy without conversation models is
        // an authoritative invalid configuration, not an offline condition.
        Ok(policy) => Ok(usable(Resolution {
            policy,
            warning: String::new(),
        })?),
        Err(error) => Err(error),
    };
    let warning = received
        .as_ref()
        .ok()
        .map(|result| result.warning.clone())
        .unwrap_or_default();
    let mut resolved = resolve_with_cache(scope, path, received.map(|result| result.policy))?;
    if !warning.is_empty() {
        resolved.warning = [resolved.warning, warning].join(" ").trim().to_string();
    }
    usable(resolved)
}

pub(super) fn constrain_request(request: &Value, resolved: &Resolution) -> Value {
    let mut next = request.clone();
    if resolved.policy.enabled {
        next["modelSelectionMode"] = json!(CODEX_MODEL_SELECTION_UPSTREAM);
        next["modelCatalogSource"] = json!(CODEX_MODEL_CATALOG_SOURCE_UPSTREAM);
        next["supportedModels"] = json!(resolved.policy.models);
        if !request
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|model| {
                resolved
                    .policy
                    .models
                    .iter()
                    .any(|allowed| allowed == model)
            })
        {
            next["model"] = json!(resolved.policy.models[0]);
        }
    }
    next
}

pub(super) fn mark_login_catalog(
    target: &CodexDirTarget,
    existing: &str,
    catalog: &Value,
) -> Result<Value, String> {
    let mut next = catalog.clone();
    if catalog.get("gaogeDesktopModelSupport").is_none() {
        return Ok(next);
    }
    let path = target.dir.join(CODEX_MODEL_CATALOG_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("受管理模型目录不能是符号链接。".to_string());
    }
    let previous = read_json_if_exists(&path)?;
    let marker = previous
        .as_ref()
        .and_then(|value| value.get("gaogeDesktopModelSupport"));
    let revision = catalog["gaogeDesktopModelSupport"]["revision"].clone();
    next["gaogeDesktopModelSupport"] = marker.cloned().unwrap_or_else(|| json!({
        "version":1,"previousCatalog":previous,"previousModel":configured_root_value(existing,"model"),
    }));
    next["gaogeDesktopModelSupport"]["revision"] = revision;
    Ok(next)
}

struct Rewrite {
    config_path: PathBuf,
    catalog_path: PathBuf,
    old_config: String,
    old_catalog: Option<Vec<u8>>,
    config: String,
    catalog: Vec<u8>,
}

fn prepare_rewrite(
    target: &CodexDirTarget,
    router: &RouterState,
    policy: &Policy,
) -> Result<Option<Rewrite>, String> {
    let config_path = target.dir.join("config.toml");
    let existing = read_text_if_exists(&config_path)?;
    if !json_bool(
        &codex_fuel_guard::status(&existing, router, &default_aggregate_login_state(), false),
        "enabled",
    ) {
        return Ok(None);
    }
    let catalog_path = match codex_managed_ultra_catalog_path(&config_path, &existing) {
        Some(path) => path,
        None if !policy.enabled => return Ok(None),
        None => return Err("受管理的模型目录路径异常，已停止自动覆盖，请重新登录。".to_string()),
    };
    let old_catalog = OptionalFileSnapshot::capture(catalog_path.clone())?.contents;
    let previous = old_catalog
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok());
    let marker = previous
        .as_ref()
        .and_then(|value| value.get("gaogeDesktopModelSupport"));
    if !policy.enabled && marker.is_none() {
        return Ok(None);
    }
    let mut models = policy.models.clone();
    let restore_catalog = if !policy.enabled {
        marker
            .and_then(|value| value.get("previousCatalog"))
            .filter(|value| value.is_object())
            .cloned()
    } else {
        None
    };
    if let Some(catalog) = &restore_catalog {
        models = codex_catalog_model_names(catalog);
    }
    if models.is_empty() {
        return Err("恢复前的模型目录为空，已停止覆盖。".to_string());
    }
    let plan = CodexModelCatalogPlan {
        mode: CODEX_MODEL_SELECTION_UPSTREAM.to_string(),
        source: CODEX_MODEL_CATALOG_SOURCE_UPSTREAM.to_string(),
        models: models.clone(),
        warning: String::new(),
    };
    let current = configured_root_value(&existing, "model").unwrap_or_default();
    let restored_model = if !policy.enabled {
        marker
            .and_then(|value| value.get("previousModel"))
            .and_then(Value::as_str)
            .unwrap_or(&current)
    } else {
        &current
    };
    let preferred = if models.iter().any(|model| model == restored_model) {
        restored_model
    } else {
        models[0].as_str()
    };
    let resolved = resolve_codex_model_catalog(std::slice::from_ref(target), preferred, &plan)?;
    let mut document = existing
        .parse::<toml_edit::Document>()
        .map_err(|_| "当前 Codex 配置无效。")?;
    if current != resolved.model {
        document["model"] = toml_edit::value(resolved.model);
    }
    let config =
        if current == configured_root_value(&document.to_string(), "model").unwrap_or_default() {
            existing.clone()
        } else {
            document.to_string()
        };
    validate_codex_config_toml(&config)?;
    let mut catalog_value = restore_catalog.unwrap_or(resolved.catalog);
    if policy.enabled {
        preserve_nonreasoning_declarations(&mut catalog_value, std::slice::from_ref(target));
        apply_catalog_capabilities(&mut catalog_value, policy);
    }
    let config = reconcile_selected_capabilities(&config, &catalog_value)?;
    let config = reconcile_previous_selection(&config, &existing, &catalog_value, previous.as_ref())?;
    if policy.enabled {
        catalog_value["gaogeDesktopModelSupport"] = marker.cloned().unwrap_or_else(|| {
            json!({
                "version":1,"previousCatalog":previous,"previousModel":current,
            })
        });
        catalog_value["gaogeDesktopModelSupport"]["revision"] = json!(policy.revision);
    }
    let catalog = serde_json::to_vec_pretty(&catalog_value).map_err(|_| "模型目录编码失败。")?;
    Ok(Some(Rewrite {
        config_path,
        catalog_path,
        old_config: existing,
        old_catalog,
        config,
        catalog,
    }))
}

fn apply_rewrites(rewrites: &[Rewrite]) -> Result<(), String> {
    let mut applied: Vec<&Rewrite> = Vec::new();
    for item in rewrites {
        let result = (|| {
            if read_text_if_exists(&item.config_path)? != item.old_config
                || OptionalFileSnapshot::capture(item.catalog_path.clone())?.contents
                    != item.old_catalog
            {
                return Err("模型配置已被其他程序更新，已取消本次覆盖。".to_string());
            }
            write_bytes_atomic(&item.catalog_path, &item.catalog)?;
            applied.push(item);
            if item.config != item.old_config {
                write_codex_config_atomic(&item.config_path, Some(&item.old_config), &item.config)?;
            }
            let actual = fs::read(&item.catalog_path).map_err(|_| "读取模型目录校验失败。")?;
            if actual != item.catalog || read_text_if_exists(&item.config_path)? != item.config {
                return Err("模型目录写入校验失败。".to_string());
            }
            Ok(())
        })();
        if let Err(error) = result {
            let mut failures = Vec::new();
            for written in applied.iter().rev() {
                if written.config != written.old_config
                    && read_text_if_exists(&written.config_path).ok().as_deref()
                        == Some(written.config.as_str())
                {
                    if let Err(error) = write_codex_config_atomic(
                        &written.config_path,
                        Some(&written.config),
                        &written.old_config,
                    ) {
                        failures.push(error);
                    }
                }
                if fs::read(&written.catalog_path).ok().as_deref()
                    == Some(written.catalog.as_slice())
                {
                    if let Err(error) = (OptionalFileSnapshot {
                        path: written.catalog_path.clone(),
                        contents: written.old_catalog.clone(),
                    })
                    .restore()
                    {
                        failures.push(error);
                    }
                }
            }
            return Err(if failures.is_empty() {
                error
            } else {
                format!("{error}；回滚失败：{}", failures.join("；"))
            });
        }
    }
    Ok(())
}

fn discover_legacy_models(router: &RouterState) -> (Vec<String>, String) {
    // Disabled is an explicit successful policy, so restore pre-policy discovery.
    let result = (|| {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ())?;
        for url in provider_model_endpoints(&router.relay_base_url, "codex").map_err(|_| ())? {
            let Ok(response) = client
                .get(&url)
                .bearer_auth(&router.relay_api_key)
                .header("Accept", "application/json")
                .header("Cache-Control", "no-cache")
                .send()
            else {
                continue;
            };
            if !response.status().is_success() {
                continue;
            }
            let mut bytes = Vec::new();
            if response
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() > 2 * 1024 * 1024
            {
                continue;
            }
            let Ok(payload) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let models: Vec<_> = extract_provider_model_names(&payload)
                .into_iter()
                .filter(|model| is_codex_conversation_model(model))
                .collect();
            if !models.is_empty() {
                return Ok(models);
            }
        }
        Err(())
    })();
    match result {
        Ok(models) => (models, String::new()),
        Err(()) => (
            codex_fallback_models(),
            "模型支持限制已关闭；上游模型获取失败，按原有行为使用内置兼容目录。".to_string(),
        ),
    }
}

/// Called after confirmed exit, before launch, including every native restart entry point.
pub(super) fn refresh_managed_catalogs(targets: &[CodexDirTarget]) -> Result<Value, String> {
    let router = load_router_state()?;
    if router.mode != "relay" || aggregate_login_state_snapshot().enabled {
        return Ok(json!({"warnings":[]}));
    }
    let mut owned = Vec::new();
    for target in targets {
        let config = read_text_if_exists(&target.dir.join("config.toml"))?;
        if json_bool(
            &codex_fuel_guard::status(&config, &router, &default_aggregate_login_state(), false),
            "enabled",
        ) {
            owned.push(target.clone());
        }
    }
    if owned.is_empty() {
        return Ok(json!({"warnings":[]}));
    }
    let resolved = refresh(&router.relay_base_url, None)?;
    let mut warnings = Vec::new();
    if !resolved.warning.is_empty() {
        warnings.push(resolved.warning.clone());
    }
    let mut catalog_policy = resolved.policy.clone();
    if !catalog_policy.enabled {
        // No previous takeover means disabled must be a true no-op (including
        // old locked-model configurations). Only a newly-created managed
        // catalog without a pre-policy baseline needs upstream discovery.
        let needs_discovery = owned.iter().any(|target| {
            read_json_if_exists(&target.dir.join(CODEX_MODEL_CATALOG_FILE))
                .ok()
                .flatten()
                .and_then(|catalog| catalog.get("gaogeDesktopModelSupport").cloned())
                .is_some_and(|marker| !marker.get("previousCatalog").is_some_and(Value::is_object))
        });
        if needs_discovery {
            let (models, warning) = discover_legacy_models(&router);
            catalog_policy.models = models;
            if !warning.is_empty() {
                warnings.push(warning);
            }
        }
    }
    let rewrites = owned
        .iter()
        .map(|target| prepare_rewrite(target, &router, &catalog_policy))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    apply_rewrites(&rewrites)?;
    Ok(
        json!({"warnings":warnings,"desktopModelSupportEnabled":resolved.policy.enabled,
        "desktopModelSupportRevision":resolved.policy.revision}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy(enabled: bool, models: &[&str]) -> Value {
        json!({"version":1,"enabled":enabled,"models":models,"revision":"revision-1"})
    }
    #[test]
    fn desktop_model_support_validates_contract_without_executing_remote_data() {
        let p = validate_policy(&policy(
            true,
            &[" gpt-6-sol ", "gpt-6-sol", "vendor/model:v2@fast"],
        ))
        .unwrap();
        assert_eq!(p.models, ["gpt-6-sol", "vendor/model:v2@fast"]);
        for model in ["", "../file", "model\ncode", "a\"b", "模型", "C:\\model"] {
            assert!(validate_policy(&policy(true, &[model])).is_err(), "{model}");
        }
        assert!(validate_policy(&policy(true, &[])).is_err());
        assert!(validate_policy(&policy(false, &[])).is_ok());
        assert!(
            validate_policy(&json!({"version":2,"enabled":false,"models":[],"revision":"x"}))
                .is_err()
        );
    }
    #[test]
    fn desktop_model_support_missing_or_unavailable_is_not_disabled() {
        assert!(parse_payload(&json!({"success":true,"data":{}})).is_err());
        assert!(parse_payload(&json!({"desktopModelSupportError":"unavailable","desktopModelSupport":policy(false,&[])})).is_err());
        assert!(
            !parse_payload(&json!({"data":{"desktopModelSupport":policy(false,&[])}}))
                .unwrap()
                .enabled
        );
    }
    #[test]
    fn desktop_model_support_cache_is_scoped_and_never_invents_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("policy.json");
        let endpoint = "https://relay.example.invalid/api/v1/desktop/config";
        assert!(resolve_with_cache(endpoint, &path, Err("offline".into())).is_err());
        let p = validate_policy(&policy(true, &["gpt-6-sol"])).unwrap();
        resolve_with_cache(endpoint, &path, Ok(p.clone())).unwrap();
        let cached = resolve_with_cache(endpoint, &path, Err("offline".into())).unwrap();
        assert_eq!(cached.policy, p);
        assert!(!cached.warning.is_empty());
        assert!(resolve_with_cache(
            "https://other.invalid/api/v1/desktop/config",
            &path,
            Err("offline".into())
        )
        .is_err());
    }
    #[test]
    fn desktop_model_support_overrides_fallback_and_supplied_models() {
        let resolution = Resolution {
            policy: validate_policy(&policy(true, &["gpt-6-sol"])).unwrap(),
            warning: String::new(),
        };
        let request = json!({"modelCatalogSource":"fallback","supportedModels":["unapproved"],"model":"gpt-5.5"});
        let adjusted = constrain_request(&request, &resolution);
        let (model, plan) = codex_model_catalog_plan(&adjusted, "gpt-5.5").unwrap();
        assert_eq!(model, "gpt-6-sol");
        assert_eq!(plan.models, ["gpt-6-sol"]);
        assert_eq!(plan.source, "upstream");
    }
    #[test]
    fn desktop_model_support_restart_replaces_only_owned_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let target = CodexDirTarget {
            dir: temp.path().to_path_buf(),
            source: "test",
            primary: true,
        };
        let mut router = default_router_state();
        router.mode = "relay".into();
        router.relay_base_url = "https://relay.example.invalid/v1".into();
        router.relay_api_key = "fixture-key".into();
        let old = write_codex_model_catalog(&target.dir, &["gpt-5.5".into(), "gpt-6-sol".into()])
            .unwrap();
        let config = format!(
            "{}\n# user comment\n[custom_user_section]\nkeep = true\n",
            build_codex_direct_config_with_catalog(
                &router.relay_api_key,
                &router.relay_base_url,
                "gpt-5.5",
                Some(&old.path),
                None
            )
        );
        fs::write(target.dir.join("config.toml"), &config).unwrap();
        let p = validate_policy(&policy(true, &["gpt-6-sol"])).unwrap();
        let rewrite = prepare_rewrite(&target, &router, &p).unwrap().unwrap();
        apply_rewrites(&[rewrite]).unwrap();
        let saved = fs::read_to_string(target.dir.join("config.toml")).unwrap();
        assert_eq!(
            configured_root_value(&saved, "model").as_deref(),
            Some("gpt-6-sol")
        );
        assert!(saved.contains("# user comment"));
        assert!(saved.contains("keep = true"));
        assert_eq!(
            codex_catalog_model_names(&read_json_if_exists(&old.path).unwrap().unwrap()),
            ["gpt-6-sol"]
        );
        let official = config.replace("model_provider = \"custom\"", "model_provider = \"openai\"");
        fs::write(target.dir.join("config.toml"), &official).unwrap();
        assert!(prepare_rewrite(&target, &router, &p).unwrap().is_none());
        assert_eq!(
            fs::read_to_string(target.dir.join("config.toml")).unwrap(),
            official
        );
    }
}

#[cfg(test)]
#[path = "desktop_model_support_tests.rs"]
mod integration_tests;
