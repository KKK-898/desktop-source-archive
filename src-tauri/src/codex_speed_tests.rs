// Exercise model catalogs and config writes against synthetic native caches.
mod codex_speed_regressions {
    use super::*;

    fn cached_model(model: &str) -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/codex-models-26.901.json"
        ))
        .unwrap();
        let mut entry = fixture["models"][0].clone();
        entry["slug"] = json!(model);
        entry["additional_speed_tiers"] = json!([]);
        entry["service_tiers"] = json!([]);
        entry
    }

    fn assert_fast(entry: &Value) {
        assert!(entry["additional_speed_tiers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tier| tier == "fast"));
        assert!(entry["service_tiers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tier| {
                tier["id"] == "priority"
                    && tier["name"].as_str().is_some_and(|value| !value.is_empty())
                    && tier["description"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
            }));
    }

    #[test]
    fn speed_all_current_models_repair_missing_cache_and_explicit_routes_support_priority() {
        let models = CODEX_FAST_MODELS.map(str::to_string);
        let metadata = models
            .iter()
            .map(|model| {
                let mut entry = cached_model(model);
                let object = entry.as_object_mut().unwrap();
                object.remove("additional_speed_tiers");
                object.remove("service_tiers");
                (model.clone(), entry)
            })
            .collect();
        for cache in [&HashMap::new(), &metadata] {
            let catalog =
                build_codex_native_responses_catalog_with_metadata(&models, cache).unwrap();
            for (index, model) in models.iter().enumerate() {
                assert_fast(&catalog["models"][index]);
                let mut route = aggregate_test_route("openai", model);
                route.model_config = json!({"fast":"supported"});
                let aggregate = aggregate_model_entry(&route, index, cache);
                assert_fast(&aggregate);
                assert_eq!(aggregate["slug"], route.public_model);
                let mut payload = json!({ "service_tier": "fast" });
                let routing = prepare_aggregate_speed_request(
                    &route,
                    &mut payload,
                );
                assert_eq!(payload["service_tier"], "priority", "{model}");
                assert_eq!(routing.upstream_model, *model);
            }
        }
        assert_eq!(codex_api_speed_model_ids(""), models);
        for model in CODEX_FAST_MODELS {
            for id in [
                model.to_string(),
                format!("{model}-2026-09-30"),
                format!("{model}-20260930"),
                format!("gaoge/openai/direct/{model}"),
            ] {
                assert!(codex_api_speed_model_supported("", &id), "{id}");
            }
        }
        assert!(codex_openai_speed_profile("gpt-6.1-sol-unknown").is_none());
        assert!(codex_openai_speed_profile("gpt-6.1-unknown").is_none());
    }

    #[test]
    fn aggregate_speed_explicit_empty_native_lists_are_not_missing_capabilities() {
        for model in CODEX_FAST_MODELS {
            let metadata = HashMap::from([(model.to_string(), cached_model(model))]);
            let mut route = aggregate_test_route("openai", model);
            let entry = aggregate_model_entry(&route, 0, &metadata);
            assert_eq!(entry["additional_speed_tiers"], json!([]), "{model}");
            assert_eq!(entry["service_tiers"], json!([]), "{model}");
            assert!(!aggregate_entry_supports_fast(&entry), "{model}");

            // A deliberate route capability takes precedence over cached values.
            route.model_config = json!({"fast":"supported"});
            assert_fast(&aggregate_model_entry(&route, 0, &metadata));
            route.model_config = json!({"fast":"unsupported"});
            assert!(!aggregate_entry_supports_fast(&aggregate_model_entry(&route, 0, &metadata)));
        }
    }

    #[test]
    fn speed_repair_handles_missing_partial_and_malformed_cache_fields() {
        for model in CODEX_FAST_MODELS {
            for (additional, service) in [
                (None, None),
                (Some(Value::Null), Some(Value::Null)),
                (Some(json!([])), Some(json!([]))),
                (Some(json!("fast")), Some(json!({}))),
                (Some(json!(["fast"])), Some(json!([]))),
                (Some(json!([])), Some(json!([{ "id": "priority" }]))),
                (
                    Some(json!([null, 1, {}, ""])),
                    Some(json!([null, "priority", {}, { "id": 42 }, { "id": "" }])),
                ),
                (
                    Some(json!([])),
                    Some(json!([{ "id": "priority", "name": null, "description": 7 }])),
                ),
            ] {
                let mut entry = cached_model(model);
                let object = entry.as_object_mut().unwrap();
                for (field, value) in [
                    ("additional_speed_tiers", additional),
                    ("service_tiers", service),
                ] {
                    if let Some(value) = value {
                        object.insert(field.to_string(), value);
                    } else {
                        object.remove(field);
                    }
                }
                let repaired = sanitize_codex_model_metadata(entry.clone(), model).unwrap();
                assert_fast(&repaired);
                for field in [
                    "model_messages",
                    "context_window",
                    "input_modalities",
                    "shell_type",
                ] {
                    assert_eq!(repaired[field], entry[field], "{model}: {field}");
                }
                assert_eq!(
                    sanitize_codex_model_metadata(repaired.clone(), model).unwrap(),
                    repaired,
                    "repeated logins must not duplicate speed tiers"
                );
            }
        }
    }

    #[test]
    fn speed_repair_preserves_native_tiers_defaults_and_unknown_models() {
        let mut entry = cached_model("gpt-6.1-sol");
        entry["additional_speed_tiers"] = json!(["ultrafast"]);
        entry["service_tiers"] = json!([{
            "id": "ultrafast", "name": "Native tier", "description": "Keep me",
            "native_metadata": { "multiplier": 3 }
        }]);
        entry["default_service_tier"] = json!("default");
        let repaired = sanitize_codex_model_metadata(entry.clone(), "gpt-6.1-sol").unwrap();
        assert_fast(&repaired);
        assert_eq!(
            repaired["additional_speed_tiers"],
            json!(["ultrafast", "fast"])
        );
        assert_eq!(repaired["service_tiers"][0], entry["service_tiers"][0]);
        assert_eq!(repaired["default_service_tier"], "default");

        for id in ["priority", "fast"] {
            entry["additional_speed_tiers"] = json!(["fast", "ultrafast"]);
            entry["service_tiers"] = json!([
                { "id": id, "name": "Native Fast", "description": "Native description",
                  "native_metadata": { "multiplier": 2 } },
                { "id": "ultrafast", "name": "Native tier", "description": "Keep me" }
            ]);
            let repaired = sanitize_codex_model_metadata(entry.clone(), "gpt-6.1-sol").unwrap();
            for field in [
                "additional_speed_tiers",
                "service_tiers",
                "default_service_tier",
            ] {
                assert_eq!(repaired[field], entry[field], "{field}");
            }
        }
        let unknown = cached_model("vendor-model");
        let repaired = sanitize_codex_model_metadata(unknown.clone(), "vendor-model").unwrap();
        assert_eq!(repaired["service_tiers"], unknown["service_tiers"]);
        assert_eq!(
            repaired["additional_speed_tiers"],
            unknown["additional_speed_tiers"]
        );
    }

    #[test]
    fn speed_login_writes_repaired_catalog_for_existing_accounts_and_api_login() {
        with_temp_user_home("speed-login", |root| {
            for force_api in [false, true] {
                for selected in [None, Some("default"), Some("priority")] {
                    let dir = root.join(format!("speed-{force_api}-{selected:?}").replace('"', ""));
                    fs::create_dir_all(&dir).unwrap();
                    let auth = test_codex_chatgpt_auth(
                        "speed@example.invalid",
                        "speed-user",
                        "speed-account",
                    );
                    write_json_pretty(&dir.join("auth.json"), &auth).unwrap();
                    let auth_before = fs::read(dir.join("auth.json")).unwrap();
                    let mut config = "model = \"gpt-6.1-sol\"\n".to_string();
                    if let Some(tier) = selected {
                        config.push_str(&format!("service_tier = \"{tier}\"\n"));
                    }
                    fs::write(dir.join("config.toml"), config).unwrap();
                    let stale = json!({
                        "models": CODEX_FAST_MODELS.map(cached_model),
                    });
                    write_json_pretty(&dir.join("models_cache.json"), &stale).unwrap();
                    let target = CodexDirTarget {
                        dir: dir.clone(),
                        primary: true,
                        source: "fixture",
                    };
                    let plan = CodexModelCatalogPlan {
                        mode: CODEX_MODEL_SELECTION_UPSTREAM.to_string(),
                        source: CODEX_MODEL_CATALOG_SOURCE_UPSTREAM.to_string(),
                        models: CODEX_FAST_MODELS.map(str::to_string).to_vec(),
                        warning: String::new(),
                    };
                    let resolved = resolve_codex_model_catalog(
                        std::slice::from_ref(&target),
                        "gpt-6.1-sol",
                        &plan,
                    )
                    .unwrap();
                    let result = configure_codex_route_targets_with_resolved_catalog(
                        &[target],
                        "synthetic-speed-key",
                        "https://relay.example.invalid/v1",
                        &resolved.model,
                        Some(&resolved.plan),
                        Some(&resolved.catalog),
                        false,
                        None,
                        force_api,
                    )
                    .unwrap();
                    assert_eq!(result[0]["configVerified"], true);
                    let catalog = read_json_if_exists(&dir.join(CODEX_MODEL_CATALOG_FILE))
                        .unwrap()
                        .unwrap();
                    assert_eq!(
                        catalog["models"].as_array().unwrap().len(),
                        CODEX_FAST_MODELS.len(),
                    );
                    for entry in catalog["models"].as_array().unwrap() {
                        assert_fast(entry);
                    }
                    let config = read_text_if_exists(&dir.join("config.toml")).unwrap();
                    assert_eq!(
                        configured_root_value(&config, "service_tier").as_deref(),
                        selected
                    );
                    assert_eq!(
                        configured_root_value(&config, "model").as_deref(),
                        Some("gpt-6.1-sol")
                    );
                    if force_api {
                        assert_eq!(
                            read_json_if_exists(&dir.join("auth.json"))
                                .unwrap()
                                .unwrap()["auth_mode"],
                            "apikey"
                        );
                    } else {
                        assert_eq!(fs::read(dir.join("auth.json")).unwrap(), auth_before);
                    }
                    assert_eq!(
                        read_json_if_exists(&dir.join("models_cache.json"))
                            .unwrap()
                            .unwrap(),
                        stale
                    );
                }
            }
        });
    }
}
