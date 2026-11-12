//! User overrides and additional upstreams for the aggregate catalog.
//! Secrets are kept in the desktop's protected settings, never returned to the UI.
use crate::aggregate_protocol::Protocol;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

/// Origin is presentation/routing metadata, never proof of credential ownership.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AggregateSource {
    #[default]
    Builtin,
    Custom,
}
impl AggregateSource {
    pub(crate) fn from_legacy(value: Option<&str>, provider_id: &str, group_id: &str) -> Self {
        match value.map(str::trim) {
            Some("builtin") => Self::Builtin,
            Some("custom") => Self::Custom,
            // Only our previous custom-interface schema is evidence of custom
            // origin. Unknown brands/providers are not all user-owned routes.
            _ if provider_id.starts_with("external-") && group_id == "custom" => Self::Custom,
            _ => Self::Builtin,
        }
    }
}
const SETTINGS_FILE: &str = "codex-aggregate-model-settings.json";
fn empty() -> Value {
    json!({"version":2,"groups":[],"providers":[]})
}
fn load() -> Result<Value, String> {
    let mut value = super::read_json_if_exists(&super::roaming_app_dir().join(SETTINGS_FILE))?
        .unwrap_or_else(empty);
    if let Some(providers) = value["providers"].as_array_mut() {
        for provider in providers {
            provider["source"] = json!(AggregateSource::Custom);
            provider["enabled"] = json!(provider["enabled"].as_bool().unwrap_or(true));
            let encrypted = provider["encryptedApiKey"].as_str().unwrap_or_default();
            if !encrypted.is_empty() {
                provider["apiKey"] = json!(super::decrypt_secret(encrypted)?.unwrap_or_default());
            }
        }
    }
    value["version"] = json!(2);
    Ok(value)
}
fn text<'a>(v: &'a Value, name: &str) -> &'a str {
    v[name].as_str().unwrap_or_default().trim()
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(crate) fn validate_model_config(value: &Value) -> Result<Value, String> {
    if value.is_null() {
        return Ok(json!({}));
    }
    let object = value.as_object().ok_or("模型配置必须是对象。")?;
    let mut result = Map::new();
    if let Some(window) = object.get("contextWindow").filter(|v| !v.is_null()) {
        let window = window
            .as_u64()
            .filter(|n| (1024..=100_000_000).contains(n))
            .ok_or("上下文窗口须为 1,024 到 100,000,000 的整数。")?;
        result.insert("contextWindow".into(), json!(window));
    }
    if let Some(percent) = object.get("autoCompactPercent").filter(|v| !v.is_null()) {
        let percent = percent
            .as_u64()
            .filter(|n| (10..=100).contains(n))
            .ok_or("自动压缩比例须为 10 到 100 的整数。")?;
        result.insert("autoCompactPercent".into(), json!(percent));
    }
    let fast = text(value, "fast");
    if !fast.is_empty() && fast != "inherit" {
        if !matches!(fast, "supported" | "unsupported") {
            return Err("Fast 设置无效。".into());
        }
        result.insert("fast".into(), json!(fast));
    }
    Ok(Value::Object(result))
}
fn validate_models(value: &Value) -> Result<Vec<String>, String> {
    let values = value.as_array().ok_or("请填写模型列表。")?;
    if values.is_empty() || values.len() > 200 {
        return Err("每个供应商需设置 1 到 200 个模型。".into());
    }
    let mut models = Vec::new();
    for item in values {
        let model = item.as_str().unwrap_or_default().trim();
        if model.is_empty()
            || model.len() > 160
            || model.chars().any(char::is_control)
            || !super::is_codex_conversation_model(model)
        {
            return Err("模型列表包含空名称、无效名称或非对话模型。".into());
        }
        if !models.iter().any(|m| m == model) {
            models.push(model.to_owned());
        }
    }
    Ok(models)
}
fn validate_model_map(value: &Value) -> Result<Value, String> {
    if value.is_null() {
        return Ok(json!({}));
    }
    let map = value.as_object().ok_or("逐模型设置必须是对象。")?;
    if map.len() > 1000 {
        return Err("逐模型设置过多。".into());
    }
    let mut result = Map::new();
    for (model, config) in map {
        if model.trim().is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
            return Err("模型配置名称无效。".into());
        }
        result.insert(model.clone(), validate_model_config(config)?);
    }
    Ok(Value::Object(result))
}
fn validate(request: &Value, previous: &Value) -> Result<Value, String> {
    let groups = request["groups"].as_array().ok_or("缺少分组配置。")?;
    let providers = request["providers"].as_array().ok_or("缺少供应商配置。")?;
    if groups.len() > 1000 || providers.len() > 50 {
        return Err("供应商或分组配置过多。".into());
    }
    let mut next = empty();
    let mut seen = HashSet::new();
    for group in groups {
        let provider_id = text(group, "providerId");
        let group_id = text(group, "groupId");
        if !id(provider_id) || !id(group_id) || !seen.insert(format!("{provider_id}/{group_id}")) {
            return Err("分组标识无效或重复。".into());
        }
        let protocol = Protocol::parse(text(group, "protocol"))?;
        let settings = validate_model_map(&group["modelSettings"])?;
        if protocol == Protocol::AnthropicMessages
            && settings
                .as_object()
                .unwrap()
                .values()
                .any(|v| v["fast"] == "supported")
        {
            return Err(
                "Anthropic 接口暂不支持将 Codex Fast 映射为原厂加速，请使用自动或不支持。".into(),
            );
        }
        next["groups"].as_array_mut().unwrap().push(json!({"providerId":provider_id,"groupId":group_id,"protocol":protocol,"modelSettings":settings}));
    }
    seen.clear();
    for provider in providers {
        let provider_id = text(provider, "id");
        let name = text(provider, "name");
        let vendor = text(provider, "vendor");
        let enabled = match provider.get("enabled") {
            None | Some(Value::Null) => true,
            Some(Value::Bool(value)) => *value,
            _ => return Err("自有接口启用状态必须是布尔值。".into()),
        };
        if !provider_id.starts_with("external-")
            || !id(provider_id)
            || !seen.insert(provider_id.to_owned())
        {
            return Err("自定义供应商标识无效或重复。".into());
        }
        if name.is_empty() || name.len() > 80 || name.chars().any(char::is_control) || !id(vendor) {
            return Err("供应商名称或类型无效。".into());
        }
        let base_url = super::normalize_base_url_strict(Some(text(provider, "baseUrl")), "")?;
        let protocol = Protocol::parse(text(provider, "protocol"))?;
        crate::aggregate_protocol::endpoint(protocol, &base_url, "/responses")?;
        let old = previous["providers"].as_array().and_then(|ps| {
            ps.iter().find(|p| {
                p["id"] == provider_id
                    && p["baseUrl"] == base_url
                    && p["protocol"] == json!(protocol)
            })
        });
        let mut key = text(provider, "apiKey").to_owned();
        if key.is_empty() {
            key = old
                .map(|p| text(p, "apiKey").to_owned())
                .unwrap_or_default();
        }
        if key.is_empty() || key.len() > 8192 || key.chars().any(char::is_control) {
            return Err(format!(
                "请为 {name} 填写可用 API Key；更换地址或协议后需重新填写。"
            ));
        }
        let models = validate_models(&provider["models"])?;
        let settings = validate_model_map(&provider["modelSettings"])?;
        if protocol == Protocol::AnthropicMessages
            && settings
                .as_object()
                .unwrap()
                .values()
                .any(|v| v["fast"] == "supported")
        {
            return Err(format!("{name} 的 Anthropic 接口不能声明 Codex Fast。"));
        }
        next["providers"].as_array_mut().unwrap().push(json!({"id":provider_id,"source":AggregateSource::Custom,"enabled":enabled,"vendor":vendor,"name":name,"baseUrl":base_url,"protocol":protocol,"apiKey":key,"models":models,"modelSettings":settings}));
    }
    Ok(next)
}
fn public(mut value: Value) -> Value {
    for provider in value["providers"].as_array_mut().into_iter().flatten() {
        provider["source"] = json!(AggregateSource::Custom);
        provider["enabled"] = json!(provider["enabled"].as_bool().unwrap_or(true));
        provider["keyConfigured"] = json!(!text(provider, "apiKey").is_empty());
        provider["apiKey"] = json!("");
        provider.as_object_mut().unwrap().remove("encryptedApiKey");
    }
    value["presets"] = super::model_capabilities::provider_presets();
    value["modelCatalog"] = json!(super::model_capabilities::builtin_model_metadata_catalog());
    value
}
pub(crate) fn snapshot() -> Result<Value, String> {
    load().map(public)
}
pub(crate) fn save(request: &Value) -> Result<Value, String> {
    let mut next = validate(request, &load()?)?;
    let result = public(next.clone());
    for provider in next["providers"].as_array_mut().unwrap() {
        let key = text(provider, "apiKey");
        if let Some(encrypted) = super::encrypt_secret(key)? {
            provider["encryptedApiKey"] = json!(encrypted);
            provider["apiKey"] = json!("");
        }
    }
    super::write_json_pretty_atomic(&super::roaming_app_dir().join(SETTINGS_FILE), &next)?;
    Ok(result)
}
pub(crate) fn apply_to_request(request: &Value) -> Result<Value, String> {
    let settings = load()?;
    merge_request(request, &settings)
}
fn merge_request(request: &Value, settings: &Value) -> Result<Value, String> {
    let mut next = request.clone();
    let providers = next["providers"]
        .as_array_mut()
        .ok_or("聚合登录缺少模型供应商。")?;
    for provider in providers.iter_mut() {
        // This array comes from relay-account synchronization. Only protected
        // custom settings below may contribute a user-owned upstream.
        provider["source"] = json!(AggregateSource::Builtin);
        let provider_id = text(provider, "id").to_owned();
        for group in provider["groups"].as_array_mut().into_iter().flatten() {
            group["source"] = json!(AggregateSource::Builtin);
            let group_id = group["id"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| group["id"].to_string());
            if let Some(config) = settings["groups"].as_array().and_then(|gs| {
                gs.iter()
                    .find(|g| g["providerId"] == provider_id && g["groupId"] == group_id)
            }) {
                group["protocol"] = config["protocol"].clone();
                group["modelSettings"] = config["modelSettings"].clone();
            }
        }
    }
    for provider in settings["providers"].as_array().into_iter().flatten() {
        if !provider["enabled"].as_bool().unwrap_or(true) {
            continue;
        }
        providers.push(json!({"id":provider["id"],"source":AggregateSource::Custom,"enabled":true,"name":provider["name"],"baseUrl":provider["baseUrl"],"groups":[{
            "id":"custom", "name":"自有接口", "source":AggregateSource::Custom, "platform":provider["vendor"], "apiKey":provider["apiKey"],
            "baseUrl":provider["baseUrl"], "protocol":provider["protocol"], "models":provider["models"], "modelSettings":provider["modelSettings"]
        }]}));
    }
    Ok(next)
}

pub(crate) fn apply_model_overrides(entry: &mut Value, config: &Value, protocol: Protocol) {
    let Some(object) = entry.as_object_mut() else {
        return;
    };
    if let Some(window) = config["contextWindow"].as_u64().filter(|w| *w > 0) {
        object.insert("context_window".into(), json!(window));
        object.insert("max_context_window".into(), json!(window));
        object.insert("effective_context_window_percent".into(), json!(100));
        // An old window's limit must not survive a user changing the window.
        object.insert("auto_compact_token_limit".into(), Value::Null);
    }
    if let (Some(percent), Some(window)) = (
        config["autoCompactPercent"].as_u64(),
        object.get("context_window").and_then(Value::as_u64),
    ) {
        object.insert(
            "auto_compact_token_limit".into(),
            json!(window.saturating_mul(percent) / 100),
        );
    }
    let fast = text(config, "fast");
    if protocol == Protocol::AnthropicMessages || fast == "unsupported" {
        object.insert("service_tiers".into(), json!([]));
        object.insert("additional_speed_tiers".into(), json!([]));
    } else if fast == "supported" {
        object.insert(
            "service_tiers".into(),
            json!([{"id":"priority","name":"Fast","description":"上游声明支持优先处理"}]),
        );
        object.insert("additional_speed_tiers".into(), json!(["fast"]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aggregate_settings_windows_compaction_and_fast_are_per_model() {
        let mut a = json!({"context_window":100_000,"auto_compact_token_limit":90_000,"service_tiers":["priority"]});
        apply_model_overrides(
            &mut a,
            &json!({"contextWindow":200_000,"autoCompactPercent":85,"fast":"unsupported"}),
            Protocol::Responses,
        );
        assert_eq!(a["auto_compact_token_limit"], 170_000);
        assert_eq!(a["service_tiers"], json!([]));
        let mut b = json!({"context_window":128_000,"service_tiers":["priority"]});
        apply_model_overrides(&mut b, &json!({}), Protocol::AnthropicMessages);
        assert_eq!(b["context_window"], 128_000);
        assert_eq!(b["service_tiers"], json!([]));
    }
    #[test]
    fn aggregate_settings_rejects_invalid_values_and_never_reuses_keys_across_hosts() {
        assert!(validate_model_config(&json!({"contextWindow":-1})).is_err());
        assert!(validate_model_config(&json!({"autoCompactPercent":101})).is_err());
        let old = json!({"groups":[],"providers":[{"id":"external-test","name":"test","vendor":"deepseek","baseUrl":"https://one.example/v1","protocol":"chatCompletions","apiKey":"secret","models":["deepseek-v4-flash"]}]});
        let mut next = old.clone();
        next["providers"][0]["apiKey"] = json!("");
        assert!(validate(&next, &old).is_ok());
        next["providers"][0]["baseUrl"] = json!("https://two.example/v1");
        assert!(validate(&next, &old).is_err());
    }
    #[test]
    fn aggregate_settings_overlay_does_not_change_legacy_protocols() {
        let request = json!({"providers":[{"id":"openai","groups":[{"id":12,"models":["a"]}]}]});
        let result = merge_request(&request, &empty()).unwrap();
        assert!(result["providers"][0]["groups"][0]["protocol"].is_null());
        let result=merge_request(&request,&json!({"groups":[{"providerId":"openai","groupId":"12","protocol":"chatCompletions","modelSettings":{"a":{"contextWindow":128000}}}],"providers":[]})).unwrap();
        assert_eq!(
            result["providers"][0]["groups"][0]["protocol"],
            "chatCompletions"
        );
    }
}

#[cfg(test)]
#[path = "aggregate_settings_source_tests.rs"]
mod source_tests;
