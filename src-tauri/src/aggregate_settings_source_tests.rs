//! Isolated source/settings regressions. Fixtures never read real accounts,
//! settings files, credentials, Codex state, or network endpoints.
use super::*;
use crate::{aggregate_login_state_from_request, aggregate_model_entry,
    aggregate_model_picker_catalog_for_state, aggregate_models_payload,
    aggregate_route_for_request, build_codex_native_responses_catalog_with_metadata,
    public_aggregate_login_state};
use std::collections::HashMap;

fn custom_provider() -> Value {
    json!({"id":"external-test", "name":"Personal relay", "vendor":"openai",
        "baseUrl":"https://custom.example.invalid/v1", "protocol":"responses",
        "apiKey":"fixture-secret-do-not-expose", "models":["gpt-5.5"], "modelSettings":{}})
}
fn provider(source: &str, provider_id: &str, group_id: &str, model: &str) -> Value {
    json!({"id":provider_id,"source":source,"name":"Fixture provider",
        "baseUrl":"https://upstream.example.invalid/v1","groups":[{
            "id":group_id,"name":"Fixture group","platform":"openai",
            "apiKey":format!("fixture-{source}-key"),"models":[model]
        }]})
}

#[test]
fn aggregate_source_legacy_migration_is_narrow_and_explicit_source_wins() {
    assert_eq!(AggregateSource::from_legacy(None, "openai", "custom"), AggregateSource::Builtin);
    assert_eq!(AggregateSource::from_legacy(None, "unknown-brand", "custom"), AggregateSource::Builtin);
    assert_eq!(AggregateSource::from_legacy(None, "external-test", "custom"), AggregateSource::Custom);
    assert_eq!(AggregateSource::from_legacy(None, "external-test", "12"), AggregateSource::Builtin);
    assert_eq!(AggregateSource::from_legacy(Some("builtin"), "external-test", "custom"), AggregateSource::Builtin);
    assert_eq!(AggregateSource::from_legacy(Some("custom"), "openai", "12"), AggregateSource::Custom);
}

#[test]
fn aggregate_source_settings_default_enabled_and_redact_custom_secret() {
    let config = validate(&json!({"groups":[],"providers":[custom_provider()]}), &empty()).unwrap();
    assert_eq!(config["version"], 2);
    assert_eq!(config["providers"][0]["enabled"], true);
    assert_eq!(config["providers"][0]["source"], "custom");
    let mut protected = config.clone();
    protected["providers"][0]["encryptedApiKey"] = json!("ciphertext-not-for-ui");
    let snapshot = public(protected);
    assert_eq!(snapshot["providers"][0]["keyConfigured"], true);
    assert_eq!(snapshot["providers"][0]["apiKey"], "");
    let serialized = snapshot.to_string();
    assert!(!serialized.contains("fixture-secret-do-not-expose"));
    assert!(!serialized.contains("ciphertext-not-for-ui"));
    assert!(!serialized.contains("encryptedApiKey"));
}

#[test]
fn aggregate_source_disabled_interfaces_stay_editable_but_leave_route_request() {
    let mut custom = custom_provider();
    custom["enabled"] = json!(false);
    let config = validate(&json!({"groups":[],"providers":[custom]}), &empty()).unwrap();
    let request = json!({"providers":[provider("custom", "openai", "1", "gpt-5.5")]});
    let merged = merge_request(&request, &config).unwrap();
    assert_eq!(merged["providers"].as_array().unwrap().len(), 1);
    assert_eq!(merged["providers"][0]["source"], "builtin");
    assert_eq!(merged["providers"][0]["groups"][0]["source"], "builtin");
    let snapshot = public(config.clone());
    assert_eq!(snapshot["providers"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["providers"][0]["enabled"], false);
    let state = aggregate_login_state_from_request(&merged).unwrap();
    assert_eq!(state.routes.len(), 1);
    assert_eq!(state.routes[0].source, AggregateSource::Builtin);
    let mut enabled = config;
    enabled["providers"][0]["enabled"] = json!(true);
    let merged = merge_request(&request, &enabled).unwrap();
    let state = aggregate_login_state_from_request(&merged).unwrap();
    assert_eq!(state.routes.len(), 2);
    assert_eq!(state.routes[1].source, AggregateSource::Custom);
    assert_eq!(state.routes[1].public_model, "gaoge/external-test/custom/gpt-5.5");
}

#[test]
fn aggregate_source_custom_edit_delete_preserves_key_boundary() {
    let old = validate(&json!({"groups":[],"providers":[custom_provider()]}), &empty()).unwrap();
    let mut edited = public(old.clone());
    edited["providers"][0]["name"] = json!("Renamed interface");
    edited["providers"][0]["enabled"] = json!(false);
    let saved = validate(&edited, &old).unwrap();
    assert_eq!(saved["providers"][0]["name"], "Renamed interface");
    assert_eq!(saved["providers"][0]["apiKey"], "fixture-secret-do-not-expose");
    assert_eq!(saved["providers"][0]["enabled"], false);
    edited["providers"][0]["protocol"] = json!("chatCompletions");
    assert!(validate(&edited, &old).is_err());
    let deleted = validate(&json!({"groups":[],"providers":[]}), &old).unwrap();
    assert!(deleted["providers"].as_array().unwrap().is_empty());
}

#[test]
fn aggregate_source_settings_reject_non_boolean_enabled() {
    let mut custom = custom_provider();
    custom["enabled"] = json!("false");
    assert!(validate(&json!({"groups":[],"providers":[custom]}), &empty()).is_err());
}

#[test]
fn aggregate_source_same_model_different_groups_use_full_route_identity() {
    let request = json!({"providers":[provider("builtin", "openai", "1", "gpt-5.5"),
        provider("custom", "external-test", "custom", "gpt-5.5")]});
    let mut state = aggregate_login_state_from_request(&request).unwrap();
    let custom_id = state.routes[1].public_model.clone();
    assert_ne!(state.routes[0].public_model, custom_id);
    state.default_model = state.routes[0].public_model.clone();
    let selected = aggregate_route_for_request(&state, &custom_id).unwrap();
    assert_eq!(selected.source, AggregateSource::Custom);
    assert_eq!(selected.api_key, "fixture-custom-key");
    assert_eq!(state.default_model, state.routes[0].public_model);
    assert!(aggregate_route_for_request(&state, "gaoge/external-missing/custom/gpt-5.5").is_none());
    assert!(aggregate_route_for_request(&state, "gaoge/custom/external-missing/custom/gpt-5.5").is_none());
}

#[test]
fn aggregate_source_collisions_namespace_custom_deterministically() {
    let builtin = provider("builtin", "openai", "1", "gpt-5.5");
    let custom = provider("custom", "openai", "1", "gpt-5.5");
    for providers in [vec![builtin.clone(), custom.clone()], vec![custom.clone(), builtin.clone()]] {
        let state = aggregate_login_state_from_request(&json!({"providers":providers})).unwrap();
        assert_eq!(state.routes.len(), 2);
        let builtin = state.routes.iter().find(|route| route.source == AggregateSource::Builtin).unwrap();
        let custom = state.routes.iter().find(|route| route.source == AggregateSource::Custom).unwrap();
        assert_eq!(builtin.public_model, "gaoge/openai/1/gpt-5.5");
        assert_eq!(custom.public_model, "gaoge/custom/openai/1/gpt-5.5");
        let status = public_aggregate_login_state(&state, false);
        assert_eq!(status["providerCount"], 2);
        assert_eq!(status["groupCount"], 2);
        let catalog = aggregate_model_picker_catalog_for_state(&state, &HashMap::new());
        assert_eq!(catalog["providers"].as_array().unwrap().len(), 2);
        for provider in catalog["providers"].as_array().unwrap() {
            let group = &provider["groups"][0];
            let model = &group["models"][0];
            assert_eq!(provider["source"], group["source"]);
            assert_eq!(group["source"], model["source"]);
            assert_eq!(model["providerId"], "openai");
            assert_eq!(model["groupId"], "1");
        }
    }
}

#[test]
fn aggregate_source_secondary_prefix_collision_is_rejected() {
    let providers = json!([
        provider("builtin", "openai", "1", "gpt-5.5"),
        provider("custom", "openai", "1", "gpt-5.5"),
        provider("builtin", "custom", "openai", "1/gpt-5.5")
    ]);
    for providers in [providers.as_array().unwrap().clone(), providers.as_array().unwrap().iter().rev().cloned().collect()] {
        let result = aggregate_login_state_from_request(&json!({"providers":providers}));
        assert!(result.unwrap_err().contains("完整路由标识冲突"));
    }
}

#[test]
fn aggregate_source_native_catalog_exposes_all_safe_routes_without_bridge_selection() {
    let mut custom = provider("custom", "external-test", "custom", "gpt-5.5");
    custom["groups"][0]["models"] = json!(["gpt-5.5", "deepseek-v4-flash"]);
    let state = aggregate_login_state_from_request(&json!({"providers":[
        provider("builtin", "openai", "1", "gpt-5.5"), custom
    ]})).unwrap();
    let mut metadata = HashMap::new();
    for (i, route) in state.routes.iter().enumerate() {
        metadata.insert(route.public_model.clone(), aggregate_model_entry(route, i, &HashMap::new()));
    }
    let models = state.routes.iter().map(|route| route.public_model.clone()).collect::<Vec<_>>();
    let native = build_codex_native_responses_catalog_with_metadata(&models, &metadata).unwrap();
    assert_eq!(native["models"].as_array().unwrap().len(), 3);
    for entry in native["models"].as_array().unwrap() {
        assert_eq!(entry["slug"], entry["gaoge_aggregate_public_model"]);
        assert!(matches!(entry["gaoge_aggregate_source"].as_str(), Some("builtin" | "custom")));
        let route = aggregate_route_for_request(&state, entry["slug"].as_str().unwrap()).unwrap();
        assert_eq!(entry["gaoge_aggregate_provider_id"], route.provider_id);
        assert_eq!(entry["gaoge_aggregate_group_id"], route.group_id);
    }
    let menu = aggregate_model_picker_catalog_for_state(&state, &HashMap::new());
    let local_models = aggregate_models_payload(&state);
    for payload in [native, menu, local_models] {
        let text = payload.to_string();
        assert!(!text.contains("fixture-builtin-key"));
        assert!(!text.contains("fixture-custom-key"));
        assert!(!text.contains("apiKey"));
        assert!(!text.contains("upstream.example.invalid"));
    }
}

#[test]
fn aggregate_source_disabled_direct_provider_is_not_routable() {
    let mut disabled = provider("custom", "external-test", "custom", "gpt-5.5");
    disabled["enabled"] = json!(false);
    let state = aggregate_login_state_from_request(&json!({"providers":[
        provider("builtin", "openai", "1", "gpt-5.5"), disabled
    ]})).unwrap();
    assert_eq!(state.routes.len(), 1);
    assert!(aggregate_route_for_request(&state, "gaoge/external-test/custom/gpt-5.5").is_none());
}


#[test]
fn aggregate_source_route_transition_rejects_builtin_takeover_of_custom_id() {
    let custom = provider("custom", "openai", "1", "gpt-5.5");
    let previous = aggregate_login_state_from_request(&json!({"providers":[custom.clone()]})).unwrap();
    let next = aggregate_login_state_from_request(&json!({"providers":[
        provider("builtin", "openai", "1", "gpt-5.5"), custom
    ]})).unwrap();
    let error = crate::validate_aggregate_route_identity_transition(&previous, &next).unwrap_err();
    assert!(error.contains("旧会话"));
    assert!(!error.contains("fixture-custom-key"));
    let mut disabled_previous = previous;
    disabled_previous.enabled = false;
    assert!(crate::validate_aggregate_route_identity_transition(&disabled_previous, &next).is_err());
}

#[test]
fn aggregate_source_route_transition_allows_same_identity_endpoint_and_key_edits() {
    let previous = aggregate_login_state_from_request(&json!({"providers":[
        provider("custom", "external-test", "custom", "gpt-5.5")
    ]})).unwrap();
    let mut next = previous.clone();
    next.routes[0].base_url = "https://new-upstream.example.invalid/v1".into();
    next.routes[0].api_key = "new-fixture-key".into();
    next.routes[0].provider_name = "Renamed provider".into();
    next.routes[0].group_name = "Renamed group".into();
    assert!(crate::validate_aggregate_route_identity_transition(&previous, &next).is_ok());
}

#[test]
fn aggregate_source_route_transition_missing_old_id_fails_closed_on_request() {
    let previous = aggregate_login_state_from_request(&json!({"providers":[
        provider("custom", "external-test", "custom", "gpt-5.5")
    ]})).unwrap();
    let next = aggregate_login_state_from_request(&json!({"providers":[
        provider("custom", "external-new", "custom", "gpt-5.5")
    ]})).unwrap();
    assert!(crate::validate_aggregate_route_identity_transition(&previous, &next).is_ok());
    assert!(aggregate_route_for_request(&next, &previous.routes[0].public_model).is_none());
    assert!(aggregate_route_for_request(&next, &next.routes[0].public_model).is_some());
}

#[test]
fn aggregate_source_route_transition_rejects_each_identity_dimension() {
    let previous = aggregate_login_state_from_request(&json!({"providers":[
        provider("custom", "external-test", "custom", "gpt-5.5")
    ]})).unwrap();
    for dimension in 0..4 {
        let mut next = previous.clone();
        match dimension {
            0 => next.routes[0].source = AggregateSource::Builtin,
            1 => next.routes[0].provider_id = "external-other".into(),
            2 => next.routes[0].group_id = "another-group".into(),
            _ => next.routes[0].upstream_model = "gpt-6-astra".into(),
        }
        assert!(crate::validate_aggregate_route_identity_transition(&previous, &next).is_err(), "dimension {dimension}");
    }
}


#[test]
fn aggregate_source_long_full_ids_survive_plan_and_native_catalog() {
    let provider_id = format!("external-{}", "a".repeat(23));
    let upstream_model = format!("gpt-{}", "m".repeat(156));
    let state = aggregate_login_state_from_request(&json!({"providers":[
        provider("custom", &provider_id, "custom", &upstream_model)
    ]})).unwrap();
    let route = &state.routes[0];
    assert!(route.public_model.len() > 200 && route.public_model.len() <= 240);
    let (selected, plan) = crate::codex_model_catalog_plan(&json!({
        "modelSelectionMode":crate::CODEX_MODEL_SELECTION_UPSTREAM,
        "modelCatalogSource":crate::CODEX_MODEL_CATALOG_SOURCE_UPSTREAM,
        "supportedModels":[route.public_model],
    }), &route.public_model).unwrap();
    assert_eq!(selected, route.public_model);
    assert_eq!(plan.models, vec![route.public_model.clone()]);
    let metadata = HashMap::from([(route.public_model.clone(), aggregate_model_entry(route, 0, &HashMap::new()))]);
    let catalog = build_codex_native_responses_catalog_with_metadata(&plan.models, &metadata).unwrap();
    assert_eq!(catalog["models"][0]["slug"], route.public_model);
    let ordinary_limit = "m".repeat(200);
    let ordinary_too_long = "m".repeat(201);
    let aggregate_limit = format!("gaoge/{}", "m".repeat(234));
    let aggregate_too_long = format!("gaoge/{}", "m".repeat(235));
    let normalized = crate::normalize_codex_model_names(Some(&json!([
        ordinary_limit, ordinary_too_long, aggregate_limit, aggregate_too_long,
    ])));
    assert_eq!(normalized, vec![ordinary_limit, aggregate_limit]);
}


#[test]
fn aggregate_source_custom_vendor_labels_preserve_endpoint_identity() {
    let mut one = provider("custom", "external-deepseek-one", "custom", "deepseek-v4-flash");
    let mut two = provider("custom", "external-deepseek-two", "custom", "deepseek-v4-flash");
    let mut kimi = provider("custom", "external-kimi", "custom", "kimi-k2.5");
    one["groups"][0]["platform"] = json!("deepseek");
    two["groups"][0]["platform"] = json!("deepseek");
    kimi["groups"][0]["platform"] = json!("moonshot");
    one["groups"][0]["apiKey"] = json!("fixture-first-secret");
    two["groups"][0]["apiKey"] = json!("fixture-second-secret");
    let state = aggregate_login_state_from_request(&json!({"providers":[one, two, kimi,
        provider("builtin", "openai", "1", "gpt-5.5")]})).unwrap();
    let catalog = aggregate_model_picker_catalog_for_state(&state, &HashMap::new());
    let suppliers = catalog["providers"].as_array().unwrap();
    assert_eq!(suppliers.len(), 4);
    for (index, id, label) in [(0, "deepseek", "DeepSeek"), (1, "deepseek", "DeepSeek"), (2, "kimi", "Kimi")] {
        let supplier = &suppliers[index];
        let model = &supplier["groups"][0]["models"][0];
        assert_eq!(supplier["vendorId"], id);
        assert_eq!(supplier["vendorLabel"], label);
        assert_eq!(model["vendorId"], id);
        assert_eq!(model["vendorLabel"], label);
        assert_eq!(model["nativeLabel"], format!("{} · {label}", state.routes[index].upstream_model));
        assert_eq!(model["providerId"], supplier["id"]);
        assert_eq!(model["publicModel"], state.routes[index].public_model);
    }
    assert_ne!(state.routes[0].public_model, state.routes[1].public_model);
    assert_eq!(aggregate_route_for_request(&state, &state.routes[0].public_model).unwrap().api_key, "fixture-first-secret");
    assert_eq!(aggregate_route_for_request(&state, &state.routes[1].public_model).unwrap().api_key, "fixture-second-secret");
    assert_eq!(suppliers[3]["groups"][0]["models"][0]["nativeLabel"], "gpt-5.5 · Fixture group · GPT");
    assert!(!catalog.to_string().contains("fixture-first-secret"));
    assert!(!catalog.to_string().contains("fixture-second-secret"));
}

#[test]
fn aggregate_source_generic_custom_suppliers_keep_their_own_labels() {
    let mut first = provider("custom", "external-custom-one", "custom", "gpt-5.5");
    let mut second = provider("custom", "external-custom-two", "custom", "gpt-5.5");
    first["groups"][0]["platform"] = json!("custom");
    second["groups"][0]["platform"] = json!("custom");
    first["name"] = json!("Personal endpoint one");
    second["name"] = json!("Personal endpoint two");
    let state = aggregate_login_state_from_request(&json!({"providers":[first, second]})).unwrap();
    let catalog = aggregate_model_picker_catalog_for_state(&state, &HashMap::new());
    for (index, name) in [(0, "Personal endpoint one"), (1, "Personal endpoint two")] {
        let supplier = &catalog["providers"][index];
        let model = &supplier["groups"][0]["models"][0];
        assert_eq!(supplier["vendorId"], state.routes[index].provider_id);
        assert_eq!(supplier["vendorLabel"], name);
        assert_eq!(model["nativeLabel"], format!("gpt-5.5 · {name}"));
    }
    assert_ne!(catalog["providers"][0]["vendorId"], catalog["providers"][1]["vendorId"]);
}
