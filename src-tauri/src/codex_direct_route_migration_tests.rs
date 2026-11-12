mod direct_route_migration_regressions {
    use super::*;
    const UPSTREAM: &str = "https://synthetic-relay.example.invalid/v1";
    const KEY: &str = "synthetic-upstream-only";
    const LOCAL_TOKEN: &str = "synthetic-retired-local-only";
    const ENDPOINT: &str = "http://127.0.0.1:59316/v1";

    fn isolated(label: &str, test: impl FnOnce(&Path)) {
        with_temp_user_home(label, |root| {
            let snapshot = CodexDisableOuterStateSnapshot::capture().unwrap();
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| test(root)));
            snapshot.restore().unwrap();
            if let Err(panic) = outcome {
                std::panic::resume_unwind(panic);
            }
        });
    }

    fn router() -> RouterState {
        let mut state = default_router_state();
        state.relay_base_url = UPSTREAM.to_string();
        state.relay_api_key = KEY.to_string();
        state
    }

    fn legacy_state_path() -> PathBuf {
        roaming_app_dir().join("codex-response-recovery.json")
    }

    fn seed_legacy_state() {
        write_json_pretty(
            &legacy_state_path(),
            &json!({
                "version": 1, "enabled": true, "port": 59316, "upstream": UPSTREAM,
                "tokenHash": format!("{:x}", Sha256::digest(LOCAL_TOKEN.as_bytes())),
                "apiKeyHash": format!("{:x}", Sha256::digest(KEY.as_bytes())),
            }),
        )
        .unwrap();
    }

    fn target(root: &Path, name: &str) -> CodexDirTarget {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        CodexDirTarget {
            dir,
            source: "synthetic",
            primary: name == ".codex",
        }
    }

    fn legacy_config() -> String {
        build_codex_direct_config(LOCAL_TOKEN, ENDPOINT, "gpt-5.5")
    }

    #[test]
    fn ordinary_both_login_modes_keep_domain_auth_and_quota_unlock() {
        for force_api_mode in [false, true] {
            isolated("ordinary-domain-login", |root| {
                let homes = [root.join(".codex"), root.join("alternate-codex")];
                std::env::set_var("CODEX_HOME", &homes[1]);
                let account = test_codex_chatgpt_auth(
                    "synthetic@example.invalid",
                    "synthetic-user",
                    "synthetic-account",
                );
                for home in &homes {
                    fs::create_dir_all(home).unwrap();
                    fs::write(home.join("config.toml"), "model = 'gpt-5.5'").unwrap();
                    if !force_api_mode {
                        with_codex_dir(home, || {
                            write_json_pretty(&codex_auth_path(), &account).unwrap();
                            upsert_account(&account, None, true).unwrap();
                        });
                    }
                }
                // A saved 1.6.2 recovery route must not redirect a new login.
                seed_legacy_state();
                let active = if force_api_mode {
                    None
                } else {
                    active_codex_account_snapshot().unwrap()
                };
                let configured = configure_codex_all_route_targets(
                    KEY,
                    UPSTREAM,
                    "gpt-5.5",
                    true,
                    active.as_ref(),
                    force_api_mode,
                )
                .unwrap();
                assert_eq!(configured.len(), 2);
                let state = save_router_state(router()).unwrap();
                let auth_before: Vec<_> = homes
                    .iter()
                    .map(|home| fs::read(home.join("auth.json")).unwrap())
                    .collect();
                for (home, auth) in homes.iter().zip(&auth_before) {
                    let config = fs::read_to_string(home.join("config.toml")).unwrap();
                    assert!(codex_relay_config_verified(
                        &config, KEY, UPSTREAM, "gpt-5.5", None
                    ));
                    assert!(!config.contains(ENDPOINT));
                    assert!(!config.contains(LOCAL_TOKEN));
                    let auth: Value = serde_json::from_slice(auth).unwrap();
                    assert_eq!(
                        auth,
                        if force_api_mode {
                            build_codex_api_auth(KEY)
                        } else {
                            account.clone()
                        }
                    );
                }
                let guard = codex_fuel_runtime_state();
                assert_eq!(guard["enabled"], true);
                assert_eq!(guard["mode"], "relay");
                assert_eq!(guard["baseUrl"], UPSTREAM);
                assert_eq!(guard["conversationRecovery"], false);
                assert_eq!(guard["apiSpeedEnabled"], force_api_mode);
                assert!(json_bool(
                    &codex_router_config_status(UPSTREAM),
                    "relayConfigured"
                ));
                if force_api_mode {
                    select_codex_api_speed(
                        &json!({"speedMode":"fast","model":"gpt-5.5","baseUrl":UPSTREAM}),
                    )
                    .unwrap();
                }
                assert_eq!(
                    codex_direct_route_migration::restore_direct_after_exit(
                        &state,
                        &codex_route_targets(),
                        true,
                    )
                    .unwrap(),
                    0
                );
                for (home, auth) in homes.iter().zip(&auth_before) {
                    assert_eq!(fs::read(home.join("auth.json")).unwrap(), *auth);
                    assert!(!fs::read_to_string(home.join("config.toml"))
                        .unwrap()
                        .contains(ENDPOINT));
                }
                disable_codex_fuel_pack_all_route_targets(KEY, true, None).unwrap();
                let mut official = state;
                official.mode = "official".to_string();
                save_router_state(official).unwrap();
                assert!(!json_bool(&codex_fuel_runtime_state(), "enabled"));
                for home in &homes {
                    let config = fs::read_to_string(home.join("config.toml")).unwrap();
                    assert!(!config.contains(ENDPOINT));
                    assert!(configured_root_value(&config, "model_provider").is_none());
                    let restored = read_json_if_exists(&home.join("auth.json")).unwrap();
                    assert_eq!(
                        restored,
                        if force_api_mode {
                            None
                        } else {
                            Some(account.clone())
                        }
                    );
                }
            });
        }
    }

    #[test]
    fn migrates_all_owned_homes_preserving_auth_history_and_settings() {
        isolated("ordinary-domain-migration", |root| {
            seed_legacy_state();
            let targets = [target(root, ".codex"), target(root, "alternate-codex")];
            let original = format!(
                "{}{}",
                "# keep this setting
service_tier = 'priority'
approval_policy = 'on-request'
",
                legacy_config()
            );
            let auth = br#"{"auth_mode":"chatgpt","synthetic":"preserve-exact-bytes"}"#;
            let history = b"immutable-history-prefix-and-cutoff";
            for target in &targets {
                fs::write(target.dir.join("config.toml"), &original).unwrap();
                fs::write(target.dir.join("auth.json"), auth).unwrap();
                fs::create_dir_all(target.dir.join("sessions")).unwrap();
                fs::write(target.dir.join("sessions/retained.jsonl"), history).unwrap();
            }
            let saved = fs::read(legacy_state_path()).unwrap();
            assert!(codex_direct_route_migration::restore_direct_after_exit(
                &router(),
                &targets,
                false
            )
            .is_err());
            assert_eq!(fs::read(legacy_state_path()).unwrap(), saved);
            for target in &targets {
                assert_eq!(
                    fs::read_to_string(target.dir.join("config.toml")).unwrap(),
                    original
                );
            }
            assert_eq!(
                codex_direct_route_migration::restore_direct_after_exit(&router(), &targets, true)
                    .unwrap(),
                2
            );
            let mut expected = original.parse::<toml_edit::Document>().unwrap();
            expected["model_providers"][CODEX_DIRECT_PROVIDER_ID]["base_url"] =
                toml_edit::value(UPSTREAM);
            expected["model_providers"][CODEX_DIRECT_PROVIDER_ID]["experimental_bearer_token"] =
                toml_edit::value(KEY);
            for target in &targets {
                assert_eq!(
                    fs::read_to_string(target.dir.join("config.toml")).unwrap(),
                    expected.to_string()
                );
                assert_eq!(fs::read(target.dir.join("auth.json")).unwrap(), auth);
                assert_eq!(
                    fs::read(target.dir.join("sessions/retained.jsonl")).unwrap(),
                    history
                );
            }
            assert_eq!(
                read_json_if_exists(&legacy_state_path()).unwrap().unwrap()["enabled"],
                false
            );
            assert_eq!(
                codex_direct_route_migration::restore_direct_after_exit(&router(), &targets, true)
                    .unwrap(),
                0
            );
        });
    }

    #[test]
    fn migration_never_claims_foreign_or_profile_configs() {
        isolated("ordinary-domain-ownership", |root| {
            seed_legacy_state();
            let original = legacy_config();
            let configs = [
                original.replace(LOCAL_TOKEN, "foreign-local-token"),
                original.replace(ENDPOINT, "http://127.0.0.1:59317/v1"),
                original.replace("name = \"Gaoge\"", "name = \"Personal\""),
                format!(
                    "profile = 'personal'
{original}"
                ),
                build_codex_direct_config(
                    "foreign-key",
                    "https://personal.example.invalid/v1",
                    "gpt-5.5",
                ),
            ];
            let t = target(root, ".codex");
            let saved = fs::read(legacy_state_path()).unwrap();
            for config in configs {
                fs::write(t.dir.join("config.toml"), &config).unwrap();
                assert_eq!(
                    codex_direct_route_migration::restore_direct_after_exit(
                        &router(),
                        std::slice::from_ref(&t),
                        true
                    )
                    .unwrap(),
                    0
                );
                assert_eq!(
                    fs::read_to_string(t.dir.join("config.toml")).unwrap(),
                    config
                );
                assert_eq!(fs::read(legacy_state_path()).unwrap(), saved);
            }
        });
    }

    #[test]
    fn migration_requires_matching_saved_upstream_and_credentials() {
        isolated("ordinary-domain-stale-state", |root| {
            seed_legacy_state();
            let t = target(root, ".codex");
            let config = legacy_config();
            fs::write(t.dir.join("config.toml"), &config).unwrap();
            for kind in ["key", "upstream", "official", "official-host", "local-host"] {
                let mut state = router();
                match kind {
                    "key" => state.relay_api_key = "different-upstream-key".to_string(),
                    "upstream" => {
                        state.relay_base_url = "https://other.example.invalid/v1".to_string()
                    }
                    "official" => state.mode = "official".to_string(),
                    "official-host" => {
                        state.relay_base_url = "https://api.openai.com/v1".to_string()
                    }
                    _ => state.relay_base_url = ENDPOINT.to_string(),
                }
                assert_eq!(
                    codex_direct_route_migration::restore_direct_after_exit(
                        &state,
                        std::slice::from_ref(&t),
                        true
                    )
                    .unwrap(),
                    0
                );
                assert_eq!(
                    fs::read_to_string(t.dir.join("config.toml")).unwrap(),
                    config
                );
            }
        });
    }

    #[test]
    fn invalid_later_config_prevents_partial_migration() {
        isolated("ordinary-domain-invalid-config", |root| {
            seed_legacy_state();
            let targets = [target(root, ".codex"), target(root, "alternate-codex")];
            let original = legacy_config();
            fs::write(targets[0].dir.join("config.toml"), &original).unwrap();
            fs::write(
                targets[1].dir.join("config.toml"),
                format!(
                    "{original}
[broken"
                ),
            )
            .unwrap();
            let saved = fs::read(legacy_state_path()).unwrap();
            assert!(codex_direct_route_migration::restore_direct_after_exit(
                &router(),
                &targets,
                true
            )
            .is_err());
            assert_eq!(
                fs::read_to_string(targets[0].dir.join("config.toml")).unwrap(),
                original
            );
            assert_eq!(fs::read(legacy_state_path()).unwrap(), saved);
        });
    }

    #[test]
    fn official_and_aggregate_modes_ignore_invalid_retired_state() {
        isolated("ordinary-domain-inactive-state", |root| {
            let t = target(root, ".codex");
            fs::create_dir_all(roaming_app_dir()).unwrap();
            fs::write(legacy_state_path(), b"invalid retired state").unwrap();
            let config = legacy_config();
            fs::write(t.dir.join("config.toml"), &config).unwrap();
            let mut official = router();
            official.mode = "official".to_string();
            let mut aggregate = router();
            aggregate.relay_base_url = ENDPOINT.to_string();
            for state in [official, aggregate] {
                assert_eq!(
                    codex_direct_route_migration::restore_direct_after_exit(
                        &state,
                        std::slice::from_ref(&t),
                        true,
                    )
                    .unwrap(),
                    0
                );
                assert_eq!(
                    fs::read_to_string(t.dir.join("config.toml")).unwrap(),
                    config
                );
            }
        });
    }

    #[test]
    fn direct_configuration_needs_no_recovery_state_file() {
        isolated("ordinary-domain-no-local-state", |root| {
            let t = target(root, ".codex");
            let config = build_codex_direct_config(KEY, UPSTREAM, "gpt-5.5");
            fs::write(t.dir.join("config.toml"), &config).unwrap();
            assert_eq!(
                codex_direct_route_migration::restore_direct_after_exit(&router(), &[t], true)
                    .unwrap(),
                0
            );
            assert!(!legacy_state_path().exists());
            assert!(codex_relay_config_verified(
                &config, KEY, UPSTREAM, "gpt-5.5", None
            ));
        });
    }
}
