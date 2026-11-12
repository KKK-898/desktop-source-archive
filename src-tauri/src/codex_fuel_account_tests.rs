use super::tests::with_temp_user_home;
use super::*;
use std::collections::BTreeMap;

fn fuel_auth(identity: &str, expires_at: i64, refresh: bool) -> Value {
    let claims = json!({
        "email": format!("{identity}@example.invalid"),
        "sub": format!("user-{identity}"),
        "exp": expires_at,
        "https://api.openai.com/auth": {
            "chatgpt_user_id": format!("user-{identity}"),
            "chatgpt_account_id": format!("account-{identity}"),
        },
    });
    let token = format!(
        "e30.{}.test",
        general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    );
    let mut auth = json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": { "access_token": token, "id_token": token },
    });
    if refresh {
        auth["tokens"]["refresh_token"] = json!(format!("synthetic-refresh-{identity}"));
    }
    auth
}

fn fuel_request(auth: &Value) -> Value {
    json!({
        "requireCurrentChatgptAccount": true,
        "accountKey": auth_account_key(auth),
    })
}

fn files_under(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .map(Result::unwrap)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            (entry.path().strip_prefix(root).unwrap().to_path_buf(), fs::read(entry.path()).unwrap())
        })
        .collect()
}

fn assert_unchanged(root: &Path, before: &BTreeMap<PathBuf, Vec<u8>>) {
    // Do not include auth material in assertion diagnostics.
    assert!(files_under(root) == *before, "account check changed isolated files");
}

#[test]
fn fuel_account_preflight_never_uses_saved_only_or_logged_out_accounts() {
    with_temp_user_home("fuel-check-saved-only", |root| {
        let auth = fuel_auth("saved", unix_now() + 3600, true);
        write_json_pretty(&codex_auth_path(), &auth).unwrap();
        upsert_account(&auth, None, true).unwrap();
        fs::remove_file(codex_auth_path()).unwrap();
        let before = files_under(root);
        let status = check_codex_fuel_account_inner().unwrap();
        assert_eq!(status["canStart"], false);
        assert_eq!(status["reason"], "missing");
        assert!(status["currentAccount"].is_null());
        let error = require_current_codex_fuel_account(&fuel_request(&auth)).err().unwrap();
        assert!(error.starts_with("CODEX_FUEL_ACCOUNT_REQUIRED:"));
        assert!(!codex_auth_path().exists());
        assert_unchanged(root, &before);
    });
}

#[test]
fn fuel_account_preflight_separates_api_invalid_and_refreshable_auth() {
    with_temp_user_home("fuel-check-states", |root| {
        let expired = fuel_auth("expired", unix_now() - 3600, false);
        let mut mixed = fuel_auth("mixed", unix_now() + 3600, true);
        mixed["OPENAI_API_KEY"] = json!("synthetic-personal-api-key");
        for (auth, can_start, reason) in [
            (build_codex_api_auth("synthetic-api-key"), false, "missing"),
            (mixed, false, "missing"),
            (json!({}), false, "missing"),
            (expired, false, "invalid"),
            (json!({"tokens":{"id_token":"synthetic-id-only"}}), false, "invalid"),
            (json!({"tokens":{"refresh_token":"unidentified-refresh"}}), false, "invalid"),
            (fuel_auth("refreshable", unix_now() - 3600, true), true, "ready"),
            (fuel_auth("valid", unix_now() + 3600, false), true, "ready"),
        ] {
            write_json_pretty(&codex_auth_path(), &auth).unwrap();
            let before = files_under(root);
            let status = check_codex_fuel_account_inner().unwrap();
            assert_eq!(status["canStart"], can_start);
            assert_eq!(status["reason"], reason);
            let serialized = status.to_string();
            assert!(!serialized.contains("synthetic-"));
            assert!(!serialized.contains("access_token"));
            assert!(!serialized.contains("refresh_token"));
            assert!(!serialized.contains("OPENAI_API_KEY"));
            assert!(!serialized.contains("snapshotPath"));
            assert_unchanged(root, &before);
        }
    });
}

#[test]
fn fuel_account_guard_uses_live_credentials_despite_stale_registry_and_newer_saved_auth() {
    with_temp_user_home("fuel-check-live-only", |root| {
        let live = fuel_auth("live", unix_now() + 3600, true);
        let mut saved = live.clone();
        saved["tokens"]["refresh_token"] = json!("synthetic-saved-must-not-be-used");
        saved["last_refresh"] = json!("2099-01-01T00:00:00Z");
        upsert_account(&saved, None, true).unwrap();
        set_registry_active_account("stale-unrelated-selection").unwrap();
        write_json_pretty(&codex_auth_path(), &live).unwrap();
        let before = files_under(root);
        let status = check_codex_fuel_account_inner().unwrap();
        assert_eq!(status["canStart"], true);
        assert_eq!(status["currentAccount"]["accountKey"], auth_account_key(&live));
        let active = require_current_codex_fuel_account(&fuel_request(&live)).unwrap().unwrap();
        assert!(active.auth == live, "guard did not retain current live credentials");
        assert_unchanged(root, &before);
    });
}

#[test]
fn fuel_account_guard_rejects_missing_identity_mismatch_and_conflicting_modes_without_writes() {
    with_temp_user_home("fuel-check-requests", |root| {
        let live = fuel_auth("live", unix_now() + 3600, true);
        write_json_pretty(&codex_auth_path(), &live).unwrap();
        let before = files_under(root);
        for request in [
            json!({"requireCurrentChatgptAccount":true}),
            json!({"requireCurrentChatgptAccount":true,"accountKey":"different-account"}),
        ] {
            let error = require_current_codex_fuel_account(&request).err().unwrap();
            assert!(error.starts_with("CODEX_FUEL_ACCOUNT_CHANGED:"));
        }
        for field in ["forceApiMode", "aggregateLogin"] {
            let mut request = fuel_request(&live);
            request[field] = json!(true);
            let error = require_current_codex_fuel_account(&request).err().unwrap();
            assert!(error.starts_with("CODEX_FUEL_ACCOUNT_MODE_CONFLICT:"));
        }
        assert_unchanged(root, &before);
    });
}

#[test]
fn fuel_account_guard_rechecks_logout_after_confirmation_without_restoring_saved_account() {
    with_temp_user_home("fuel-check-logout-race", |root| {
        let live = fuel_auth("live", unix_now() + 3600, true);
        upsert_account(&live, None, true).unwrap();
        write_json_pretty(&codex_auth_path(), &live).unwrap();
        fs::write(codex_config_path(), "# must stay official\n").unwrap();
        let request = fuel_request(&live);
        assert!(require_current_codex_fuel_account(&request).unwrap().is_some());
        fs::remove_file(codex_auth_path()).unwrap();
        let before = files_under(root);
        let error = require_current_codex_fuel_account(&request).err().unwrap();
        assert!(error.starts_with("CODEX_FUEL_ACCOUNT_REQUIRED:"));
        assert!(!codex_auth_path().exists());
        assert_unchanged(root, &before);
    });
}

#[test]
fn fuel_account_guard_rechecks_switches_and_uses_same_account_rotated_credentials() {
    with_temp_user_home("fuel-check-rotation-race", |root| {
        let live = fuel_auth("live", unix_now() + 3600, true);
        write_json_pretty(&codex_auth_path(), &live).unwrap();
        let request = fuel_request(&live);
        assert!(require_current_codex_fuel_account(&request).unwrap().is_some());
        let other = fuel_auth("other", unix_now() + 3600, true);
        write_json_pretty(&codex_auth_path(), &other).unwrap();
        let before = files_under(root);
        let error = require_current_codex_fuel_account(&request).err().unwrap();
        assert!(error.starts_with("CODEX_FUEL_ACCOUNT_CHANGED:"));
        assert_unchanged(root, &before);
        let mut rotated = live;
        rotated["tokens"]["refresh_token"] = json!("synthetic-native-rotated");
        write_json_pretty(&codex_auth_path(), &rotated).unwrap();
        let before = files_under(root);
        let active = require_current_codex_fuel_account(&request).unwrap().unwrap();
        assert!(active.auth == rotated, "guard discarded native token rotation");
        assert_unchanged(root, &before);
    });
}

#[test]
fn fuel_account_preflight_surfaces_read_and_parse_failures_without_touching_auth() {
    with_temp_user_home("fuel-check-read-errors", |root| {
        fs::create_dir_all(codex_auth_path()).unwrap();
        let before = files_under(root);
        assert!(check_codex_fuel_account_inner().is_err());
        assert_unchanged(root, &before);
        fs::remove_dir(codex_auth_path()).unwrap();
        fs::write(codex_auth_path(), "{ invalid auth json").unwrap();
        let before = files_under(root);
        assert!(check_codex_fuel_account_inner().is_err());
        assert_unchanged(root, &before);
    });
}

#[test]
fn fuel_account_guard_leaves_legacy_api_aggregate_and_explicit_account_requests_unchanged() {
    with_temp_user_home("fuel-check-legacy", |root| {
        // A read would fail: legacy flows must not perform this new check.
        fs::create_dir_all(codex_auth_path()).unwrap();
        let before = files_under(root);
        for request in [
            json!({}),
            json!({"forceApiMode":true}),
            json!({"aggregateLogin":true,"forceApiMode":true}),
            json!({"accountKey":"explicitly-selected-saved-account"}),
        ] {
            assert!(require_current_codex_fuel_account(&request).unwrap().is_none());
        }
        assert_unchanged(root, &before);
    });
}
