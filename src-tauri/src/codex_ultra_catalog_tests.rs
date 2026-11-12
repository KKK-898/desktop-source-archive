#[test]
fn codex_ultra_catalog_keeps_native_delegation_and_upgrades_known_fallbacks() {
    for model in [
        "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol",
        "gpt-6.1-sol", "gpt-6-astra-2026-09-01", "gaoge/openai/full/gpt-6.1-sol",
    ] {
        let fallback = codex_native_responses_model_entry(model, 0);
        assert_eq!(fallback["multi_agent_version"], "v2", "{model}");
        assert!(fallback["supported_reasoning_levels"].as_array().unwrap()
            .iter().any(|level| level["effort"] == "ultra"), "{model}");
        let mut native = fallback;
        native["multi_agent_version"] = json!("v2");
        native["multi_agent_reasoning_effort"] = json!("xhigh");
        native["model_messages"]["instructions_template"] = json!("Keep native instructions");
        let preserved = sanitize_codex_model_metadata(native.clone(), model).unwrap();
        assert_eq!(preserved["multi_agent_version"], "v2");
        assert_eq!(preserved["multi_agent_reasoning_effort"], "xhigh");
        assert_eq!(preserved["model_messages"]["instructions_template"], "Keep native instructions");
        native["multi_agent_version"] = json!("v1");
        assert_eq!(sanitize_codex_model_metadata(native, model).unwrap()["multi_agent_version"], "v2");
    }
}

#[test]
fn codex_ultra_catalog_does_not_invent_luna_or_unknown_model_support() {
    for model in ["gpt-5.6-luna", "gpt-6-luna", "gpt-6-luna-2026-09-01", "gaoge/openai/full/gpt-6-luna"] {
        let fallback = codex_native_responses_model_entry(model, 0);
        assert!(fallback.get("multi_agent_version").is_none());
        let mut stale = fallback;
        stale["supported_reasoning_levels"].as_array_mut().unwrap()
            .push(json!({"effort":"ultra", "description":"Stale synthetic capability"}));
        stale["default_reasoning_level"] = json!("ultra");
        let repaired = sanitize_codex_model_metadata(stale, model).unwrap();
        let efforts = repaired["supported_reasoning_levels"].as_array().unwrap().iter()
            .map(|level| level["effort"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(efforts, ["low", "medium", "high", "xhigh", "max"], "{model}");
        assert_eq!(repaired["default_reasoning_level"], "medium");
    }
    for model in ["gpt-6-future", "gpt-5.6-unknown", "vendor-model-live"] {
        let mut entry = codex_native_responses_model_entry(model, 0);
        assert!(entry.get("multi_agent_version").is_none());
        assert!(!entry["supported_reasoning_levels"].as_array().unwrap()
            .iter().any(|level| level["effort"] == "ultra"));
        entry["multi_agent_version"] = json!("v2");
        assert_eq!(sanitize_codex_model_metadata(entry, model).unwrap()["multi_agent_version"], "v2");
    }
}

#[test]
fn codex_model_picker_261007_native_catalog_requires_exact_access_rules() {
    let fixture = include_str!("../../scripts/fixtures/codex-model-filter-26.1007.js");
    assert_eq!(codex_native_model_catalog_offsets(fixture.as_bytes()).len(), 1);
    for (original, altered) in [
        ("!t&&c!=null", "t&&c!=null"),
        ("!c.includes(`standard`)", "c.includes(`standard`)"),
        ("i&&!o.hidden", "i&&o.hidden"),
        ("c?.some(e=>e!==`standard`)", "c?.some(e=>e===`standard`)"),
        ("apiKeyDaybreakSupported:t,authMethod:n", "apiKeyDaybreakSupported:n,authMethod:n"),
    ] {
        assert!(fixture.contains(original));
        assert!(codex_native_model_catalog_offsets(fixture.replace(original, altered).as_bytes()).is_empty());
    }
    assert!(codex_native_model_catalog_asset(format!("{fixture}{fixture}").as_bytes()).is_err());
}

#[test]
fn codex_ultra_export_production_catalog_when_requested() {
    let catalog = build_codex_native_responses_catalog(&[
        "gpt-6-astra".to_string(), "gpt-6.1-sol".to_string(), "gpt-6-luna".to_string(),
    ]).unwrap();
    assert_eq!(catalog["models"][0]["multi_agent_version"], "v2");
    if let Ok(path) = std::env::var("CODEX_ULTRA_CATALOG_OUTPUT") {
        write_json_pretty(Path::new(&path), &catalog).unwrap();
    }
}

#[test]
fn codex_ultra_installed_package_when_provided() {
    let Ok(path) = std::env::var("CODEX_ULTRA_ASAR_FIXTURE") else { return; };
    let original = fs::read(path).unwrap();
    let mut patched = original.clone();
    let result = patch_codex_model_picker_bytes(&mut patched).unwrap();
    assert!(result.native_model_catalog);
    assert!(result.ultra_reasoning_patched);
    assert!(result.changed);
    assert!(patched.len() > original.len());
    let once = patched.clone();
    assert!(!patch_codex_model_picker_bytes(&mut patched).unwrap().changed);
    assert_eq!(patched, once);
    if let Ok(output) = std::env::var("CODEX_ULTRA_ASAR_OUTPUT") {
        let output = Path::new(&output);
        ensure_parent(output).unwrap();
        fs::write(output, patched).unwrap();
    }
}

#[test]
fn aggregate_reasoning_recovers_known_gpt_ceiling_after_native_overlay() {
    for (model, ceiling) in [("gpt-6-astra", "ultra"), ("gpt-6.1-sol", "ultra"),
        ("gpt-5.6-sol", "ultra"), ("gpt-6-luna", "max"), ("gpt-5.5", "xhigh")] {
        for custom in [false, true] {
            let mut route = aggregate_test_route("openai", model);
            if custom {
                route.source = aggregate_settings::AggregateSource::Custom;
                route.public_model = format!("gaoge/custom/openai/1/{model}");
            }
            let native = json!({"context_window":160_000,"input_modalities":["text"],
                "service_tiers":[],"default_reasoning_level":"max",
                "supported_reasoning_levels":[{"effort":"high"},{"effort":"max","description":"Keep native description"}]});
            let metadata = HashMap::from([(model.to_owned(), native)]);
            let entry = aggregate_model_entry(&route, 0, &metadata);
            let efforts = entry["supported_reasoning_levels"].as_array().unwrap();
            assert_eq!(efforts.last().unwrap()["effort"], ceiling, "{model} custom={custom}");
            assert_eq!(entry["context_window"], 160_000);
            assert_eq!(entry["input_modalities"], json!(["text"]));
            assert!(!aggregate_entry_supports_fast(&entry));
            assert_eq!(entry["slug"], route.public_model);
            assert_eq!(entry["gaoge_aggregate_upstream_model"], model);
            if ceiling != "xhigh" {
                assert_eq!(efforts.iter().find(|level| level["effort"] == "max").unwrap()["description"], "Keep native description");
            }
            let final_catalog = build_codex_native_responses_catalog_with_metadata(
                &[route.public_model.clone()], &HashMap::from([(route.public_model.clone(), entry.clone())])).unwrap();
            assert_eq!(final_catalog["models"][0], entry);
        }
    }
}

#[test]
fn aggregate_reasoning_preserves_explicit_nonreasoning_and_exact_vendor_ceiling() {
    let route = aggregate_test_route("openai", "gpt-6-astra");
    for levels in [json!([]), json!([{"effort":"none"}])] {
        let metadata = HashMap::from([("gpt-6-astra".to_owned(), json!({
            "supported_reasoning_levels":levels,"default_reasoning_level":"none"}))]);
        let entry = aggregate_model_entry(&route, 0, &metadata);
        assert_eq!(entry["supported_reasoning_levels"], levels);
        assert!(!entry["supported_reasoning_levels"].as_array().unwrap().iter().any(|level| level["effort"] == "ultra"));
    }
    for (provider, model, ceiling) in [("deepseek", "deepseek-v4-pro", "max"),
        ("kimi", "kimi-k3", "max"), ("glm", "glm-5.3", "max"),
        ("anthropic", "claude-opus-4-8", "max"), ("grok", "grok-4.7", "xhigh")] {
        let route = aggregate_test_route(provider, model);
        let entry = aggregate_model_entry(&route, 0, &HashMap::new());
        let levels = entry["supported_reasoning_levels"].as_array().unwrap();
        assert_eq!(levels.last().unwrap()["effort"], ceiling, "{model}");
        assert!(!levels.iter().any(|level| level["effort"] == "ultra"), "{model}");
        let restricted = json!([{"effort":"low"},{"effort":"high"}]);
        let entry = aggregate_model_entry(&route, 0, &HashMap::from([(model.to_owned(),
            json!({"supported_reasoning_levels":restricted,"default_reasoning_level":"high"}))]));
        assert_eq!(entry["supported_reasoning_levels"], restricted, "{model}");
    }
}

#[test]
fn aggregate_reasoning_identity_distinguishes_collision_routes_and_namespaced_upstreams() {
    let mut collision = aggregate_test_route("openai", "gpt-6-astra");
    collision.source = aggregate_settings::AggregateSource::Custom;
    collision.public_model = "gaoge/custom/openai/1/gpt-6-astra".to_owned();
    let entry = aggregate_model_entry(&collision, 0, &HashMap::new());
    assert_eq!(canonical_codex_catalog_entry_model_name(&entry, &collision.public_model, &[]), "gpt-6-astra");
    let mut legacy = entry.clone();
    legacy.as_object_mut().unwrap().remove("gaoge_aggregate_upstream_model");
    assert_eq!(canonical_codex_catalog_entry_model_name(&legacy, &collision.public_model, &[collision.clone()]), "gpt-6-astra");
    assert_eq!(canonical_codex_catalog_entry_model_name(&legacy, &collision.public_model, &[]), "1/gpt-6-astra");

    let mut named_custom = aggregate_test_route("custom", "1/gpt-6-astra");
    named_custom.group_id = "openai".to_owned();
    named_custom.public_model = collision.public_model.clone();
    named_custom.source = aggregate_settings::AggregateSource::Custom;
    let custom_entry = aggregate_model_entry(&named_custom, 0, &HashMap::new());
    assert_eq!(canonical_codex_catalog_entry_model_name(&custom_entry, &named_custom.public_model, &[]), "1/gpt-6-astra");
    assert_eq!(canonical_codex_catalog_entry_model_name(&entry, &named_custom.public_model, &[named_custom.clone()]), "1/gpt-6-astra");
    assert_eq!(canonical_codex_catalog_model_name("gaoge/custom/group/gpt-6-astra"), "gpt-6-astra");
    assert_eq!(canonical_codex_catalog_model_name("gaoge/custom/group/vendor/route/gpt-6-astra"), "vendor/route/gpt-6-astra");
    let mut inconsistent = entry;
    inconsistent["gaoge_aggregate_group_id"] = json!("other");
    assert_eq!(canonical_codex_catalog_entry_model_name(&inconsistent, &collision.public_model, &[]), "1/gpt-6-astra");
}
