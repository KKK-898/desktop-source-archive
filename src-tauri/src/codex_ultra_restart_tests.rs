fn ultra_restart_fixture(root: &Path) -> (PathBuf, PathBuf, RouterState, AggregateLoginState) {
    let directory = root.join("owned-codex");
    fs::create_dir_all(&directory).unwrap();
    let config_path = directory.join("config.toml");
    let catalog_path = directory.join(CODEX_MODEL_CATALOG_FILE);
    let mut router = default_router_state();
    router.mode = "relay".to_string();
    router.relay_base_url = "https://relay.example.invalid/v1".to_string();
    router.relay_api_key = "ultra-restart-fixture-key".to_string();
    let config = build_codex_direct_config_with_catalog(
        &router.relay_api_key, &router.relay_base_url, "gpt-6-astra", Some(&catalog_path), Some("high"),
    );
    fs::write(&config_path, format!("{config}\n[desktop]\nshow-ultra-in-model-picker-slider = false\nappearanceTheme = \"dark\"\n")).unwrap();
    let mut known = codex_native_responses_model_entry("gpt-6-astra", 0);
    known["supported_reasoning_levels"] = json!([{ "effort": "high", "description": "preserve description" }]);
    known["multi_agent_version"] = json!("v1");
    known["custom_metadata"] = json!({"keep": true});
    let unknown = json!({"slug": "future-model", "supported_reasoning_levels": [{"effort": "future"}], "multi_agent_version": "v3"});
    write_json_pretty(&catalog_path, &json!({"models": [known, unknown], "custom_root": "keep"})).unwrap();
    (config_path, catalog_path, router, default_aggregate_login_state())
}

#[test]
fn ultra_restart_repairs_only_reasoning_metadata_and_is_idempotent() {
    with_temp_user_home("ultra-restart-repair", |root| {
        let (config_path, catalog_path, router, aggregate) = ultra_restart_fixture(root);
        let original: Value = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        let result = repair_codex_managed_ultra_target(&config_path, &router, &aggregate, false).unwrap().unwrap();
        assert_eq!(result["changed"], true);
        let config = fs::read_to_string(&config_path).unwrap();
        assert!(config.contains("show-ultra-in-model-picker-slider = true"));
        assert!(config.contains("appearanceTheme = \"dark\""));
        assert_eq!(configured_root_value(&config, "model_reasoning_effort").as_deref(), Some("high"));
        let catalog: Value = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        assert_eq!(catalog["models"][0]["multi_agent_version"], "v2");
        assert!(catalog["models"][0]["supported_reasoning_levels"].as_array().unwrap().iter().any(|level| level["effort"] == "ultra"));
        assert_eq!(catalog["models"][0]["custom_metadata"], original["models"][0]["custom_metadata"]);
        assert_eq!(catalog["models"][1], original["models"][1]);
        assert_eq!(catalog["custom_root"], original["custom_root"]);
        let once = fs::read(&catalog_path).unwrap();
        let second = repair_codex_managed_ultra_target(&config_path, &router, &aggregate, false).unwrap().unwrap();
        assert_eq!(second["changed"], false);
        assert_eq!(fs::read(&catalog_path).unwrap(), once);
        assert_eq!(fs::read_to_string(&config_path).unwrap(), config);
    });
}

#[test]
fn ultra_restart_rejects_official_profiles_and_same_name_unowned_routes() {
    with_temp_user_home("ultra-restart-ownership", |root| {
        let (config_path, catalog_path, router, aggregate) = ultra_restart_fixture(root);
        let original = fs::read_to_string(&config_path).unwrap();
        let original_catalog = fs::read(&catalog_path).unwrap();
        for candidate in [
            original.replace("model_provider = \"custom\"", "model_provider = \"openai\""),
            original.replace("ultra-restart-fixture-key", "personal-token"),
            original.replace("relay.example.invalid", "personal.example.invalid"),
            format!("profile = \"personal\"\n{original}"),
        ] {
            fs::write(&config_path, &candidate).unwrap();
            assert!(repair_codex_managed_ultra_target(&config_path, &router, &aggregate, false).unwrap().is_none());
            assert_eq!(fs::read_to_string(&config_path).unwrap(), candidate);
            assert_eq!(fs::read(&catalog_path).unwrap(), original_catalog);
        }
    });
}

#[test]
fn ultra_restart_rejects_catalogs_outside_owned_config_directory() {
    with_temp_user_home("ultra-restart-catalog-path", |root| {
        let (config_path, catalog_path, router, aggregate) = ultra_restart_fixture(root);
        let original = fs::read_to_string(&config_path).unwrap();
        let external = root.join(CODEX_MODEL_CATALOG_FILE);
        fs::copy(&catalog_path, &external).unwrap();
        let before = fs::read(&external).unwrap();
        let candidate = original.replace(&escape_toml(&catalog_path.to_string_lossy()), &escape_toml(&external.to_string_lossy()));
        fs::write(&config_path, &candidate).unwrap();
        assert!(repair_codex_managed_ultra_target(&config_path, &router, &aggregate, false).unwrap().is_none());
        assert_eq!(fs::read(&external).unwrap(), before);
        assert_eq!(fs::read_to_string(&config_path).unwrap(), candidate);
    });
}

#[test]
fn ultra_restart_does_not_write_config_when_owned_catalog_is_invalid() {
    with_temp_user_home("ultra-restart-invalid", |root| {
        let (config_path, catalog_path, router, aggregate) = ultra_restart_fixture(root);
        let before = fs::read(&config_path).unwrap();
        fs::write(&catalog_path, "invalid catalog").unwrap();
        assert!(repair_codex_managed_ultra_target(&config_path, &router, &aggregate, false).is_err());
        assert_eq!(fs::read(&config_path).unwrap(), before);
        assert_eq!(fs::read_to_string(&catalog_path).unwrap(), "invalid catalog");
    });
}

#[test]
fn ultra_restart_warning_merge_preserves_distinct_patch_and_launch_failures() {
    let mut launch = json!({"warnings": ["launch warning"]});
    append_codex_result_warnings(&mut launch, &json!({"warnings": ["catalog warning", "launch warning", ""]}));
    assert_eq!(launch["warnings"], json!(["launch warning", "catalog warning"]));
}

#[test]
fn ultra_restart_native_catalog_keeps_original_target_and_legacy_patch_binds_target() {
    with_temp_user_home("ultra-restart-launch-path", |root| {
        let app_dir = root.join("patched-client");
        let resources = app_dir.join("resources");
        fs::create_dir_all(&resources).unwrap();
        fs::write(app_dir.join("Codex.exe"), "fixture only").unwrap();
        fs::write(resources.join("app.asar"), "fixture only").unwrap();
        let mut patch = json!({"applied": true, "method": "native-model-catalog", "resourcesDir": resources.to_string_lossy()});
        assert!(codex_model_patch_launch_target(&patch).is_none());
        patch["method"] = json!("asar-byte");
        assert_eq!(codex_model_patch_launch_target(&patch), Some(app_dir));
        patch["applied"] = json!(false);
        assert!(codex_model_patch_launch_target(&patch).is_none());
    });
}

#[test]
fn ultra_restart_runtime_hint_survives_minifier_changes_without_certifying_native_support() {
    assert!(codex_native_catalog_runtime_hint(b"differentVariable.hasConfiguredModelCatalog;query(\"model/list\");"));
    assert!(!codex_native_catalog_runtime_hint(b"hasConfiguredModelCatalog"));
    assert!(!codex_native_catalog_runtime_hint(b"model/list"));
    assert!(codex_native_model_catalog_asset(b"differentVariable.hasConfiguredModelCatalog;query(\"model/list\");").unwrap().is_none());
}

#[test]
fn ultra_restart_runtime_verification_expires_across_restart_and_route_changes() {
    with_temp_user_home("ultra-restart-runtime-scope", |root| {
        struct RestoreRuntimeState(RouterState, AggregateLoginState);
        impl Drop for RestoreRuntimeState {
            fn drop(&mut self) {
                *ROUTER_STATE.lock().unwrap() = self.0.clone();
                *AGGREGATE_LOGIN_STATE.lock().unwrap() = self.1.clone();
                codex_ultra_runtime::reset();
            }
        }
        let _restore = RestoreRuntimeState(
            ROUTER_STATE.lock().unwrap().clone(),
            AGGREGATE_LOGIN_STATE.lock().unwrap().clone(),
        );
        let (config_path, _, router, aggregate) = ultra_restart_fixture(root);
        // with_temp_user_home restores CODEX_HOME even when this assertion scope
        // unwinds. All config, catalog, and saved route writes stay under root.
        std::env::set_var("CODEX_HOME", config_path.parent().unwrap());
        *AGGREGATE_LOGIN_STATE.lock().unwrap() = aggregate.clone();
        save_router_state(router.clone()).unwrap();
        repair_codex_managed_ultra_target(&config_path, &router, &aggregate, false).unwrap().unwrap();
        codex_ultra_runtime::reset();
        let expected = codex_ultra_runtime::state();
        assert_eq!(expected["enabled"], true);
        let revision = current_codex_runtime_revision();
        let verified = json!({
            "enabled": true, "scopeKey": expected["scopeKey"],
            "version": codex_ultra_runtime::version(), "healthy": true,
            "ready": true, "verified": true, "needsReinstall": false,
            "reason": "ready", "error": "",
        });
        codex_ultra_runtime::record(&verified, revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], true);
        codex_ultra_runtime::reset();
        assert_eq!(current_codex_runtime_revision(), revision);
        assert_ne!(codex_ultra_runtime::state()["scopeKey"], expected["scopeKey"]);
        codex_ultra_runtime::record(&verified, revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], false);
        let personal = fs::read_to_string(&config_path).unwrap()
            .replace("ultra-restart-fixture-key", "personal-route-key");
        fs::write(&config_path, personal).unwrap();
        assert_eq!(codex_ultra_runtime::state()["enabled"], false);
        assert_eq!(codex_ultra_runtime::status()["verified"], false);
    });
}


#[test]
fn ultra_restart_target_source_and_disconnect_reject_delayed_success_without_writes() {
    with_temp_user_home("ultra-target-lifecycle", |root| {
        struct RestoreRuntimeState(RouterState, AggregateLoginState);
        impl Drop for RestoreRuntimeState {
            fn drop(&mut self) {
                *ROUTER_STATE.lock().unwrap() = self.0.clone();
                *AGGREGATE_LOGIN_STATE.lock().unwrap() = self.1.clone();
                codex_ultra_runtime::reset();
            }
        }
        let _restore = RestoreRuntimeState(ROUTER_STATE.lock().unwrap().clone(),
            AGGREGATE_LOGIN_STATE.lock().unwrap().clone());
        let (config_path, catalog_path, router, aggregate) = ultra_restart_fixture(root);
        std::env::set_var("CODEX_HOME", config_path.parent().unwrap());
        *AGGREGATE_LOGIN_STATE.lock().unwrap() = aggregate.clone();
        save_router_state(router.clone()).unwrap();
        repair_codex_managed_ultra_target(&config_path, &router, &aggregate, false).unwrap().unwrap();
        let config_before = fs::read(&config_path).unwrap();
        let catalog_before = fs::read(&catalog_path).unwrap();
        codex_ultra_runtime::reset();
        let revision = current_codex_runtime_revision();
        let ready = || json!({"enabled":true,"scopeKey":codex_ultra_runtime::state()["scopeKey"],
            "version":codex_ultra_runtime::version(),"healthy":true,"ready":true,"verified":true,
            "needsReinstall":false,"reason":"ready","error":""});
        assert!(codex_ultra_runtime::observe_target("ws://127.0.0.1:1/page/first", "file:///old/app.html"));
        let first = ready();
        codex_ultra_runtime::record(&first, revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], true);
        assert!(!codex_ultra_runtime::observe_target("ws://127.0.0.1:1/page/first", "file:///old/app.html"));
        assert_eq!(codex_ultra_runtime::status()["verified"], true);

        // Upgrade navigation can retain its websocket but change document source.
        assert!(codex_ultra_runtime::observe_target("ws://127.0.0.1:1/page/first", "file:///new/app.html"));
        codex_ultra_runtime::record(&first, revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], false);
        let second = ready();
        codex_ultra_runtime::record(&second, revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], true);
        codex_ultra_runtime::source_unavailable(revision);
        let source_scope = codex_ultra_runtime::state()["scopeKey"].clone();
        codex_ultra_runtime::source_unavailable(revision);
        assert_eq!(codex_ultra_runtime::state()["scopeKey"], source_scope);
        codex_ultra_runtime::record(&second, revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], false);

        let third = ready();
        codex_ultra_runtime::record(&third, revision);
        codex_ultra_runtime::disconnected();
        let disconnected_scope = codex_ultra_runtime::state()["scopeKey"].clone();
        codex_ultra_runtime::disconnected();
        assert_eq!(codex_ultra_runtime::state()["scopeKey"], disconnected_scope);
        codex_ultra_runtime::record(&third, revision);
        let unavailable = codex_ultra_runtime::status();
        assert_eq!(unavailable["verified"], false);
        assert_eq!(unavailable["reason"], "connection-unavailable");
        assert_eq!(unavailable["connectionState"], "disconnected");
        assert!(codex_ultra_runtime::observe_target("ws://127.0.0.1:1/page/second", "file:///new/app.html"));
        codex_ultra_runtime::record(&third, revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], false);
        let current = ready();
        codex_ultra_runtime::record(&current, revision);
        codex_ultra_runtime::source_unavailable(revision.wrapping_add(1));
        assert_eq!(codex_ultra_runtime::status()["verified"], true);
        codex_ultra_runtime::record(&json!({"ready":true,"verified":true}), revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], false);
        codex_ultra_runtime::record(&current, revision);
        assert_eq!(codex_ultra_runtime::status()["verified"], false);
        codex_ultra_runtime::record(&ready(), revision);
        let recovered = codex_ultra_runtime::status();
        assert_eq!(recovered["verified"], true);
        assert_eq!(recovered["observationFresh"], true);
        assert_eq!(recovered["connectionState"], "connected");
        assert!(!recovered.to_string().contains("file:///"));
        assert!(!recovered.to_string().contains("127.0.0.1"));
        assert_eq!(fs::read(&config_path).unwrap(), config_before);
        assert_eq!(fs::read(&catalog_path).unwrap(), catalog_before);
    });
}
