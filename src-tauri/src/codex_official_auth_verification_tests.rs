// All credentials and homes in these tests are synthetic and isolated.
#[test]
fn official_auth_write_check_rejects_changed_identity_before_restore_cleanup() {
    with_temp_user_home("official-write-check", |_root| {
        let original = test_codex_chatgpt_auth("before@example.test", "before", "before");
        write_json_pretty(&codex_auth_path(), &original).unwrap();
        configure_codex_all_route_targets(
            "relay-key",
            GAOGE_OPENAI_BASE_URL,
            "gpt-5.5",
            true,
            None,
            true,
        )
        .unwrap();
        let before_auth = fs::read(codex_auth_path()).unwrap();
        let before_config = fs::read(codex_config_path()).unwrap();
        let artifacts: Vec<_> = codex_relay_restore::artifact_paths()
            .into_iter()
            .map(|path| {
                let bytes = fs::read(&path).ok();
                (path, bytes)
            })
            .collect();
        let other = test_codex_chatgpt_auth("other@example.test", "other", "other");
        let result = run_codex_relay_close_transaction(
            &codex_config_path(),
            &String::from_utf8(before_config.clone()).unwrap(),
            "",
            "relay-key",
            None,
            || write_json_pretty(&codex_auth_path(), &other),
        );
        assert!(
            result.is_err(),
            "must not delete recovery evidence after a failed identity read-back"
        );
        assert_eq!(fs::read(codex_auth_path()).unwrap(), before_auth);
        assert_eq!(fs::read(codex_config_path()).unwrap(), before_config);
        for (path, bytes) in artifacts {
            assert_eq!(fs::read(path).ok(), bytes);
        }
    });
}

fn official_auth_verification_fixture() -> (Value, String, Value) {
    let auth =
        test_codex_chatgpt_auth("official@example.test", "official-user", "official-account");
    write_json_pretty(&codex_auth_path(), &auth).unwrap();
    let entry = upsert_account(&auth, None, true).unwrap();
    let key = json_str(&entry, "accountKey");
    let cleanup = json!({"restored": true, "expectedAccountKey": key, "restoredAccountKey": key});
    (auth, key, cleanup)
}

fn official_auth_verification_bytes() -> Vec<(PathBuf, Option<Vec<u8>>)> {
    let mut paths = vec![
        codex_auth_path(),
        codex_registry_path(),
        codex_config_path(),
    ];
    paths.extend(codex_relay_restore::artifact_paths());
    if let Ok(entries) = fs::read_dir(codex_snapshots_dir()) {
        paths.extend(entries.flatten().map(|entry| entry.path()));
    }
    paths
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path).ok();
            (path, bytes)
        })
        .collect()
}

fn assert_official_auth_verification_read_only(before: Vec<(PathBuf, Option<Vec<u8>>)>) {
    for (path, bytes) in before {
        assert!(
            fs::read(&path).ok() == bytes,
            "verification mutated isolated credential state"
        );
    }
}

#[test]
fn official_auth_verify_exact_identity_only_confirms_local_persisted_auth() {
    with_temp_user_home("official-verify-exact", |_| {
        let (_, key, cleanup) = official_auth_verification_fixture();
        let before = official_auth_verification_bytes();
        let result = codex_official_auth_verification::verify_current(
            &cleanup,
            &json!({"launchConfirmed": true}),
        );
        assert_eq!(result["status"], "verified");
        assert_eq!(result["reason"], "local-official-auth-matched");
        assert_eq!(result["expectedAccountKey"], key);
        assert_eq!(result["scope"], "local-auth-file");
        assert_eq!(result["nativeSessionVerified"], false);
        assert_eq!(result["checkedAfterLaunch"], true);
        assert_eq!(result["codexDir"], codex_dir().to_string_lossy().as_ref());
        assert_official_auth_verification_read_only(before);
    });
}

#[test]
fn official_auth_verify_rejects_missing_wrong_api_and_mixed_credentials() {
    for (kind, reason) in [
        ("missing", "auth-missing"),
        ("malformed", "auth-read-failed"),
        ("wrong", "account-mismatch"),
        ("api", "not-official-account"),
        ("mixed", "not-official-account"),
    ] {
        with_temp_user_home("official-verify-bad-auth", |_| {
            let (mut auth, key, cleanup) = official_auth_verification_fixture();
            match kind {
                "missing" => fs::remove_file(codex_auth_path()).unwrap(),
                "malformed" => fs::write(codex_auth_path(), "not a JSON document").unwrap(),
                "wrong" => write_json_pretty(
                    &codex_auth_path(),
                    &test_codex_chatgpt_auth("other@example.test", "other-user", "other-account"),
                )
                .unwrap(),
                "api" => write_json_pretty(
                    &codex_auth_path(),
                    &build_codex_api_auth("synthetic-api-key"),
                )
                .unwrap(),
                "mixed" => {
                    auth["OPENAI_API_KEY"] = json!("synthetic-mixed-key");
                    write_json_pretty(&codex_auth_path(), &auth).unwrap();
                }
                _ => unreachable!(),
            }
            let before = official_auth_verification_bytes();
            let result = codex_official_auth_verification::verify_current(
                &cleanup,
                &json!({"launchConfirmed": true}),
            );
            assert_eq!(result["status"], "failed", "{kind}");
            assert_eq!(result["reason"], reason, "{kind}");
            assert_eq!(result["expectedAccountKey"], key);
            assert_eq!(result["nativeSessionVerified"], false);
            assert_official_auth_verification_read_only(before);
        });
    }
}

#[test]
fn official_auth_verify_rejects_auth_and_registry_read_errors() {
    for kind in ["auth", "registry"] {
        with_temp_user_home("official-verify-read-error", |_| {
            let (_, _, cleanup) = official_auth_verification_fixture();
            let path = if kind == "auth" {
                codex_auth_path()
            } else {
                codex_registry_path()
            };
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
            let before = official_auth_verification_bytes();
            let result = codex_official_auth_verification::verify_current(
                &cleanup,
                &json!({"launchConfirmed": true}),
            );
            assert_eq!(result["status"], "failed");
            assert_eq!(result["reason"], format!("{kind}-read-failed"));
            assert!(
                path.is_dir(),
                "read failure must not replace the blocked path"
            );
            assert_official_auth_verification_read_only(before);
        });
    }
}

#[test]
fn official_auth_verify_rejects_registry_active_mismatch() {
    for active in ["", "unrelated-saved-account"] {
        with_temp_user_home("official-verify-registry-mismatch", |_| {
            let (_, key, cleanup) = official_auth_verification_fixture();
            set_registry_active_account(active).unwrap();
            let before = official_auth_verification_bytes();
            let result = codex_official_auth_verification::verify_current(
                &cleanup,
                &json!({"launchConfirmed": true}),
            );
            assert_eq!(result["status"], "failed");
            assert_eq!(result["reason"], "active-account-mismatch");
            assert_eq!(result["expectedAccountKey"], key);
            assert_official_auth_verification_read_only(before);
        });
    }
}

#[test]
fn official_auth_verify_rejects_expired_unrefreshable_official_tokens() {
    for missing_access in [false, true] {
        with_temp_user_home("official-verify-expired", |_| {
            let (_, _, cleanup) = official_auth_verification_fixture();
            let mut expired = test_codex_chatgpt_auth_with_exp(
                "official@example.test",
                "official-user",
                "official-account",
                unix_now() - 3600,
                false,
            );
            if missing_access {
                expired["tokens"]
                    .as_object_mut()
                    .unwrap()
                    .remove("access_token");
            }
            write_json_pretty(&codex_auth_path(), &expired).unwrap();
            let before = official_auth_verification_bytes();
            let result = codex_official_auth_verification::verify_current(
                &cleanup,
                &json!({"launchConfirmed": true}),
            );
            assert_eq!(result["status"], "failed");
            assert_eq!(result["reason"], "official-auth-unrecoverable");
            assert_official_auth_verification_read_only(before);
        });
    }
}

#[test]
fn official_auth_verify_keeps_refreshable_opaque_and_near_expiry_credentials() {
    for kind in ["refreshable", "opaque", "near-expiry"] {
        with_temp_user_home("official-verify-usable", |_| {
            let (_, key, cleanup) = official_auth_verification_fixture();
            let mut usable = test_codex_chatgpt_auth_with_exp(
                "official@example.test",
                "official-user",
                "official-account",
                if kind == "refreshable" {
                    unix_now() - 3600
                } else {
                    unix_now() + 90
                },
                kind == "refreshable",
            );
            if kind == "opaque" {
                usable["tokens"]["access_token"] = json!("synthetic-opaque-token");
            }
            write_json_pretty(&codex_auth_path(), &usable).unwrap();
            mark_codex_account_requires_reauth(&key, "synthetic temporary network failure")
                .unwrap();
            let before = official_auth_verification_bytes();
            let result = codex_official_auth_verification::verify_current(
                &cleanup,
                &json!({"launchConfirmed": true}),
            );
            assert_eq!(result["status"], "verified", "{kind}");
            assert_eq!(result["nativeSessionVerified"], false);
            assert_official_auth_verification_read_only(before);
        });
    }
}

#[test]
fn official_auth_verify_waits_for_launch_confirmation() {
    with_temp_user_home("official-verify-launch", |_| {
        let (_, _, cleanup) = official_auth_verification_fixture();
        for (launch, reason) in [
            (
                json!({"launchQueued": true, "launchConfirmed": false}),
                "launch-queued",
            ),
            (
                json!({"launchAccepted": true, "launchConfirmed": false}),
                "launch-queued",
            ),
            (
                json!({"launchQueued": true, "launchConfirmed": true}),
                "launch-queued",
            ),
            (json!({"launchConfirmed": false}), "launch-not-confirmed"),
            (json!({}), "launch-not-confirmed"),
        ] {
            let before = official_auth_verification_bytes();
            let result = codex_official_auth_verification::verify_current(&cleanup, &launch);
            assert_eq!(result["status"], "pending");
            assert_eq!(result["reason"], reason);
            assert_eq!(result["checkedAfterLaunch"], false);
            assert_eq!(result["nativeSessionVerified"], false);
            assert_official_auth_verification_read_only(before);
        }
    });
}

#[test]
fn official_auth_verify_preserves_original_expected_key_when_other_account_is_retained() {
    for reason in [
        "preserved_current_auth_after_missing_official_auth",
        "preserved_current_auth_after_invalid_official_auth",
    ] {
        with_temp_user_home("official-verify-lost-original", |_| {
            let (_, original_key, _) = official_auth_verification_fixture();
            let other =
                test_codex_chatgpt_auth("other@example.test", "other-user", "other-account");
            write_json_pretty(&codex_auth_path(), &other).unwrap();
            let other_key = json_str(&upsert_account(&other, None, true).unwrap(), "accountKey");
            let cleanup = json!({"restored": false, "reason": reason, "expectedAccountKey": original_key, "restoredAccountKey": other_key});
            let before = official_auth_verification_bytes();
            let result = codex_official_auth_verification::verify_current(
                &cleanup,
                &json!({"launchConfirmed": true}),
            );
            assert_eq!(result["status"], "failed");
            assert_eq!(result["reason"], "original-account-unavailable");
            assert_eq!(result["expectedAccountKey"], original_key);
            assert_ne!(result["expectedAccountKey"], other_key);
            assert_official_auth_verification_read_only(before);
        });
    }
}

#[test]
fn official_auth_verify_rejects_unrestored_account_despite_matching_current_identity() {
    with_temp_user_home("official-verify-not-restored", |_| {
        let (_, key, mut cleanup) = official_auth_verification_fixture();
        cleanup["restored"] = json!(false);
        let before = official_auth_verification_bytes();
        let result = codex_official_auth_verification::verify_current(
            &cleanup,
            &json!({"launchConfirmed": true}),
        );
        assert_eq!(result["status"], "failed");
        assert_eq!(result["reason"], "original-account-not-restored");
        assert_eq!(result["expectedAccountKey"], key);
        assert_official_auth_verification_read_only(before);
    });
}

#[test]
fn official_auth_verify_signed_out_never_selects_saved_account() {
    with_temp_user_home("official-verify-signed-out", |_| {
        let (saved, _, _) = official_auth_verification_fixture();
        fs::remove_file(codex_auth_path()).unwrap();
        set_registry_active_account("").unwrap();
        assert!(snapshot_path_for_key(&auth_account_key(&saved)).exists());
        let before = official_auth_verification_bytes();
        let cleanup =
            json!({"removed": true, "restored": false, "reason": "restored_pre_login_signed_out"});
        let result = codex_official_auth_verification::verify_current(
            &cleanup,
            &json!({"launchConfirmed": true}),
        );
        assert_eq!(result["status"], "not-required");
        assert_eq!(result["reason"], "originally-signed-out");
        assert!(result["expectedAccountKey"].is_null());
        assert!(!codex_auth_path().exists());
        assert_eq!(read_registry().unwrap()["activeAccountKey"], "");
        assert_official_auth_verification_read_only(before);
    });
}

#[test]
fn official_auth_verify_rejects_signed_out_state_that_reacquires_identity() {
    for auth_exists in [false, true] {
        with_temp_user_home("official-verify-signed-out-mismatch", |_| {
            let (_, _, _) = official_auth_verification_fixture();
            if auth_exists {
                set_registry_active_account("").unwrap();
            } else {
                fs::remove_file(codex_auth_path()).unwrap();
            }
            let before = official_auth_verification_bytes();
            let result = codex_official_auth_verification::verify_current(
                &json!({"removed": true, "restored": false, "reason": "restored_pre_login_signed_out"}),
                &json!({"launchConfirmed": true}),
            );
            assert_eq!(result["status"], "failed");
            assert_eq!(result["reason"], "signed-out-state-mismatch");
            assert_official_auth_verification_read_only(before);
        });
    }
}

#[test]
fn official_auth_verify_does_not_rewrite_auth_after_native_identity_changes() {
    with_temp_user_home("official-verify-native-change", |_| {
        let (_, key, cleanup) = official_auth_verification_fixture();
        assert_eq!(
            codex_official_auth_verification::verify_current(
                &cleanup,
                &json!({"launchConfirmed": true})
            )["status"],
            "verified"
        );
        let other = test_codex_chatgpt_auth(
            "new-native@example.test",
            "new-native-user",
            "new-native-account",
        );
        write_json_pretty(&codex_auth_path(), &other).unwrap();
        upsert_account(&other, None, true).unwrap();
        let before = official_auth_verification_bytes();
        let result = codex_official_auth_verification::verify_current(
            &cleanup,
            &json!({"launchConfirmed": true}),
        );
        assert_eq!(result["status"], "failed");
        assert_eq!(result["expectedAccountKey"], key);
        assert_eq!(result["reason"], "account-mismatch");
        assert_official_auth_verification_read_only(before);
    });
}

#[test]
fn official_auth_verify_targets_fails_when_secondary_disagrees() {
    with_temp_user_home("official-verify-secondary-failed", |root| {
        let primary = codex_dir();
        let secondary = root.join("secondary-home");
        let (_, _, primary_cleanup) = official_auth_verification_fixture();
        let secondary_cleanup = with_codex_dir(&secondary, || {
            let (_, _, cleanup) = official_auth_verification_fixture();
            write_json_pretty(
                &codex_auth_path(),
                &build_codex_api_auth("synthetic-secondary-api"),
            )
            .unwrap();
            cleanup
        });
        let primary_before = official_auth_verification_bytes();
        let secondary_before = with_codex_dir(&secondary, official_auth_verification_bytes);
        let mut targets = vec![
            json!({"codexDir": primary, "authCleanup": primary_cleanup}),
            json!({"codexDir": secondary, "authCleanup": secondary_cleanup}),
        ];
        let result = codex_official_auth_verification::verify_targets(
            &mut targets,
            &json!({"launchConfirmed": true}),
        );
        assert_eq!(targets[0]["authVerification"]["status"], "verified");
        assert_eq!(targets[1]["authVerification"]["status"], "failed");
        assert_eq!(result["status"], "failed");
        assert_eq!(result["reason"], "secondary-target-verification-failed");
        assert_eq!(result["nativeSessionVerified"], false);
        assert_official_auth_verification_read_only(primary_before);
        assert_official_auth_verification_read_only(secondary_before);
    });
}

#[test]
fn official_auth_verify_targets_reports_secondary_pending_without_claiming_success() {
    with_temp_user_home("official-verify-secondary-pending", |root| {
        let primary = codex_dir();
        let secondary = root.join("secondary-home");
        let secondary_cleanup =
            with_codex_dir(&secondary, || official_auth_verification_fixture().2);
        let mut targets = vec![
            json!({"codexDir": primary, "authCleanup": {"restored": false, "removed": true, "reason": "restored_pre_login_signed_out"}}),
            json!({"codexDir": secondary, "authCleanup": secondary_cleanup}),
        ];
        let result = codex_official_auth_verification::verify_targets(
            &mut targets,
            &json!({"launchQueued": true, "launchConfirmed": false}),
        );
        assert_eq!(targets[0]["authVerification"]["status"], "not-required");
        assert_eq!(targets[1]["authVerification"]["status"], "pending");
        assert_eq!(result["status"], "pending");
        assert_eq!(result["reason"], "secondary-target-verification-pending");
        assert_eq!(result["checkedAfterLaunch"], false);
    });
}

#[test]
fn official_auth_verify_targets_checks_independent_homes_without_mutation() {
    with_temp_user_home("official-verify-independent-homes", |root| {
        let primary = codex_dir();
        let secondary = root.join("secondary-home");
        let (_, primary_key, primary_cleanup) = official_auth_verification_fixture();
        let (secondary_key, secondary_cleanup) = with_codex_dir(&secondary, || {
            let auth = test_codex_chatgpt_auth(
                "secondary@example.test",
                "secondary-user",
                "secondary-account",
            );
            write_json_pretty(&codex_auth_path(), &auth).unwrap();
            let key = json_str(&upsert_account(&auth, None, true).unwrap(), "accountKey");
            (
                key.clone(),
                json!({"restored": true, "expectedAccountKey": key, "restoredAccountKey": key}),
            )
        });
        let primary_before = official_auth_verification_bytes();
        let secondary_before = with_codex_dir(&secondary, official_auth_verification_bytes);
        let mut targets = vec![
            json!({"codexDir": primary, "authCleanup": primary_cleanup}),
            json!({"codexDir": secondary, "authCleanup": secondary_cleanup}),
        ];
        let result = codex_official_auth_verification::verify_targets(
            &mut targets,
            &json!({"launchConfirmed": true}),
        );
        assert_eq!(result["status"], "verified");
        assert_eq!(
            targets[0]["authVerification"]["expectedAccountKey"],
            primary_key
        );
        assert_eq!(
            targets[1]["authVerification"]["expectedAccountKey"],
            secondary_key
        );
        assert_ne!(primary_key, secondary_key);
        for target in targets {
            assert_eq!(target["authVerification"]["status"], "verified");
            assert_eq!(target["authVerification"]["scope"], "local-auth-file");
            assert_eq!(target["authVerification"]["nativeSessionVerified"], false);
        }
        assert_official_auth_verification_read_only(primary_before);
        assert_official_auth_verification_read_only(secondary_before);
    });
}

#[test]
fn official_auth_verify_targets_rejects_missing_target_directories() {
    with_temp_user_home("official-verify-missing-target", |_| {
        for mut targets in [vec![], vec![json!({})]] {
            let result = codex_official_auth_verification::verify_targets(
                &mut targets,
                &json!({"launchConfirmed": true}),
            );
            assert_eq!(result["status"], "failed");
            assert_eq!(result["reason"], "target-directory-missing");
            assert_eq!(result["nativeSessionVerified"], false);
        }
    });
}

fn official_auth_verification_tree(path: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
    fn collect(path: &Path, result: &mut Vec<(PathBuf, Option<Vec<u8>>)>) {
        if path.is_dir() {
            result.push((path.to_path_buf(), None));
            for entry in fs::read_dir(path).unwrap() {
                collect(&entry.unwrap().path(), result);
            }
        } else {
            result.push((path.to_path_buf(), Some(fs::read(path).unwrap())));
        }
    }
    let mut result = Vec::new();
    collect(path, &mut result);
    result.sort_by(|left, right| left.0.cmp(&right.0));
    result
}

#[test]
fn official_auth_verify_strict_readers_reject_malformed_files_without_backup_writes() {
    for (kind, contents) in [
        ("auth", "{broken"),
        ("auth", ""),
        ("auth", "[]"),
        ("auth", "null"),
        ("registry", "{broken"),
        ("registry", ""),
        ("registry", "[]"),
        ("registry", "null"),
        ("registry", r#"{"activeAccountKey":42,"items":[]}"#),
        ("registry", r#"{"activeAccountKey":"","items":{}}"#),
        ("registry", r#"{"activeAccountKey":null,"items":[]}"#),
    ] {
        for signed_out in [false, true] {
            with_temp_user_home("official-verify-strict-files", |root| {
                let (_, _, restored_cleanup) = official_auth_verification_fixture();
                let cleanup = if signed_out {
                    fs::remove_file(codex_auth_path()).unwrap();
                    set_registry_active_account("").unwrap();
                    json!({"restored": false, "removed": true, "reason": "restored_pre_login_signed_out"})
                } else {
                    restored_cleanup
                };
                let path = if kind == "auth" {
                    codex_auth_path()
                } else {
                    codex_registry_path()
                };
                fs::write(&path, contents).unwrap();
                let before = official_auth_verification_tree(root);
                let result = codex_official_auth_verification::verify_current(
                    &cleanup,
                    &json!({"launchConfirmed": true}),
                );
                assert_eq!(result["status"], "failed", "{kind} signed_out={signed_out}");
                assert_eq!(result["reason"], format!("{kind}-read-failed"));
                assert!(
                    codex_official_auth_verification::validate_written_identity(&cleanup).is_err()
                );
                assert!(
                    official_auth_verification_tree(root) == before,
                    "strict readers must not change credentials or create backups"
                );
            });
        }
    }
}

#[test]
fn official_auth_verify_missing_auth_retains_saved_marker_without_activating_it() {
    with_temp_user_home("official-verify-stale-marker", |root| {
        let (_, saved_key, _) = official_auth_verification_fixture();
        fs::remove_file(codex_auth_path()).unwrap();
        let cleanup = json!({"changed": false, "reason": "missing_auth"});
        let before = official_auth_verification_tree(root);
        codex_official_auth_verification::validate_written_identity(&cleanup).unwrap();
        let result = codex_official_auth_verification::verify_current(
            &cleanup,
            &json!({"launchConfirmed": true}),
        );
        assert_eq!(result["status"], "not-required");
        assert_eq!(result["reason"], "auth-missing");
        assert!(result["expectedAccountKey"].is_null());
        assert!(!codex_auth_path().exists());
        assert_eq!(read_registry().unwrap()["activeAccountKey"], saved_key);
        assert!(
            official_auth_verification_tree(root) == before,
            "saved selection is not authorization to activate an account"
        );
    });
}

#[test]
fn official_auth_verify_missing_auth_detects_post_close_identity_without_overwriting_it() {
    with_temp_user_home("official-verify-missing-auth-changed", |root| {
        official_auth_verification_fixture();
        let cleanup = json!({"changed": false, "reason": "missing_auth"});
        let before = official_auth_verification_tree(root);
        assert!(codex_official_auth_verification::validate_written_identity(&cleanup).is_err());
        let result = codex_official_auth_verification::verify_current(
            &cleanup,
            &json!({"launchConfirmed": true}),
        );
        assert_eq!(result["status"], "failed");
        assert_eq!(result["reason"], "auth-changed-after-close");
        assert!(official_auth_verification_tree(root) == before);
    });
}

#[test]
fn official_auth_write_check_allows_legacy_unknown_missing_auth_with_saved_selection() {
    with_temp_user_home("official-close-unknown-stale-selection", |_| {
        let (_, saved_key, _) = official_auth_verification_fixture();
        fs::remove_file(codex_auth_path()).unwrap();
        codex_relay_restore::capture("model = \"gpt-5.5\"\n", "synthetic-relay", false).unwrap();
        let state_path = codex_relay_restore::artifact_paths()[1].clone();
        let mut state = read_json_if_exists(&state_path).unwrap().unwrap();
        state["auth_baseline_captured"] = json!(false);
        write_json_pretty(&state_path, &state).unwrap();
        assert!(matches!(
            codex_relay_restore::explicit_auth_baseline().unwrap(),
            Some(codex_relay_restore::ExplicitAuthBaseline::Unknown)
        ));
        let config_path = codex_config_path();
        fs::write(&config_path, "model = \"gpt-5.5\"\n").unwrap();
        let existing = read_text_if_exists(&config_path).unwrap();
        let official = codex_relay_restore::restore_config(&existing).unwrap();
        let registry_before = fs::read(codex_registry_path()).unwrap();
        let cleanup = run_codex_relay_close_transaction(
            &config_path,
            &existing,
            &official,
            "synthetic-relay",
            None,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(cleanup["reason"], "missing_auth");
        assert!(!codex_auth_path().exists());
        assert!(fs::read(codex_registry_path()).unwrap() == registry_before);
        assert_eq!(read_registry().unwrap()["activeAccountKey"], saved_key);
        assert!(
            !state_path.exists(),
            "legacy close should finish clearing recovery evidence"
        );
        assert_eq!(
            codex_official_auth_verification::verify_current(
                &cleanup,
                &json!({"launchConfirmed": true})
            )["status"],
            "not-required"
        );
    });
}
