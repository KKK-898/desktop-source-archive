use super::*;
use crate::tests::with_temp_user_home;

fn account(label: &str) -> Value {
    let claims = json!({
        "email": format!("{label}@example.invalid"), "sub": format!("user-{label}"),
        "exp": unix_now() + 3600,
        "https://api.openai.com/auth": {
            "chatgpt_user_id": format!("user-{label}"),
            "chatgpt_account_id": format!("account-{label}")
        }
    });
    let token = format!(
        "e30.{}.test",
        general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    );
    json!({"auth_mode":"chatgpt", "OPENAI_API_KEY":null,
        "tokens":{"access_token":token,"id_token":token,"refresh_token":format!("synthetic-refresh-{label}")}})
}

fn initial_state(kind: &str) {
    capture("model = \"gpt-5.5\"\n", "old-relay", false).unwrap();
    let mut state = read_state().unwrap().unwrap();
    match kind {
        "signed-out" => {}
        "unknown" => state.auth_baseline_captured = false,
        "legacy" => {
            state.legacy = true;
            state.auth_baseline_captured = false;
        }
        _ => panic!("unsupported synthetic baseline"),
    }
    write_text_atomic(
        &state_path(),
        &serde_json::to_string_pretty(&state).unwrap(),
    )
    .unwrap();
}

fn start_api_twice(key: &str) {
    // The production coordinator and per-target configuration both capture
    // before writing auth. Exercise that double capture without native launch.
    let config = read_text_if_exists(&codex_config_path()).unwrap();
    capture(&config, key, true).unwrap();
    capture(&config, key, true).unwrap();
    write_codex_api_auth(key, "synthetic-transition").unwrap();
}

fn close_api(key: &str) -> Value {
    cleanup_codex_gaoge_api_auth_for_official(key, "").unwrap()
}

fn assert_identity(auth: &Value) {
    assert!(
        read_json_if_exists(&codex_auth_path()).unwrap().as_ref() == Some(auth),
        "official login was not restored to the exact synthetic identity"
    );
    assert_eq!(
        read_registry().unwrap()["activeAccountKey"],
        auth_account_key(auth)
    );
}

#[test]
fn new_official_to_api_transition_replaces_stale_signed_out_baseline() {
    with_temp_user_home("transition-signed-out", |_| {
        initial_state("signed-out");
        let roots = read_state().unwrap().unwrap().root_lines;
        let live = account("current");
        write_json_pretty(&codex_auth_path(), &live).unwrap();
        start_api_twice("new-api");
        let result = close_api("new-api");
        assert!(
            result["restored"] == true,
            "stale signed-out baseline discarded the current login"
        );
        assert_identity(&live);
        assert_eq!(read_state().unwrap().unwrap().root_lines, roots);
    });
}

#[test]
fn new_official_to_api_transition_replaces_unknown_auth_baseline() {
    with_temp_user_home("transition-unknown", |_| {
        initial_state("unknown");
        let live = account("current");
        write_json_pretty(&codex_auth_path(), &live).unwrap();
        start_api_twice("new-api");
        assert!(close_api("new-api")["restored"] == true);
        assert_identity(&live);
    });
}

#[test]
fn new_official_to_api_transition_records_identity_in_legacy_state() {
    with_temp_user_home("transition-legacy", |_| {
        initial_state("legacy");
        let live = account("current");
        write_json_pretty(&codex_auth_path(), &live).unwrap();
        start_api_twice("new-api");
        // Unrelated newer snapshots must never become the return account.
        upsert_account(&account("unrelated"), None, false).unwrap();
        assert!(
            matches!(explicit_auth_baseline().unwrap(), Some(ExplicitAuthBaseline::Account(key)) if key == auth_account_key(&live))
        );
        close_api("new-api");
        assert_identity(&live);
    });
}

#[test]
fn new_official_identity_supersedes_an_older_account_before_api_overwrite() {
    with_temp_user_home("transition-new-identity", |_| {
        let first = account("first");
        write_json_pretty(&codex_auth_path(), &first).unwrap();
        capture("", "old-api", true).unwrap();
        let current = account("current");
        write_json_pretty(&codex_auth_path(), &current).unwrap();
        start_api_twice("new-api");
        close_api("new-api");
        assert_identity(&current);
    });
}

#[test]
fn repeated_api_login_with_native_metadata_preserves_original_return_identity() {
    with_temp_user_home("transition-repeat-api", |_| {
        let live = account("original");
        write_json_pretty(&codex_auth_path(), &live).unwrap();
        start_api_twice("first-api");
        let mut api = build_codex_api_auth("first-api");
        api["native_metadata"] = json!({"schema":2,"counter":3});
        write_json_pretty(&codex_auth_path(), &api).unwrap();
        start_api_twice("first-api");
        assert!(read_json_if_exists(&codex_auth_path()).unwrap().as_ref() == Some(&api));
        start_api_twice("second-api");
        assert!(close_api("second-api")["restored"] == true);
        assert_identity(&live);
    });
}

#[test]
fn originally_signed_out_transition_never_chooses_a_saved_only_account() {
    with_temp_user_home("transition-no-live", |_| {
        upsert_account(&account("saved-only"), None, false).unwrap();
        start_api_twice("first-api");
        start_api_twice("second-api");
        let result = close_api("second-api");
        assert_eq!(result["reason"], "restored_pre_login_signed_out");
        assert!(!codex_auth_path().exists());
        assert_eq!(read_registry().unwrap()["activeAccountKey"], "");
    });
}

#[test]
fn personal_api_baseline_survives_repeated_managed_api_logins() {
    with_temp_user_home("transition-personal-api", |_| {
        let personal = build_codex_api_auth("synthetic-personal-api");
        write_json_pretty(&codex_auth_path(), &personal).unwrap();
        if !secure_storage_available() {
            // Unsupported platforms must retain live auth and refuse the
            // transition before recording an unencrypted backup.
            let error = capture("", "first-api", true).unwrap_err();
            assert!(error.contains("安全凭据存储"));
            assert!(read_json_if_exists(&codex_auth_path()).unwrap().as_ref() == Some(&personal));
            assert!(read_state().unwrap().is_none());
            return;
        }
        start_api_twice("first-api");
        start_api_twice("second-api");
        close_api("second-api");
        assert!(read_json_if_exists(&codex_auth_path()).unwrap().as_ref() == Some(&personal));
    });
}

#[test]
fn new_live_account_supersedes_preserved_personal_auth_without_stale_hash_errors() {
    for preserved_in_place in [false, true] {
        with_temp_user_home(
            if preserved_in_place {
                "transition-inplace-to-account"
            } else {
                "transition-encrypted-to-account"
            },
            |_| {
                let personal = build_codex_api_auth("personal-api");
                write_json_pretty(&codex_auth_path(), &personal).unwrap();
                let captured = capture("", "old-relay", !preserved_in_place);
                if !preserved_in_place && !secure_storage_available() {
                    assert!(captured.unwrap_err().contains("安全凭据存储"));
                    assert!(read_json_if_exists(&codex_auth_path()).unwrap().as_ref() == Some(&personal));
                    assert!(read_state().unwrap().is_none());
                    return;
                }
                captured.unwrap();
                let live = account("current");
                write_json_pretty(&codex_auth_path(), &live).unwrap();
                let unrelated = upsert_account(&account("stale-selected"), None, false).unwrap();
                set_registry_active_account(unrelated["accountKey"].as_str().unwrap()).unwrap();
                start_api_twice("managed-api");
                let state = read_state().unwrap().unwrap();
                assert_eq!(
                    state.official_account_key.as_deref(),
                    Some(auth_account_key(&live).as_str())
                );
                assert!(state.encrypted_preserved_auth.is_empty());
                assert!(state.preserved_auth_hash.is_empty());
                assert!(!state.preserved_auth_in_place);
                assert!(state.legacy_preserved_auth.is_none());
                close_api("managed-api");
                assert_identity(&live);
            },
        );
    }
}

#[test]
fn api_only_reconfiguration_does_not_promote_an_unrelated_saved_selection() {
    with_temp_user_home("transition-api-selection", |_| {
        let original = account("original");
        write_json_pretty(&codex_auth_path(), &original).unwrap();
        start_api_twice("first-api");
        let unrelated = upsert_account(&account("saved-selection"), None, false).unwrap();
        set_registry_active_account(unrelated["accountKey"].as_str().unwrap()).unwrap();
        start_api_twice("second-api");
        close_api("second-api");
        assert_identity(&original);
    });
}

#[test]
fn non_overwriting_relay_reconfiguration_keeps_existing_baseline_semantics() {
    with_temp_user_home("transition-no-overwrite", |_| {
        initial_state("signed-out");
        write_json_pretty(&codex_auth_path(), &account("later")).unwrap();
        capture("", "relay", false).unwrap();
        assert!(matches!(
            explicit_auth_baseline().unwrap(),
            Some(ExplicitAuthBaseline::SignedOut)
        ));
    });
}

#[test]
fn independent_codex_homes_capture_their_own_transition_identity() {
    with_temp_user_home("transition-multiple-homes", |root| {
        let first_home = codex_dir();
        let second_home = root.join("secondary-codex");
        let first = account("primary");
        let second = account("secondary");
        for (home, live, kind) in [
            (&first_home, &first, "signed-out"),
            (&second_home, &second, "unknown"),
        ] {
            with_codex_dir(home, || {
                initial_state(kind);
                write_json_pretty(&codex_auth_path(), live).unwrap();
                start_api_twice("managed-api");
            });
        }
        for (home, live) in [(&second_home, &second), (&first_home, &first)] {
            with_codex_dir(home, || {
                close_api("managed-api");
                assert_identity(live);
            });
        }
    });
}

#[test]
fn restored_transition_rolls_back_auth_registry_and_baseline_on_close_failure() {
    with_temp_user_home("transition-close-rollback", |_| {
        initial_state("signed-out");
        write_json_pretty(&codex_auth_path(), &account("current")).unwrap();
        start_api_twice("managed-api");
        let config_path = codex_config_path();
        let existing = read_text_if_exists(&config_path).unwrap();
        let official = restore_config(&existing).unwrap();
        let before = codex_relay_close_snapshot_paths()
            .into_iter()
            .map(|path| {
                let bytes = fs::read(&path).ok();
                (path, bytes)
            })
            .collect::<Vec<_>>();
        let error = run_codex_relay_close_transaction(
            &config_path,
            &existing,
            &official,
            "managed-api",
            None,
            || Err("synthetic cleanup failure".into()),
        )
        .unwrap_err();
        assert!(error.contains("已恢复本次关闭前"));
        for (path, bytes) in before {
            assert!(
                fs::read(&path).ok() == bytes,
                "close failure changed isolated transaction state"
            );
        }
    });
}
