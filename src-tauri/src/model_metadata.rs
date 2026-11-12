//! Versioned model declarations, separate from routing and account entitlements.
//! Data source and license: third_party/codex-plus-plus/model-metadata/NOTICE.md.
//! Only capability fields are projected; upstream prompts and protocol defaults
//! never replace this application's instructions or transport configuration.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub(crate) const UPSTREAM_REVISION: &str = "38033bf98325a32bbb80842441e2e0e2b3c9d7bd";

struct EmbeddedSource {
    name: &'static str,
    file: &'static str,
    json: &'static str,
}

const SOURCES: &[EmbeddedSource] = &[
    EmbeddedSource {
        name: "GPT-6 Astra",
        file: "astra-model-metadata-compat.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/astra-model-metadata-compat.json"
        ),
    },
    EmbeddedSource {
        name: "DeepSeek",
        file: "deepseek-model-metadata.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/deepseek-model-metadata.json"
        ),
    },
    EmbeddedSource {
        name: "Doubao",
        file: "doubao-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/doubao-model-metadata.json"),
    },
    EmbeddedSource {
        name: "Gemini",
        file: "gemini-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/gemini-model-metadata.json"),
    },
    EmbeddedSource {
        name: "GLM",
        file: "glm-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/glm-model-metadata.json"),
    },
    EmbeddedSource {
        name: "GPT-5.6",
        file: "gpt56-model-metadata-compat.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/gpt56-model-metadata-compat.json"
        ),
    },
    EmbeddedSource {
        name: "GPT-6 Sol/Luna",
        file: "gpt6-sol-luna-model-metadata-compat.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/gpt6-sol-luna-model-metadata-compat.json"
        ),
    },
    EmbeddedSource {
        name: "GPT-6.1 Sol",
        file: "gpt61-sol-model-metadata-compat.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/gpt61-sol-model-metadata-compat.json"
        ),
    },
    EmbeddedSource {
        name: "gpt-oss",
        file: "gptoss-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/gptoss-model-metadata.json"),
    },
    EmbeddedSource {
        name: "Grok",
        file: "grok-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/grok-model-metadata.json"),
    },
    EmbeddedSource {
        name: "Kimi",
        file: "kimi-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/kimi-model-metadata.json"),
    },
    EmbeddedSource {
        name: "MiMo",
        file: "mimo-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/mimo-model-metadata.json"),
    },
    EmbeddedSource {
        name: "MiniMax",
        file: "minimax-model-metadata.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/minimax-model-metadata.json"
        ),
    },
    EmbeddedSource {
        name: "Mistral",
        file: "mistral-model-metadata.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/mistral-model-metadata.json"
        ),
    },
    EmbeddedSource {
        name: "Muse",
        file: "muse-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/muse-model-metadata.json"),
    },
    EmbeddedSource {
        name: "NVIDIA",
        file: "nvidia-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/nvidia-model-metadata.json"),
    },
    EmbeddedSource {
        name: "Qwen",
        file: "qwen-model-metadata.json",
        json: include_str!("third_party/codex-plus-plus/model-metadata/qwen-model-metadata.json"),
    },
    EmbeddedSource {
        name: "StepFun",
        file: "stepfun-model-metadata.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/stepfun-model-metadata.json"
        ),
    },
    EmbeddedSource {
        name: "Thinking Machines",
        file: "thinkingmachines-model-metadata.json",
        json: include_str!(
            "third_party/codex-plus-plus/model-metadata/thinkingmachines-model-metadata.json"
        ),
    },
];

struct MetadataEntry {
    source: &'static str,
    value: Value,
}

fn index() -> &'static BTreeMap<String, MetadataEntry> {
    static INDEX: OnceLock<BTreeMap<String, MetadataEntry>> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut entries = BTreeMap::new();
        for source in SOURCES {
            // Assets are checked by tests before shipping. A corrupt optional
            // fallback must not crash startup or manufacture capabilities.
            let Ok(catalog) = serde_json::from_str::<Value>(source.json) else {
                continue;
            };
            let Some(models) = catalog.get("models").and_then(Value::as_array) else {
                continue;
            };
            for model in models {
                let Some(slug) = model
                    .get("slug")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                if model
                    .get("context_window")
                    .and_then(Value::as_u64)
                    .is_none_or(|v| v == 0)
                {
                    continue;
                }
                let mut value = Map::new();
                apply_layer(&mut value, model);
                value.insert("slug".into(), Value::String(slug.to_string()));
                entries
                    .entry(slug.to_ascii_lowercase())
                    .or_insert(MetadataEntry {
                        source: source.name,
                        value: Value::Object(value),
                    });
            }
        }
        entries
    })
}

fn lookup(model: &str) -> Option<&'static MetadataEntry> {
    let exact = model.trim().to_ascii_lowercase();
    let index = index();
    if let Some(entry) = index.get(&exact) {
        return Some(entry);
    }
    let canonical = super::canonical_model_name(model);
    if let Some(entry) = index.get(&canonical) {
        return Some(entry);
    }
    // Only the existing documented dated-snapshot aliases are recognized.
    // No vendor path stripping, prefix family guessing, or fuzzy matching.
    index
        .iter()
        .find(|(slug, _)| super::release(&canonical, slug))
        .map(|(_, entry)| entry)
}

pub(crate) fn builtin_model_metadata(model: &str) -> Option<Value> {
    let mut value = lookup(model)?.value.clone();
    value["slug"] = Value::String(model.trim().to_string());
    Some(value)
}

#[cfg(test)]
fn builtin_model_metadata_source(model: &str) -> Option<&'static str> {
    lookup(model).map(|entry| entry.source)
}

/// Merge valid capabilities only: explicit user settings > matching native
/// metadata > static declarations. A native empty/false/null capability is an
/// intentional override and is never filled back in from a lower source.
/// Callers resolve their native cache key before passing the matching entry.
pub(crate) fn resolved_model_metadata(
    model: &str,
    native: Option<&Value>,
    explicit: Option<&Value>,
) -> Option<Value> {
    let mut result = builtin_model_metadata(model)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(native) = native {
        apply_layer(&mut result, native);
    }
    if let Some(explicit) = explicit {
        apply_layer(&mut result, explicit);
    }
    if result.is_empty() {
        return None;
    }
    result.insert("slug".into(), Value::String(model.trim().to_string()));
    Some(Value::Object(result))
}

fn provider_id(source: &str) -> &'static str {
    match source {
        "GPT-6 Astra" | "GPT-5.6" | "GPT-6 Sol/Luna" | "GPT-6.1 Sol" | "gpt-oss" => "openai",
        "DeepSeek" => "deepseek",
        "Doubao" => "doubao",
        "Gemini" => "gemini",
        "GLM" => "glm",
        "Grok" => "grok",
        "Kimi" => "kimi",
        "MiMo" => "mimo",
        "MiniMax" => "minimax",
        "Mistral" => "mistral",
        "Muse" => "muse",
        "NVIDIA" => "nvidia",
        "Qwen" => "qwen",
        "StepFun" => "stepfun",
        "Thinking Machines" => "thinking-machines",
        _ => "unknown",
    }
}

/// Public metadata choices, not a list of models available to the account.
/// Provider presets are separate because one endpoint can serve many families.
pub(crate) fn builtin_model_metadata_catalog() -> Vec<Value> {
    index()
        .values()
        .map(|entry| {
            serde_json::json!({
                "slug": entry.value["slug"], "provider": provider_id(entry.source),
                "contextWindow": entry.value["context_window"],
                "maxContextWindow": entry.value["max_context_window"],
                "source": entry.source, "sourceRevision": UPSTREAM_REVISION,
                "metadata": entry.value,
            })
        })
        .collect()
}

/// Exact upstream preset fields, including empty model lists. Consumers may
/// filter categories but must not imply these defaults were fetched with a Key.
pub(crate) fn provider_presets() -> Value {
    static PRESETS: OnceLock<Value> = OnceLock::new();
    PRESETS
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "third_party/codex-plus-plus/model-metadata/provider-presets.json"
            ))
            .unwrap_or_else(|_| Value::Array(Vec::new()))
        })
        .clone()
}

fn valid_field(key: &str, value: &Value) -> bool {
    match key {
        "context_window" | "max_output_tokens" => value.as_u64().is_some_and(|v| v > 0),
        "max_context_window" | "auto_compact_token_limit" => {
            value.is_null() || value.as_u64().is_some_and(|v| v > 0)
        }
        "effective_context_window_percent" => {
            value.as_u64().is_some_and(|v| (1..=100).contains(&v))
        }
        "supports_image_detail_original"
        | "supports_parallel_tool_calls"
        | "supports_reasoning_summaries"
        | "support_verbosity"
        | "supports_search_tool" => value.is_boolean(),
        "default_reasoning_level"
        | "default_reasoning_summary"
        | "reasoning_summary_format"
        | "default_verbosity" => value.as_str().is_some_and(|s| !s.trim().is_empty()),
        "input_modalities" => value.as_array().is_some_and(|values| {
            !values.is_empty()
                && values
                    .iter()
                    .all(|v| matches!(v.as_str(), Some("text" | "image")))
        }),
        "supported_reasoning_levels" => value.as_array().is_some_and(|values| {
            values.iter().all(|v| {
                v.get("effort")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
                    && v.get("description").is_none_or(Value::is_string)
            })
        }),
        "additional_speed_tiers" => value.as_array().is_some_and(|values| {
            values
                .iter()
                .all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
        }),
        "service_tiers" => value.as_array().is_some_and(|values| {
            values.iter().all(|v| {
                v.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
                    && ["name", "description"]
                        .iter()
                        .all(|key| v.get(*key).is_none_or(Value::is_string))
            })
        }),
        _ => false,
    }
}

fn apply_layer(target: &mut Map<String, Value>, layer: &Value) {
    let Some(layer) = layer.as_object() else {
        return;
    };
    // The two speed representations are one capability. A native disabled
    // tier in either representation must suppress a static Fast declaration.
    if ["service_tiers", "additional_speed_tiers"]
        .iter()
        .any(|key| layer.get(*key).is_some_and(|v| valid_field(key, v)))
    {
        target.remove("service_tiers");
        target.remove("additional_speed_tiers");
    }
    if let Some(window) = layer
        .get("context_window")
        .filter(|v| valid_field("context_window", v))
    {
        if target.get("context_window") != Some(window) {
            // A new window invalidates the previous source's derived ceiling
            // and compaction count; higher-layer explicit values are restored below.
            target.remove("max_context_window");
            target.remove("auto_compact_token_limit");
        }
    }
    if let Some(modalities) = layer
        .get("input_modalities")
        .filter(|v| valid_field("input_modalities", v))
    {
        if !modalities
            .as_array()
            .is_some_and(|items| items.iter().any(|v| v.as_str() == Some("image")))
        {
            target.remove("supports_image_detail_original");
        }
    }
    for (key, value) in layer {
        if valid_field(key, value) {
            target.insert(key.clone(), value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeSet;

    #[test]
    fn model_inventory_is_complete_and_separate_from_provider_presets() {
        let inventory = builtin_model_metadata_catalog();
        assert_eq!(inventory.len(), 69);
        assert!(inventory
            .iter()
            .all(|entry| entry["sourceRevision"] == UPSTREAM_REVISION
                && entry["provider"] != "unknown"));
        let deepseek = inventory
            .iter()
            .find(|entry| entry["slug"] == "deepseek-v4-pro")
            .unwrap();
        assert_eq!(deepseek["provider"], "deepseek");
        assert_eq!(deepseek["contextWindow"], 1_048_576);
        assert!(!inventory
            .iter()
            .any(|entry| entry["slug"].as_str().unwrap().starts_with("claude-")));
        let presets = provider_presets();
        let list = presets.as_array().unwrap();
        assert_eq!(list.len(), 29);
        let anthropic = list
            .iter()
            .find(|entry| entry["id"] == "anthropic")
            .unwrap();
        assert_eq!(anthropic["protocol"], "anthropicMessages");
        assert_eq!(
            anthropic["modelList"],
            json!(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
        );
        let xai = list.iter().find(|entry| entry["id"] == "xai").unwrap();
        assert_eq!(xai["modelList"], json!([]));
        assert_eq!(xai["model"], "");
        let mut ids = BTreeSet::new();
        for preset in list {
            assert!(ids.insert(preset["id"].as_str().unwrap()));
            assert!(matches!(
                preset["protocol"].as_str(),
                Some("responses" | "chatCompletions" | "anthropicMessages")
            ));
            assert!(preset["baseUrl"].as_str().unwrap().starts_with("http"));
            assert_eq!(preset["sourceRevision"], UPSTREAM_REVISION);
        }
        let manifest: Value = serde_json::from_str(include_str!(
            "third_party/codex-plus-plus/model-metadata/provider-presets-source.json"
        ))
        .unwrap();
        let data = include_str!("third_party/codex-plus-plus/model-metadata/provider-presets.json");
        assert_eq!(
            manifest["sha256"],
            format!("{:x}", Sha256::digest(data.as_bytes()))
        );
    }

    #[test]
    fn pinned_assets_are_complete_unique_and_unchanged() {
        let manifest: Value = serde_json::from_str(include_str!(
            "third_party/codex-plus-plus/model-metadata/source-manifest.json"
        ))
        .unwrap();
        assert_eq!(manifest["revision"], UPSTREAM_REVISION);
        assert_eq!(manifest["license"], "AGPL-3.0");
        assert_eq!(manifest["files"].as_array().unwrap().len(), SOURCES.len());
        let mut slugs = BTreeSet::new();
        for source in SOURCES {
            let record = manifest["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|record| record["file"] == source.file)
                .unwrap();
            assert_eq!(
                record["sha256"],
                format!("{:x}", Sha256::digest(source.json.as_bytes())),
                "{}",
                source.file
            );
            let catalog: Value = serde_json::from_str(source.json).unwrap();
            let models = catalog["models"].as_array().unwrap();
            assert_eq!(record["modelCount"].as_u64(), Some(models.len() as u64));
            for model in models {
                let slug = model["slug"].as_str().unwrap();
                assert!(slugs.insert(slug.to_ascii_lowercase()), "duplicate {slug}");
                assert!(
                    model["context_window"].as_u64().is_some_and(|v| v > 0),
                    "{slug}"
                );
                assert!(
                    valid_field("input_modalities", &model["input_modalities"]),
                    "{slug}"
                );
                assert!(
                    valid_field(
                        "supported_reasoning_levels",
                        &model["supported_reasoning_levels"]
                    ),
                    "{slug}"
                );
                assert!(
                    model["supported_reasoning_levels"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|level| level["effort"] == model["default_reasoning_level"]),
                    "{slug}"
                );
                assert!(builtin_model_metadata(slug).is_some(), "{slug}");
            }
        }
        assert_eq!(slugs.len(), 69);
        assert_eq!(index().len(), slugs.len());
        let license = include_str!("third_party/codex-plus-plus/model-metadata/LICENSE");
        assert_eq!(
            manifest["licenseSha256"],
            format!("{:x}", Sha256::digest(license.as_bytes()))
        );
        assert!(license.contains("GNU AFFERO GENERAL PUBLIC LICENSE"));
    }

    #[test]
    fn all_model_families_have_their_own_window_declarations() {
        for (model, window, source) in [
            ("gpt-6.1-sol", 272_000, "GPT-6.1 Sol"),
            ("deepseek-v4.1-flash", 1_048_576, "DeepSeek"),
            ("doubao-seed-2.0-mini", 262_144, "Doubao"),
            ("gemini-3.1-pro", 1_000_000, "Gemini"),
            ("glm-5.3", 1_048_576, "GLM"),
            ("grok-4.7", 500_000, "Grok"),
            ("k3-256k", 262_144, "Kimi"),
            ("mimo-v2.6-pro", 1_048_576, "MiMo"),
            ("MiniMax-M2.7", 204_800, "MiniMax"),
            ("mistral-medium-3.5", 262_144, "Mistral"),
            ("muse-glimmer", 131_072, "Muse"),
            ("nemotron-3-ultra", 1_000_000, "NVIDIA"),
            ("qwen3-coder-next", 262_144, "Qwen"),
            ("step-3.7-flash", 262_144, "StepFun"),
            ("inkling", 1_000_000, "Thinking Machines"),
            ("gpt-oss-120b", 131_072, "gpt-oss"),
        ] {
            let metadata = builtin_model_metadata(model).unwrap();
            assert_eq!(metadata["context_window"], window, "{model}");
            assert_eq!(
                builtin_model_metadata_source(model),
                Some(source),
                "{model}"
            );
        }
    }

    #[test]
    fn aliases_never_expand_to_unknown_variants_or_provider_routes() {
        assert_eq!(
            builtin_model_metadata(" GPT_6 ").unwrap()["context_window"],
            272_000
        );
        assert_eq!(
            builtin_model_metadata("MINIMAX-M3").unwrap()["context_window"],
            1_048_576
        );
        assert!(builtin_model_metadata("gpt-6-astra-2026-09-01").is_some());
        for model in [
            "claude-opus-5-5",
            "vendor-model",
            "gpt-6-sol-future",
            "qwen3.8-max-custom",
            "vendor/gpt-6-sol",
            "gaoge/openai/3/gpt-6-sol",
            "gemini-3.1-pro-2026-xx-01",
            "gpt-image-2.6-flare",
        ] {
            assert!(builtin_model_metadata(model).is_none(), "{model}");
            assert!(
                resolved_model_metadata(model, None, None).is_none(),
                "{model}"
            );
        }
    }

    #[test]
    fn static_fast_is_never_borrowed_from_a_different_model() {
        let mut fast = Vec::new();
        for (slug, metadata) in index() {
            if metadata.value["service_tiers"]
                .as_array()
                .is_some_and(|tiers| tiers.iter().any(|tier| tier["id"] == "priority"))
            {
                fast.push(slug.as_str());
            }
        }
        assert_eq!(
            fast,
            [
                "gpt-5.6-luna",
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-6-astra",
                "gpt-6-luna",
                "gpt-6-sol",
                "gpt-6.1-sol"
            ]
        );
        for model in [
            "deepseek-v4-flash",
            "gemini-3.8-flash",
            "grok-4.7",
            "kimi-k2.7-code-highspeed",
            "MiniMax-M2.7-highspeed",
        ] {
            let metadata = builtin_model_metadata(model).unwrap();
            assert!(
                metadata["service_tiers"]
                    .as_array()
                    .is_none_or(Vec::is_empty),
                "{model}"
            );
        }
    }

    #[test]
    fn explicit_user_then_native_then_static_precedence_preserves_restrictions() {
        let native = json!({"context_window": 64000, "max_context_window": null,
            "auto_compact_token_limit": 50000, "input_modalities": ["text"],
            "supports_image_detail_original": false, "supports_parallel_tool_calls": false,
            "service_tiers": [], "supported_reasoning_levels": [{"effort": "low"}], "default_reasoning_level": "low"});
        let user = json!({"context_window": 96000, "auto_compact_token_limit": 80000});
        let resolved = resolved_model_metadata("gpt-6-sol", Some(&native), Some(&user)).unwrap();
        assert_eq!(resolved["context_window"], 96000);
        assert_eq!(resolved["auto_compact_token_limit"], 80000);
        assert!(resolved.get("max_context_window").is_none());
        assert_eq!(resolved["input_modalities"], json!(["text"]));
        assert_eq!(resolved["supports_image_detail_original"], false);
        assert_eq!(resolved["service_tiers"], json!([]));
        assert!(resolved.get("additional_speed_tiers").is_none());
        assert_eq!(
            resolved["supported_reasoning_levels"],
            json!([{"effort":"low"}])
        );
    }

    #[test]
    fn changing_the_window_cannot_reuse_an_old_compaction_count_or_ceiling() {
        let native = json!({"context_window": 100_000, "max_context_window": 100_000, "auto_compact_token_limit": 90_000});
        let user = json!({"context_window": 20_000});
        let resolved = resolved_model_metadata("vendor-model", Some(&native), Some(&user)).unwrap();
        assert_eq!(resolved["context_window"], 20_000);
        assert!(resolved.get("max_context_window").is_none());
        assert!(resolved.get("auto_compact_token_limit").is_none());
    }

    #[test]
    fn native_and_user_explicit_empty_speed_lists_disable_static_fast() {
        for key in ["service_tiers", "additional_speed_tiers"] {
            let disabled = json!({key: []});
            let resolved = resolved_model_metadata("gpt-6.1-sol", Some(&disabled), None).unwrap();
            assert_eq!(resolved[key], json!([]));
            let other = if key == "service_tiers" {
                "additional_speed_tiers"
            } else {
                "service_tiers"
            };
            assert!(resolved.get(other).is_none());
            let resolved = resolved_model_metadata("gpt-6.1-sol", None, Some(&disabled)).unwrap();
            assert!(resolved.get(other).is_none());
        }
    }

    #[test]
    fn unknown_models_accept_real_metadata_without_fabricating_missing_fields() {
        let native = json!({"context_window": 123456, "input_modalities": ["text"], "auto_compact_token_limit": null});
        let resolved = resolved_model_metadata("new-model", Some(&native), None).unwrap();
        assert_eq!(resolved["context_window"], 123456);
        assert!(resolved["auto_compact_token_limit"].is_null());
        assert!(resolved.get("service_tiers").is_none());
        assert!(resolved.get("supported_reasoning_levels").is_none());
        assert_eq!(
            super::super::ContextProfile::from_entry(&resolved)
                .unwrap()
                .context_window,
            123456
        );
    }

    #[test]
    fn malformed_metadata_and_prompts_do_not_override_capabilities() {
        let invalid = json!({"context_window": -1, "max_context_window": 0,
            "effective_context_window_percent": 999, "service_tiers": ["priority"],
            "input_modalities": "image", "base_instructions": "foreign prompt", "model_messages": {"instructions_template":"foreign"},
            "use_responses_lite": true, "tool_mode": "foreign", "model_provider": "foreign", "api_key": "fixture"});
        let resolved =
            resolved_model_metadata("gemini-3.1-pro", Some(&invalid), Some(&invalid)).unwrap();
        assert_eq!(resolved["context_window"], 1_000_000);
        for field in [
            "base_instructions",
            "model_messages",
            "use_responses_lite",
            "tool_mode",
            "model_provider",
            "api_key",
            "service_tiers",
        ] {
            assert!(resolved.get(field).is_none(), "{field}");
        }
        assert!(resolved_model_metadata("unknown", Some(&invalid), None).is_none());
        for model in ["deepseek-v4-pro", "deepseek-v4-flash-vision"] {
            let metadata = builtin_model_metadata(model).unwrap();
            assert!(metadata.get("model_messages").is_none());
            assert!(metadata.get("base_instructions").is_none());
        }
    }
}
