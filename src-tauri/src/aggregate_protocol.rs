//! Responses bridges for explicitly configured upstream protocols.
//! Design reference: CodexPlusPlus 38033bf98325a32bbb80842441e2e0e2b3c9d7bd,
//! protocol_proxy.rs / anthropic_bridge.rs (AGPL-3.0). See aggregate_protocol.NOTICE.md.
//! No networking, account mutation, retries, or global provider selection lives here.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
static RESPONSE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const ENVELOPE: &str = "gaoge-protocol:v1:";
const MAX_EVENT: usize = 4 * 1024 * 1024;
const MAX_OUTPUT: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Protocol {
    #[serde(rename = "responses")]
    Responses,
    #[serde(
        rename = "chatCompletions",
        alias = "chat_completions",
        alias = "chat-completions",
        alias = "chat"
    )]
    ChatCompletions,
    #[serde(
        rename = "anthropicMessages",
        alias = "anthropic_messages",
        alias = "anthropic-messages",
        alias = "messages",
        alias = "anthropic"
    )]
    AnthropicMessages,
}
impl Default for Protocol {
    fn default() -> Self {
        Self::Responses
    }
}
impl Protocol {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '-'], "")
            .as_str()
        {
            "responses" | "response" => Ok(Self::Responses),
            "chatcompletions" | "chat" => Ok(Self::ChatCompletions),
            "anthropicmessages" | "messages" | "anthropic" => Ok(Self::AnthropicMessages),
            _ => Err(format!("不支持的聚合上游协议：{value}")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::ChatCompletions => "chatCompletions",
            Self::AnthropicMessages => "anthropicMessages",
        }
    }
}

pub(crate) fn endpoint(
    protocol: Protocol,
    base_url: &str,
    request_path: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(base_url).map_err(|_| "聚合上游地址无效。".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("聚合上游地址必须使用 HTTP 或 HTTPS。".into());
    }
    let incoming = request_path
        .split('?')
        .next()
        .unwrap_or(request_path)
        .trim_end_matches('/');
    if !matches!(
        incoming,
        "/responses" | "/v1/responses" | "/responses/compact" | "/v1/responses/compact"
    ) {
        return Err(unsupported("unknown Responses endpoint"));
    }
    let compact = incoming.ends_with("/responses/compact");
    if compact && protocol != Protocol::Responses {
        return Err("当前上游协议不支持 Responses /compact；请使用本地会话压缩。".into());
    }
    let suffix = match protocol {
        Protocol::Responses if compact => "responses/compact",
        Protocol::Responses => "responses",
        Protocol::ChatCompletions => "chat/completions",
        Protocol::AnthropicMessages => "messages",
    };
    let mut base = url.path().trim_end_matches('/').to_string();
    for tail in [
        "/responses/compact",
        "/chat/completions",
        "/responses",
        "/messages",
    ] {
        if base.ends_with(tail) {
            base.truncate(base.len() - tail.len());
            break;
        }
    }
    if base.is_empty() {
        base = "/v1".into();
    }
    // Chat SDK bases may end with /v2/coding or /v1beta/openai: these are
    // complete path prefixes. Anthropic keeps its /v1/messages convention.
    if protocol != Protocol::ChatCompletions
        && !base
            .rsplit('/')
            .next()
            .is_some_and(|s| s.starts_with('v') && s[1..].chars().all(|c| c.is_ascii_digit()))
    {
        base.push_str("/v1");
    }
    url.set_path(&format!("{base}/{suffix}"));
    // Retain explicit upstream query options (e.g. api-version), never the
    // incoming local-router query.
    url.set_fragment(None);
    Ok(url.to_string())
}
fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} 必须是 JSON 对象。"))
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("协议转换缺少字符串字段 {field}。"))
}
fn unsupported(label: &str) -> String {
    format!("当前上游协议无法可靠转换 {label}；请选择 Responses 协议或调整该请求。")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn encoded(value: Value) -> String {
    format!("{ENVELOPE}{}", STANDARD.encode(value.to_string()))
}
fn decode(value: &str) -> Option<Value> {
    let bytes = STANDARD.decode(value.strip_prefix(ENVELOPE)?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[derive(Clone, Debug)]
struct Tool {
    wire: String,
    name: String,
    namespace: Option<String>,
    custom: bool,
    definition: Value,
}
fn tools(request: &Value) -> Result<Vec<Tool>, String> {
    fn add(out: &mut Vec<Tool>, value: &Value, ns: Option<&str>) -> Result<(), String> {
        let kind = text(value, "type")?;
        if kind == "namespace" {
            if ns.is_some() {
                return Err(unsupported("nested namespace tools"));
            }
            let ns = text(value, "name")?;
            for nested in value
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| unsupported("namespace.tools"))?
            {
                add(out, nested, Some(ns))?;
            }
            return Ok(());
        }
        if !matches!(kind, "function" | "custom") {
            return Err(unsupported(&format!("tool type {kind}")));
        }
        let name = text(value, "name")?.to_string();
        let namespace = ns
            .or_else(|| value.get("namespace").and_then(Value::as_str))
            .map(str::to_owned);
        let wire = namespace
            .as_ref()
            .map(|ns| format!("{ns}__{name}"))
            .unwrap_or_else(|| name.clone());
        if wire.is_empty()
            || wire.len() > 64
            || !wire
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        {
            return Err(unsupported(&format!("tool name {wire}")));
        }
        if out.iter().any(|t| t.wire == wire) {
            return Err(unsupported("colliding tool names"));
        }
        let custom = kind == "custom";
        let parameters = if custom {
            json!({"type":"object","properties":{"input":{"type":"string"}},"required":["input"],"additionalProperties":false})
        } else {
            value
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({"type":"object","properties":{}}))
        };
        let mut definition = json!({"name":wire,"parameters":parameters});
        if let Some(description) = value.get("description") {
            definition["description"] = description.clone();
        }
        if custom {
            // A grammar cannot constrain Chat/Messages generation, but its full
            // source is preserved in the tool contract rather than discarded.
            let mut desc = definition
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            desc.push_str(
                "\nPass the tool's exact raw input as the input string. Do not alter its syntax.",
            );
            if let Some(format) = value.get("format") {
                desc.push_str("\nRequired input format: ");
                desc.push_str(&format.to_string());
            }
            definition["description"] = json!(desc);
        }
        if let Some(strict) = value.get("strict") {
            definition["strict"] = strict.clone();
        }
        out.push(Tool {
            wire,
            name,
            namespace,
            custom,
            definition,
        });
        Ok(())
    }
    let mut out = Vec::new();
    if let Some(value) = request.get("tools").filter(|v| !v.is_null()) {
        for tool in value.as_array().ok_or_else(|| unsupported("tools"))? {
            add(&mut out, tool, None)?;
        }
    }
    Ok(out)
}
fn lookup<'a>(tools: &'a [Tool], name: &str, namespace: Option<&str>) -> Result<&'a Tool, String> {
    tools
        .iter()
        .find(|t| t.name == name && t.namespace.as_deref() == namespace)
        .or_else(|| tools.iter().find(|t| t.wire == name))
        .ok_or_else(|| unsupported(&format!("undeclared tool {name}")))
}
fn image(value: &Value, protocol: Protocol) -> Result<Value, String> {
    let url = value
        .get("image_url")
        .and_then(Value::as_str)
        .ok_or_else(|| unsupported("input_image without image_url (file_id)"))?;
    if protocol == Protocol::ChatCompletions {
        let mut result = json!({"type":"image_url","image_url":{"url":url}});
        if let Some(detail) = value.get("detail") {
            result["image_url"]["detail"] = detail.clone();
        }
        return Ok(result);
    }
    if let Some(data) = url.strip_prefix("data:") {
        let (mime, body) = data
            .split_once(";base64,")
            .ok_or_else(|| unsupported("non-base64 image data URL"))?;
        if !matches!(
            mime,
            "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        ) {
            return Err(unsupported(&format!("image media type {mime}")));
        }
        if STANDARD.decode(body).is_err() {
            return Err("图片 Base64 数据无效。".into());
        }
        Ok(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":body}}))
    } else if url.starts_with("https://") || url.starts_with("http://") {
        Ok(json!({"type":"image","source":{"type":"url","url":url}}))
    } else {
        Err(unsupported("image URL scheme"))
    }
}
fn content(value: &Value, protocol: Protocol) -> Result<Vec<Value>, String> {
    if let Some(s) = value.as_str() {
        return Ok(vec![json!({"type":"text","text":s})]);
    }
    let mut out = Vec::new();
    for part in value
        .as_array()
        .ok_or_else(|| unsupported("message content"))?
    {
        match text(part, "type")? {
            "input_text" | "output_text" | "text" => {
                out.push(json!({"type":"text","text":text(part,"text")?}))
            }
            "input_image" => out.push(image(part, protocol)?),
            "refusal" => out.push(json!({"type":"text","text":text(part,"refusal")?})),
            kind => return Err(unsupported(&format!("content type {kind}"))),
        }
    }
    Ok(out)
}
fn push_message(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>, protocol: Protocol) {
    if protocol == Protocol::AnthropicMessages && messages.last().is_some_and(|m| m["role"] == role)
    {
        messages.last_mut().unwrap()["content"]
            .as_array_mut()
            .unwrap()
            .extend(blocks);
    } else {
        messages.push(json!({"role":role,"content":blocks}));
    }
}
fn assistant(messages: &mut Vec<Value>) -> &mut Value {
    if !messages.last().is_some_and(|m| m["role"] == "assistant") {
        messages.push(json!({"role":"assistant","content":null}));
    }
    messages.last_mut().unwrap()
}
fn add_chat_text(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if role == "assistant" && messages.last().is_some_and(|m| m["role"] == "assistant") {
        let m = messages.last_mut().unwrap();
        if m["content"].is_null() {
            m["content"] = json!([]);
        }
        m["content"].as_array_mut().unwrap().extend(blocks);
    } else {
        messages.push(json!({"role":role,"content":blocks}));
    }
}
fn choice(value: &Value, list: &[Tool], protocol: Protocol) -> Result<Value, String> {
    if let Some(mode) = value.as_str() {
        if !matches!(mode, "auto" | "none" | "required") {
            return Err(unsupported("tool_choice"));
        }
        return Ok(if protocol == Protocol::ChatCompletions {
            json!(mode)
        } else {
            json!({"type": if mode == "required" {"any"} else {mode}})
        });
    }
    if !matches!(
        value.get("type").and_then(Value::as_str),
        Some("function" | "custom")
    ) {
        return Err(unsupported("tool_choice"));
    }
    let spec = lookup(
        list,
        text(value, "name")?,
        value.get("namespace").and_then(Value::as_str),
    )?;
    Ok(if protocol == Protocol::ChatCompletions {
        json!({"type":"function","function":{"name":spec.wire}})
    } else {
        json!({"type":"tool","name":spec.wire})
    })
}

pub(crate) fn prepare_request(protocol: Protocol, request: &Value) -> Result<Value, String> {
    if protocol == Protocol::Responses {
        return Ok(request.clone());
    }
    let root = object(request, "Responses request")?;
    for key in root.keys() {
        if !matches!(
            key.as_str(),
            "model"
                | "input"
                | "instructions"
                | "tools"
                | "tool_choice"
                | "parallel_tool_calls"
                | "reasoning"
                | "store"
                | "stream"
                | "include"
                | "prompt_cache_key"
                | "prompt_cache_retention"
                | "service_tier"
                | "truncation"
                | "max_output_tokens"
                | "max_tokens"
                | "max_completion_tokens"
                | "temperature"
                | "top_p"
                | "text"
                | "metadata"
                | "client_metadata"
                | "previous_response_id"
                | "conversation"
                | "background"
                | "safety_identifier"
                | "user"
                | "stream_options"
        ) {
            return Err(unsupported(&format!("request field {key}")));
        }
    }
    for key in ["previous_response_id", "conversation"] {
        if request.get(key).is_some_and(|v| !v.is_null()) {
            return Err(unsupported(key));
        }
    }
    if request.get("background") == Some(&json!(true)) {
        return Err(unsupported("background execution"));
    }
    let list = tools(request)?;
    if list.is_empty()
        && request
            .get("tool_choice")
            .is_some_and(|v| !v.is_null() && !matches!(v.as_str(), Some("none" | "auto")))
    {
        return Err(unsupported("tool_choice without tools"));
    }
    if request
        .get("truncation")
        .is_some_and(|v| !v.is_null() && v.as_str() != Some("disabled"))
    {
        return Err(unsupported("server-side automatic truncation"));
    }
    if let Some(reasoning) = request.get("reasoning").filter(|v| !v.is_null()) {
        for key in object(reasoning, "reasoning")?.keys() {
            if !matches!(key.as_str(), "effort" | "summary") {
                return Err(unsupported(&format!("reasoning.{key}")));
            }
        }
    }
    if let Some(options) = request.get("text").filter(|v| !v.is_null()) {
        for key in object(options, "text")?.keys() {
            if !matches!(key.as_str(), "format" | "verbosity") {
                return Err(unsupported(&format!("text.{key}")));
            }
        }
    }
    let mut result = json!({"model":text(request,"model")?,"stream":request.get("stream").and_then(Value::as_bool).unwrap_or(false)});
    if protocol == Protocol::ChatCompletions {
        for key in [
            "store",
            "safety_identifier",
            "user",
            "prompt_cache_key",
            "prompt_cache_retention",
        ] {
            if let Some(value) = request.get(key) {
                result[key] = value.clone();
            }
        }
    }
    if let Some(verbosity) = request.pointer("/text/verbosity") {
        if protocol == Protocol::ChatCompletions {
            result["verbosity"] = verbosity.clone();
        } else {
            return Err(unsupported("Anthropic text.verbosity"));
        }
    }
    for key in ["temperature", "top_p"] {
        if let Some(v) = request.get(key) {
            result[key] = v.clone();
        }
    }
    let max = request
        .get("max_output_tokens")
        .or_else(|| request.get("max_completion_tokens"))
        .or_else(|| request.get("max_tokens"));
    if let Some(v) = max {
        if v.as_u64().filter(|v| *v > 0).is_none() {
            return Err(unsupported("max output tokens"));
        }
        result[if protocol == Protocol::AnthropicMessages {
            "max_tokens"
        } else {
            "max_completion_tokens"
        }] = v.clone();
    }
    if protocol == Protocol::AnthropicMessages && max.is_none() {
        result["max_tokens"] = json!(8192);
    }
    if let Some(tier) = request.get("service_tier").filter(|v| !v.is_null()) {
        if protocol == Protocol::ChatCompletions {
            result["service_tier"] = tier.clone();
        } else {
            match tier.as_str() {
                Some("auto") => result["service_tier"] = json!("auto"),
                Some("default" | "standard" | "standard_only") => {
                    result["service_tier"] = json!("standard_only")
                }
                _ => {
                    return Err(unsupported(
                        "Anthropic service_tier (priority is not Anthropic Fast)",
                    ))
                }
            }
        }
    }
    if let Some(include) = request.get("include").filter(|v| !v.is_null()) {
        for value in include.as_array().ok_or_else(|| unsupported("include"))? {
            if value.as_str() != Some("reasoning.encrypted_content") {
                return Err(unsupported("include field"));
            }
        }
    }
    let mut messages = Vec::new();
    let mut system = Vec::new();
    let mut extras = HashMap::<String, Value>::new();
    if let Some(instructions) = request.get("instructions").filter(|v| !v.is_null()) {
        let blocks = content(instructions, protocol)?;
        if protocol == Protocol::AnthropicMessages {
            system.extend(blocks);
        } else {
            push_message(&mut messages, "system", blocks, protocol);
        }
    }
    let input = request
        .get("input")
        .ok_or_else(|| unsupported("missing input"))?;
    let input = if input.is_string() {
        vec![json!({"role":"user","content":input})]
    } else {
        input
            .as_array()
            .ok_or_else(|| unsupported("input"))?
            .clone()
    };
    let mut pending_calls = HashMap::<String, bool>::new();
    let mut pending_tool_images = Vec::new();
    for item in input {
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        match kind {
            "reasoning" => {
                // Opaque provider-owned encrypted history is not portable. Only
                // our tagged envelopes are decoded; user/tool content is never removed.
                if let Some(envelope) = item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .and_then(decode)
                    .filter(|v| {
                        v["protocol"] == protocol.as_str()
                            && v.get("model").map_or(true, |m| m == &request["model"])
                    })
                {
                    if protocol == Protocol::AnthropicMessages {
                        if let Some(blocks) = envelope.get("blocks").and_then(Value::as_array) {
                            push_message(&mut messages, "assistant", blocks.clone(), protocol);
                        }
                    } else {
                        if let Some(reasoning) = envelope.get("reasoning_content") {
                            assistant(&mut messages)["reasoning_content"] = reasoning.clone();
                        }
                        if let Some(values) = envelope.get("tool_extras").and_then(Value::as_object)
                        {
                            extras.extend(values.iter().map(|(k, v)| (k.clone(), v.clone())));
                        }
                    }
                }
            }
            "message" => {
                let role = text(&item, "role")?;
                if !matches!(role, "system" | "developer" | "user" | "assistant") {
                    return Err(unsupported(&format!("message role {role}")));
                }
                let blocks = content(
                    item.get("content")
                        .ok_or_else(|| unsupported("empty message content"))?,
                    protocol,
                )?;
                if protocol == Protocol::AnthropicMessages {
                    if matches!(role, "system" | "developer") {
                        system.extend(blocks);
                    } else {
                        push_message(&mut messages, role, blocks, protocol);
                    }
                } else {
                    add_chat_text(
                        &mut messages,
                        if role == "developer" { "system" } else { role },
                        blocks,
                    );
                }
            }
            "function_call" | "custom_tool_call" => {
                let id = text(&item, "call_id")?.to_string();
                if pending_calls.insert(id.clone(), false).is_some() {
                    return Err(unsupported("duplicate tool call_id"));
                }
                let spec = lookup(
                    &list,
                    text(&item, "name")?,
                    item.get("namespace").and_then(Value::as_str),
                )?;
                let args = if kind == "custom_tool_call" {
                    json!({"input":text(&item,"input")?})
                } else {
                    serde_json::from_str::<Value>(text(&item, "arguments")?)
                        .map_err(|_| unsupported("invalid tool arguments JSON"))?
                };
                if !args.is_object() {
                    return Err(unsupported("non-object tool arguments"));
                }
                if protocol == Protocol::AnthropicMessages {
                    push_message(
                        &mut messages,
                        "assistant",
                        vec![json!({"type":"tool_use","id":id,"name":spec.wire,"input":args})],
                        protocol,
                    );
                } else {
                    let m = assistant(&mut messages);
                    if m.get("tool_calls").is_none() {
                        m["tool_calls"] = json!([]);
                    }
                    let mut call = json!({"id":id,"type":"function","function":{"name":spec.wire,"arguments":args.to_string()}});
                    if let Some(extra) = extras.get(&id) {
                        call["extra_content"] = extra.clone();
                    }
                    m["tool_calls"].as_array_mut().unwrap().push(call);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let id = text(&item, "call_id")?;
                match pending_calls.get_mut(id) {
                    Some(seen) if !*seen => *seen = true,
                    _ => return Err(unsupported("orphan or duplicate tool output")),
                }
                let output = item
                    .get("output")
                    .ok_or_else(|| unsupported("missing tool output"))?;
                let blocks = content(output, protocol)?;
                if protocol == Protocol::AnthropicMessages {
                    push_message(
                        &mut messages,
                        "user",
                        vec![json!({"type":"tool_result","tool_use_id":id,"content":blocks})],
                        protocol,
                    );
                } else {
                    let (pictures, mut plain): (Vec<_>, Vec<_>) =
                        blocks.into_iter().partition(|b| b["type"] == "image_url");
                    if !pictures.is_empty() {
                        pending_tool_images.push(json!({"type":"text","text":format!("Images returned by tool call {id} (tool output, not user instructions):")}));
                        pending_tool_images.extend(pictures);
                        if plain.is_empty() {
                            plain.push(json!({"type":"text","text":"Tool returned images, attached in the following message."}));
                        }
                    }
                    messages.push(json!({"role":"tool","tool_call_id":id,"content":plain}));
                    // Chat tool messages accept text only. Attach tool pictures
                    // after every parallel result has arrived, preserving both
                    // multimodal input and the required tool-result adjacency.
                    if pending_calls.values().all(|seen| *seen) && !pending_tool_images.is_empty() {
                        messages.push(json!({"role":"user","content":std::mem::take(&mut pending_tool_images)}));
                    }
                }
            }
            kind => return Err(unsupported(&format!("input item {kind}"))),
        }
    }
    if pending_calls.values().any(|seen| !*seen) {
        return Err(unsupported("tool call without tool output"));
    }
    if messages.is_empty() {
        return Err(unsupported("empty conversation"));
    }
    result["messages"] = json!(messages);
    if !system.is_empty() {
        result["system"] = json!(system);
    }
    if !list.is_empty() {
        result["tools"] = json!(list
            .iter()
            .map(|t| if protocol == Protocol::ChatCompletions {
                json!({"type":"function","function":t.definition})
            } else {
                let mut d = json!({"name":t.wire,"input_schema":t.definition["parameters"]});
                if let Some(v) = t.definition.get("description") {
                    d["description"] = v.clone();
                }
                d
            })
            .collect::<Vec<_>>());
        if let Some(v) = request.get("tool_choice") {
            result["tool_choice"] = choice(v, &list, protocol)?;
        }
        if let Some(v) = request.get("parallel_tool_calls") {
            if protocol == Protocol::ChatCompletions {
                result["parallel_tool_calls"] = v.clone();
            } else {
                if result.get("tool_choice").is_none() {
                    result["tool_choice"] = json!({"type":"auto"});
                }
                result["tool_choice"]["disable_parallel_tool_use"] = json!(!v
                    .as_bool()
                    .ok_or_else(|| unsupported("parallel_tool_calls"))?);
            }
        }
    }
    if let Some(format) = request
        .pointer("/text/format")
        .filter(|v| v.get("type").and_then(Value::as_str) != Some("text"))
    {
        if protocol == Protocol::AnthropicMessages {
            return Err(unsupported("structured text format on Anthropic"));
        }
        match format.get("type").and_then(Value::as_str) {
            Some("json_object") => result["response_format"] = json!({"type":"json_object"}),
            Some("json_schema") => {
                let mut schema = format.clone();
                schema.as_object_mut().unwrap().remove("type");
                result["response_format"] = json!({"type":"json_schema","json_schema":schema});
            }
            _ => return Err(unsupported("text.format")),
        }
    }
    if let Some(effort) = request.pointer("/reasoning/effort").and_then(Value::as_str) {
        if protocol == Protocol::ChatCompletions {
            result["reasoning_effort"] = json!(effort);
        } else if !matches!(effort, "none" | "minimal") {
            if result.get("temperature").is_some() || result.get("top_p").is_some() {
                return Err(unsupported("Anthropic thinking with temperature/top_p"));
            }
            let model = text(request, "model")?.to_ascii_lowercase();
            let adaptive = [
                "opus-4-6",
                "opus-4-7",
                "opus-4-8",
                "sonnet-4-6",
                "opus-5",
                "sonnet-5",
                "fable-5",
                "mythos-5",
            ]
            .iter()
            .any(|m| model.contains(m));
            if adaptive {
                let level = match effort {
                    "low" | "medium" | "high" | "max" => effort,
                    "xhigh" | "ultra" => "max",
                    _ => return Err(unsupported("reasoning.effort")),
                };
                result["thinking"] = json!({"type":"adaptive"});
                result["output_config"] = json!({"effort":level});
            } else {
                let budget = match effort {
                    "low" => 1024,
                    "medium" => 4096,
                    "high" => 8192,
                    "xhigh" => 16384,
                    "max" | "ultra" => 32768,
                    _ => return Err(unsupported("reasoning.effort")),
                };
                // The generic 8192 output default must not silently reduce
                // a requested high/max thinking budget to medium. Only grow
                // our own default; an explicit caller limit stays authoritative.
                if max.is_none() {
                    result["max_tokens"] = json!(8192_u64.max(budget * 2));
                }
                let max = result["max_tokens"].as_u64().unwrap();
                let budget = budget.min(max / 2);
                if budget < 1024 {
                    return Err(unsupported("thinking token budget below 1024"));
                }
                result["thinking"] = json!({"type":"enabled","budget_tokens":budget});
            }
        }
    }
    if protocol == Protocol::ChatCompletions && result["stream"] == true {
        result["stream_options"] = json!({"include_usage":true});
    }
    Ok(result)
}

#[derive(Default)]
struct PendingTool {
    id: String,
    name: String,
    arguments: String,
    emitted: usize,
    output: Option<usize>,
    extra: Option<Value>,
}

pub(crate) struct StreamAdapter {
    protocol: Protocol,
    model: String,
    id: String,
    created: u64,
    list: Vec<Tool>,
    line: Vec<u8>,
    data: Vec<String>,
    event: String,
    event_size: usize,
    received: usize,
    sequence: u64,
    started: bool,
    ended: bool,
    finish_reason: Option<String>,
    items: Vec<Value>,
    text_index: Option<usize>,
    reasoning_index: Option<usize>,
    pending: BTreeMap<u64, PendingTool>,
    blocks: BTreeMap<u64, (String, usize)>,
    thinking: BTreeMap<u64, Value>,
    closed: HashSet<u64>,
    extras: Map<String, Value>,
    reasoning_text: String,
    usage: Value,
    final_status: String,
    failure: Option<String>,
}
impl StreamAdapter {
    pub fn new(protocol: Protocol, request: &Value) -> Result<Self, String> {
        Ok(Self {
            protocol,
            model: text(request, "model")?.into(),
            id: format!(
                "resp_bridge_{}_{}_{}",
                now(),
                std::process::id(),
                RESPONSE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
            created: now(),
            list: if protocol == Protocol::Responses {
                Vec::new()
            } else {
                tools(request)?
            },
            line: Vec::new(),
            data: Vec::new(),
            event: String::new(),
            event_size: 0,
            received: 0,
            sequence: 0,
            started: false,
            ended: false,
            finish_reason: None,
            items: Vec::new(),
            text_index: None,
            reasoning_index: None,
            pending: BTreeMap::new(),
            blocks: BTreeMap::new(),
            thinking: BTreeMap::new(),
            closed: HashSet::new(),
            extras: Map::new(),
            reasoning_text: String::new(),
            usage: json!({"input_tokens":0,"output_tokens":0,"total_tokens":0,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}),
            final_status: "in_progress".into(),
            failure: None,
        })
    }
    fn emit(&mut self, kind: &str, mut value: Value, out: &mut Vec<u8>) {
        value["type"] = json!(kind);
        value["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        out.extend_from_slice(format!("event: {kind}\ndata: {value}\n\n").as_bytes());
    }
    fn response(&self) -> Value {
        json!({"id":self.id,"object":"response","created_at":self.created,"status":self.final_status,"model":self.model,"output":self.items,"usage":self.usage,
            "error":self.failure.as_ref().map(|m|json!({"code":"upstream_error","message":m})),
            "incomplete_details":if self.final_status=="incomplete"{Some(json!({"reason":self.finish_reason.as_deref().unwrap_or("upstream_stream_interrupted")}))}else{None},"parallel_tool_calls":true})
    }
    fn start(&mut self, out: &mut Vec<u8>) {
        if !self.started {
            self.started = true;
            self.emit("response.created", json!({"response":self.response()}), out);
            self.emit(
                "response.in_progress",
                json!({"response":self.response()}),
                out,
            );
        }
    }
    fn append(&mut self, item: Value, out: &mut Vec<u8>) -> usize {
        self.start(out);
        let index = self.items.len();
        self.items.push(item.clone());
        self.emit(
            "response.output_item.added",
            json!({"output_index":index,"item":item}),
            out,
        );
        index
    }
    fn message(&mut self, out: &mut Vec<u8>) -> usize {
        let id = format!("msg_{}_{}", self.id, self.items.len());
        let part = json!({"type":"output_text","text":"","annotations":[],"logprobs":[]});
        let index=self.append(json!({"id":id,"type":"message","role":"assistant","status":"in_progress","content":[]}),out);
        self.items[index]["content"] = json!([part.clone()]);
        self.emit(
            "response.content_part.added",
            json!({"item_id":id,"output_index":index,"content_index":0,"part":part}),
            out,
        );
        index
    }
    fn add_text(&mut self, index: usize, delta: &str, out: &mut Vec<u8>) {
        if let Value::String(current) = &mut self.items[index]["content"][0]["text"] {
            current.push_str(delta);
        }
        self.emit("response.output_text.delta",json!({"item_id":self.items[index]["id"],"output_index":index,"content_index":0,"delta":delta,"logprobs":[]}),out);
    }
    fn reasoning(&mut self, out: &mut Vec<u8>) -> usize {
        if let Some(index) = self.reasoning_index {
            return index;
        }
        let id = format!("rs_{}_{}", self.id, self.items.len());
        let index = self.append(json!({"id":id,"type":"reasoning","summary":[]}), out);
        self.reasoning_index = Some(index);
        index
    }
    fn add_reasoning(&mut self, delta: &str, out: &mut Vec<u8>) {
        let i = self.reasoning(out);
        if self.items[i]["summary"].as_array().unwrap().is_empty() {
            let part = json!({"type":"summary_text","text":""});
            self.items[i]["summary"] = json!([part.clone()]);
            self.emit("response.reasoning_summary_part.added",json!({"item_id":self.items[i]["id"],"output_index":i,"summary_index":0,"part":part}),out);
        }
        self.reasoning_text.push_str(delta);
        self.items[i]["summary"][0]["text"] = json!(self.reasoning_text);
        self.emit(
            "response.reasoning_summary_text.delta",
            json!({"item_id":self.items[i]["id"],"output_index":i,"summary_index":0,"delta":delta}),
            out,
        );
    }
    fn tool(&mut self, key: u64, out: &mut Vec<u8>) -> Result<(), String> {
        let mut pending = self.pending.remove(&key).unwrap_or_default();
        if pending.id.is_empty() || pending.name.is_empty() {
            if self.protocol == Protocol::AnthropicMessages {
                return Err(unsupported("Anthropic tool without id/name"));
            }
            self.pending.insert(key, pending);
            return Ok(());
        }
        let Some(spec) = self.list.iter().find(|t| t.wire == pending.name).cloned() else {
            if self.protocol == Protocol::AnthropicMessages {
                return Err(unsupported("Anthropic undeclared tool"));
            }
            self.pending.insert(key, pending);
            return Ok(());
        };
        // Chat name/id fragments can arrive before argument fragments. Wait
        // until arguments start before announcing the final function identity.
        if self.protocol == Protocol::ChatCompletions
            && pending.output.is_none()
            && pending.arguments.is_empty()
        {
            self.pending.insert(key, pending);
            return Ok(());
        }
        if let Some(extra) = pending.extra.clone() {
            self.reasoning(out);
            self.extras.insert(pending.id.clone(), extra);
        }
        let index = if let Some(index) = pending.output {
            index
        } else {
            let mut item = if spec.custom {
                json!({"type":"custom_tool_call","call_id":pending.id,"name":spec.name,"input":""})
            } else {
                json!({"type":"function_call","call_id":pending.id,"name":spec.name,"arguments":""})
            };
            item["id"] = json!(format!("fc_{}_{}", self.id, self.items.len()));
            item["status"] = json!("in_progress");
            if let Some(ns) = spec.namespace {
                item["namespace"] = json!(ns);
            }
            let index = self.append(item, out);
            pending.output = Some(index);
            index
        };
        if !spec.custom && pending.emitted < pending.arguments.len() {
            let delta = &pending.arguments[pending.emitted..];
            self.items[index]["arguments"] = json!(pending.arguments);
            self.emit(
                "response.function_call_arguments.delta",
                json!({"item_id":self.items[index]["id"],"output_index":index,"delta":delta}),
                out,
            );
            pending.emitted = pending.arguments.len();
        }
        self.pending.insert(key, pending);
        Ok(())
    }
    fn chat_usage(&mut self, value: &Value) {
        if !value.is_object() {
            return;
        }
        let input = value
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let output = value
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.usage = json!({"input_tokens":input,"output_tokens":output,"total_tokens":input+output,"input_tokens_details":{"cached_tokens":value.pointer("/prompt_tokens_details/cached_tokens").and_then(Value::as_u64).unwrap_or(0)},"output_tokens_details":{"reasoning_tokens":value.pointer("/completion_tokens_details/reasoning_tokens").and_then(Value::as_u64).unwrap_or(0)}});
    }
    fn anthropic_usage(&mut self, value: &Value) {
        if !value.is_object() {
            return;
        }
        // Anthropic input_tokens excludes cache read/create tokens. Responses
        // input_tokens is the full count; cache writes remain non-cached input.
        if let Some(input) = value.get("input_tokens").and_then(Value::as_u64) {
            let read = value
                .get("cache_read_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let write = value
                .get("cache_creation_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            self.usage["input_tokens"] = json!(input + read + write);
            self.usage["input_tokens_details"]["cached_tokens"] = json!(read);
        }
        if let Some(output) = value.get("output_tokens").and_then(Value::as_u64) {
            self.usage["output_tokens"] = json!(output);
        }
        self.usage["total_tokens"] = json!(
            self.usage["input_tokens"].as_u64().unwrap_or(0)
                + self.usage["output_tokens"].as_u64().unwrap_or(0)
        );
    }
    fn handle_chat(&mut self, value: Value, out: &mut Vec<u8>) -> Result<(), String> {
        if let Some(error) = value.get("error") {
            self.fail(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("上游流式请求失败。"),
                out,
            );
            return Ok(());
        }
        if !self.started {
            if let Some(id) = value.get("id").and_then(Value::as_str) {
                self.id = format!("resp_{id}");
            }
            if let Some(created) = value.get("created").and_then(Value::as_u64) {
                self.created = created;
            }
        }
        if let Some(usage) = value.get("usage") {
            self.chat_usage(usage);
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| unsupported("Chat stream without choices/error"))?;
        if choices.len() > 1 {
            return Err(unsupported("multiple Chat choices"));
        }
        for c in choices {
            if c.get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
                return Err(unsupported("Chat choice index"));
            }
            if let Some(reason) = c.get("finish_reason").and_then(Value::as_str) {
                self.finish_reason = Some(reason.to_owned());
            }
            let delta = c
                .get("delta")
                .or_else(|| c.get("message"))
                .ok_or_else(|| unsupported("Chat choice delta"))?;
            if delta.get("function_call").is_some() {
                return Err(unsupported("legacy Chat function_call without call_id"));
            }
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .filter(|v| !v.is_null())
            {
                let value = reasoning
                    .as_str()
                    .ok_or_else(|| unsupported("non-text reasoning delta"))?;
                if !value.is_empty() {
                    self.add_reasoning(value, out);
                }
            }
            if let Some(refusal) = delta
                .get("refusal")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                let i = if let Some(i) = self.text_index {
                    i
                } else {
                    let i = self.message(out);
                    self.text_index = Some(i);
                    i
                };
                self.add_text(i, refusal, out);
            }
            if let Some(value) = delta.get("content").filter(|v| !v.is_null()) {
                let text = value
                    .as_str()
                    .ok_or_else(|| unsupported("non-text Chat output content"))?;
                if !text.is_empty() {
                    let i = if let Some(i) = self.text_index {
                        i
                    } else {
                        let i = self.message(out);
                        self.text_index = Some(i);
                        i
                    };
                    self.add_text(i, text, out);
                }
            }
            if let Some(calls) = delta.get("tool_calls").filter(|v| !v.is_null()) {
                for (fallback, call) in calls
                    .as_array()
                    .ok_or_else(|| unsupported("tool_calls delta"))?
                    .iter()
                    .enumerate()
                {
                    let key = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(fallback as u64);
                    let pending = self.pending.entry(key).or_default();
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        if pending.id != id {
                            if pending.output.is_some() {
                                return Err(unsupported("tool call ID changed after arguments"));
                            }
                            pending.id.push_str(id);
                        }
                    }
                    if let Some(kind) = call.get("type").and_then(Value::as_str) {
                        if kind != "function" {
                            return Err(unsupported("non-function Chat tool call"));
                        }
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        if pending.output.is_some() {
                            if name != pending.name && !name.is_empty() {
                                return Err(unsupported("tool name changed after arguments"));
                            }
                        } else {
                            pending.name.push_str(name);
                        }
                    }
                    if let Some(args) = call.pointer("/function/arguments").filter(|v| !v.is_null())
                    {
                        pending.arguments.push_str(
                            args.as_str()
                                .ok_or_else(|| unsupported("non-text Chat tool arguments"))?,
                        );
                    }
                    if let Some(extra) = call.get("extra_content") {
                        pending.extra = Some(extra.clone());
                    }
                    for field in ["thought_signature", "thoughtSignature"] {
                        if let Some(sig) = call.get(field) {
                            pending.extra = Some(json!({"google":{"thought_signature":sig}}));
                        }
                    }
                    self.tool(key, out)?;
                }
            }
        }
        Ok(())
    }
    fn handle_anthropic(
        &mut self,
        event: &str,
        value: Value,
        out: &mut Vec<u8>,
    ) -> Result<(), String> {
        if !self.started && !matches!(event, "message_start" | "ping" | "error") {
            return Err(unsupported("Anthropic event before message_start"));
        }
        match event {
            "ping" => {}
            "error" => {
                self.fail(
                    value
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Anthropic 流式请求失败。"),
                    out,
                );
            }
            "message_start" => {
                if self.started {
                    return Err(unsupported("duplicate message_start"));
                }
                let message = value
                    .get("message")
                    .ok_or_else(|| unsupported("message_start.message"))?;
                self.id = format!("resp_{}", text(message, "id")?);
                self.anthropic_usage(&message["usage"]);
                self.start(out);
            }
            "content_block_start" => {
                let key = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| unsupported("content block index"))?;
                if self.blocks.contains_key(&key) {
                    return Err(unsupported("duplicate content block index"));
                }
                let b = value
                    .get("content_block")
                    .ok_or_else(|| unsupported("content block"))?;
                match text(b, "type")? {
                    "text" => {
                        let i = self.message(out);
                        self.blocks.insert(key, ("text".into(), i));
                        if let Some(t) = b
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            self.add_text(i, t, out);
                        }
                    }
                    "tool_use" => {
                        let input = b.get("input").cloned().unwrap_or_else(|| json!({}));
                        if !input.is_object() {
                            return Err(unsupported("tool_use.input"));
                        }
                        self.pending.insert(
                            key,
                            PendingTool {
                                id: text(b, "id")?.into(),
                                name: text(b, "name")?.into(),
                                arguments: if input.as_object().unwrap().is_empty() {
                                    String::new()
                                } else {
                                    input.to_string()
                                },
                                ..Default::default()
                            },
                        );
                        self.tool(key, out)?;
                        self.blocks
                            .insert(key, ("tool_use".into(), self.pending[&key].output.unwrap()));
                    }
                    "thinking" => {
                        let i = self.reasoning(out);
                        self.blocks.insert(key, ("thinking".into(), i));
                        self.thinking.insert(key, b.clone());
                        if let Some(t) = b
                            .get("thinking")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            self.add_reasoning(t, out);
                        }
                    }
                    "redacted_thinking" => {
                        let i = self.reasoning(out);
                        self.blocks.insert(key, ("redacted_thinking".into(), i));
                        self.thinking.insert(key, b.clone());
                    }
                    kind => return Err(unsupported(&format!("Anthropic content block {kind}"))),
                }
            }
            "content_block_delta" => {
                let key = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| unsupported("content block index"))?;
                if self.closed.contains(&key) {
                    return Err(unsupported("delta after content_block_stop"));
                }
                let (kind, index) = self
                    .blocks
                    .get(&key)
                    .cloned()
                    .ok_or_else(|| unsupported("delta before content block"))?;
                let delta = value
                    .get("delta")
                    .ok_or_else(|| unsupported("content block delta"))?;
                match text(delta, "type")? {
                    "text_delta" if kind == "text" => {
                        self.add_text(index, text(delta, "text")?, out)
                    }
                    "input_json_delta" if kind == "tool_use" => {
                        self.pending
                            .get_mut(&key)
                            .unwrap()
                            .arguments
                            .push_str(text(delta, "partial_json")?);
                        self.tool(key, out)?;
                    }
                    "thinking_delta" if kind == "thinking" => {
                        let text = text(delta, "thinking")?;
                        let b = self.thinking.get_mut(&key).unwrap();
                        let mut value = b
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        value.push_str(text);
                        b["thinking"] = json!(value);
                        self.add_reasoning(text, out);
                    }
                    "signature_delta" if kind == "thinking" => {
                        let b = self.thinking.get_mut(&key).unwrap();
                        let mut sig = b
                            .get("signature")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        sig.push_str(text(delta, "signature")?);
                        b["signature"] = json!(sig);
                    }
                    kind => return Err(unsupported(&format!("Anthropic delta {kind}"))),
                }
            }
            "content_block_stop" => {
                let key = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| unsupported("content block index"))?;
                if !self.blocks.contains_key(&key) || !self.closed.insert(key) {
                    return Err(unsupported("missing or duplicate content block stop"));
                }
            }
            "message_delta" => {
                self.anthropic_usage(&value["usage"]);
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.finish_reason = Some(reason.into());
                }
            }
            "message_stop" => {
                if self.closed.len() != self.blocks.len() {
                    return Err(unsupported("message_stop before content_block_stop"));
                }
                if self.finish_reason.is_none() {
                    return Err(unsupported("message_stop without stop_reason"));
                }
                self.complete(out)?;
            }
            "" => return Err(unsupported("Anthropic event without type")),
            other => return Err(unsupported(&format!("Anthropic event {other}"))),
        }
        Ok(())
    }
    fn finalize_items(&mut self, out: &mut Vec<u8>) -> Result<(), String> {
        let mut call_ids = HashSet::new();
        if self
            .pending
            .values()
            .any(|p| !call_ids.insert(p.id.clone()))
        {
            return Err(unsupported("duplicate upstream tool call IDs"));
        }
        let keys = self.pending.keys().copied().collect::<Vec<_>>();
        for key in keys {
            if self.pending[&key].arguments.is_empty() {
                self.pending.get_mut(&key).unwrap().arguments = "{}".into();
            }
            self.tool(key, out)?;
            let pending = &self.pending[&key];
            let i = pending
                .output
                .ok_or_else(|| unsupported("tool call without id/name"))?;
            let args = if pending.arguments.is_empty() {
                "{}".to_owned()
            } else {
                pending.arguments.clone()
            };
            let parsed: Value = serde_json::from_str(&args)
                .map_err(|_| unsupported("incomplete tool arguments JSON"))?;
            if !parsed.is_object() {
                return Err(unsupported("non-object tool arguments JSON"));
            }
            if self.items[i]["type"] == "custom_tool_call" {
                let input = parsed
                    .get("input")
                    .and_then(Value::as_str)
                    .ok_or_else(|| unsupported("custom tool input wrapper"))?
                    .to_owned();
                if parsed.as_object().unwrap().len() != 1 {
                    return Err(unsupported("custom tool wrapper extra fields"));
                }
                self.items[i]["input"] = json!(input);
                self.emit(
                    "response.custom_tool_call_input.delta",
                    json!({"item_id":self.items[i]["id"],"output_index":i,"delta":input}),
                    out,
                );
            } else {
                self.items[i]["arguments"] = json!(args);
            }
        }
        if self.protocol == Protocol::AnthropicMessages {
            for b in self.thinking.values() {
                if b["type"] == "thinking"
                    && !b
                        .get("signature")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                {
                    return Err(unsupported("unsigned Anthropic thinking block"));
                }
            }
        }
        if let Some(i) = self.reasoning_index {
            let envelope = if self.protocol == Protocol::AnthropicMessages {
                json!({"protocol":self.protocol.as_str(),"model":self.model,"blocks":self.thinking.values().cloned().collect::<Vec<_>>()})
            } else {
                json!({"protocol":self.protocol.as_str(),"model":self.model,"reasoning_content":self.reasoning_text,"tool_extras":self.extras})
            };
            self.items[i]["encrypted_content"] = json!(encoded(envelope));
        }
        for i in 0..self.items.len() {
            self.items[i]["status"] = json!("completed");
            let item = self.items[i].clone();
            match item["type"].as_str().unwrap_or(""){
                "message"=>{let part=&item["content"][0];self.emit("response.output_text.done",json!({"item_id":item["id"],"output_index":i,"content_index":0,"text":part["text"],"logprobs":[]}),out);self.emit("response.content_part.done",json!({"item_id":item["id"],"output_index":i,"content_index":0,"part":part}),out);},
                "function_call"=>self.emit("response.function_call_arguments.done",json!({"item_id":item["id"],"output_index":i,"name":item["name"],"arguments":item["arguments"]}),out),
                "custom_tool_call"=>self.emit("response.custom_tool_call_input.done",json!({"item_id":item["id"],"output_index":i,"input":item["input"]}),out),
                "reasoning"=>{if let Some(part)=item["summary"].as_array().and_then(|a|a.first()){self.emit("response.reasoning_summary_text.done",json!({"item_id":item["id"],"output_index":i,"summary_index":0,"text":part["text"]}),out);self.emit("response.reasoning_summary_part.done",json!({"item_id":item["id"],"output_index":i,"summary_index":0,"part":part}),out);}},
                _=>{},
            }
            self.emit(
                "response.output_item.done",
                json!({"output_index":i,"item":item}),
                out,
            );
        }
        Ok(())
    }
    fn complete(&mut self, out: &mut Vec<u8>) -> Result<(), String> {
        if self.ended {
            return Ok(());
        }
        self.start(out);
        let reason = self.finish_reason.clone().unwrap_or_default();
        if matches!(reason.as_str(), "tool_calls" | "tool_use") && self.pending.is_empty() {
            return Err(unsupported("tool completion without tool calls"));
        }
        match reason.as_str() {
            "stop" | "tool_calls" | "end_turn" | "tool_use" | "stop_sequence" => {
                self.finalize_items(out)?;
                self.final_status = "completed".into();
            }
            "length" | "max_tokens" => {
                self.final_status = "incomplete".into();
                self.finish_reason = Some("max_output_tokens".into());
            }
            "content_filter" | "refusal" => {
                self.final_status = "incomplete".into();
                self.finish_reason = Some("content_filter".into());
            }
            "" => {
                self.final_status = "incomplete".into();
                self.finish_reason = Some("upstream_stream_interrupted".into());
            }
            other => {
                self.final_status = "incomplete".into();
                self.finish_reason = Some(format!("unsupported_stop_reason:{other}"));
            }
        }
        self.ended = true;
        let kind = if self.final_status == "completed" {
            "response.completed"
        } else {
            "response.incomplete"
        };
        self.emit(kind, json!({"response":self.response()}), out);
        Ok(())
    }
    fn fail(&mut self, message: &str, out: &mut Vec<u8>) {
        if self.ended {
            return;
        }
        self.start(out);
        self.final_status = "failed".into();
        self.failure = Some(message.chars().take(2000).collect());
        self.ended = true;
        self.emit(
            "error",
            json!({"code":"upstream_error","message":self.failure,"param":null}),
            out,
        );
        self.emit("response.failed", json!({"response":self.response()}), out);
    }
    /// Turn a transport/validation failure after headers were sent into a valid
    /// terminal Responses error. This does not retry or report completion.
    pub fn abort(&mut self, message: &str) -> Vec<u8> {
        let mut out = Vec::new();
        self.fail(message, &mut out);
        out
    }
    fn dispatch(&mut self, out: &mut Vec<u8>) -> Result<(), String> {
        let data = self.data.join("\n");
        let event = std::mem::take(&mut self.event);
        self.data.clear();
        self.event_size = 0;
        if data.is_empty() || event == "ping" {
            return Ok(());
        }
        if self.ended {
            return Err(unsupported("data after terminal stream event"));
        }
        if data.trim() == "[DONE]" {
            if self.protocol != Protocol::ChatCompletions {
                return Err(unsupported("Anthropic [DONE] without message_stop"));
            }
            return self.complete(out);
        }
        let value: Value =
            serde_json::from_str(&data).map_err(|_| "上游 SSE 数据不是有效 JSON。".to_string())?;
        match self.protocol {
            Protocol::ChatCompletions => self.handle_chat(value, out),
            Protocol::AnthropicMessages => {
                let name = if event.is_empty() {
                    value
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                } else {
                    event
                };
                self.handle_anthropic(&name, value, out)
            }
            Protocol::Responses => Ok(()),
        }
    }
    fn line(&mut self, bytes: Vec<u8>, out: &mut Vec<u8>) -> Result<(), String> {
        let line = std::str::from_utf8(&bytes)
            .map_err(|_| "上游 SSE 含无效 UTF-8。".to_string())?
            .trim_end_matches('\r');
        if line.is_empty() {
            return self.dispatch(out);
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        self.event_size += value.len();
        if self.event_size > MAX_EVENT {
            return Err("上游 SSE 事件超过 4 MiB 安全上限。".into());
        }
        match field {
            "event" => self.event = value.into(),
            "data" => self.data.push(value.into()),
            "id" | "retry" => {}
            _ => {}
        }
        Ok(())
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<u8>, String> {
        if self.protocol == Protocol::Responses {
            return Ok(bytes.to_vec());
        }
        self.received = self.received.saturating_add(bytes.len());
        if self.received > MAX_OUTPUT {
            return Err("上游流式响应超过 32 MiB 安全上限。".into());
        }
        let mut out = Vec::new();
        for byte in bytes {
            if *byte == b'\n' {
                let line = std::mem::take(&mut self.line);
                self.line(line, &mut out)?;
            } else {
                self.line.push(*byte);
                if self.line.len() > MAX_EVENT {
                    return Err("上游 SSE 单行超过安全上限。".into());
                }
            }
        }
        Ok(out)
    }
    pub fn finish(&mut self) -> Result<Vec<u8>, String> {
        if self.protocol == Protocol::Responses {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        if !self.line.is_empty() {
            let line = std::mem::take(&mut self.line);
            self.line(line, &mut out)?;
        }
        if !self.data.is_empty() {
            self.dispatch(&mut out)?;
        }
        if !self.ended {
            if self.protocol == Protocol::AnthropicMessages {
                self.finish_reason = None;
            }
            self.complete(&mut out)?;
        }
        Ok(out)
    }
}

fn convert_whole(
    protocol: Protocol,
    value: &Value,
    request: &Value,
) -> Result<(Value, Vec<u8>), String> {
    if let Some(error) = value.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("上游请求失败。")
            .into());
    }
    let mut adapter = StreamAdapter::new(protocol, request)?;
    let mut discard = Vec::new();
    match protocol {
        Protocol::ChatCompletions => {
            adapter.handle_chat(value.clone(), &mut discard)?;
            adapter.complete(&mut discard)?;
        }
        Protocol::AnthropicMessages => {
            adapter.handle_anthropic("message_start", json!({"message":value}), &mut discard)?;
            for (i, block) in value
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| unsupported("Anthropic message content"))?
                .iter()
                .enumerate()
            {
                adapter.handle_anthropic(
                    "content_block_start",
                    json!({"index":i,"content_block":block}),
                    &mut discard,
                )?;
                adapter.handle_anthropic("content_block_stop", json!({"index":i}), &mut discard)?;
            }
            adapter.handle_anthropic(
                "message_delta",
                json!({"delta":{"stop_reason":value["stop_reason"]},"usage":value["usage"]}),
                &mut discard,
            )?;
            adapter.handle_anthropic("message_stop", json!({}), &mut discard)?;
        }
        Protocol::Responses => {}
    }
    Ok((adapter.response(), discard))
}

pub(crate) fn convert_response(
    protocol: Protocol,
    value: &Value,
    request: &Value,
) -> Result<Value, String> {
    if protocol == Protocol::Responses {
        return Ok(value.clone());
    }
    convert_whole(protocol, value, request).map(|(value, _)| value)
}
/// Some providers ignore stream:true and return JSON. Produce the same complete
/// Responses event lifecycle instead of forwarding JSON under an SSE header.
pub(crate) fn convert_response_sse(
    protocol: Protocol,
    value: &Value,
    request: &Value,
) -> Result<Vec<u8>, String> {
    if protocol == Protocol::Responses {
        return Err(unsupported("Responses JSON-to-SSE synthesis"));
    }
    convert_whole(protocol, value, request).map(|(_, bytes)| bytes)
}

#[cfg(test)]
#[path = "aggregate_protocol_tests.rs"]
mod tests;
