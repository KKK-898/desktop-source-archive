//! Retain exact aggregate aliases after their authenticated routes are removed.
//! Native model selection must still validate targets in the current catalog.
use super::{AggregateLoginState, AggregateProviderRoute};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

const MAX_REMEMBERED_MODELS: usize = 10_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Model {
    pub public_model: String,
    pub upstream_model: String,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid(model: &Model) -> bool {
    if model.public_model.len() > 260
        || model.upstream_model.trim() != model.upstream_model
        || model.upstream_model.is_empty()
        || model.upstream_model.chars().any(char::is_control)
        || !super::is_codex_conversation_model(&model.upstream_model)
    {
        return false;
    }
    // Validate explicit metadata, never derive a target by trimming an alias.
    let Some(prefix) = model
        .public_model
        .strip_prefix("gaoge/")
        .and_then(|value| value.strip_suffix(&model.upstream_model))
        .and_then(|value| value.strip_suffix('/'))
    else {
        return false;
    };
    let parts: Vec<_> = prefix.split('/').collect();
    match parts.as_slice() {
        [provider, group] => identifier(provider) && identifier(group),
        ["custom", provider, group] => identifier(provider) && identifier(group),
        _ => false,
    }
}

fn normalize(candidates: impl IntoIterator<Item = Model>) -> Vec<Model> {
    let mut models = Vec::new();
    let mut indices = HashMap::new();
    for candidate in candidates {
        if !valid(&candidate) {
            continue;
        }
        if let Some(index) = indices.get(&candidate.public_model).copied() {
            models[index] = candidate;
        } else {
            indices.insert(candidate.public_model.clone(), models.len());
            models.push(candidate);
        }
    }
    if models.len() > MAX_REMEMBERED_MODELS {
        models.drain(..models.len() - MAX_REMEMBERED_MODELS);
    }
    models
}

pub(super) fn deserialize(value: Option<&Value>) -> Vec<Model> {
    let mut models = Vec::new();
    if let Some(entries) = value.and_then(Value::as_array) {
        for entry in entries.iter().rev().take(MAX_REMEMBERED_MODELS).rev() {
            if let Ok(model) = serde_json::from_value::<Model>(entry.clone()) {
                models.push(model);
            }
        }
    }
    normalize(models)
}

fn route_model(route: &AggregateProviderRoute) -> Option<Model> {
    let ordinary = format!(
        "gaoge/{}/{}/{}",
        route.provider_id, route.group_id, route.upstream_model
    );
    let collision = format!(
        "gaoge/custom/{}/{}/{}",
        route.provider_id, route.group_id, route.upstream_model
    );
    if route.public_model != ordinary
        && !(route.source == super::aggregate_settings::AggregateSource::Custom
            && route.public_model == collision)
    {
        return None;
    }
    Some(Model {
        public_model: route.public_model.clone(),
        upstream_model: route.upstream_model.clone(),
    })
}

pub(super) fn remembered_models(state: &AggregateLoginState) -> Vec<Model> {
    normalize(
        state
            .recovery_models
            .iter()
            .cloned()
            .chain(state.routes.iter().filter_map(route_model)),
    )
}

fn catalog_models(catalog: &Value) -> Vec<Model> {
    let mut models = Vec::new();
    let Some(entries) = catalog.get("models").and_then(Value::as_array) else {
        return models;
    };
    for entry in entries.iter().take(MAX_REMEMBERED_MODELS) {
        let (Some(public), Some(upstream), Some(provider), Some(group)) = (
            entry["gaoge_aggregate_public_model"].as_str(),
            entry["gaoge_aggregate_upstream_model"].as_str(),
            entry["gaoge_aggregate_provider_id"].as_str(),
            entry["gaoge_aggregate_group_id"].as_str(),
        ) else {
            continue;
        };
        if entry["slug"].as_str() != Some(public) {
            continue;
        }
        let ordinary = format!("gaoge/{provider}/{group}/{upstream}");
        let collision = format!("gaoge/custom/{provider}/{group}/{upstream}");
        if public == ordinary
            || (entry["gaoge_aggregate_source"].as_str() == Some("custom") && public == collision)
        {
            models.push(Model {
                public_model: public.into(),
                upstream_model: upstream.into(),
            });
        }
    }
    normalize(models)
}

/// A branded managed catalog can recover exact identities for older installs.
/// Missing metadata must not be guessed from user model names.
pub(super) fn recover_managed_catalogs(models: &mut Vec<Model>) {
    let remembered = std::mem::take(models);
    for target in super::codex_route_targets() {
        let path = target.dir.join(super::CODEX_MODEL_CATALOG_FILE);
        if !std::fs::symlink_metadata(&path)
            .ok()
            .is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        {
            continue;
        }
        let Ok(Some(catalog)) = super::read_json_if_exists(&path) else {
            continue;
        };
        models.extend(catalog_models(&catalog));
    }
    // A persisted route identity is newer evidence than an orphaned catalog.
    models.extend(remembered);
    *models = normalize(std::mem::take(models));
}

pub(super) fn runtime_payload(config: &str, state: &AggregateLoginState) -> Value {
    // Already normalized during load/save. Avoid rescanning routes on every
    // runtime poll; the aliases carry no credentials or provider connections.
    let models = &state.recovery_models;
    json!({
        "version": 1,
        "enabled": !state.enabled && !models.is_empty(),
        "defaultModel": super::configured_root_value(config, "model").unwrap_or_default(),
        "models": models,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(provider: &str, group: &str, upstream: &str) -> AggregateProviderRoute {
        AggregateProviderRoute {
            source: super::super::aggregate_settings::AggregateSource::Builtin,
            provider_id: provider.into(),
            provider_name: provider.into(),
            upstream_platform: provider.into(),
            group_id: group.into(),
            group_name: group.into(),
            group_rate_text: String::new(),
            public_model: format!("gaoge/{provider}/{group}/{upstream}"),
            upstream_model: upstream.into(),
            base_url: "https://fixture.example.invalid/v1".into(),
            api_key: "private-fixture-key".into(),
            protocol: super::super::aggregate_protocol::Protocol::Responses,
            model_config: json!({}),
        }
    }

    #[test]
    fn aggregate_recovery_retains_exact_aliases_without_credentials() {
        let mut state = super::super::default_aggregate_login_state();
        state.routes.push(route("openai", "3", "gpt-6-astra"));
        state.recovery_models = remembered_models(&state);
        state.routes.clear();
        let payload = runtime_payload("model=\"gpt-5.6-sol\"", &state);
        assert_eq!(payload["enabled"], true);
        assert_eq!(payload["defaultModel"], "gpt-5.6-sol");
        assert_eq!(
            payload["models"],
            json!([{"publicModel":"gaoge/openai/3/gpt-6-astra","upstreamModel":"gpt-6-astra"}])
        );
        assert!(!payload.to_string().contains("private-fixture-key"));
        assert!(!payload.to_string().contains("fixture.example.invalid"));
        state.enabled = true;
        assert_eq!(runtime_payload("", &state)["enabled"], false);
    }

    #[test]
    fn aggregate_recovery_preserves_custom_collisions_and_slashes() {
        let mut state = super::super::default_aggregate_login_state();
        let mut custom = route("deepseek", "custom", "vendor/deepseek-v4");
        custom.source = super::super::aggregate_settings::AggregateSource::Custom;
        custom.public_model = format!("gaoge/custom/deepseek/custom/{}", custom.upstream_model);
        state.routes.push(custom.clone());
        let models = remembered_models(&state);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].public_model, custom.public_model);
        assert_eq!(models[0].upstream_model, "vendor/deepseek-v4");
        assert_eq!(
            deserialize(Some(&serde_json::to_value(&models).unwrap())),
            models
        );
        state.routes[0].source = super::super::aggregate_settings::AggregateSource::Builtin;
        assert!(remembered_models(&state).is_empty());
    }

    #[test]
    fn aggregate_recovery_rejects_unverified_aliases_and_unrelated_models() {
        let values = json!([
            {"publicModel":"gpt-6-astra","upstreamModel":"gpt-6-astra"},
            {"publicModel":"gaoge/openai/3/gpt-6-astra","upstreamModel":"other-model"},
            {"publicModel":"gaoge/openai/3/gpt-6-astra","upstreamModel":"gpt-6-astra"},
            {"publicModel":"gaoge/openai/3/gpt-6-astra","upstreamModel":"gpt-6-astra"}
        ]);
        assert_eq!(deserialize(Some(&values)).len(), 1);
        let mut state = super::super::default_aggregate_login_state();
        let mut invalid = route("openai", "3", "gpt-6-astra");
        invalid.public_model = "gaoge/openai/other/gpt-6-astra".into();
        state.routes.push(invalid);
        assert!(remembered_models(&state).is_empty());
        assert_eq!(runtime_payload("", &state)["enabled"], false);
    }

    #[test]
    fn aggregate_recovery_catalog_requires_complete_matching_metadata() {
        let entry = json!({"slug":"gaoge/openai/3/gpt-6-astra", "gaoge_aggregate_public_model":"gaoge/openai/3/gpt-6-astra", "gaoge_aggregate_upstream_model":"gpt-6-astra", "gaoge_aggregate_provider_id":"openai", "gaoge_aggregate_group_id":"3"});
        assert_eq!(catalog_models(&json!({"models":[entry.clone()]})).len(), 1);
        for field in [
            "slug",
            "gaoge_aggregate_public_model",
            "gaoge_aggregate_upstream_model",
            "gaoge_aggregate_provider_id",
            "gaoge_aggregate_group_id",
        ] {
            let mut incomplete = entry.clone();
            incomplete.as_object_mut().unwrap().remove(field);
            assert!(
                catalog_models(&json!({"models":[incomplete]})).is_empty(),
                "{field}"
            );
        }
        let mut mismatch = entry;
        mismatch["gaoge_aggregate_upstream_model"] = json!("gpt-5.6-sol");
        assert!(catalog_models(&json!({"models":[mismatch]})).is_empty());
    }

    #[test]
    fn aggregate_recovery_round_trips_disabled_state_and_old_catalogs() {
        super::super::tests::with_temp_user_home("aggregate-model-recovery", |_| {
            struct Restore(AggregateLoginState);
            impl Drop for Restore {
                fn drop(&mut self) {
                    *crate::AGGREGATE_LOGIN_STATE.lock().unwrap() = self.0.clone();
                }
            }
            let _restore = Restore(super::super::aggregate_login_state_snapshot());
            let mut state = super::super::default_aggregate_login_state();
            state.routes.push(route("openai", "3", "gpt-6-astra"));
            state.recovery_models = remembered_models(&state);
            state.routes.clear();
            super::super::save_aggregate_login_state(&state).unwrap();
            let loaded = super::super::load_aggregate_login_state().unwrap();
            assert_eq!(loaded.recovery_models, state.recovery_models);
            assert!(!loaded.enabled);
            let saved =
                super::super::read_json_if_exists(&super::super::aggregate_login_state_path())
                    .unwrap()
                    .unwrap();
            assert_eq!(saved["routes"], json!([]));
            assert_eq!(saved["recoveryModels"].as_array().unwrap().len(), 1);
            assert!(!saved.to_string().contains("private-fixture-key"));
            let catalog_path =
                super::super::codex_dir().join(super::super::CODEX_MODEL_CATALOG_FILE);
            super::super::write_json_pretty_atomic(&catalog_path, &json!({"models":[{"slug":"gaoge/kimi/7/kimi-k2", "gaoge_aggregate_public_model":"gaoge/kimi/7/kimi-k2", "gaoge_aggregate_upstream_model":"kimi-k2", "gaoge_aggregate_provider_id":"kimi", "gaoge_aggregate_group_id":"7"}]})).unwrap();
            let loaded = super::super::load_aggregate_login_state().unwrap();
            assert_eq!(loaded.recovery_models.len(), 2);
            assert_eq!(
                runtime_payload("model=\"gpt-5.6-sol\"", &loaded)["enabled"],
                true
            );
        });
    }

    #[test]
    fn aggregate_recovery_guard_is_required_for_official_without_paid_route() {
        let recovery = json!({"version":1,"enabled":true,"models":[{"publicModel":"gaoge/openai/3/gpt-6-astra","upstreamModel":"gpt-6-astra"}]});
        assert!(super::super::codex_model_transition_guard_required(
            &json!({"enabled":false,"mode":"","aggregateModelRecovery":recovery})
        ));
        assert!(!super::super::codex_model_transition_guard_required(
            &json!({"enabled":true,"mode":"aggregate","aggregateModelRecovery":recovery})
        ));
        assert!(!super::super::codex_model_transition_guard_required(
            &json!({"aggregateModelRecovery":{"enabled":true,"version":1,"models":[]}})
        ));
    }

    #[test]
    fn aggregate_recovery_current_route_identity_overrides_older_mapping() {
        let mut state = super::super::default_aggregate_login_state();
        state.recovery_models.push(Model {
            public_model: "gaoge/custom/openai/group/gpt-6-astra".into(),
            upstream_model: "group/gpt-6-astra".into(),
        });
        let mut current = route("openai", "group", "gpt-6-astra");
        current.source = super::super::aggregate_settings::AggregateSource::Custom;
        current.public_model = "gaoge/custom/openai/group/gpt-6-astra".into();
        state.routes.push(current);
        let models = remembered_models(&state);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].upstream_model, "gpt-6-astra");
    }

    #[test]
    fn aggregate_recovery_write_failure_does_not_clear_active_routes() {
        super::super::tests::with_temp_user_home("aggregate-model-recovery-failure", |_| {
            struct Restore(AggregateLoginState);
            impl Drop for Restore {
                fn drop(&mut self) {
                    *crate::AGGREGATE_LOGIN_STATE.lock().unwrap() = self.0.clone();
                }
            }
            let _restore = Restore(super::super::aggregate_login_state_snapshot());
            let mut state = super::super::default_aggregate_login_state();
            state.enabled = true;
            state.routes.push(route("openai", "3", "gpt-6-astra"));
            state.default_model = state.routes[0].public_model.clone();
            *crate::AGGREGATE_LOGIN_STATE.lock().unwrap() = state.clone();
            // Force the atomic rename to fail inside this isolated fixture.
            std::fs::create_dir_all(super::super::aggregate_login_state_path()).unwrap();
            assert!(super::super::deactivate_aggregate_login_state().is_err());
            let retained = super::super::aggregate_login_state_snapshot();
            assert!(retained.enabled);
            assert_eq!(retained.routes.len(), 1);
            assert_eq!(retained.default_model, state.default_model);
        });
    }
}
