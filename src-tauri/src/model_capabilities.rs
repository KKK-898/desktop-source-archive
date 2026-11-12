//! Exact model declarations. User settings and native Codex metadata take precedence.
//! Static CodexPlusPlus metadata is pinned and attributed in third_party/.
//! The existing local Claude/OpenAI fallbacks below retain their separate sources.
//! Sources and the distinction between API limits and Codex defaults are in
//! docs/codex-aggregate-compatibility.md. Explicit text-only metadata always
//! wins; otherwise new conversation models default to image input so future
//! model additions do not silently lose the attachment and vision controls.

use serde_json::Value;

#[path = "model_metadata.rs"]
mod model_metadata;
pub(crate) use model_metadata::{
    builtin_model_metadata, builtin_model_metadata_catalog, provider_presets,
    resolved_model_metadata,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ContextProfile {
    pub context_window: u64,
    pub max_context_window: u64,
    pub effective_context_window_percent: u64,
    pub auto_compact_token_limit: Option<u64>,
}

impl ContextProfile {
    pub fn new(context_window: u64) -> Self {
        Self {
            context_window,
            max_context_window: context_window,
            effective_context_window_percent: 95,
            auto_compact_token_limit: None,
        }
    }

    pub fn from_entry(entry: &Value) -> Option<Self> {
        let context_window = entry.get("context_window")?.as_u64().filter(|v| *v > 0)?;
        Some(Self {
            context_window,
            max_context_window: entry
                .get("max_context_window")
                .and_then(Value::as_u64)
                .filter(|v| *v >= context_window)
                .unwrap_or(context_window),
            effective_context_window_percent: entry
                .get("effective_context_window_percent")
                .and_then(Value::as_u64)
                .filter(|v| (1..=100).contains(v))
                .unwrap_or(95),
            auto_compact_token_limit: entry
                .get("auto_compact_token_limit")
                .and_then(Value::as_u64)
                .filter(|v| *v > 0),
        })
    }

    pub fn label(self) -> String {
        context_label(self.context_window)
    }

    pub fn max_label(self) -> String {
        context_label(self.max_context_window)
    }
}

fn context_label(window: u64) -> String {
    match window {
        1_000_000 | 1_048_576 => "1M".to_string(),
        262_144 => "256K".to_string(),
        value if value >= 1_000 => format!("{}K", value / 1_000),
        0 => "未配置".to_string(),
        value => value.to_string(),
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ModelCapabilities {
    pub context: ContextProfile,
    // Unknown conversation models use Some(true) as a forward-compatible
    // default. None is reserved for a deliberately unresolved model whose
    // image capability must remain disabled until it is verified.
    pub image_input: Option<bool>,
    pub image_detail_original: bool,
    pub verified: bool,
}

impl ModelCapabilities {
    /// Only verified metadata is suitable for a visible/configured window.
    /// The internal unknown fallback stays compatible with existing callers.
    pub fn context_profile(self) -> Option<ContextProfile> {
        self.verified.then_some(self.context)
    }

    fn from_metadata(entry: &Value) -> Option<Self> {
        let context = ContextProfile::from_entry(entry)?;
        let image_input = entry
            .get("input_modalities")
            .and_then(Value::as_array)
            .map(|modalities| {
                modalities
                    .iter()
                    .any(|value| value.as_str() == Some("image"))
            })
            .or(Some(true));
        Some(Self {
            context,
            image_input,
            image_detail_original: entry
                .get("supports_image_detail_original")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            verified: true,
        })
    }

    fn known(window: u64, image_input: bool, original: bool) -> Self {
        Self {
            context: ContextProfile::new(window),
            image_input: Some(image_input),
            image_detail_original: original,
            verified: true,
        }
    }

    fn codex_openai(max_window: u64, original: bool) -> Self {
        let mut profile = Self::known(272_000, true, original);
        profile.context.max_context_window = max_window;
        profile
    }

    pub fn unknown() -> Self {
        Self {
            context: ContextProfile::new(262_144),
            image_input: Some(true),
            image_detail_original: false,
            verified: false,
        }
    }
}

/// Normalize only documented/supported aliases. The actual upstream request ID
/// remains unchanged, including relay-specific aliases such as `k3`.
pub(crate) fn canonical_model_name(model: &str) -> String {
    let normalized = model.trim().to_ascii_lowercase().replace('_', "-");
    match normalized.as_str() {
        "k3" => "kimi-k3".to_string(),
        "gpt-5.6" => "gpt-5.6-sol".to_string(),
        "gpt-6" => "gpt-6-sol".to_string(),
        "grok-4.5-latest" | "grok-build-latest" => "grok-4.5".to_string(),
        _ => normalized,
    }
}

fn release(model: &str, name: &str) -> bool {
    model == name
        || model.strip_prefix(name).is_some_and(|suffix| {
            // Dated snapshots are the same release; unrelated variants are not.
            let suffix = suffix.strip_prefix('-').unwrap_or("");
            (suffix.len() == 8 && suffix.bytes().all(|c| c.is_ascii_digit()))
                || (suffix.len() == 10
                    && suffix.bytes().enumerate().all(|(i, c)| {
                        if i == 4 || i == 7 {
                            c == b'-'
                        } else {
                            c.is_ascii_digit()
                        }
                    }))
        })
}

const CODEX_IMAGE_GENERATION_MODELS: &[&str] = &[
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.6-flare",
    "gpt-image-2.6-sunburst",
    "image-2.5-flare",
    "image-2.5-sunburst",
    "image-2.6-flare",
    "image-2.6-sunburst",
];

pub(crate) fn is_codex_conversation_model(model: &str) -> bool {
    let trimmed = model.trim();
    let upstream = trimmed
        .strip_prefix("gaoge/")
        .and_then(|route| route.splitn(3, '/').nth(2))
        .unwrap_or(trimmed);
    let canonical = canonical_model_name(upstream);
    !CODEX_IMAGE_GENERATION_MODELS
        .iter()
        .any(|name| release(&canonical, name))
}

pub(crate) fn fallback_capabilities(model: &str) -> ModelCapabilities {
    if let Some(capabilities) = builtin_model_metadata(model)
        .as_ref()
        .and_then(ModelCapabilities::from_metadata)
    {
        return capabilities;
    }
    let model = canonical_model_name(model);
    let m = model.as_str();
    if [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ]
    .iter()
    .any(|name| release(m, name))
    {
        // Codex 26.901 model metadata: API 1.05M is not its default work window.
        return ModelCapabilities::codex_openai(872_000, true);
    }
    if ["gpt-5.4", "gpt-5.5"].iter().any(|name| release(m, name)) {
        // Preserve the standard Codex window when native long-context metadata
        // is unavailable; do not manufacture an account's long-context grant.
        return ModelCapabilities::codex_openai(272_000, true);
    }
    if ["gpt-5.2", "gpt-5.3-codex", "gpt-5.4-mini"]
        .iter()
        .any(|name| release(m, name))
    {
        return ModelCapabilities::codex_openai(272_000, false);
    }
    if m == "gpt-5.3-codex-spark" {
        return ModelCapabilities::known(128_000, false, false);
    }
    if [
        "claude-fable-5",
        "claude-fable-5.1",
        "claude-mythos-5",
        "claude-mythos-5.1",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
    ]
    .iter()
    .any(|name| release(m, name))
    {
        return ModelCapabilities::known(1_000_000, true, false);
    }
    if [
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
        "claude-opus-4-5",
        "claude-opus-4-1",
        "claude-opus-4",
        "claude-sonnet-4",
    ]
    .iter()
    .any(|name| release(m, name))
    {
        return ModelCapabilities::known(200_000, true, false);
    }
    if release(m, "grok-4.5") {
        return ModelCapabilities::known(500_000, true, false);
    }
    if m == "composer-2.5" {
        return ModelCapabilities::known(200_000, false, false);
    }
    if release(m, "kimi-k3") {
        return ModelCapabilities::known(1_048_576, true, false);
    }
    if ["kimi-k2.5", "kimi-k2.6"]
        .iter()
        .any(|name| release(m, name))
    {
        return ModelCapabilities::known(262_144, true, false);
    }
    if matches!(m, "kimi-k2.7-code" | "kimi-k2.7-code-highspeed") {
        let mut profile = ModelCapabilities::known(262_144, false, false);
        profile.image_input = None; // No official vision specification found.
        return profile;
    }
    if release(m, "deepseek-v4-flash-vision-exp") {
        return ModelCapabilities::known(1_048_576, true, true);
    }
    if ["deepseek-v4-flash", "deepseek-v4-pro"]
        .iter()
        .any(|name| release(m, name))
    {
        return ModelCapabilities::known(1_048_576, false, false);
    }
    if release(m, "deepseek-v3.2") {
        return ModelCapabilities::known(128_000, false, false);
    }
    if release(m, "glm-5.2") {
        return ModelCapabilities::known(1_000_000, false, false);
    }
    if [
        "glm-5.1",
        "glm-5",
        "glm-5-turbo",
        "glm-4.7",
        "glm-4.7-flashx",
        "glm-4.6",
    ]
    .iter()
    .any(|name| release(m, name))
    {
        return ModelCapabilities::known(200_000, false, false);
    }
    // gpt-reserve/codex-auto-review have no published independent API spec.
    // Image-only releases are deliberately excluded from Codex conversations.
    ModelCapabilities::unknown()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_metadata_is_used_without_inventing_unknown_windows() {
        let gpt = fallback_capabilities("gpt-6.1-sol");
        assert!(gpt.verified);
        assert_eq!(gpt.context_profile().unwrap().context_window, 272_000);
        assert_eq!(gpt.context.max_context_window, 872_000);
        assert_eq!(gpt.context.effective_context_window_percent, 100);
        let deepseek = fallback_capabilities("deepseek-v4-pro");
        assert_eq!(
            deepseek.context_profile().unwrap().context_window,
            1_048_576
        );
        assert_eq!(deepseek.image_input, Some(false));
        assert!(fallback_capabilities("custom-unknown")
            .context_profile()
            .is_none());
        assert!(builtin_model_metadata("claude-opus-4-6").is_none());
        assert_eq!(
            fallback_capabilities("claude-opus-4-6")
                .context_profile()
                .unwrap()
                .context_window,
            1_000_000
        );
    }

    #[test]
    fn image_input_does_not_imply_original_detail_support() {
        for declared in [None, Some(false), Some(true)] {
            let mut metadata = serde_json::json!({
                "context_window": 128_000,
                "input_modalities": ["text", "image"]
            });
            if let Some(value) = declared {
                metadata["supports_image_detail_original"] = Value::Bool(value);
            }
            let capability = ModelCapabilities::from_metadata(&metadata).unwrap();
            assert_eq!(capability.image_input, Some(true));
            assert_eq!(capability.image_detail_original, declared.unwrap_or(false));
        }
        let pinned = fallback_capabilities("gpt-5.6-sol");
        assert_eq!(pinned.image_input, Some(true));
        assert!(!pinned.image_detail_original);
    }

    #[test]
    fn aliases_and_snapshots_do_not_grant_capabilities_to_other_variants() {
        assert_eq!(
            fallback_capabilities(" K3 ").context.context_window,
            1_048_576
        );
        assert_eq!(
            fallback_capabilities("GPT_5.6").context.max_context_window,
            872_000
        );
        assert_eq!(
            fallback_capabilities("grok-build-latest")
                .context
                .context_window,
            500_000
        );
        assert_eq!(
            fallback_capabilities("gpt-6-astra-2026-09-01").image_input,
            Some(true)
        );
        for model in [
            "gpt-6-astra-unknown",
            "gpt-5.6-sol-text",
            "claude-opus-5-mystery",
            "gpt-reserve",
            "codex-auto-review",
            "gpt-image-2",
        ] {
            assert!(!fallback_capabilities(model).verified, "{model}");
        }
        for model in [
            "gpt-6-sol",
            "gpt-6-astra-unknown",
            "vendor-model-live",
            "gpt-reserve",
            "codex-auto-review",
        ] {
            assert_eq!(
                fallback_capabilities(model).image_input,
                Some(true),
                "{model} should default to image input"
            );
        }
        for model in ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"] {
            assert_eq!(
                fallback_capabilities(model).image_input,
                Some(true),
                "{model} uses its precise upstream image declaration"
            );
        }
        for model in [
            "gaoge/openai/3/gpt-image-2",
            "gpt-image-2-2026-09-01",
            "gpt-image-2.5-flare",
            "gpt-image-2.5-sunburst",
            "gaoge/openai/3/gpt-image-2.5-flare",
            "gpt-image-2.5-sunburst-2026-09-21",
            "Image-2.5-Flare",
            "image_2.5_sunburst",
            "gaoge/openai/3/Image-2.5-Sunburst",
            "image-2.5-flare-20260921",
        ] {
            assert!(!is_codex_conversation_model(model), "{model}");
        }
        assert!(is_codex_conversation_model("image-2.5-flare-chat"));
        assert!(is_codex_conversation_model("gpt-6-astra"));
    }

    #[test]
    fn image_26_aliases_and_relay_snapshots_stay_out_of_conversation_models() {
        for model in [
            "gpt-image-2.6-flare",
            "gpt-image-2.6-sunburst",
            "Image-2.6-Flare",
            "image_2.6_sunburst",
            "GPT_IMAGE_2.6_FLARE",
            "gpt-image-2.6-flare-2026-11-05",
            "image-2.6-sunburst-20261105",
            "gaoge/openai/3/gpt-image-2.6-flare",
            "gaoge/openai/3/Image-2.6-Sunburst",
            "gaoge/openai/3/image_2.6_flare_20261105",
            "gaoge/openai/3/gpt-image-2.6-sunburst-2026-11-05",
        ] {
            assert!(!is_codex_conversation_model(model), "{model}");
            assert!(!fallback_capabilities(model).verified, "{model}");
        }
        for model in [
            "gpt-image-2.6-flare-chat",
            "image-2.6-sunburst-2026-11-05-extra",
            "gpt-image-2.6-flare-2026-xx-05",
            "gaoge/openai/3/gpt-6-astra",
        ] {
            assert!(is_codex_conversation_model(model), "{model}");
        }
    }
}
