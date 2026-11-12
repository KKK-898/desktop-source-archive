use super::*;
use crate::tests::with_temp_user_home;

fn empty_api_profile(home: &Path) {
    fs::create_dir_all(home).unwrap();
    write_json_pretty(
        &home.join("auth.json"),
        &json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-project-bridge-key"}),
    )
    .unwrap();
    write_json_pretty(
        &home.join(".codex-global-state.json"),
        &json!({"electron-account-renderer-state-v1":{"owner":null,"inactive":{}}}),
    )
    .unwrap();
}

fn save_request(snapshot: &Value) -> Value {
    json!({"scope":snapshot["scope"],"runtimeRevision":snapshot["runtimeRevision"],
        "expectedRevision":snapshot["revision"],"globals":snapshot["globals"],"memberships":snapshot["memberships"]})
}

#[test]
fn project_bridge_saves_empty_api_state_and_accepts_only_identical_retries() {
    with_temp_user_home("api-project-bridge-cas", |_| {
        let home = codex_dir();
        empty_api_profile(&home);
        let original_auth = fs::read(home.join("auth.json")).unwrap();
        let original_native = fs::read(home.join(".codex-global-state.json")).unwrap();
        let initial = runtime_payload(None).unwrap();
        assert_eq!(initial["revision"], 0);
        let request = save_request(&initial);
        let saved = commit(&request).unwrap();
        assert_eq!(saved["ok"], true);
        assert!(saved["apiLocalProjects"]["revision"].as_u64().unwrap() > 0);
        let bytes = fs::read(home.join(".gaoge-api-local-projects.json")).unwrap();
        assert_eq!(
            commit(&request).unwrap()["apiLocalProjects"],
            saved["apiLocalProjects"]
        );
        let mut changed = request.clone();
        changed["globals"]["unknown-account-field"] = json!(true);
        assert!(commit(&changed).is_err());
        assert_eq!(
            bytes,
            fs::read(home.join(".gaoge-api-local-projects.json")).unwrap()
        );
        assert_eq!(original_auth, fs::read(home.join("auth.json")).unwrap());
        assert_eq!(
            original_native,
            fs::read(home.join(".codex-global-state.json")).unwrap()
        );
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("synthetic-project-bridge-key"));
        assert!(!text.contains("electron-account-renderer-state-v1"));
    });
}

#[test]
fn project_bridge_rejects_previous_home_login_generation_and_official_auth() {
    with_temp_user_home("api-project-bridge-identity", |root| {
        let home = codex_dir();
        empty_api_profile(&home);
        let request = save_request(&runtime_payload(None).unwrap());
        let mut stale = request.clone();
        stale["runtimeRevision"] = json!(current_codex_runtime_revision() + 1);
        assert!(commit(&stale).is_err());
        stale = request.clone();
        stale["scope"] = json!("previous-home");
        assert!(commit(&stale).is_err());
        for auth in [
            json!({"auth_mode":"chatgpt","tokens":{"access_token":"synthetic-official"}}),
            json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic","tokens":{"access_token":"synthetic-official"}}),
        ] {
            write_json_pretty(&home.join("auth.json"), &auth).unwrap();
            assert!(commit(&request).is_err());
        }
        let other = root.join("other-active-home");
        empty_api_profile(&other);
        std::env::set_var("CODEX_HOME", &other);
        assert!(commit(&request).is_err());
        assert!(!home.join(".gaoge-api-local-projects.json").exists());
        assert!(!other.join(".gaoge-api-local-projects.json").exists());
    });
}

#[test]
fn project_bridge_rejects_account_globals_and_does_not_block_foreground_switches() {
    with_temp_user_home("api-project-bridge-boundary", |_| {
        let home = codex_dir();
        empty_api_profile(&home);
        let mut request = save_request(&runtime_payload(None).unwrap());
        request["globals"]["electron-account-renderer-state-v1"] = json!({"owner":"forbidden"});
        assert!(commit(&request).is_err());
        request["globals"]
            .as_object_mut()
            .unwrap()
            .remove("electron-account-renderer-state-v1");
        let guard = CODEX_CONFIGURE_LOCK.lock().unwrap();
        let started = Instant::now();
        assert!(commit(&request).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(guard);
        assert!(!home.join(".gaoge-api-local-projects.json").exists());
    });
}

fn official(user: &str, account: &str) -> Value {
    let claims = json!({"email":"synthetic-project-owner@example.invalid", "sub":user,
        "exp":unix_now()+3600, "https://api.openai.com/auth":{
            "chatgpt_user_id":user,"chatgpt_account_id":account}});
    let token = format!(
        "e30.{}.test",
        general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    );
    json!({"auth_mode":"chatgpt","tokens":{"access_token":token,"id_token":token,
        "refresh_token":"synthetic-project-owner-refresh","account_id":account}})
}

fn native_owner(auth: &Value) -> String {
    let (user, account, _) = codex_auth_identity(auth);
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&[user, account]).unwrap())
    )
}

fn hidden_source(home: &Path, auth: &Value) -> Value {
    let identity = format!("local:{}", home.to_string_lossy());
    json!({"electron-account-renderer-state-v1":{"owner":null,"inactive":{
        (native_owner(auth)):{"globals":{
            "local-projects":{"legacy-a":{"id":"legacy-a","name":"Synthetic A","createdAt":1,"updatedAt":2,"rootPaths":[home.join("workspace").to_string_lossy()]}},
            "app-server-project-id-by-legacy-project-id-by-host":{(identity.clone()):{"legacy-a":"server-a"}},
            "app-server-projects-migration-by-host":{(identity):{"version":1,"projectsMigrated":true,"threadAssignmentsMigrated":false,
                "threadAssignmentsReadMigrated":false,"pendingThreadAssignmentIds":["thread-a"]}},
            "thread-project-assignments":{"thread-a":{"projectKind":"local","projectId":"legacy-a"}},
            "projectless-thread-ids":["independent"],
            "thread-host-ids":{"thread-a":"local","independent":"local"}
        }}
    }}})
}

fn capture_return_identity(home: &Path, auth: &Value) {
    with_codex_dir(home, || {
        fs::create_dir_all(home).unwrap();
        write_json_pretty(&home.join("auth.json"), auth).unwrap();
        codex_relay_restore::capture("", "synthetic-project-api-key", true).unwrap();
        write_json_pretty(
            &home.join("auth.json"),
            &json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-project-api-key"}),
        )
        .unwrap();
    });
}

#[test]
fn hidden_catalog_uses_only_the_exact_saved_return_owner_without_restoring_auth() {
    with_temp_user_home("project-inactive-exact-owner", |_| {
        let home = codex_dir();
        let first = official("owner-a", "account-a");
        capture_return_identity(&home, &first);
        let other = official("owner-b", "account-b");
        upsert_account(&other, None, false).unwrap();
        let mut source = hidden_source(&home, &first);
        source["electron-account-renderer-state-v1"]["inactive"][native_owner(&other)] =
            json!({"globals":{"local-projects":{"wrong-owner":{}}}});
        write_json_pretty(&home.join(".codex-global-state.json"), &source).unwrap();
        let before_auth = fs::read(home.join("auth.json")).unwrap();
        let before_state = fs::read(home.join(".codex-global-state.json")).unwrap();
        let before_registry = fs::read(codex_registry_path()).unwrap();
        let selected = verified_native_project_source(&home, &source)
            .unwrap()
            .unwrap();
        assert!(selected["local-projects"].get("legacy-a").is_some());
        assert!(selected["local-projects"].get("wrong-owner").is_none());
        assert!(!selected
            .to_string()
            .contains("synthetic-project-owner-refresh"));
        assert_eq!(before_auth, fs::read(home.join("auth.json")).unwrap());
        assert_eq!(
            before_state,
            fs::read(home.join(".codex-global-state.json")).unwrap()
        );
        assert_eq!(before_registry, fs::read(codex_registry_path()).unwrap());
    });
}

#[test]
fn hidden_catalog_preserves_root_and_existing_api_edits_even_if_cache_is_damaged() {
    with_temp_user_home("project-inactive-priority", |_| {
        let home = codex_dir();
        let auth = official("owner-a", "account-a");
        capture_return_identity(&home, &auth);
        let mut source = hidden_source(&home, &auth);
        source["local-projects"] = json!({});
        assert!(verified_native_project_source(&home, &source)
            .unwrap()
            .is_none());
        source.as_object_mut().unwrap().remove("local-projects");
        fs::write(
            home.join(".gaoge-api-local-projects.json"),
            b"damaged-cache",
        )
        .unwrap();
        assert!(verified_native_project_source(&home, &source)
            .unwrap()
            .is_none());
        write_json_pretty(&home.join(".codex-global-state.json"), &source).unwrap();
        assert!(runtime_payload(None).is_err());
        assert_eq!(
            fs::read(home.join(".gaoge-api-local-projects.json")).unwrap(),
            b"damaged-cache"
        );
    });
}

#[test]
fn hidden_catalog_rejects_other_home_owner_and_ambiguous_login() {
    with_temp_user_home("project-inactive-boundaries", |root| {
        let home = codex_dir();
        let auth = official("owner-a", "account-a");
        capture_return_identity(&home, &auth);
        let source = hidden_source(&home, &auth);
        for owner in [json!(native_owner(&auth)), json!(false), json!("")] {
            let mut changed = source.clone();
            changed["electron-account-renderer-state-v1"]["owner"] = owner;
            assert!(verified_native_project_source(&home, &changed)
                .unwrap()
                .is_none());
        }
        let other = root.join("other-home");
        empty_api_profile(&other);
        assert!(verified_native_project_source(&other, &source)
            .unwrap()
            .is_none());
        let wrong_home = hidden_source(&other, &auth);
        assert!(verified_native_project_source(&home, &wrong_home)
            .unwrap()
            .is_none());
        for live in [
            auth.clone(),
            json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic","tokens":auth["tokens"]}),
        ] {
            write_json_pretty(&home.join("auth.json"), &live).unwrap();
            assert!(verified_native_project_source(&home, &source)
                .unwrap()
                .is_none());
        }
    });
}

#[test]
fn hidden_catalog_rejects_same_key_changed_user_duplicate_registry_and_damaged_registry() {
    with_temp_user_home("project-inactive-identity-integrity", |_| {
        let home = codex_dir();
        let auth = official("owner-a", "account-a");
        capture_return_identity(&home, &auth);
        let source = hidden_source(&home, &auth);
        let key = auth_account_key(&auth);
        let impostor = official("different-user", "account-a");
        assert_eq!(auth_account_key(&impostor), key);
        write_json_pretty(&snapshot_path_for_key(&key), &impostor).unwrap();
        assert!(verified_native_project_source(&home, &source)
            .unwrap()
            .is_none());
        write_json_pretty(&snapshot_path_for_key(&key), &auth).unwrap();
        let mut registry = read_json_if_exists(&codex_registry_path())
            .unwrap()
            .unwrap();
        let duplicate = registry["items"][0].clone();
        registry["items"].as_array_mut().unwrap().push(duplicate);
        write_json_pretty(&codex_registry_path(), &registry).unwrap();
        assert!(verified_native_project_source(&home, &source)
            .unwrap()
            .is_none());
        fs::write(codex_registry_path(), b"damaged-registry").unwrap();
        let parent = codex_registry_path().parent().unwrap().to_owned();
        let before = fs::read_dir(&parent).unwrap().count();
        assert!(verified_native_project_source(&home, &source)
            .unwrap()
            .is_none());
        assert_eq!(before, fs::read_dir(&parent).unwrap().count());
        assert_eq!(
            fs::read(codex_registry_path()).unwrap(),
            b"damaged-registry"
        );
    });
}

#[test]
fn hidden_catalog_baselines_require_complete_explicit_official_identity() {
    use codex_relay_restore::ExplicitAuthBaseline;
    for baseline in [
        ExplicitAuthBaseline::SignedOut,
        ExplicitAuthBaseline::Unknown,
        ExplicitAuthBaseline::PreservedInPlace {
            auth_hash: "not-proof".into(),
            active_account_key: "not-proof".into(),
        },
        ExplicitAuthBaseline::Preserved {
            auth: json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic"}),
            active_account_key: "not-proof".into(),
        },
        ExplicitAuthBaseline::Preserved {
            auth: official("", "account-a"),
            active_account_key: "not-proof".into(),
        },
        ExplicitAuthBaseline::Preserved {
            auth: official("owner-a", ""),
            active_account_key: "not-proof".into(),
        },
    ] {
        assert!(baseline_owner(baseline).unwrap().is_none());
    }
    let auth = official("owner-a", "account-a");
    assert_eq!(
        baseline_owner(ExplicitAuthBaseline::Preserved {
            auth: auth.clone(),
            active_account_key: "irrelevant".into()
        })
        .unwrap(),
        Some(native_owner(&auth))
    );
}

#[test]
fn hidden_catalog_repairs_dual_database_then_seeds_snapshot_without_changing_native_envelope() {
    with_temp_user_home("project-inactive-full-pipeline", |_| {
        let home = codex_dir();
        let auth = official("owner-a", "account-a");
        capture_return_identity(&home, &auth);
        let source = hidden_source(&home, &auth);
        write_json_pretty(&home.join(".codex-global-state.json"), &source).unwrap();
        fs::create_dir_all(home.join("workspace")).unwrap();
        fs::create_dir_all(home.join("sqlite")).unwrap();
        let native = home.join("state_5.sqlite");
        let legacy = home.join("sqlite/state_5.sqlite");
        let db = rusqlite::Connection::open(&native).unwrap();
        db.execute_batch(
            "CREATE TABLE projects(id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
            CREATE TABLE project_roots(project_id TEXT,path TEXT);
            CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,archived INTEGER NOT NULL);
            INSERT INTO projects VALUES('server-a','{}');
            INSERT INTO threads VALUES('thread-a',NULL,0),('independent',NULL,0);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO project_roots VALUES('server-a',?1)",
            [home.join("workspace").to_string_lossy().as_ref()],
        )
        .unwrap();
        drop(db);
        rusqlite::Connection::open(&legacy)
            .unwrap()
            .execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER NOT NULL);")
            .unwrap();
        let before_state = fs::read(home.join(".codex-global-state.json")).unwrap();
        let before_auth = fs::read(home.join("auth.json")).unwrap();
        let report =
            codex_project_compat::sync_native_project_memberships(&home, &[native, legacy], true)
                .unwrap();
        assert!(!report.deferred, "{}", report.warning);
        assert_eq!(report.restored, 1);
        prepare_for_login(false).unwrap();
        let snapshot = runtime_payload(None).unwrap();
        assert!(snapshot["globals"]["local-projects"]
            .get("server-a")
            .is_some());
        assert_eq!(
            snapshot["memberships"]["assignments"]["thread-a"]["projectId"],
            "server-a"
        );
        assert_eq!(
            snapshot["memberships"]["projectlessThreadIds"],
            json!(["independent"])
        );
        assert_eq!(
            before_state,
            fs::read(home.join(".codex-global-state.json")).unwrap()
        );
        assert_eq!(before_auth, fs::read(home.join("auth.json")).unwrap());
        let text = fs::read_to_string(home.join(".gaoge-api-local-projects.json")).unwrap();
        assert!(!text.contains("owner-a"));
        assert!(!text.contains("account-a"));
        assert!(!text.contains("synthetic-project-api-key"));
    });
}

#[test]
fn manual_session_sync_saves_native_api_edits_before_rewriting_sessions() {
    with_temp_user_home("project-manual-sync-last-save", |_| {
        let home = codex_dir();
        empty_api_profile(&home);
        let initial = runtime_payload(None).unwrap();
        let saved = commit(&save_request(&initial)).unwrap()["apiLocalProjects"].clone();
        let workspace = home.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let identity = format!("local:{}", home.to_string_lossy());
        let native = json!({
            "electron-account-renderer-state-v1":{"owner":null,"inactive":{}},
            "electron-persisted-atom-state":{"gaoge:api-local-projects-hydrated-v1":{
                "version":1,"scope":saved["scope"],"revision":saved["revision"],"nonce":saved["checkpoint"]["nonce"]}},
            "local-projects":{"native-new":{"id":"native-new","name":"Created just before sync",
                "createdAt":1,"updatedAt":2,"rootPaths":[workspace.to_string_lossy()]}},
            "electron-saved-workspace-roots":[workspace.to_string_lossy()],
            "electron-workspace-root-labels":{},
            "app-server-project-id-by-legacy-project-id-by-host":{(identity):{"native-new":"server-new"}}
        });
        write_json_pretty(&home.join(".codex-global-state.json"), &native).unwrap();
        let original_auth = fs::read(home.join("auth.json")).unwrap();
        // The actual manual-sync route owns this foreground lock. Its stopped
        // branch must perform the same final save as switching login modes.
        let _operation = lock_codex_foreground_operation().unwrap();
        let _ = sync_codex_route_targets_with_provider(None, false);
        let snapshot = codex_api_local_projects::read(&home).unwrap().unwrap();
        assert_eq!(
            snapshot["globals"]["local-projects"]["server-new"]["name"],
            "Created just before sync"
        );
        assert!(snapshot["revision"].as_u64().unwrap() > saved["revision"].as_u64().unwrap());
        assert_eq!(original_auth, fs::read(home.join("auth.json")).unwrap());
    });
}
